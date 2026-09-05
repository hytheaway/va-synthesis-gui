#!/usr/bin/env python3
"""Small dependency-free local host for the VA Synthesis browser UI."""

from __future__ import annotations

import argparse
import base64
import json
import os
import threading
import time
import uuid
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import shutil
import subprocess
import tempfile
from urllib.parse import urlparse
import webbrowser


ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
MAX_UPLOAD = 128 * 1024 * 1024
JOB_TTL_SECONDS = 60 * 60


def find_pffdtd_python() -> Path | None:
    configured = os.environ.get("VA_PFFDTD_PYTHON")
    if configured:
        candidate = Path(configured).expanduser()
        return candidate if candidate.is_file() else None
    for name in ("python3", "python"):
        located = shutil.which(name)
        if located:
            return Path(located)
    return None


class RenderJob:
    def __init__(self, *, command: list[str], workdir: tempfile.TemporaryDirectory[str], stem: str, file_name: str):
        self.id = uuid.uuid4().hex
        self.command = command
        self.workdir = workdir
        self.stem = stem
        self.file_name = file_name
        self.status = "running"
        self.error: str | None = None
        self.message = ""
        self.result: bytes | None = None
        self.started_at = time.monotonic()
        self.finished_at: float | None = None
        self._lock = threading.Lock()
        self._process: subprocess.Popen[bytes] | None = None
        self._thread = threading.Thread(target=self._run, name=f"va-render-{self.id[:8]}", daemon=True)
        self._thread.start()

    def elapsed(self) -> float:
        end = self.finished_at if self.finished_at is not None else time.monotonic()
        return max(0.0, end - self.started_at)

    def snapshot(self) -> dict[str, object]:
        with self._lock:
            return {
                "jobId": self.id,
                "status": self.status,
                "error": self.error,
                "message": self.message,
                "elapsed": self.elapsed(),
                "fileName": self.file_name,
            }

    def completed_result(self) -> tuple[bytes, str, str] | None:
        with self._lock:
            if self.status != "done" or self.result is None:
                return None
            return self.result, self.stem, self.message

    def cancel(self) -> None:
        process = self._process
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()

    def _finish(self, *, status: str, error: str | None = None, message: str = "", result: bytes | None = None) -> None:
        with self._lock:
            self.status = status
            self.error = error
            self.message = message
            self.result = result
            self.finished_at = time.monotonic()
        print(f"[va-gui] render {self.id[:8]} {status} after {self.elapsed():.1f}s")

    def _consume_output(self, stream) -> str:
        lines: list[str] = []
        buffer = ""
        while True:
            chunk = stream.read(256)
            if not chunk:
                break
            buffer += chunk.decode("utf-8", errors="replace").replace("\r", "\n")
            while "\n" in buffer:
                line, buffer = buffer.split("\n", 1)
                text = line.strip()
                if not text:
                    continue
                lines.append(text)
                with self._lock:
                    self.message = text
        text = buffer.strip()
        if text:
            lines.append(text)
            with self._lock:
                self.message = text
        return "\n".join(lines)

    def _run(self) -> None:
        env = os.environ.copy()
        env["PYTHONUNBUFFERED"] = "1"
        process: subprocess.Popen[bytes] | None = None
        try:
            process = subprocess.Popen(
                self.command,
                cwd=ROOT,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                bufsize=0,
                env=env,
            )
            self._process = process
            assert process.stdout is not None
            output = self._consume_output(process.stdout)
            returncode = process.wait()
            if returncode != 0:
                message = output.removeprefix("error: ").strip() or "The acoustic renderer failed"
                self._finish(status="error", error=message, message=message)
                return
            result_path = Path(self.workdir.name) / "rendered.wav"
            if not result_path.is_file():
                raise RuntimeError("The renderer finished without writing output audio")
            payload = result_path.read_bytes()
            self._finish(
                status="done",
                message=(output.split("\n")[-1] if output else f"{len(payload) / (1024 * 1024):.2f} MB WAV"),
                result=payload,
            )
        except Exception as error:
            self._finish(status="error", error=str(error), message=str(error))
        finally:
            if process is not None and process.poll() is None:
                process.kill()
                process.wait()
            self._process = None
            try:
                self.workdir.cleanup()
            except OSError:
                pass
            with self._lock:
                if self.finished_at is None:
                    self.finished_at = time.monotonic()
                    if self.status == "running":
                        self.status = "error"
                        self.error = "The renderer stopped unexpectedly"
                        self.message = self.error


class JobStore:
    def __init__(self) -> None:
        self._jobs: dict[str, RenderJob] = {}
        self._lock = threading.Lock()

    def add(self, job: RenderJob) -> RenderJob:
        self.expire()
        with self._lock:
            self._jobs[job.id] = job
        return job

    def get(self, job_id: str) -> RenderJob | None:
        with self._lock:
            return self._jobs.get(job_id)

    def expire(self) -> None:
        cutoff = time.monotonic()
        with self._lock:
            stale = [
                job_id
                for job_id, job in self._jobs.items()
                if job.status != "running"
                and job.finished_at is not None
                and cutoff - job.finished_at > JOB_TTL_SECONDS
            ]
            for job_id in stale:
                self._jobs.pop(job_id, None)

    def cancel_all(self) -> None:
        with self._lock:
            jobs = list(self._jobs.values())
        for job in jobs:
            job.cancel()


class Handler(SimpleHTTPRequestHandler):
    server_version = "VASynthesisGUI/0.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_ROOT), **kwargs)

    def do_GET(self) -> None:
        parts = [part for part in urlparse(self.path).path.split("/") if part]
        if parts == ["api", "health"]:
            self.send_health()
            return
        if len(parts) >= 3 and parts[0] == "api" and parts[1] == "jobs":
            job = self.server.jobs.get(parts[2])  # type: ignore[attr-defined]
            if job is None:
                self.send_json({"error": "The render job is no longer available"}, HTTPStatus.NOT_FOUND)
                return
            if parts[3:] == ["result"]:
                completed = job.completed_result()
                if completed is None:
                    self.send_json({"error": "The render is still running"}, HTTPStatus.CONFLICT)
                    return
                payload, stem, message = completed
                self.send_bytes(
                    payload,
                    content_type="audio/wav",
                    headers={
                        "Content-Disposition": f'attachment; filename="{stem}-va.wav"',
                        "X-VA-Message": message,
                    },
                )
                return
            if not parts[3:]:
                self.send_json(job.snapshot())
                return
        super().do_GET()

    def send_health(self) -> None:
        renderer = self.server.renderer  # type: ignore[attr-defined]
        if not renderer.is_file():
            self.send_json({"ready": False, "error": "Renderer executable is missing"})
            return
        try:
            check = subprocess.run(
                [str(renderer), "--capabilities", "true"], cwd=ROOT,
                capture_output=True, text=True, timeout=5, check=False,
            )
            if check.returncode != 0:
                raise RuntimeError(check.stderr.strip() or "Renderer self-check failed")
            capabilities = json.loads(check.stdout)
            pffdtd_python = self.server.pffdtd_python  # type: ignore[attr-defined]
            for component in capabilities.get("components", []):
                if component.get("name") == "PFFDTD adapter" and component.get("status") == "built":
                    if pffdtd_python:
                        runtime = subprocess.run(
                            [str(pffdtd_python), "-c", "import h5py,numba,numpy,resampy,scipy"],
                            capture_output=True, text=True, timeout=10, check=False,
                        )
                        if runtime.returncode == 0:
                            component["status"] = "ready"
                            component["detail"] = f"Adapter and Python runtime verified: {pffdtd_python}"
                        else:
                            component["status"] = "limited"
                            component["detail"] = "Adapter is built, but the PFFDTD Python import check failed"
                    else:
                        component["status"] = "limited"
                        component["detail"] = "Adapter is built, but no PFFDTD Python interpreter was found"
            capabilities["renderer"] = str(renderer)
            self.send_json(capabilities)
        except Exception as error:
            self.send_json({"ready": False, "error": str(error)})

    def do_POST(self) -> None:
        if urlparse(self.path).path != "/api/render":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_UPLOAD:
                raise ValueError("Upload is empty or exceeds the 128 MB limit")
            request = json.loads(self.rfile.read(length))
            encoded = request.pop("audioBase64", "")
            if not encoded:
                raise ValueError("No audio file was provided")
            audio = base64.b64decode(encoded, validate=True)
            if len(audio) < 12 or audio[:4] != b"RIFF" or audio[8:12] != b"WAVE":
                raise ValueError("Please choose a PCM or float WAV file")
            if request.get("wave-backend") == "pffdtd" and not request.get("pffdtd-python"):
                pffdtd_python = self.server.pffdtd_python  # type: ignore[attr-defined]
                if not pffdtd_python:
                    raise ValueError("PFFDTD Python was not found; set VA_PFFDTD_PYTHON")
                request["pffdtd-python"] = str(pffdtd_python)
            workdir = tempfile.TemporaryDirectory(prefix="va-synthesis-")
            try:
                source = Path(workdir.name) / "input.wav"
                result = Path(workdir.name) / "rendered.wav"
                source.write_bytes(audio)
                command = [str(self.server.renderer), "--input", str(source), "--output", str(result)]  # type: ignore[attr-defined]
                for key, value in request.items():
                    if key == "fileName" or value is None:
                        continue
                    command.extend(("--" + key, str(value).lower() if isinstance(value, bool) else str(value)))
                raw_stem = Path(str(request.get("fileName", "audio.wav"))).stem
                stem = "".join(character for character in raw_stem if character.isalnum() or character in "-_")[:80] or "audio"
                job = RenderJob(command=command, workdir=workdir, stem=stem, file_name=str(request.get("fileName", "audio.wav")))
            except Exception:
                workdir.cleanup()
                raise
            self.server.jobs.add(job)  # type: ignore[attr-defined]
            self.log_message("render %s started", job.id[:8])
            self.send_json({"jobId": job.id})
        except (ValueError, KeyError, json.JSONDecodeError) as error:
            self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
        except Exception as error:
            self.send_json({"error": str(error)}, HTTPStatus.UNPROCESSABLE_ENTITY)

    def send_json(self, value: object, status: HTTPStatus = HTTPStatus.OK) -> None:
        self.send_bytes(
            json.dumps(value).encode(),
            content_type="application/json",
            status=status,
            headers={"Cache-Control": "no-store"},
        )

    def send_bytes(
        self,
        payload: bytes,
        *,
        content_type: str,
        status: HTTPStatus = HTTPStatus.OK,
        headers: dict[str, str] | None = None,
    ) -> None:
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(payload)))
            for name, value in (headers or {}).items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def log_message(self, message: str, *args: object) -> None:
        formatted = message % args
        if '"GET /api/jobs/' in formatted and "/result" not in formatted and '" 200 ' in formatted:
            return
        print(f"[va-gui] {formatted}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the VA Synthesis GUI")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--renderer", type=Path, default=ROOT / "build" / "va_render")
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    renderer = args.renderer.resolve()
    if not renderer.is_file():
        raise SystemExit(f"Renderer not found at {renderer}. Run ./scripts/build.sh first.")
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.renderer = renderer  # type: ignore[attr-defined]
    server.pffdtd_python = find_pffdtd_python()  # type: ignore[attr-defined]
    server.jobs = JobStore()  # type: ignore[attr-defined]
    url = f"http://{args.host}:{args.port}"
    print(f"VA Synthesis is running at {url}")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping VA Synthesis")
    finally:
        server.jobs.cancel_all()  # type: ignore[attr-defined]
        server.server_close()


if __name__ == "__main__":
    main()
