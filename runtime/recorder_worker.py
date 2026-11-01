"""Private line-delimited JSON transport for a single persistent BLE owner.

Upstream files remain pinned and unchanged. Logs go to stderr, never the wire.
Any failed device operation retires the session: late frames cannot affect retry.
"""
import argparse
import asyncio
import contextlib
import json
from pathlib import Path
import sys

from recorder_cli import (load_upstream, configure_runtime, require_dependency,
                          confirmed_list, confirmed_record, safe_import_file, ImportReport)


class Worker:
    def __init__(self, upstream, emit):
        self.upstream = upstream
        self.emit = emit
        self.session = None
        self.address = ""
        self.name = ""
        self.closing = False
        self.dropped = asyncio.Event()
        self.cleanup_error = None

    def state(self, status, **extra):
        return {"status": status, "name": self.name, **extra}

    async def disconnect(self):
        session, self.session = self.session, None
        # Never retry and reinterpret an upstream no-op as successful cleanup.
        if session is not None:
            try:
                await asyncio.wait_for(session.disconnect(), 5)
            except BaseException as error:
                self.cleanup_error = str(error) or type(error).__name__
                # Idle retirement has no request id to reply to. Send the same
                # sticky terminal warning even when finally is the only caller.
                self.emit({"event": self.state("cleanup-unconfirmed",
                    message="Connection release is unconfirmed: " + self.cleanup_error)})
                raise
        if self.cleanup_error is not None:
            return self.state("cleanup-unconfirmed", message="Connection release is unconfirmed: " + self.cleanup_error)
        return self.state("disconnected")

    async def connect(self, address=""):
        self.emit({"event": self.state("connecting")})
        if not address:
            found = await self.upstream.scan_devices()
            if len(found) != 1:
                return self.state("selection-required" if found else "not-found",
                                  devices=[{"address": a, "name": n} for a, n in found])
            address, self.name = found[0]
        self.address = address
        self.session = self.upstream.Session()
        # The pinned Session constructs BleakClient without a drop callback.
        # Supply it through that public constructor, before any connection begins.
        original_client = self.session.BleakClient
        def dropped(_client):
            if not self.closing:
                self.dropped.set()
                self.emit({"event": self.state("disconnected", message="设备连接已断开，请重新连接。")})
        self.session.BleakClient = lambda addr: original_client(addr, disconnected_callback=dropped)
        await self.session.connect(address)
        if not self.session.client.is_connected:
            raise RuntimeError("Device disconnected during connection setup")
        return self.state("connected", address=address)

    async def operation(self, method, args):
        if method == "connect":
            return await self.connect(args.get("address", ""))
        if method == "disconnect":
            self.closing = True
            return await self.disconnect()
        session = self.session
        if session is None or not session.client or not session.client.is_connected:
            raise RuntimeError("Device disconnected; connect again before retrying")
        # Drop unsolicited frames accumulated while idle. Failed transactions
        # always terminate this worker instead of reusing an ambiguous stream.
        while not session.events.empty():
            session.events.get_nowait()
        if method == "status":
            result = await self.upstream.read_status(session)
        elif method == "list":
            files = await confirmed_list(self.upstream, session)
            result = [{"index": i, "name": f.name, "size": f.size,
                       "durationOrTime": f.duration_or_time} for i, f in enumerate(files, 1)]
        elif method == "recordState":
            result = await self.upstream.read_record_state(session)
        elif method == "record":
            await confirmed_record(self.upstream, session, args["action"])
            result = await self.upstream.read_record_state(session)
        elif method == "importFirst":
            await self.upstream.read_status(session)
            files = await confirmed_list(self.upstream, session)
            if not files:
                raise RuntimeError("File list empty")
            report = ImportReport()
            await safe_import_file(self.upstream.import_file, session, files[0].name,
                                   Path(args["outDir"]), report)
            # Intentionally retained by Host, distinct from confirmed release.
            report.data["cleanup"] = {"status": "retained", "errors": []}
            return report.data
        else:
            raise RuntimeError("Unsupported worker method")
        return {"code": 0, "out": json.dumps(result, ensure_ascii=False), "err": ""}


async def until_drop(worker, operation):
    """Retire idle or busy work promptly; never publish success after a drop."""
    task = asyncio.create_task(operation)
    dropped = asyncio.create_task(worker.dropped.wait())
    try:
        await asyncio.wait((task, dropped), return_when=asyncio.FIRST_COMPLETED)
        if worker.dropped.is_set():
            raise RuntimeError("Device disconnected; session retired, operation outcome may be unknown")
        return await task
    finally:
        task.cancel()
        dropped.cancel()
        await asyncio.gather(task, dropped, return_exceptions=True)


async def serve(upstream, source, emit, timeout=180):
    worker = Worker(upstream, emit)
    try:
        while not worker.dropped.is_set():
            try:
                # Host closes stdin after the drop event, allowing the executor
                # thread to exit too; cancelling to_thread alone is insufficient.
                line = await until_drop(worker, asyncio.to_thread(source.readline))
            except RuntimeError:
                if worker.dropped.is_set():
                    break
                raise
            if not line:
                break
            request = json.loads(line)
            try:
                result = await until_drop(worker, asyncio.wait_for(
                    worker.operation(request["method"], request.get("args", {})), timeout))
                emit({"id": request["id"], "result": result})
                if request["method"] == "disconnect" or (request["method"] == "connect" and result["status"] != "connected"):
                    break
            except Exception as error:
                cleanup = (str(error) or type(error).__name__) if request["method"] == "disconnect" else None
                try:
                    worker.closing = True
                    await worker.disconnect()
                except BaseException as release:
                    cleanup = str(release) or type(release).__name__
                emit({"event": worker.state("disconnected" if cleanup is None else "cleanup-unconfirmed",
                    message="操作失败，连接已停止。" if cleanup is None else "Connection release is unconfirmed: " + cleanup)})
                emit({"id": request["id"], "error": str(error) or type(error).__name__, "cleanupError": cleanup})
                break
    finally:
        worker.closing = True
        await worker.disconnect()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--data-dir", type=Path, required=True)
    args = parser.parse_args()
    wire = sys.stdout
    def emit(value):
        wire.write(json.dumps(value, ensure_ascii=False) + "\n")
        wire.flush()
    with contextlib.redirect_stdout(sys.stderr):
        upstream = load_upstream(args.repo_root)
        require_dependency("bleak")
        configure_runtime(upstream, args.data_dir)
        args.data_dir.mkdir(parents=True, exist_ok=True)
        asyncio.run(serve(upstream, sys.stdin, emit))


if __name__ == "__main__":
    main()
