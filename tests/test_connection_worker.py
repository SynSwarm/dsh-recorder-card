"""Exercise the pinned upstream Session with simulated Bleak, no radio access."""
import asyncio
import io
import json
import queue
import tempfile
import wave
from pathlib import Path
from types import SimpleNamespace
import sys
import unittest
from unittest.mock import patch, AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runtime"))
import recorder_worker as worker
from recorder_cli import load_upstream, DEFAULT_REPO_ROOT


class Client:
    instances = []
    fail_disconnect = False

    def __init__(self, address, disconnected_callback=None):
        self.address = address
        self.drop = disconnected_callback
        self.is_connected = False
        self.disconnects = 0
        self.__class__.instances.append(self)

    async def connect(self):
        self.is_connected = True

    async def start_notify(self, _uuid, _callback):
        pass

    async def disconnect(self):
        self.disconnects += 1
        if self.fail_disconnect:
            raise RuntimeError("first disconnect failed")
        self.is_connected = False
        self.drop(self)


class ConnectionWorkerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        Client.instances.clear()
        Client.fail_disconnect = False
        self.upstream = load_upstream(DEFAULT_REPO_ROOT)
        self.patcher = patch.object(self.upstream, "import_bleak", return_value=(Client, None))
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    async def test_named_import_reuses_session_and_publishes_only_selected_audio(self):
        owner = worker.Worker(self.upstream, lambda _: None)
        await owner.connect("test")
        self.addAsyncCleanup(owner.disconnect)
        session = owner.session
        audio = io.BytesIO()
        with wave.open(audio, "wb") as stream:
            stream.setnchannels(1)
            stream.setsampwidth(2)
            stream.setframerate(16000)
            stream.writeframes(b"\x01\x02" * 20)
        requested = []
        async def write(_uuid, data, response):
            self.assertEqual(len(data), 36)
            frame = self.upstream.FrameParser().push(data)[0]
            requested.append(frame.params[4:].rstrip(b"\0").decode())
            for cmd, body in [(3, b"second.wav"), (4, audio.getvalue()), (5, b"\0")]:
                session._on_ae22(0, self.upstream.build_frame(bytes([2, cmd]) + body, cmd))
        Client.instances[0].write_gatt_char = write
        files = [SimpleNamespace(name="first.wav"), SimpleNamespace(name="second.wav")]
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(self.upstream, "read_status", AsyncMock()), \
                patch.object(worker, "confirmed_list", AsyncMock(return_value=files)):
            for _ in range(2):
                result = await owner.operation("importFile", {"filename": "second.wav", "outDir": directory})
                self.assertEqual(result["cleanup"]["status"], "retained")
                self.assertEqual(Path(result["imports"][0]["path"]).read_bytes(), audio.getvalue())
            self.assertEqual(len(list(Path(directory).glob("*.wav"))), 2)
            for filename in ["missing.wav", "SECOND.WAV", "second", "../second.wav", "first.wav,second.wav"]:
                with self.assertRaises((RuntimeError, ValueError)):
                    await owner.operation("importFile", {"filename": filename, "outDir": directory})
        self.assertEqual(requested, ["second.wav", "second.wav"])
        self.assertIs(owner.session, session)
        self.assertEqual(len(Client.instances), 1)
        self.assertEqual(Client.instances[0].disconnects, 0)

    async def test_import_drop_reports_typed_failure_and_no_published_audio(self):
        async def interrupted(session, _name, out):
            (out / "partial.wav").write_bytes(b"partial")
            client = Client.instances[0]
            client.is_connected = False
            client.drop(client)
            await asyncio.Event().wait()
        source = io.StringIO('\n'.join(json.dumps(value) for value in [
            {"id": 1, "method": "connect", "args": {"address": "test"}},
            {"id": 2, "method": "importFile", "args": {"filename": "test.wav", "outDir": "unused"}}]) + '\n')
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(self.upstream, "read_status", AsyncMock()), \
                patch.object(worker, "confirmed_list", AsyncMock(return_value=[SimpleNamespace(name="test.wav")])), \
                patch.object(self.upstream, "import_file", interrupted):
            source = io.StringIO(source.getvalue().replace('"unused"', json.dumps(directory)))
            results = []
            await worker.serve(self.upstream, source, results.append)
            failed = next(value for value in results if value.get("id") == 2)
            self.assertEqual(failed["errorCode"], "DEVICE_DISCONNECTED")
            self.assertNotIn("result", failed)
            self.assertEqual(list(Path(directory).iterdir()), [])

    async def test_persistent_session_and_drop_callback(self):
        events = []
        owner = worker.Worker(self.upstream, events.append)
        result = await owner.operation("connect", {"address": "test"})
        self.assertEqual(result["status"], "connected")
        client = Client.instances[0]
        self.assertEqual(client.disconnects, 0)
        client.is_connected = False
        client.drop(client)
        self.assertEqual(events[-1]["event"]["status"], "disconnected")
        with self.assertRaisesRegex(RuntimeError, "disconnected"):
            await owner.operation("list", {})
        await owner.disconnect()

    async def test_multiple_candidates_do_not_connect(self):
        async def scan():
            return [("test-a", "A"), ("test-b", "B")]
        with patch.object(self.upstream, "scan_devices", scan):
            result = await worker.Worker(self.upstream, lambda _: None).operation("connect", {})
        self.assertEqual(result["status"], "selection-required")
        self.assertEqual(len(result["devices"]), 2)
        self.assertEqual(Client.instances, [])

    async def test_first_disconnect_failure_survives_upstream_clearing_client(self):
        Client.fail_disconnect = True
        source = io.StringIO('\n'.join(json.dumps(value) for value in [
            {"id": 1, "method": "connect", "args": {"address": "test"}},
            {"id": 2, "method": "disconnect"}]) + '\n')
        results = []
        await worker.serve(self.upstream, source, results.append)
        failure = next(item for item in results if item.get("id") == 2)
        self.assertIn("first disconnect failed", failure["cleanupError"])
        self.assertNotIn("result", failure)
        self.assertEqual(Client.instances[0].disconnects, 1)

    async def test_operation_failure_closes_and_never_accepts_next_request(self):
        source = io.StringIO('\n'.join(json.dumps(value) for value in [
            {"id": 1, "method": "connect", "args": {"address": "test"}},
            {"id": 2, "method": "invalid"}, {"id": 3, "method": "list"}]) + '\n')
        results = []
        await worker.serve(self.upstream, source, results.append)
        self.assertIn("error", next(item for item in results if item.get("id") == 2))
        self.assertFalse(any(item.get("id") == 3 for item in results))
        self.assertEqual(Client.instances[0].disconnects, 1)

    async def test_eof_releases_session(self):
        source = io.StringIO(json.dumps({"id": 1, "method": "connect", "args": {"address": "test"}}) + '\n')
        await worker.serve(self.upstream, source, lambda _: None)
        self.assertEqual(Client.instances[0].disconnects, 1)

    async def test_idle_drop_retires_session_and_stdin_thread(self):
        lines = queue.Queue()
        lines.put(json.dumps({"id": 1, "method": "connect", "args": {"address": "test"}}) + '\n')
        class Source:
            def readline(self):
                return lines.get(timeout=2)
        results = []
        def drop():
            client = Client.instances[0]
            client.is_connected = False
            client.drop(client)
        def emit(value):
            results.append(value)
            if value.get("id") == 1:
                asyncio.get_running_loop().call_later(0.01, drop)
            if value.get("event", {}).get("status") == "disconnected":
                lines.put("")  # Host ends stdin on the disconnected event.
        await asyncio.wait_for(worker.serve(self.upstream, Source(), emit), 1)
        self.assertEqual(results[-1]["event"]["status"], "disconnected")

    async def test_idle_drop_cleanup_failure_is_sent_on_wire_before_exit(self):
        Client.fail_disconnect = True
        lines = queue.Queue()
        lines.put(json.dumps({"id": 1, "method": "connect", "args": {"address": "test"}}) + '\n')
        class Source:
            def readline(self):
                return lines.get(timeout=2)
        results = []
        def emit(value):
            results.append(value)
            if value.get("id") == 1:
                client = Client.instances[0]
                # Simulate a drop notification followed by failing cleanup.
                asyncio.get_running_loop().call_later(0.01, client.drop, client)
            if value.get("event", {}).get("status") == "disconnected":
                lines.put("")
        with self.assertRaisesRegex(RuntimeError, "first disconnect failed"):
            await asyncio.wait_for(worker.serve(self.upstream, Source(), emit), 1)
        self.assertEqual(results[-1]["event"]["status"], "cleanup-unconfirmed")
        self.assertIn("first disconnect failed", results[-1]["event"]["message"])
        self.assertEqual(Client.instances[0].disconnects, 1)

    async def test_busy_drop_cancels_operation_and_preserves_cleanup_failure(self):
        Client.fail_disconnect = True
        cancelled = []
        async def status(_session):
            # Keep is_connected true to simulate release failure after notification.
            client = Client.instances[0]
            asyncio.get_running_loop().call_soon(client.drop, client)
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.append(True)
        source = io.StringIO('\n'.join(json.dumps(value) for value in [
            {"id": 1, "method": "connect", "args": {"address": "test"}},
            {"id": 2, "method": "status"}, {"id": 3, "method": "list"}]) + '\n')
        results = []
        with patch.object(self.upstream, "read_status", status):
            await asyncio.wait_for(worker.serve(self.upstream, source, results.append), 1)
        failure = next(item for item in results if item.get("id") == 2)
        self.assertIn("Device disconnected", failure["error"])
        self.assertIn("first disconnect failed", failure["cleanupError"])
        self.assertEqual(cancelled, [True])
        self.assertFalse(any(item.get("id") == 3 for item in results))


if __name__ == "__main__":
    unittest.main()
