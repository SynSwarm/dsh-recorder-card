#!/usr/bin/env python3
"""Confirmed-response adapter for the bundled, pinned QS668 CLI.

See skill/references/runtime.md for setup and developer source overrides.
Protocol behavior follows NextProto, Copyright (c) 2026 NextProto (MIT).
Full upstream notice: ../vendor/LICENSE
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import hashlib
import importlib.util
import importlib
import math
import json
import os
import subprocess
import struct
import tempfile
import uuid
from pathlib import Path
import sys
import time

UPSTREAM_COMMIT = "de42d1fbf19fc92064ac4688f71f42730c82267f"
SOURCE_HASHES = {
    "tools/qs668-bringup.py": "6cc048293781a0fb2baa40d5c05f6c4fad7e3ae0ef847289b08b5a2a21707efb",
    "tools/qs668_protocol.py": "c18c7a846dfa7aa9714f08fe219e21a2e4e02bdb03b6125409e97b10baa41cb8",
}
TRANSCRIBE_HASH = "83300e08465371f8ca8c288e07f54b4808100a6c6b91c72207f1f404dc8af1da"
DEFAULT_REPO_ROOT = Path(__file__).resolve().parents[1] / "vendor" / "upstream"
DEFAULT_DATA_DIR = Path.home() / ".dsh-recorder-card"
# Source trees may be read-only. Never create Python caches beside bundled code.
sys.dont_write_bytecode = True


def require_dependency(name):
    try:
        return importlib.import_module(name)
    except ImportError as error:
        raise RuntimeError(f"Python dependency {name!r} is missing or broken. "
                           f'Run "{sys.executable}" -m pip install bleak requests '
                           "using the same interpreter configured in the plugin's python field.") from error


def configure_runtime(module, data_dir):
    module.ROOT = data_dir
    module.DEFAULT_OUT = data_dir / "archive" / "audio"
    module.DEFAULT_AUDIO_DIR = module.DEFAULT_OUT
    module.DEFAULT_CORPUS_DIR = data_dir / "archive" / "corpus"
    module.DEVICE_CACHE = data_dir / ".qs668-device"
    module.ENV_FILE = data_dir / ".env"


def load_transcriber(repo_root):
    path = repo_root / "tools" / "qs668-transcribe.py"
    if hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest() != TRANSCRIBE_HASH:
        raise RuntimeError(f"Unsupported upstream transcription source; expected {UPSTREAM_COMMIT}")
    require_dependency("requests")
    spec = importlib.util.spec_from_file_location("recorder_transcriber", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # Required by upstream dataclass declarations.
    spec.loader.exec_module(module)
    return module


class UnconfirmedResponse(RuntimeError):
    """The device may have acted; do not retry blindly on this connection."""


class TransferInterrupted(RuntimeError):
    def __init__(self, message, *, disconnected=False):
        self.code = "DEVICE_DISCONNECTED" if disconnected else "TRANSFER_INTERRUPTED"
        super().__init__(message + "; reconnect and explicitly retry this file from the beginning (no resume)")


class Diagnostics:
    """Bounded metadata only. Durations use a monotonic clock; nested stages overlap."""

    def __init__(self, operation, *, clock=time.monotonic):
        self.clock = clock
        self.started = clock()
        self.active = []
        self.times = {}
        self.values = {"version": 1, "operation": operation, "phase": "starting", "outcome": "running",
                       "bytesReceived": 0, "dataFrames": 0, "attempts": 0, "cleanup": "pending"}
        self.transferring = False

    def elapsed(self):
        return max(0, round((self.clock() - self.started) * 1000))

    def fail(self, error):
        self.values.setdefault("failedPhase", self.active[-1][0] if self.active else self.values["phase"])
        self.values["outcome"] = "cancelled" if isinstance(error, asyncio.CancelledError) else "failed"

    @contextlib.contextmanager
    def stage(self, name):
        start = self.clock()
        self.active.append((name, start))
        self.values["phase"] = name
        try:
            yield
        except BaseException as error:
            self.fail(error)
            raise
        finally:
            self.times[name + "Ms"] = self.times.get(name + "Ms", 0) + max(0, round((self.clock() - start) * 1000))
            self.active.pop()
            if self.active:
                self.values["phase"] = self.active[-1][0]

    def frame(self, item):
        _source, frame = item
        if not self.transferring or frame.type != 2 or frame.cmd not in (3, 4, 5):
            return
        now = self.elapsed()
        self.values.setdefault("firstFrameMs", now)
        if frame.cmd == 4:
            self.values.setdefault("firstDataMs", now)
            self.values["lastDataMs"] = now
            self.values["bytesReceived"] += len(frame.params)
            self.values["dataFrames"] += 1
        elif frame.cmd == 5:
            self.values["endFrameMs"] = now
            self.values["endCode"] = frame.params[0] if frame.params else 3
            self.transferring = False

    def attach(self, session):
        """Observe existing writes and parsed-frame enqueue; never consume/reorder frames."""
        original_write, original_put = session.write_payload, session.events.put_nowait
        async def write(payload):
            if payload[:2] != b"\x02\x02":
                return await original_write(payload)
            self.values["attempts"] += 1
            self.transferring = True
            with self.stage("importWrite"):
                return await original_write(payload)
        def put(item):
            self.frame(item)
            return original_put(item)
        session.write_payload, session.events.put_nowait = write, put
        def restore():
            session.write_payload, session.events.put_nowait = original_write, original_put
        return restore

    def finish(self, cleanup):
        self.values["cleanup"] = cleanup
        if self.values["outcome"] == "running":
            self.values["outcome"] = "succeeded"
        self.values["phase"] = "done" if self.values["outcome"] == "succeeded" else "failed"
        self.finished = self.elapsed()

    def snapshot(self):
        result = {**self.values, **self.times, "elapsedMs": getattr(self, "finished", self.elapsed())}
        for name, start in self.active:
            result[name + "Ms"] = result.get(name + "Ms", 0) + max(0, round((self.clock() - start) * 1000))
        return result


def diagnostic_stage(trace, name):
    return trace.stage(name) if trace else contextlib.nullcontext()


def select_import_file(files, filename=None):
    """Select one exact on-card name; never silently fall back to a stem/first match."""
    if filename is None:
        if not files:
            raise RuntimeError("File list empty")
        return files[0]
    if (not isinstance(filename, str) or not filename or filename != filename.strip()
            or any(ord(c) < 32 or c in "/\\," for c in filename)):
        raise ValueError("filename must be one exact name from recorder_list, without paths or commas")
    matches = [entry for entry in files if entry.name == filename]
    if len(matches) != 1:
        raise RuntimeError("filename is missing or ambiguous; refresh recorder_list and select an exact name")
    return matches[0]


def load_upstream(repo_root: Path):
    repo_root = repo_root.resolve()
    for relative, expected in SOURCE_HASHES.items():
        path = repo_root / relative
        try:
            content = path.read_bytes().replace(b"\r\n", b"\n")
        except OSError as error:
            raise RuntimeError(f"Missing upstream source: {relative}") from error
        if hashlib.sha256(content).hexdigest() != expected:
            raise RuntimeError(f"Unsupported upstream source: {relative}; expected {UPSTREAM_COMMIT}")
    sys.path.insert(0, str(repo_root / "tools"))
    # The adapter process owns this import; use the just-verified checkout.
    sys.modules.pop("qs668_protocol", None)
    spec = importlib.util.spec_from_file_location("recorder_upstream", repo_root / "tools/qs668-bringup.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def ensure_confirmed_session(session):
    if getattr(session, "_recorder_uncertain", False):
        raise UnconfirmedResponse("Previous response was unconfirmed; reconnect before another command")


async def confirmed_list(upstream, session, *, first_timeout=4.0, idle_timeout=1.2, total_timeout=30.0):
    ensure_confirmed_session(session)
    files = []
    deadline = time.monotonic() + total_timeout
    idle_deadline = time.monotonic() + first_timeout
    try:
        await session.write_payload(upstream.cmd_list_files())
        while True:
            remaining = min(deadline, idle_deadline) - time.monotonic()
            if remaining <= 0:
                raise UnconfirmedResponse(f"List timed out; {len(files)} entries remain incomplete")
            try:
                _source, frame = await asyncio.wait_for(session.events.get(), remaining)
            except asyncio.TimeoutError as error:
                raise UnconfirmedResponse(f"List timed out; {len(files)} entries remain incomplete") from error
            if frame.type != 2:
                continue
            if frame.cmd == 1:
                payload = frame.params
                if len(payload) < 4:
                    raise UnconfirmedResponse("Malformed list frame: missing count")
                count = int.from_bytes(payload[:4], "big")
                if len(payload) != 4 + count * 28:
                    raise UnconfirmedResponse("Malformed list frame: entry count/length mismatch")
                files.extend(upstream.parse_file_list(payload))
                idle_deadline = time.monotonic() + idle_timeout
            elif frame.cmd == 18:
                if not frame.params or frame.params[0] != 0:
                    raise UnconfirmedResponse("List end did not confirm success")
                print(f"OK confirmed list count={len(files)}")
                return files
    except BaseException:
        session._recorder_uncertain = True
        raise


async def confirmed_record(upstream, session, action, *, timeout=3.0):
    ensure_confirmed_session(session)
    commands = {
        "start": (upstream.cmd_start_recording, 2),
        "save": (upstream.cmd_save_recording, 4),
        "pause": (upstream.cmd_pause_recording, 6),
        "resume": (upstream.cmd_resume_recording, 8),
    }
    if action not in commands:
        raise ValueError("Unsupported recording action")
    build, expected = commands[action]
    deadline = time.monotonic() + timeout
    try:
        await session.write_payload(build())
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise UnconfirmedResponse(f"Recording {action} not acknowledged; outcome unknown, do not retry blindly")
            try:
                source, frame = await asyncio.wait_for(session.events.get(), remaining)
            except asyncio.TimeoutError as error:
                raise UnconfirmedResponse(f"Recording {action} not acknowledged; outcome unknown, do not retry blindly") from error
            if frame.type != 3 or frame.cmd != expected:
                continue
            if not frame.params:
                raise UnconfirmedResponse(f"Recording {action} acknowledgement has no result")
            if frame.params[0] != 1:
                raise UnconfirmedResponse(f"Recording {action} was not confirmed: code={frame.params[0]}")
            print(f"OK confirmed record {action} via {source}")
            return
    except BaseException:
        session._recorder_uncertain = True
        raise


class ImportReport:
    """Private, atomic machine-readable handoff; never infer outcomes from logs."""

    def __init__(self, path=None):
        self.path = Path(path) if path is not None else None
        self.data = {"version": 2, "imports": [], "transcriptions": [], "cleanup": {"status": "pending", "errors": []}}
        self.save()

    def save(self):
        if self.path is None:
            return
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.path.parent,
                                             prefix=".result-", delete=False) as stream:
                temporary = Path(stream.name)
                json.dump(self.data, stream, ensure_ascii=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)


def validate_audio(path):
    """Verify the supported RIFF/WAVE PCM container and whole sample frames.

    No source checksum exists here: this cannot prove absence of all bit corruption.
    Unknown formats fail closed rather than being labelled successful imports.
    """
    def unconfirmed(detail):
        raise RuntimeError(f"Audio integrity unconfirmed: {detail}")

    size = path.stat().st_size
    with path.open("rb") as stream:
        header = stream.read(12)
        if len(header) != 12 or header[:4] != b"RIFF" or header[8:] != b"WAVE":
            unconfirmed("only RIFF/WAVE PCM can currently be verified")
        if struct.unpack_from("<I", header, 4)[0] + 8 != size:
            unconfirmed("RIFF declared length does not match received file length")
        position = 12
        pcm = None
        data_size = None
        while position < size:
            if size - position < 8:
                unconfirmed("truncated chunk header")
            stream.seek(position)
            chunk_id, length = struct.unpack("<4sI", stream.read(8))
            end = position + 8 + length
            padded_end = end + (length & 1)
            if padded_end > size:
                unconfirmed("chunk payload or padding is truncated")
            if chunk_id == b"fmt ":
                if pcm is not None or length not in (16, 18):
                    unconfirmed("missing or duplicate PCM format")
                format_tag, channels, rate, byte_rate, alignment, bits = struct.unpack("<HHIIHH", stream.read(16))
                if length == 18 and stream.read(2) != b"\x00\x00":
                    unconfirmed("unsupported PCM format extension")
                if format_tag != 1 or bits not in (8, 16, 24, 32):
                    unconfirmed("unsupported WAVE encoding")
                if channels <= 0 or rate <= 0 or alignment != channels * (bits // 8) or byte_rate != rate * alignment:
                    unconfirmed("inconsistent PCM format fields")
                pcm = (channels, rate, bits, alignment)
            elif chunk_id == b"data":
                if pcm is None or data_size is not None or length <= 0:
                    unconfirmed("missing format, duplicate data or empty sample data")
                if length % pcm[3]:
                    unconfirmed("sample data ends inside a PCM frame")
                data_size = length
            position = padded_end
        if pcm is None or data_size is None:
            unconfirmed("missing format or sample data")
    return {"status": "verified", "format": "wav-pcm", "channels": pcm[0],
            "sampleRate": pcm[1], "bitsPerSample": pcm[2], "frames": data_size // pcm[3]}


async def safe_import_file(original_import, session, list_name, out_dir, report, trace=None):
    destination = Path(out_dir).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    # Upstream may overwrite its target. Give it a fresh private directory only.
    with tempfile.TemporaryDirectory(prefix=".recorder-import-", dir=destination) as temporary:
        staging = Path(temporary).resolve()
        try:
            with diagnostic_stage(trace, "transfer"):
                staged = Path(await original_import(session, list_name, staging))
        except Exception as error:
            client = getattr(session, "client", None)
            disconnected = client is not None and not client.is_connected
            problem = TransferInterrupted(str(error) or type(error).__name__, disconnected=disconnected)
            report.data["error"] = {"code": problem.code, "message": str(problem)}
            report.save()
            raise problem from error
        with diagnostic_stage(trace, "validate"):
            if staged.is_symlink() or staged.resolve().parent != staging or not staged.is_file():
                raise RuntimeError("Import did not produce a regular file in its staging directory")
            size = staged.stat().st_size
            if size <= 0:
                raise RuntimeError("Import completed without audio data")
            integrity = validate_audio(staged)
            with staged.open("rb+") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
                os.fsync(stream.fileno())
        target = destination / staged.name
        # Hard-link publication is atomic and never replaces an existing target,
        # including dangling symlinks. No check-then-rename or overwriting fallback.
        with diagnostic_stage(trace, "publish"):
            while True:
                try:
                    os.link(staged, target)
                    break
                except FileExistsError:
                    target = destination / f"{staged.stem}-{uuid.uuid4().hex}{staged.suffix}"
        report.data["imports"].append({"status": "succeeded", "path": str(target),
                                       "bytes": size, "sha256": digest, "integrity": integrity})
        report.save()
        print(f"OK import published {target} ({size} B)")
        return target


def checked_transcription(upstream, audio_path, args, report, *, timeout=120):
    item = {"status": "running", "audioPath": str(audio_path), "exitCode": None}
    report.data["transcriptions"].append(item)
    report.save()
    command = [sys.executable, "-B", str(Path(__file__).resolve()),
               "--repo-root", str(upstream.TOOLS_DIR.parent), "--data-dir", str(upstream.ROOT),
               "--transcribe-file", str(audio_path), "--", "--out-dir", str(upstream.ROOT / "archive" / "corpus")]
    for key in ("title", "customer"):
        if getattr(args, key, ""):
            command.extend([f"--{key}", getattr(args, key)])
    if getattr(args, "force", False):
        command.append("--force")
    try:
        result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8",
                                errors="replace", timeout=timeout)
        item["exitCode"] = result.returncode
        if result.stdout:
            print(result.stdout.rstrip())
        if result.returncode:
            item.update(status="failed", error={"code": "TRANSCRIPTION_FAILED",
                        "message": (result.stderr or result.stdout or "Transcription failed")[-2048:]})
        else:
            item["status"] = "succeeded"
    except subprocess.TimeoutExpired:
        item.update(status="failed", error={"code": "TRANSCRIPTION_TIMEOUT", "message": "Transcription timed out"})
    except OSError as error:
        item.update(status="failed", error={"code": "TRANSCRIPTION_SPAWN_FAILED", "message": str(error)})
    report.save()
    if item["status"] == "failed":
        raise RuntimeError(f"Transcription failed after successful import; audio retained at {audio_path}")
    print("DONE transcription process completed")


def install_guards(upstream, *, operation_timeout=180.0, cleanup_timeout=5.0, report=None):
    report = report if report is not None else ImportReport()
    original_session = upstream.Session
    original_run = upstream.run
    original_targets = upstream.resolve_import_targets
    active = []
    trace = None

    class TrackedSession(original_session):
        def __init__(self):
            super().__init__()
            self._recorder_disconnect_errors = []
            if trace:
                trace.attach(self)
            active.append(self)

        async def connect(self, address):
            with diagnostic_stage(trace, "connect"):
                return await super().connect(address)

        async def disconnect(self):
            # Upstream clears client in finally, even when disconnect fails.
            # Observe the first attempt too: a later no-op cannot prove release.
            try:
                # A second no-op must not inflate or replace the first cleanup stage.
                with diagnostic_stage(trace if getattr(self, "client", True) else None, "cleanup"):
                    return await asyncio.wait_for(super().disconnect(), cleanup_timeout)
            except BaseException as error:
                self._recorder_disconnect_errors.append(error)
                raise

    async def guarded_run(args):
        nonlocal trace
        importing = any(getattr(args, key, None) for key in ("import_first", "import_all", "filename"))
        trace = Diagnostics("import" if importing else "cli")
        async def pulse():
            while True:
                report.data["diagnostics"] = trace.snapshot()
                try:
                    report.save()
                except OSError:
                    pass  # Diagnostic sampling must not cancel a device operation.
                await asyncio.sleep(1)
        report.data["cleanup"] = {"status": "pending", "errors": []}
        report.save()
        heartbeat = asyncio.create_task(pulse())
        primary = None
        try:
            return await asyncio.wait_for(original_run(args), operation_timeout)
        except BaseException as error:
            trace.fail(error)
            primary = error
            raise
        finally:
            cleanup_error = None
            cleanup_errors = []
            had_sessions = bool(active)
            # Includes partially initialized connections, before upstream's finally.
            for session in active:
                try:
                    await asyncio.wait_for(session.disconnect(), cleanup_timeout)
                except Exception as error:
                    # Also cover an instance-level replacement of disconnect.
                    # A timeout can wrap cancellation recorded by TrackedSession.
                    if not session._recorder_disconnect_errors:
                        session._recorder_disconnect_errors.append(error)
                for error in session._recorder_disconnect_errors:
                    cleanup_error = error
                    cleanup_errors.append({"code": "DEVICE_CLEANUP_FAILED",
                                           "message": "Connection release is unconfirmed: " + (str(error) or type(error).__name__)})
                    print("WARN device cleanup failed; connection release is unconfirmed", file=sys.stderr)
            active.clear()
            report.data["cleanup"] = {"status": "unconfirmed" if cleanup_errors else ("succeeded" if had_sessions else "not-needed"),
                                      "errors": cleanup_errors}
            if cleanup_error is not None:
                trace.fail(cleanup_error)
            trace.finish(report.data["cleanup"]["status"])
            heartbeat.cancel()
            await asyncio.gather(heartbeat, return_exceptions=True)
            report.data["diagnostics"] = trace.snapshot()
            try:
                report.save()
            except OSError:
                if primary is None:
                    raise
                print("WARN cleanup report could not be saved; release status remains unconfirmed", file=sys.stderr)
            if cleanup_error is not None and primary is None:
                raise RuntimeError("Device cleanup failed; connection release is unconfirmed") from cleanup_error

    if hasattr(upstream, "import_file"):
        original_import = upstream.import_file
        upstream.import_file = lambda session, name, out: safe_import_file(original_import, session, name, out, report, trace)
    if hasattr(upstream, "read_status"):
        original_status = upstream.read_status
        async def status(session):
            with diagnostic_stage(trace, "status"):
                return await original_status(session)
        upstream.read_status = status
    if hasattr(upstream, "scan_devices"):
        original_scan = upstream.scan_devices
        async def scan():
            with diagnostic_stage(trace, "scan"):
                return await original_scan()
        upstream.scan_devices = scan
    upstream.run_transcribe_after_import = lambda path, args: checked_transcription(upstream, path, args, report)
    upstream.Session = TrackedSession
    def exact_targets(files, args):
        names = upstream.normalize_filename_args(getattr(args, "filename", None))
        if names:
            return [select_import_file(files, name).name for name in names]
        return original_targets(files, args)
    upstream.resolve_import_targets = exact_targets
    async def listing(session):
        with diagnostic_stage(trace, "list"):
            return await confirmed_list(upstream, session)
    upstream.list_files = listing
    upstream.send_record_command = lambda session, action: confirmed_record(upstream, session, action)
    upstream.run = guarded_run


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=DEFAULT_REPO_ROOT, help="Pinned CLI source; defaults to bundled vendor/upstream")
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA_DIR, help="Writable user data directory; never the CLI source directory")
    parser.add_argument("--check-deps", action="store_true", help="Check bundled sources and Python dependencies without accessing Bluetooth")
    parser.add_argument("--transcribe-file", type=Path, help="Transcribe an existing audio file without opening a BLE session")
    parser.add_argument("--timeout", type=float, default=180.0, help="Total CLI operation timeout in seconds (default: 180)")
    parser.add_argument("--result-file", type=Path, help="Private JSON import/transcription result file")
    parser.add_argument("cli_args", nargs=argparse.REMAINDER, help="Use -- before upstream CLI arguments")
    args = parser.parse_args(argv)
    if not math.isfinite(args.timeout) or args.timeout <= 0:
        parser.error("--timeout must be finite and positive")
    cli_args = args.cli_args[1:] if args.cli_args[:1] == ["--"] else args.cli_args
    original_argv = sys.argv
    try:
        if sys.version_info < (3, 11):
            raise RuntimeError("Python 3.11 or newer is required; set the plugin's python field to that interpreter")
        repo_root = args.repo_root.resolve()
        data_dir = args.data_dir.resolve()
        if data_dir.is_relative_to(repo_root):
            raise RuntimeError("dataDir must be outside the CLI source directory")
        if args.check_deps:
            load_upstream(repo_root)
            require_dependency("bleak")
            load_transcriber(repo_root)
            print("OK pinned CLI sources and Python dependencies (bleak, requests); no Bluetooth access")
            return 0
        if args.transcribe_file is not None:
            upstream = load_transcriber(repo_root)
            configure_runtime(upstream, data_dir)
            data_dir.mkdir(parents=True, exist_ok=True)
            sys.argv = [str(repo_root / "tools/qs668-transcribe.py"), str(args.transcribe_file.resolve()), *cli_args]
            return upstream.main()
        upstream = load_upstream(repo_root)
        configure_runtime(upstream, data_dir)
        if "--help" not in cli_args and "-h" not in cli_args:
            require_dependency("bleak")
            data_dir.mkdir(parents=True, exist_ok=True)
        install_guards(upstream, operation_timeout=args.timeout, report=ImportReport(args.result_file))
        sys.argv = [str(repo_root / "tools/qs668-bringup.py"), *cli_args]
        return upstream.main()
    except KeyboardInterrupt:
        print("ERR cancelled; verify device state before retrying", file=sys.stderr)
        return 130
    except asyncio.TimeoutError:
        print("ERR operation timed out; device outcome may be unknown", file=sys.stderr)
        return 124
    except (OSError, RuntimeError) as error:
        print(f"ERR {error}", file=sys.stderr)
        return 1
    finally:
        sys.argv = original_argv


if __name__ == "__main__":
    raise SystemExit(main())
