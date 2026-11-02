"""Diagnostic regressions with pinned protocol parsing; no Bluetooth or ASR."""
import asyncio
import io
import json
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch, AsyncMock

import test_cli_adapter as fixtures
import test_connection_worker as worker_fixtures

adapter = fixtures.adapter


class DiagnosticTests(unittest.IsolatedAsyncioTestCase):
    def test_interval_window_is_bounded_and_separates_slow_frames_from_stalls(self):
        now = [0.0]
        trace = adapter.Diagnostics("import", clock=lambda: now[0])
        trace.transferring = True
        trace.values["attempts"] = 1
        for _ in range(45):
            now[0] += .156
            trace.frame(fixtures.frame(2, 4, b"x" * 160))
        now[0] += 8
        trace.frame(fixtures.frame(2, 4, b"x" * 160))
        value = trace.snapshot()
        self.assertEqual(value["frameIntervalSamples"], 32)
        self.assertEqual(value["frameIntervalMedianMs"], 156)
        self.assertEqual(value["frameIntervalP95Ms"], 156)
        self.assertEqual(value["frameIntervalMaxMs"], 8000)
        self.assertEqual(value["stalls"], 1)
        self.assertEqual(value["idleTimeoutMs"], 12000)
        for _ in range(40):
            now[0] += 9
            trace.frame(fixtures.frame(2, 4, b"x"))
        self.assertEqual(trace.snapshot()["idleTimeoutMs"], 20000)
        now[0] += 3
        self.assertEqual(trace.snapshot()["dataIdleMs"], 3000)

    async def test_pinned_import_accepts_slow_transfer_and_restores_idle_setting(self):
        upstream = adapter.load_upstream(adapter.DEFAULT_REPO_ROOT)
        now = [0.0]
        trace = adapter.Diagnostics("import", clock=lambda: now[0])
        audio = fixtures.pcm_audio(b"\x00\x01" * 200)
        frames = [(0, fixtures.frame(2, 3, b"test.wav"))]
        frames += [(6, fixtures.frame(2, 4, audio[i:i+12])) for i in range(0, len(audio), 12)]
        frames[20] = (15, frames[20][1])  # Exceeds old 12s, below adapted 18s.
        frames.append((0, fixtures.frame(2, 5, b"\0")))
        session = fixtures.Session()
        session.seq = 0
        trace.attach(session)
        waits = []
        original_get = session.events.get
        async def timed_get():
            gap, frame = frames.pop(0)
            now[0] += gap
            session.events.put_nowait(frame)
            return await original_get()
        async def timed_wait(awaitable, timeout):
            waits.append(timeout)
            if frames[0][0] > timeout:
                awaitable.close()
                raise asyncio.TimeoutError()
            return await awaitable
        session.events.get = timed_get
        upstream.time = SimpleNamespace(monotonic=lambda: now[0])
        upstream.asyncio = SimpleNamespace(wait_for=timed_wait, TimeoutError=asyncio.TimeoutError)
        with tempfile.TemporaryDirectory() as directory:
            saved = await adapter.safe_import_file(upstream.import_file, session, "test.wav", Path(directory),
                                                  adapter.ImportReport(), trace, upstream)
            self.assertEqual(saved.read_bytes(), audio)
        self.assertGreater(now[0], 180)
        self.assertIn(18.0, waits)
        self.assertEqual(upstream.IMPORT_IDLE_S, 12.0)
        self.assertEqual(trace.snapshot()["dataFrames"], len(audio) // 12)

    async def test_adaptive_import_restores_observers_and_policy_after_cancellation(self):
        upstream = adapter.load_upstream(adapter.DEFAULT_REPO_ROOT)
        session = fixtures.Session()
        original_put = session.events.put_nowait
        ready = asyncio.Event()
        async def wait(session, _name, _out):
            await session.write_payload(b"\x02\x02")
            ready.set()
            await asyncio.Event().wait()
        operation = asyncio.create_task(adapter.adaptive_import(upstream, wait, session, "test.wav", Path("unused"), None))
        await ready.wait()
        operation.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await operation
        self.assertEqual(session.events.put_nowait, original_put)
        self.assertEqual(upstream.IMPORT_IDLE_S, 12.0)

    async def test_disconnect_checks_original_client_and_bounds_advertising_verification(self):
        upstream = adapter.load_upstream(adapter.DEFAULT_REPO_ROOT)
        scanner = SimpleNamespace(find_device_by_address=AsyncMock(return_value=object()))
        upstream.import_bleak = lambda: (None, scanner)
        for stuck, found in [(True, object()), (False, None), (False, object())]:
            scanner.find_device_by_address.reset_mock()
            scanner.find_device_by_address.return_value = found
            client = SimpleNamespace(is_connected=True)
            session = SimpleNamespace(client=client, _recorder_import_failed=True)
            async def disconnect():
                client.is_connected = stuck
                session.client = None
            if stuck or found is None:
                with self.assertRaisesRegex(RuntimeError, "still connected|re-advertising"):
                    await adapter.confirmed_disconnect(session, disconnect, upstream, "test")
            else:
                await adapter.confirmed_disconnect(session, disconnect, upstream, "test")
            if stuck:
                scanner.find_device_by_address.assert_not_awaited()
            else:
                scanner.find_device_by_address.assert_awaited_once_with("test", timeout=3.0)

    async def test_first_recovery_failure_remains_unconfirmed_after_upstream_clears_client(self):
        upstream = adapter.load_upstream(adapter.DEFAULT_REPO_ROOT)
        client = worker_fixtures.Client
        client.instances.clear()
        client.fail_disconnect = False
        scanner = SimpleNamespace(find_device_by_address=AsyncMock(return_value=None))
        async def run(_args):
            session = upstream.Session()
            await session.connect("test")
            session._recorder_import_failed = True
            await session.disconnect()
        upstream.run = run
        report = adapter.ImportReport()
        with patch.object(upstream, "import_bleak", return_value=(lambda addr: client(addr, lambda _: None), scanner)):
            adapter.install_guards(upstream, report=report)
            with self.assertRaisesRegex(RuntimeError, "re-advertising"):
                await upstream.run(SimpleNamespace(import_first=True))
        self.assertEqual(report.data["cleanup"]["status"], "unconfirmed")
        self.assertEqual(report.data["diagnostics"]["cleanup"], "unconfirmed")
        self.assertEqual(client.instances[-1].disconnects, 1)
        scanner.find_device_by_address.assert_awaited_once()

    async def test_pinned_import_counts_fragmented_notifications_without_changing_audio(self):
        upstream = adapter.load_upstream(adapter.DEFAULT_REPO_ROOT)
        with patch.object(upstream, "import_bleak", return_value=(lambda _: None, None)):
            session = upstream.Session()
        audio = fixtures.pcm_audio()
        now = [10.0]
        trace = adapter.Diagnostics("import", clock=lambda: now[0])
        async def write(_uuid, _data, response):
            now[0] += .020
            for cmd, body in [(3, b"private-name.wav"), (4, audio[:20]), (4, audio[20:]), (5, b"\0")]:
                now[0] += .010
                packet = upstream.build_frame(bytes([2, cmd]) + body, cmd)
                # Observer must see parsed frames once, not count raw BLE fragments.
                session._on_ae22(0, packet[:5])
                session._on_ae22(0, packet[5:])
        session.client = SimpleNamespace(write_gatt_char=write, is_connected=True)
        restore = trace.attach(session)
        with tempfile.TemporaryDirectory() as directory:
            report = adapter.ImportReport()
            saved = await adapter.safe_import_file(upstream.import_file, session, "private-name.wav", Path(directory), report, trace)
            self.assertEqual(saved.read_bytes(), audio)
            trace.finish("retained")
            value = trace.snapshot()
            self.assertEqual(value["bytesReceived"], len(audio))
            self.assertEqual(value["dataFrames"], 2)
            self.assertEqual(value["attempts"], 1)
            self.assertEqual([value[k] for k in ["firstFrameMs", "firstDataMs", "lastDataMs", "endFrameMs"]], [30, 40, 50, 60])
            self.assertEqual(value["endCode"], 0)
            self.assertEqual(value["outcome"], "succeeded")
            self.assertEqual(value["importWriteMs"], 60)
            self.assertIn("validateMs", value)
            self.assertNotIn("private-name", json.dumps(value))
            self.assertNotIn("RIFF", json.dumps(value))
        restore()
        previous = trace.snapshot()
        session.events.put_nowait(fixtures.frame(2, 4, b"ignored"))
        self.assertEqual(trace.snapshot(), previous)

    async def test_blocked_write_and_silent_transfer_have_distinct_failed_phases(self):
        for blocked, phase in [(True, "importWrite"), (False, "transfer")]:
            with self.subTest(blocked=blocked), tempfile.TemporaryDirectory() as directory:
                upstream = adapter.load_upstream(adapter.DEFAULT_REPO_ROOT)
                session = fixtures.Session()
                session.seq = 0
                async def write(_payload):
                    if blocked:
                        await asyncio.Event().wait()
                session.write_payload = write
                trace = adapter.Diagnostics("import")
                trace.attach(session)
                with self.assertRaises(asyncio.TimeoutError):
                    await asyncio.wait_for(adapter.safe_import_file(upstream.import_file, session, "test.wav", Path(directory), adapter.ImportReport(), trace), .02)
                trace.finish("succeeded")
                value = trace.snapshot()
                self.assertEqual(value["failedPhase"], phase)
                self.assertEqual(value["bytesReceived"], 0)
                self.assertNotIn("firstFrameMs", value)
                self.assertEqual(value["attempts"], 1)
                self.assertEqual(list(Path(directory).iterdir()), [])

    async def test_end_frame_does_not_make_truncated_audio_successful(self):
        session = fixtures.Session()
        trace = adapter.Diagnostics("import")
        trace.attach(session)
        async def truncated(session, _name, directory):
            await session.write_payload(b"\x02\x02")
            audio = b"RIFF" + (1000).to_bytes(4, "little") + b"WAVE"
            session.events.put_nowait(fixtures.frame(2, 4, audio))
            session.events.put_nowait(fixtures.frame(2, 5, b"\0"))
            path = directory / "test.wav"
            path.write_bytes(audio)
            return path
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(RuntimeError):
                await adapter.safe_import_file(truncated, session, "test.wav", Path(directory), adapter.ImportReport(), trace)
            trace.finish("succeeded")
            value = trace.snapshot()
            self.assertEqual(value["failedPhase"], "validate")
            self.assertEqual(value["outcome"], "failed")
            self.assertEqual(value["endCode"], 0)
            self.assertEqual(value["bytesReceived"], 12)
            self.assertEqual(list(Path(directory).iterdir()), [])

    async def test_one_shot_heartbeat_and_first_cleanup_failure_are_preserved(self):
        upstream = adapter.load_upstream(adapter.DEFAULT_REPO_ROOT)
        client = worker_fixtures.Client
        client.instances.clear()
        client.fail_disconnect = True
        self.addCleanup(setattr, client, "fail_disconnect", False)
        with tempfile.TemporaryDirectory() as directory, patch.object(upstream, "import_bleak", return_value=(client, None)):
            report = adapter.ImportReport(Path(directory) / "result.json")
            async def operation(_args):
                session = upstream.Session()
                await session.connect("test")
                # Let the report heartbeat run while a real pinned Session exists.
                await asyncio.sleep(1.05)
                self.assertEqual(json.loads(report.path.read_text())["diagnostics"]["outcome"], "running")
                await session.disconnect()
            upstream.run = operation
            adapter.install_guards(upstream, report=report)
            with self.assertRaisesRegex(RuntimeError, "first disconnect failed"):
                await upstream.run(SimpleNamespace(import_first=True))
            result = json.loads(report.path.read_text())
            self.assertEqual(result["diagnostics"]["cleanup"], "unconfirmed")
            self.assertEqual(result["diagnostics"]["failedPhase"], "cleanup")
            self.assertEqual(result["diagnostics"]["outcome"], "failed")
            self.assertEqual(client.instances[-1].disconnects, 1)
            saved = report.path.read_bytes()
            await asyncio.sleep(.02)
            self.assertEqual(report.path.read_bytes(), saved)

    async def test_worker_timeout_emits_progress_and_final_cleanup_diagnostics(self):
        worker = worker_fixtures.worker
        upstream = adapter.load_upstream(adapter.DEFAULT_REPO_ROOT)
        client = worker_fixtures.Client
        client.instances.clear()
        client.fail_disconnect = False
        async def hanging_status(_session):
            await asyncio.Event().wait()
        upstream.read_status = hanging_status
        source = io.StringIO('\n'.join(json.dumps(request) for request in [
            {"id": 1, "method": "connect", "args": {"address": "test"}},
            {"id": 2, "method": "status"}]) + '\n')
        messages = []
        with patch.object(upstream, "import_bleak", return_value=(client, None)):
            await worker.serve(upstream, source, messages.append, timeout=1.05)
        progress = [m["progress"] for m in messages if m.get("progress", {}).get("id") == 2]
        self.assertTrue(any(m["diagnostics"]["phase"] == "status" for m in progress))
        final = next(m for m in messages if m.get("id") == 2)
        self.assertEqual(final["diagnostics"]["failedPhase"], "status")
        self.assertEqual(final["diagnostics"]["outcome"], "failed")
        self.assertEqual(final["diagnostics"]["cleanup"], "succeeded")
        self.assertEqual(client.instances[-1].disconnects, 1)
