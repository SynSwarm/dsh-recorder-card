"""Real worker transport and pinned Session, fake Bluetooth only."""
import asyncio
import contextlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "runtime"))
from recorder_cli import load_upstream, DEFAULT_REPO_ROOT
from recorder_worker import serve


class Client:
    def __init__(self, address, disconnected_callback):
        self.callback = disconnected_callback
        self.is_connected = False

    async def connect(self):
        self.is_connected = True
        asyncio.get_running_loop().call_later(0.3, self.drop)

    async def start_notify(self, *_args):
        pass

    def drop(self):
        self.is_connected = "--cleanup-fail" in sys.argv
        self.callback(self)

    async def disconnect(self):
        if "--cleanup-fail" in sys.argv:
            raise RuntimeError("idle cleanup failed")
        self.is_connected = False


wire = sys.stdout
def emit(value):
    wire.write(json.dumps(value) + "\n")
    wire.flush()


async def status(_session):
    await asyncio.Event().wait()  # Drop must interrupt this, not wait for timeout.


with contextlib.redirect_stdout(sys.stderr):
    upstream = load_upstream(DEFAULT_REPO_ROOT)
    upstream.import_bleak = lambda: (Client, None)
    upstream.read_status = status
    asyncio.run(serve(upstream, sys.stdin, emit))
