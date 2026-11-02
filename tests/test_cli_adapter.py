"""Offline regressions against bundled pinned sources; no BLE or cloud ASR."""
import asyncio
import contextlib
import importlib.util
import io
import json
import hashlib
import os
import struct
import wave
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ADAPTER_PATH = Path(__file__).resolve().parents[1] / "runtime/recorder_cli.py"
spec = importlib.util.spec_from_file_location("adapter", ADAPTER_PATH)
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


def frame(kind, command, body=b""):
    return ("ae22", SimpleNamespace(type=kind, cmd=command, params=body))


def payload(count=1):
    return count.to_bytes(4, "big") + b"\0" * (28 * count)


def pcm_audio(samples=b"\x00\x01\x02\x03"):
    content = io.BytesIO()
    with wave.open(content, "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(16000)
        stream.writeframes(samples)
    return content.getvalue()


class Session:
    def __init__(self, *frames):
        self.events = asyncio.Queue()
        for value in frames:
            self.events.put_nowait(value)
        self.writes = []
        self.closed = 0

    async def write_payload(self, value):
        self.writes.append(value)

    async def disconnect(self):
        self.closed += 1


def upstream():
    return SimpleNamespace(
        Session=Session,
        resolve_import_targets=lambda files, args: [],
        cmd_list_files=lambda: b"list",
        parse_file_list=lambda value: ["entry"] * int.from_bytes(value[:4], "big"),
        cmd_start_recording=lambda: b"start",
        cmd_pause_recording=lambda: b"pause",
        cmd_resume_recording=lambda: b"resume",
        cmd_save_recording=lambda: b"save",
    )


class ConfirmationTests(unittest.IsolatedAsyncioTestCase):
    def test_pinned_filename_selection_is_exact_and_does_not_import_all(self):
        module = adapter.load_upstream(adapter.DEFAULT_REPO_ROOT)
        adapter.install_guards(module)
        files = [SimpleNamespace(name="first.wav"), SimpleNamespace(name="second.wav")]
        args = SimpleNamespace(filename=["second.wav"], import_all=False, import_first=False)
        self.assertEqual(module.resolve_import_targets(files, args), ["second.wav"])
        for value in ["second", "SECOND.WAV", "missing.wav"]:
            args.filename = [value]
            with self.assertRaises(RuntimeError):
                module.resolve_import_targets(files, args)

    async def test_transfer_failure_report_distinguishes_connected_from_disconnected(self):
        for connected, code in [(True, "TRANSFER_INTERRUPTED"), (False, "DEVICE_DISCONNECTED")]:
            with self.subTest(connected=connected), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                session = SimpleNamespace(client=SimpleNamespace(is_connected=connected))
                report = adapter.ImportReport(root / "result.json")
                async def transfer(_session, _name, out):
                    (out / "test.wav").write_bytes(b"partial")
                    raise RuntimeError("simulated incomplete transfer")
                with self.assertRaises(adapter.TransferInterrupted):
                    await adapter.safe_import_file(transfer, session, "test.wav", root, report)
                saved = json.loads(report.path.read_text(encoding="utf-8"))
                self.assertEqual(saved["error"]["code"], code)
                self.assertIn("from the beginning", saved["error"]["message"])
                self.assertEqual(saved["imports"], [])
                self.assertEqual(list(root.iterdir()), [report.path])

    async def test_empty_list_requires_success_end(self):
        result = await adapter.confirmed_list(upstream(), Session(frame(2, 18, b"\0")))
        self.assertEqual(result, [])

    async def test_multiframe_list_accumulates_until_confirmed(self):
        session = Session(frame(2, 1, payload(2)), frame(0, 4, b"d"), frame(2, 1, payload()), frame(2, 18, b"\0"))
        self.assertEqual(len(await adapter.confirmed_list(upstream(), session)), 3)

    async def test_invalid_end_is_not_empty_list(self):
        for body in [b"", b"\x01"]:
            with self.subTest(body=body):
                with self.assertRaises(adapter.UnconfirmedResponse):
                    await adapter.confirmed_list(upstream(), Session(frame(2, 18, body)))

    async def test_no_response_is_not_empty_list(self):
        with self.assertRaisesRegex(adapter.UnconfirmedResponse, "0 entries remain incomplete"):
            await adapter.confirmed_list(upstream(), Session(), first_timeout=0.01)

    async def test_partial_list_and_late_end_cannot_complete_retry(self):
        session = Session(frame(2, 1, payload()))
        with self.assertRaisesRegex(adapter.UnconfirmedResponse, "1 entries remain incomplete"):
            await adapter.confirmed_list(upstream(), session, idle_timeout=0.01)
        session.events.put_nowait(frame(2, 18, b"\0"))
        with self.assertRaisesRegex(adapter.UnconfirmedResponse, "reconnect"):
            await adapter.confirmed_list(upstream(), session)
        self.assertEqual(len(session.writes), 1)
        self.assertEqual(await adapter.confirmed_list(upstream(), Session(frame(2, 18, b"\0"))), [])

    async def test_malformed_list_is_not_confirmed_by_later_end(self):
        for body in [b"", b"\0\0\0\x02" + b"\0" * 28, payload() + b"extra"]:
            with self.subTest(length=len(body)):
                with self.assertRaisesRegex(adapter.UnconfirmedResponse, "Malformed"):
                    await adapter.confirmed_list(upstream(), Session(frame(2, 1, body), frame(2, 18, b"\0")))

    async def test_unrelated_traffic_does_not_extend_timeout(self):
        session = Session()
        async def traffic():
            while True:
                session.events.put_nowait(frame(0, 4, b"d"))
                await asyncio.sleep(0)
        task = asyncio.create_task(traffic())
        try:
            with self.assertRaises(adapter.UnconfirmedResponse):
                await asyncio.wait_for(adapter.confirmed_list(upstream(), session, first_timeout=0.02), 0.5)
        finally:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    async def test_total_deadline_bounds_continuous_list_frames(self):
        session = Session()
        async def traffic():
            while True:
                session.events.put_nowait(frame(2, 1, payload(0)))
                await asyncio.sleep(0.001)
        task = asyncio.create_task(traffic())
        try:
            with self.assertRaises(adapter.UnconfirmedResponse):
                await asyncio.wait_for(adapter.confirmed_list(upstream(), session, idle_timeout=1, total_timeout=0.02), 0.5)
        finally:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    async def test_write_failure_prevents_retry(self):
        session = Session()
        async def fail(_):
            raise OSError("write failed")
        session.write_payload = fail
        with self.assertRaises(OSError):
            await adapter.confirmed_list(upstream(), session)
        with self.assertRaisesRegex(adapter.UnconfirmedResponse, "reconnect"):
            await adapter.confirmed_list(upstream(), session)

    async def test_all_record_actions_require_corresponding_success(self):
        for action, command in [("start", 2), ("save", 4), ("pause", 6), ("resume", 8)]:
            with self.subTest(action=action):
                session = Session(frame(3, 1, b"\1"), frame(3, command, b"\1"))
                await adapter.confirmed_record(upstream(), session, action)
                self.assertEqual(session.writes, [action.encode()])

    async def test_record_missing_negative_and_unknown_ack_fail(self):
        for body in [b"", b"\2", b"\0", b"\xff"]:
            with self.subTest(body=body):
                with self.assertRaises(adapter.UnconfirmedResponse):
                    await adapter.confirmed_record(upstream(), Session(frame(3, 2, body)), "start")

    async def test_hardware_event_or_state_is_not_command_ack(self):
        session = Session(frame(3, 1, b"\1"), frame(3, 20, b"\1"), frame(3, 4, b"\1"))
        with self.assertRaisesRegex(adapter.UnconfirmedResponse, "outcome unknown"):
            await adapter.confirmed_record(upstream(), session, "start", timeout=0.01)
        session.events.put_nowait(frame(3, 2, b"\1"))
        with self.assertRaisesRegex(adapter.UnconfirmedResponse, "reconnect"):
            await adapter.confirmed_record(upstream(), session, "start")
        self.assertEqual(len(session.writes), 1)

    async def test_invalid_action_does_not_write(self):
        session = Session()
        with self.assertRaises(ValueError):
            await adapter.confirmed_record(upstream(), session, "delete")
        self.assertEqual(session.writes, [])

    async def test_cancelled_list_marks_session_uncertain(self):
        session = Session()
        task = asyncio.create_task(adapter.confirmed_list(upstream(), session))
        await asyncio.sleep(0)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        with self.assertRaisesRegex(adapter.UnconfirmedResponse, "reconnect"):
            await adapter.confirmed_list(upstream(), session)


class LifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_setup_failure_releases_partial_session(self):
        module = upstream()
        sessions = []
        async def run(_):
            session = module.Session()
            sessions.append(session)
            raise RuntimeError("notify setup failed")
        module.run = run
        adapter.install_guards(module)
        with self.assertRaisesRegex(RuntimeError, "notify setup failed"):
            await module.run(None)
        self.assertEqual(sessions[0].closed, 1)

    async def test_operation_timeout_releases_session(self):
        module = upstream()
        sessions = []
        async def run(_):
            sessions.append(module.Session())
            await asyncio.Event().wait()
        module.run = run
        adapter.install_guards(module, operation_timeout=0.01)
        with self.assertRaises(asyncio.TimeoutError):
            await module.run(None)
        self.assertEqual(sessions[0].closed, 1)

    async def test_operation_cancellation_releases_session(self):
        module = upstream()
        sessions = []
        ready = asyncio.Event()
        async def run(_):
            sessions.append(module.Session())
            ready.set()
            await asyncio.Event().wait()
        module.run = run
        adapter.install_guards(module)
        task = asyncio.create_task(module.run(None))
        await ready.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(sessions[0].closed, 1)

    async def test_cleanup_failure_does_not_report_success(self):
        module = upstream()
        async def run(_):
            session = module.Session()
            async def fail():
                raise OSError("disconnect failed")
            session.disconnect = fail
            return 0
        module.run = run
        adapter.install_guards(module)
        with self.assertRaisesRegex(RuntimeError, "cleanup failed"):
            await module.run(None)

    async def test_cleanup_error_does_not_replace_primary(self):
        module = upstream()
        async def run(_):
            session = module.Session()
            async def fail():
                raise OSError("disconnect failed")
            session.disconnect = fail
            raise RuntimeError("original operation failed")
        module.run = run
        adapter.install_guards(module)
        with self.assertRaisesRegex(RuntimeError, "original operation failed"):
            await module.run(None)

    async def test_hung_cleanup_is_bounded(self):
        module = upstream()
        async def run(_):
            session = module.Session()
            session.disconnect = asyncio.Event().wait
            return 0
        module.run = run
        adapter.install_guards(module, cleanup_timeout=0.01)
        with self.assertRaisesRegex(RuntimeError, "cleanup failed"):
            await asyncio.wait_for(module.run(None), 0.5)


class DisconnectHistoryTests(unittest.IsolatedAsyncioTestCase):
    def session_class(self):
        class ClearingSession(Session):
            def __init__(self):
                super().__init__()
                self.client = None

            async def disconnect(self):
                if self.client is None:
                    return
                try:
                    await self.client.disconnect()
                finally:
                    self.client = None
        return ClearingSession

    async def test_first_failure_survives_later_noop_and_transcription_error(self):
        for outcome in ("propagate", "swallow", "transcription"):
            with self.subTest(outcome=outcome), tempfile.TemporaryDirectory() as directory:
                module = upstream()
                module.Session = self.session_class()
                report_path = Path(directory) / "report.json"
                report = adapter.ImportReport(report_path)
                attempts = []
                sessions = []

                async def fail():
                    attempts.append("disconnect")
                    raise OSError("first disconnect failed")

                async def run(_):
                    session = module.Session()
                    sessions.append(session)
                    session.client = SimpleNamespace(is_connected=True, disconnect=fail)
                    try:
                        if outcome == "transcription":
                            report.data["transcriptions"].append({"status": "failed", "exitCode": 7,
                                "error": {"code": "TRANSCRIPTION_FAILED", "message": "quota"}})
                            raise RuntimeError("transcription failed")
                    finally:
                        try:
                            await session.disconnect()
                        except OSError:
                            if outcome != "swallow":
                                raise

                module.run = run
                adapter.install_guards(module, report=report)
                with self.assertRaisesRegex((OSError, RuntimeError), "disconnect failed|cleanup failed"):
                    await module.run(None)
                self.assertIsNone(sessions[0].client)
                self.assertEqual(attempts, ["disconnect"])
                result = json.loads(report_path.read_text(encoding="utf-8"))
                self.assertEqual(result["cleanup"]["status"], "unconfirmed")
                self.assertEqual(len(result["cleanup"]["errors"]), 1)
                self.assertIn("first disconnect failed", result["cleanup"]["errors"][0]["message"])
                if outcome == "transcription":
                    self.assertEqual(result["transcriptions"][0]["error"]["code"], "TRANSCRIPTION_FAILED")

    async def test_successful_first_disconnect_remains_confirmed(self):
        module = upstream()
        module.Session = self.session_class()
        report = adapter.ImportReport()
        attempts = []
        client = SimpleNamespace(is_connected=True)

        async def disconnect():
            attempts.append("disconnect")
            client.is_connected = False

        async def run(_):
            session = module.Session()
            client.disconnect = disconnect
            session.client = client
            await session.disconnect()
            return 0

        module.run = run
        adapter.install_guards(module, report=report)
        self.assertEqual(await module.run(None), 0)
        self.assertEqual(attempts, ["disconnect"])
        self.assertEqual(report.data["cleanup"], {"status": "succeeded", "errors": []})

    async def test_cancelled_first_disconnect_cannot_be_confirmed_by_noop(self):
        module = upstream()
        module.Session = self.session_class()
        report = adapter.ImportReport()
        sessions = []

        async def run(_):
            session = module.Session()
            sessions.append(session)
            session.client = SimpleNamespace(is_connected=True, disconnect=asyncio.Event().wait)
            await session.disconnect()

        module.run = run
        adapter.install_guards(module, report=report, operation_timeout=0.02, cleanup_timeout=0.2)
        with self.assertRaises(asyncio.TimeoutError):
            await module.run(None)
        self.assertIsNone(sessions[0].client)
        self.assertEqual(report.data["cleanup"]["status"], "unconfirmed")
        self.assertEqual(len(report.data["cleanup"]["errors"]), 1)


class PinnedSessionDisconnectTests(DisconnectHistoryTests):
    def session_class(self):
        root = Path(os.environ.get("RECORDER_UPSTREAM_ROOT", adapter.DEFAULT_REPO_ROOT))
        module = adapter.load_upstream(root)  # Verifies both pinned source hashes.
        # Keep the actual Session implementation; replace only its hardware factory.
        module.import_bleak = lambda: (None, None)
        return module.Session


class SafeImportTests(unittest.IsolatedAsyncioTestCase):
    async def test_collision_preserves_original_and_publishes_complete_unique_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            existing = root / "record.wav"
            existing.write_bytes(b"original audio")
            report = adapter.ImportReport(root / "result.json")
            async def unsafe_import(_session, _name, out):
                target = out / "record.wav"
                target.write_bytes(pcm_audio())
                return target
            first = await adapter.safe_import_file(unsafe_import, None, "record.wav", root, report)
            second = await adapter.safe_import_file(unsafe_import, None, "record.wav", root, report)
            self.assertEqual(existing.read_bytes(), b"original audio")
            self.assertNotEqual(first, second)
            self.assertEqual(first.read_bytes(), pcm_audio())
            self.assertEqual(second.read_bytes(), pcm_audio())
            self.assertFalse(list(root.glob(".recorder-import-*")))
            data = json.loads((root / "result.json").read_text(encoding="utf-8"))
            self.assertEqual(data["imports"][0]["sha256"], hashlib.sha256(pcm_audio()).hexdigest())

    async def test_atomic_publish_handles_destination_created_at_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            async def download(_session, _name, out):
                (out / "record.wav").write_bytes(pcm_audio())
                return out / "record.wav"
            original_link = os.link
            raced = False
            def race(source, target):
                nonlocal raced
                if not raced:
                    raced = True
                    target.write_bytes(b"concurrent valid audio")
                return original_link(source, target)
            with patch.object(adapter.os, "link", side_effect=race):
                target = await adapter.safe_import_file(download, None, "record.wav", root, adapter.ImportReport())
            self.assertEqual((root / "record.wav").read_bytes(), b"concurrent valid audio")
            self.assertEqual(target.read_bytes(), pcm_audio())

    async def test_failure_never_exposes_staged_file_or_overwrites_existing_audio(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "record.wav").write_bytes(b"valid")
            async def failed(_session, _name, out):
                (out / "record.wav").write_bytes(b"partial")
                raise RuntimeError("transfer incomplete")
            report = adapter.ImportReport()
            with self.assertRaisesRegex(RuntimeError, "incomplete"):
                await adapter.safe_import_file(failed, None, "record.wav", root, report)
            self.assertEqual(list(root.iterdir()), [root / "record.wav"])
            self.assertEqual((root / "record.wav").read_bytes(), b"valid")
            self.assertEqual(report.data["imports"], [])

    async def test_cancel_cleans_staging_without_touching_existing_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "record.wav").write_bytes(b"valid")
            ready = asyncio.Event()
            async def stalled(_session, _name, out):
                (out / "record.wav").write_bytes(b"partial")
                ready.set()
                await asyncio.Event().wait()
            task = asyncio.create_task(adapter.safe_import_file(stalled, None, "record.wav", root, adapter.ImportReport()))
            await ready.wait()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertEqual(list(root.iterdir()), [root / "record.wav"])
            self.assertEqual((root / "record.wav").read_bytes(), b"valid")

    async def test_empty_file_and_unsupported_atomic_publication_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            async def empty(_session, _name, out):
                (out / "record.wav").touch()
                return out / "record.wav"
            with self.assertRaisesRegex(RuntimeError, "without audio"):
                await adapter.safe_import_file(empty, None, "record.wav", root, adapter.ImportReport())
            async def complete(_session, _name, out):
                (out / "record.wav").write_bytes(pcm_audio())
                return out / "record.wav"
            with patch.object(adapter.os, "link", side_effect=OSError("hard links unavailable")):
                with self.assertRaisesRegex(OSError, "hard links unavailable"):
                    await adapter.safe_import_file(complete, None, "record.wav", root, adapter.ImportReport())
            self.assertEqual(list(root.iterdir()), [])

    async def test_installed_guard_routes_upstream_import_to_safe_publication(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "record.wav").write_bytes(b"original")
            module = upstream()
            async def download(_session, _name, out):
                (out / "record.wav").write_bytes(pcm_audio())
                return out / "record.wav"
            module.import_file = download
            async def run(_):
                return await module.import_file(module.Session(), "record.wav", root)
            module.run = run
            adapter.install_guards(module)
            target = await module.run(None)
            self.assertNotEqual(target, root / "record.wav")
            self.assertEqual((root / "record.wav").read_bytes(), b"original")


class IntegrityTests(unittest.IsolatedAsyncioTestCase):
    async def test_truncated_declared_riff_length_is_not_published_or_transcribed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = root / "test.wav"
            original.write_bytes(pcm_audio())
            module = upstream()
            async def incomplete(_session, _name, staging):
                path = staging / "test.wav"
                path.write_bytes(b"RIFF" + struct.pack("<I", 1000) + b"WAVE")
                return path
            module.import_file = incomplete
            called = []
            async def run(_):
                path = await module.import_file(module.Session(), "test.wav", root)
                called.append(path)  # Would start post-import transcription.
            module.run = run
            report = adapter.ImportReport(root / "report.json")
            adapter.install_guards(module, report=report)
            with self.assertRaisesRegex(RuntimeError, "Audio integrity unconfirmed"):
                await module.run(None)
            self.assertEqual(called, [])
            self.assertEqual(original.read_bytes(), pcm_audio())
            self.assertEqual(report.data["imports"], [])
            self.assertFalse(list(root.glob(".recorder-import-*")))

    def test_valid_pcm_and_metadata_chunks_are_verified(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "test.wav"
            valid = pcm_audio()
            path.write_bytes(valid)
            result = adapter.validate_audio(path)
            self.assertEqual(result, {"status": "verified", "format": "wav-pcm", "channels": 1,
                                      "sampleRate": 16000, "bitsPerSample": 16, "frames": 2})
            # Odd-length metadata chunk must have its padding byte.
            extra = b"JUNK" + struct.pack("<I", 1) + b"x\0"
            data = valid[:12] + extra + valid[12:]
            data = data[:4] + struct.pack("<I", len(data) - 8) + data[8:]
            path.write_bytes(data)
            self.assertEqual(adapter.validate_audio(path), result)

    def test_bad_chunks_pcm_fields_and_unknown_formats_remain_unconfirmed(self):
        valid = pcm_audio()
        def change(offset, value):
            return valid[:offset] + value + valid[offset + len(value):]
        cases = [
            valid[:-2], valid + b"trailing",
            change(40, struct.pack("<I", 100)),
            change(32, struct.pack("<H", 1)),  # Invalid block alignment.
            change(28, struct.pack("<I", 1)),  # Invalid byte rate.
            change(20, struct.pack("<H", 3)),  # Float encoding not supported.
            b"OggSunknown-content",
        ]
        # Internally consistent RIFF size, but sample data ends inside a frame.
        partial = valid[:-1]
        partial = partial[:4] + struct.pack("<I", len(valid) - 8) + partial[8:40] + struct.pack("<I", 3) + partial[44:] + b"\0"
        cases.append(partial)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "test.wav"
            for index, data in enumerate(cases):
                with self.subTest(index=index):
                    path.write_bytes(data)
                    with self.assertRaisesRegex(RuntimeError, "Audio integrity unconfirmed"):
                        adapter.validate_audio(path)

    async def test_primary_and_cleanup_failures_are_both_persisted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            module = upstream()
            report = adapter.ImportReport(root / "report.json")
            async def run(_):
                session = module.Session()
                async def fail():
                    raise OSError("simulated disconnect failure")
                session.disconnect = fail
                report.data["transcriptions"].append({"status": "failed", "exitCode": 7,
                    "error": {"code": "TRANSCRIPTION_FAILED", "message": "quota"}})
                raise RuntimeError("transcription failed")
            module.run = run
            adapter.install_guards(module, report=report)
            with self.assertRaisesRegex(RuntimeError, "transcription failed"):
                await module.run(None)
            data = json.loads((root / "report.json").read_text(encoding="utf-8"))
            self.assertEqual(data["transcriptions"][0]["status"], "failed")
            self.assertEqual(data["cleanup"]["status"], "unconfirmed")
            self.assertIn("disconnect failure", data["cleanup"]["errors"][0]["message"])


class TranscriptionTests(unittest.TestCase):
    def test_real_subprocess_failure_records_separate_result_and_retains_audio(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "tools").mkdir()
            (root / "tools/qs668-transcribe.py").write_text("import sys; print('quota failure', file=sys.stderr); sys.exit(9)")
            audio = root / "test.wav"
            audio.write_bytes(b"retained audio")
            report = adapter.ImportReport(root / "result.json")
            report.data["imports"].append({"status": "succeeded", "path": str(audio)})
            run_process = subprocess.run
            def simulated_transcriber(command, **options):
                self.assertIn("--transcribe-file", command)
                self.assertIn("--data-dir", command)
                return run_process([sys.executable, str(root / "tools/qs668-transcribe.py")], **options)
            with patch.object(adapter.subprocess, "run", side_effect=simulated_transcriber):
                with self.assertRaisesRegex(RuntimeError, "audio retained"):
                    adapter.checked_transcription(SimpleNamespace(ROOT=root, TOOLS_DIR=root / "tools"), audio, SimpleNamespace(), report)
            data = json.loads((root / "result.json").read_text(encoding="utf-8"))
            self.assertEqual(data["imports"][0]["status"], "succeeded")
            self.assertEqual(data["transcriptions"][0]["status"], "failed")
            self.assertEqual(data["transcriptions"][0]["exitCode"], 9)
            self.assertIn("quota failure", data["transcriptions"][0]["error"]["message"])
            self.assertEqual(audio.read_bytes(), b"retained audio")

    def test_success_timeout_and_spawn_errors_are_explicit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            module = SimpleNamespace(ROOT=root, TOOLS_DIR=root / "tools")
            for result, expected in [
                (SimpleNamespace(returncode=0, stdout="ok", stderr=""), "succeeded"),
                (subprocess.TimeoutExpired("test", 1), "failed"),
                (OSError("missing interpreter"), "failed"),
            ]:
                report = adapter.ImportReport()
                with patch.object(adapter.subprocess, "run") as run:
                    if isinstance(result, Exception): run.side_effect = result
                    else: run.return_value = result
                    if expected == "failed":
                        with self.assertRaises(RuntimeError):
                            adapter.checked_transcription(module, root / "audio.wav", SimpleNamespace(), report)
                    else:
                        adapter.checked_transcription(module, root / "audio.wav", SimpleNamespace(), report)
                self.assertEqual(report.data["transcriptions"][0]["status"], expected)


class BundledRuntimeTests(unittest.IsolatedAsyncioTestCase):
    def test_default_sources_work_from_unrelated_directory_without_python_packages(self):
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run([sys.executable, "-S", "-B", str(ADAPTER_PATH), "--", "--help"],
                                    cwd=directory, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("--scan", result.stdout)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_missing_dependencies_name_same_interpreter_install_command(self):
        with tempfile.TemporaryDirectory() as directory:
            data_dir = Path(directory) / "data"
            for args, dependency in [(["--", "--scan"], "bleak"),
                                     (["--transcribe-file", "synthetic.wav"], "requests")]:
                with self.subTest(dependency=dependency):
                    result = subprocess.run([sys.executable, "-S", "-B", str(ADAPTER_PATH),
                        "--data-dir", str(data_dir), *args], cwd=directory, capture_output=True, text=True)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(dependency, result.stderr)
                    self.assertIn("-m pip install bleak requests", result.stderr)
                    self.assertFalse(data_dir.exists())

    def test_source_override_does_not_change_data_or_credentials_location(self):
        module = adapter.load_upstream(adapter.DEFAULT_REPO_ROOT)
        with tempfile.TemporaryDirectory() as directory:
            data_dir = Path(directory)
            adapter.configure_runtime(module, data_dir)
            module.write_cached_address("synthetic-device")
            self.assertEqual((data_dir / ".qs668-device").read_text().strip(), "synthetic-device")
            self.assertEqual(module.DEFAULT_OUT, data_dir / "archive/audio")
            self.assertEqual(module.TOOLS_DIR, adapter.DEFAULT_REPO_ROOT / "tools")
            with patch.dict(sys.modules, {"requests": SimpleNamespace()}):
                transcriber = adapter.load_transcriber(adapter.DEFAULT_REPO_ROOT)
            adapter.configure_runtime(transcriber, data_dir)
            self.assertEqual(transcriber.ENV_FILE, data_dir / ".env")
            self.assertEqual(transcriber.DEFAULT_CORPUS_DIR, data_dir / "archive/corpus")

    def test_sources_cannot_be_used_as_data_directory(self):
        with contextlib.redirect_stderr(io.StringIO()) as stderr:
            code = adapter.main(["--data-dir", str(adapter.DEFAULT_REPO_ROOT), "--", "--scan"])
        self.assertEqual(code, 1)
        self.assertIn("outside the CLI source", stderr.getvalue())

    async def test_actual_bundled_import_preserves_existing_audio_and_rejects_truncation(self):
        module = adapter.load_upstream(adapter.DEFAULT_REPO_ROOT)
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            name = "test.wav"
            old = out / f"{module.stem_from_name(name)}.wav"
            old.write_bytes(b"existing audio")
            for data, valid in [(pcm_audio(), True), (b"RIFF" + struct.pack("<I", 1000) + b"WAVE", False)]:
                report = adapter.ImportReport()
                session = Session(frame(2, 3, name.encode()), frame(2, 4, data), frame(2, 5, b"\0"))
                session.seq = 0
                if valid:
                    path = await adapter.safe_import_file(module.import_file, session, name, out, report)
                    self.assertEqual(path.read_bytes(), data)
                    self.assertNotEqual(path, old)
                    self.assertEqual(report.data["imports"][0]["integrity"]["status"], "verified")
                else:
                    with self.assertRaisesRegex(RuntimeError, "integrity unconfirmed"):
                        await adapter.safe_import_file(module.import_file, session, name, out, report)
                    self.assertEqual(report.data["imports"], [])
                self.assertEqual(old.read_bytes(), b"existing audio")
            self.assertFalse(list(out.glob(".recorder-import-*")))


class SourceValidationTests(unittest.TestCase):
    def test_unknown_source_rejected_before_execution(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "tools").mkdir()
            (root / "tools/qs668-bringup.py").write_text("raise Exception('MUST NOT EXECUTE')")
            result = subprocess.run([sys.executable, str(ADAPTER_PATH), "--repo-root", str(root), "--", "--scan"], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Unsupported upstream source", result.stderr)
            self.assertNotIn("MUST NOT EXECUTE", result.stderr)

    def test_missing_source_is_actionable_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(RuntimeError, "Missing upstream source"):
                adapter.load_upstream(Path(tmp))

    def test_invalid_total_timeout_rejected_before_import(self):
        for value in ["0", "-1", "nan", "inf"]:
            with self.subTest(value=value), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as error:
                    adapter.main(["--repo-root", ".", "--timeout", value, "--", "--scan"])
                self.assertEqual(error.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
