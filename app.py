#!/usr/bin/env python3
"""Small dependency-free local host for the VA Synthesis browser UI."""

from __future__ import annotations

import argparse
import base64
import json
import math
import os
import sys
import threading
import time
import uuid
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import shutil
import subprocess
import tempfile
from urllib.parse import parse_qs, urlparse
import webbrowser


ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
VA_ROOT = ROOT / "submodules" / "va-synthesis"
PREPARE_SCRIPT = VA_ROOT / "tools" / "prepare_pffdtd_job.py"
MAX_UPLOAD = 128 * 1024 * 1024
JOB_TTL_SECONDS = 60 * 60
BROWSE_LOCK = threading.Lock()
PICKER_SCRIPT = r"""
import json
import os
import subprocess
import sys
from pathlib import Path
import tkinter as tk
from tkinter import filedialog

request = json.load(sys.stdin)
if sys.platform == "darwin":
    subprocess.run(
        [
            "osascript", "-e",
            f'tell application "System Events" to set frontmost of every process whose unix id is {os.getpid()} to true',
        ],
        check=False,
        capture_output=True,
    )

root = tk.Tk()
root.title(request.get("title") or "Select")
root.geometry("1x1+0+0")
try:
    root.attributes("-topmost", True)
except tk.TclError:
    pass
try:
    root.call("::tk::mac::ReopenApplication")
except tk.TclError:
    pass
root.lift()
root.focus_force()
root.update()

kind = request["kind"]
title = request.get("title") or ("Select a folder" if kind == "directory" else "Select a file")
initial = Path(request.get("initial") or "")
initialdir = ""
initialfile = ""
if initial.is_file():
    initialdir = str(initial.parent)
    initialfile = initial.name
elif initial.is_dir():
    initialdir = str(initial)
elif initial.parent.is_dir():
    initialdir = str(initial.parent)
options = {"title": title, "parent": root}
if initialdir:
    options["initialdir"] = initialdir
if kind == "directory":
    chosen = filedialog.askdirectory(**options)
else:
    if initialfile:
        options["initialfile"] = initialfile
    types = [str(item).lstrip(".") for item in (request.get("types") or []) if str(item).strip()]
    if types:
        patterns = " ".join(f"*.{ext}" for ext in types)
        options["filetypes"] = [(patterns, patterns), ("All files", "*.*")]
    else:
        options["filetypes"] = [("All files", "*.*")]
    chosen = filedialog.askopenfilename(**options)
try:
    root.attributes("-topmost", False)
except tk.TclError:
    pass
root.destroy()
json.dump({"path": chosen or ""}, sys.stdout)
"""
RENDER_SKIP_KEYS = {
    "fileName",
    "pffdtd-job-mode",
    "pffdtd-model",
    "pffdtd-output",
    "pffdtd-source",
    "pffdtd-processes",
    "pffdtd-differentiate-source",
    "pffdtd-fcc",
    "pffdtd-materials-dir",
    "pffdtd-materials",
}


def as_bool(value: object) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "on", "yes"}


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


def resolve_va_path(raw_path: str, *, must_exist: bool = True) -> Path:
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = VA_ROOT / path
    path = path.resolve()
    if must_exist and not path.exists():
        raise ValueError(f"Path not found: {path}")
    return path


def browse_anchor(raw_path: str) -> Path:
    text = (raw_path or "").strip()
    if not text:
        return VA_ROOT
    try:
        path = resolve_va_path(text, must_exist=False)
    except Exception:
        return VA_ROOT
    if path.exists():
        return path
    if path.parent.exists():
        return path.parent
    return VA_ROOT


def display_selected_path(chosen: Path, *, basename: bool = False, relative_to: Path | None = None) -> str:
    chosen = chosen.resolve()
    if basename:
        if relative_to is not None:
            try:
                return str(chosen.relative_to(relative_to.resolve()))
            except ValueError:
                pass
        return chosen.name
    try:
        return str(chosen.relative_to(VA_ROOT))
    except ValueError:
        return str(chosen)


def _applescript_quote(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def pick_with_osascript(*, kind: str, title: str, initial: Path, types: list[str]) -> Path | None:
    if initial.is_file():
        location = initial.parent
    elif initial.is_dir():
        location = initial
    elif initial.parent.is_dir():
        location = initial.parent
    else:
        location = Path.home()
    prompt = title or ("Select a folder" if kind == "directory" else "Select a file")
    location_clause = f" default location POSIX file {_applescript_quote(str(location))}"
    if kind == "directory":
        chooser = (
            f"POSIX path of (choose folder with prompt {_applescript_quote(prompt)}"
            f"{location_clause})"
        )
    else:
        apple_types: list[str] = []
        for ext in types:
            if ext.lower() == "json":
                apple_types.extend(["json", "public.json"])
        type_clause = ""
        if apple_types:
            type_clause = " of type {" + ", ".join(_applescript_quote(item) for item in apple_types) + "}"
        chooser = (
            f"POSIX path of (choose file with prompt {_applescript_quote(prompt)}"
            f"{type_clause}{location_clause})"
        )
    script = (
        'tell application "System Events" to activate\n'
        "try\n"
        f"    {chooser}\n"
        "on error\n"
        '    return ""\n'
        "end try\n"
    )
    completed = subprocess.run(
        ["osascript"],
        input=script,
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "macOS file picker failed").strip()
        raise ValueError(detail.splitlines()[-1] if detail else "macOS file picker failed")
    chosen = completed.stdout.strip().rstrip("/")
    return Path(chosen) if chosen else None


def pick_native_path(*, kind: str, title: str, initial: Path, types: list[str]) -> Path | None:
    if sys.platform == "darwin":
        try:
            return pick_with_osascript(kind=kind, title=title, initial=initial, types=types)
        except (OSError, ValueError):
            pass
    payload = {
        "kind": kind,
        "title": title,
        "initial": str(initial),
        "types": types,
    }
    completed = subprocess.run(
        [sys.executable, "-c", PICKER_SCRIPT],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "file picker failed").strip()
        raise ValueError(detail.splitlines()[-1] if detail else "file picker failed")
    try:
        result = json.loads(completed.stdout or "{}")
    except json.JSONDecodeError as error:
        raise ValueError("file picker returned unreadable output") from error
    chosen = str(result.get("path") or "").strip()
    return Path(chosen) if chosen else None


def _xyz(value: object) -> list[float] | None:
    if not isinstance(value, (list, tuple)) or len(value) < 3:
        return None
    try:
        point = [float(value[0]), float(value[1]), float(value[2])]
    except (TypeError, ValueError):
        return None
    if not all(map(math.isfinite, point)):
        return None
    return point


def inspect_pffdtd_model(raw_path: str) -> dict[str, object]:
    path = resolve_va_path(raw_path)
    if not path.is_file():
        raise ValueError(f"Model not found: {path}")
    with path.open(encoding="utf-8") as handle:
        model = json.load(handle)
    mats = model.get("mats_hash")
    if not isinstance(mats, dict):
        raise ValueError("model JSON is missing mats_hash")

    bmin = [math.inf, math.inf, math.inf]
    bmax = [-math.inf, -math.inf, -math.inf]
    layers: list[dict[str, object]] = []
    triangle_count = 0
    max_triangles = 12_000
    for name, material in mats.items():
        if not isinstance(material, dict):
            continue
        points = material.get("pts") or []
        triangles = material.get("tris") or []
        raw_color = material.get("color") or [128, 128, 128]
        try:
            channels = [float(raw_color[0]), float(raw_color[1]), float(raw_color[2])]
        except (TypeError, ValueError, IndexError):
            channels = [128.0, 128.0, 128.0]
        if max(channels) <= 1.0:
            color = [int(round(channel * 255)) for channel in channels]
        else:
            color = [int(max(0, min(255, round(channel)))) for channel in channels]
        top: list[list[list[float]]] = []
        side: list[list[list[float]]] = []
        for triangle in triangles:
            if triangle_count >= max_triangles:
                break
            if not isinstance(triangle, (list, tuple)) or len(triangle) < 3:
                continue
            try:
                corners = [points[int(triangle[0])], points[int(triangle[1])], points[int(triangle[2])]]
            except (IndexError, TypeError, ValueError):
                continue
            world = [_xyz(corner) for corner in corners]
            if any(point is None for point in world):
                continue
            for point in world:
                for axis in range(3):
                    bmin[axis] = min(bmin[axis], point[axis])
                    bmax[axis] = max(bmax[axis], point[axis])
            top.append([[round(point[0], 3), round(point[1], 3)] for point in world])
            side.append([[round(point[0], 3), round(point[2], 3)] for point in world])
            triangle_count += 1
        if top:
            layers.append({"name": name, "color": color, "top": top, "side": side})

    if not math.isfinite(bmin[0]):
        raise ValueError("model JSON does not contain mesh points")

    def named_points(key: str) -> list[dict[str, object]]:
        items = []
        for entry in model.get(key) or []:
            if not isinstance(entry, dict):
                continue
            point = _xyz(entry.get("xyz"))
            if point is None:
                continue
            items.append({"xyz": point, "name": str(entry.get("name") or "")})
        return items

    return {
        "path": str(path),
        "surfaces": sorted(name for name in mats if name != "_RIGID"),
        "hasVaMaterials": bool(model.get("va_materials")),
        "bounds": {"min": bmin, "max": bmax},
        "size": {"x": bmax[0] - bmin[0], "y": bmax[1] - bmin[1], "z": bmax[2] - bmin[2]},
        "sources": named_points("sources"),
        "receivers": named_points("receivers"),
        "layers": layers,
    }


def inset_point(point: list[float], bounds: dict[str, list[float]], margin: float = 1e-3) -> list[float]:
    lo, hi = bounds["min"], bounds["max"]
    placed = []
    for axis in range(3):
        low = lo[axis] + margin
        high = hi[axis] - margin
        if high <= low:
            placed.append(0.5 * (lo[axis] + hi[axis]))
        else:
            placed.append(min(max(point[axis], low), high))
    return placed


def write_placed_pffdtd_model(
    source_model: Path,
    destination: Path,
    source_xyz: list[float],
    receiver_xyz: list[float],
) -> None:
    with source_model.open(encoding="utf-8") as handle:
        model = json.load(handle)
    model["sources"] = [{"xyz": source_xyz, "name": "S1"}]
    model["receivers"] = [{"xyz": receiver_xyz, "name": "R1"}]
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("w", encoding="utf-8") as handle:
        json.dump(model, handle)


def required_text(request: dict[str, object], key: str) -> str:
    value = str(request.get(key) or "").strip()
    if not value:
        raise ValueError(f"{key} is required to prepare a PFFDTD job")
    return value


def build_pffdtd_prepare_command(request: dict[str, object], python: str) -> list[str]:
    if not PREPARE_SCRIPT.is_file():
        raise ValueError(f"PFFDTD prepare script was not found at {PREPARE_SCRIPT}")
    command = [
        python,
        str(PREPARE_SCRIPT),
        "--repository", required_text(request, "pffdtd-repository"),
        "--model", required_text(request, "pffdtd-model"),
        "--output", required_text(request, "pffdtd-output"),
        "--maximum-frequency", required_text(request, "maximum-frequency"),
        "--points-per-wavelength", str(request.get("points-per-wavelength") or "8"),
        "--duration", required_text(request, "ir-duration"),
        "--source", str(request.get("pffdtd-source") or "1"),
    ]
    processes = str(request.get("pffdtd-processes") or "").strip()
    if processes:
        command.extend(("--processes", processes))
    if as_bool(request.get("pffdtd-differentiate-source")):
        command.append("--differentiate-source")
    if as_bool(request.get("pffdtd-fcc")):
        command.append("--fcc")
    materials_dir = str(request.get("pffdtd-materials-dir") or "").strip()
    if materials_dir:
        command.extend(("--materials-dir", materials_dir))
    materials = request.get("pffdtd-materials") or []
    if isinstance(materials, str):
        materials = [line.strip() for line in materials.splitlines() if line.strip()]
    if not isinstance(materials, list):
        raise ValueError("pffdtd-materials must be a list of NAME=FILE mappings")
    for assignment in materials:
        text = str(assignment).strip()
        if not text:
            continue
        if "=" not in text or text.startswith("=") or text.endswith("="):
            raise ValueError(f"material mapping must be NAME=FILE, got {text!r}")
        command.extend(("--material", text))
    return command


def absolutize_pffdtd_paths(request: dict[str, object], *, preparing: bool) -> None:
    if preparing:
        output = resolve_va_path(required_text(request, "pffdtd-output"), must_exist=False)
        request["pffdtd-output"] = str(output)
        request["pffdtd-data-directory"] = str(output)
    else:
        data_directory = str(request.get("pffdtd-data-directory") or "").strip()
        if not data_directory:
            raise ValueError("Prepared job directory is required")
        request["pffdtd-data-directory"] = str(resolve_va_path(data_directory))
    repository = str(request.get("pffdtd-repository") or "").strip()
    if repository:
        request["pffdtd-repository"] = str(resolve_va_path(repository))
    materials = str(request.get("pffdtd-materials-dir") or "").strip()
    if materials:
        request["pffdtd-materials-dir"] = str(resolve_va_path(materials))
    model = str(request.get("pffdtd-model") or "").strip()
    if model:
        request["pffdtd-model"] = str(resolve_va_path(model, must_exist=not preparing))
    request["pffdtd-bridge"] = str(VA_ROOT / "tools" / "pffdtd_bridge.py")


class RenderJob:
    def __init__(
        self,
        *,
        steps: list[tuple[str, list[str], Path]],
        workdir: tempfile.TemporaryDirectory[str],
        stem: str,
        file_name: str,
    ):
        self.id = uuid.uuid4().hex
        self.steps = steps
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
        outputs: list[str] = []
        try:
            for label, command, cwd in self.steps:
                with self._lock:
                    self.message = label
                process = subprocess.Popen(
                    command,
                    cwd=cwd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    bufsize=0,
                    env=env,
                )
                self._process = process
                assert process.stdout is not None
                output = self._consume_output(process.stdout)
                returncode = process.wait()
                process = None
                self._process = None
                if output:
                    outputs.append(output)
                if returncode != 0:
                    message = output.removeprefix("error: ").strip() or f"{label} failed"
                    self._finish(status="error", error=message, message=message)
                    return
            combined = "\n".join(outputs).strip()
            result_path = Path(self.workdir.name) / "rendered.wav"
            if not result_path.is_file():
                raise RuntimeError("The renderer finished without writing output audio")
            payload = result_path.read_bytes()
            self._finish(
                status="done",
                message=(combined.split("\n")[-1] if combined else f"{len(payload) / (1024 * 1024):.2f} MB WAV"),
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
        if parts == ["api", "pffdtd", "model"]:
            try:
                path = (parse_qs(urlparse(self.path).query).get("path") or [""])[0]
                if not path.strip():
                    raise ValueError("path is required")
                self.send_json(inspect_pffdtd_model(path))
            except Exception as error:
                self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
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
        route = urlparse(self.path).path
        if route == "/api/browse":
            self.handle_browse()
            return
        if route != "/api/render":
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
            use_pffdtd = (
                request.get("mode") in {"wave", "hybrid"}
                and request.get("wave-backend") == "pffdtd"
            )
            if use_pffdtd and not request.get("pffdtd-python"):
                pffdtd_python = self.server.pffdtd_python  # type: ignore[attr-defined]
                if not pffdtd_python:
                    raise ValueError("PFFDTD Python was not found; set VA_PFFDTD_PYTHON")
                request["pffdtd-python"] = str(pffdtd_python)
            prepare_pffdtd = (
                use_pffdtd
                and str(request.get("pffdtd-job-mode") or "existing") == "prepare"
            )
            if prepare_pffdtd:
                if str(request.get("pffdtd-execution") or "prepared") == "prepared":
                    raise ValueError(
                        "Preparing a job does not produce sim_outs.h5. "
                        "Choose Python CPU or a native CPU execution."
                    )
                inspected = inspect_pffdtd_model(required_text(request, "pffdtd-model"))
                source_xyz = inset_point(
                    [float(request["source-x"]), float(request["source-y"]), float(request["source-z"])],
                    inspected["bounds"],  # type: ignore[arg-type]
                )
                receiver_xyz = inset_point(
                    [float(request["receiver-x"]), float(request["receiver-y"]), float(request["receiver-z"])],
                    inspected["bounds"],  # type: ignore[arg-type]
                )
                placed_model = resolve_va_path(required_text(request, "pffdtd-output"), must_exist=False) / "model_placed.json"
                write_placed_pffdtd_model(
                    resolve_va_path(required_text(request, "pffdtd-model")),
                    placed_model,
                    source_xyz,
                    receiver_xyz,
                )
                request["pffdtd-model"] = str(placed_model)
                request["pffdtd-source"] = "1"
            if use_pffdtd:
                absolutize_pffdtd_paths(request, preparing=prepare_pffdtd)
            workdir = tempfile.TemporaryDirectory(prefix="va-synthesis-")
            try:
                source = Path(workdir.name) / "input.wav"
                result = Path(workdir.name) / "rendered.wav"
                source.write_bytes(audio)
                render_command = [str(self.server.renderer), "--input", str(source), "--output", str(result)]  # type: ignore[attr-defined]
                for key, value in request.items():
                    if key in RENDER_SKIP_KEYS or value is None or value == "":
                        continue
                    if isinstance(value, (list, dict)):
                        continue
                    render_command.extend(("--" + key, str(value).lower() if isinstance(value, bool) else str(value)))
                steps: list[tuple[str, list[str], Path]] = []
                if prepare_pffdtd:
                    steps.append((
                        "Preparing PFFDTD job…",
                        build_pffdtd_prepare_command(request, str(request["pffdtd-python"])),
                        VA_ROOT,
                    ))
                steps.append(("Computing pressure field…", render_command, ROOT))
                raw_stem = Path(str(request.get("fileName", "audio.wav"))).stem
                stem = "".join(character for character in raw_stem if character.isalnum() or character in "-_")[:80] or "audio"
                job = RenderJob(
                    steps=steps,
                    workdir=workdir,
                    stem=stem,
                    file_name=str(request.get("fileName", "audio.wav")),
                )
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

    def handle_browse(self) -> None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 65_536:
                raise ValueError("Invalid browse request")
            request = json.loads(self.rfile.read(length))
            kind = str(request.get("kind") or "").strip()
            if kind not in {"file", "directory"}:
                raise ValueError("kind must be file or directory")
            title = str(request.get("title") or "").strip() or (
                "Select a folder" if kind == "directory" else "Select a file"
            )
            types = request.get("types") or []
            if isinstance(types, str):
                types = [part.strip() for part in types.split(",") if part.strip()]
            if not isinstance(types, list):
                raise ValueError("types must be a list of extensions")
            types = [str(item).lstrip(".").strip() for item in types if str(item).strip()]
            initial = browse_anchor(str(request.get("initial") or ""))
            relative_raw = str(request.get("relativeTo") or "").strip()
            relative_to = browse_anchor(relative_raw) if relative_raw else None
            if relative_to is not None and relative_to.is_file():
                relative_to = relative_to.parent
            if as_bool(request.get("basename")) and relative_to is not None and relative_to.is_dir():
                name = Path(str(request.get("initial") or "")).name
                nested = relative_to / name if name else relative_to
                initial = nested if nested.exists() else relative_to
            if not BROWSE_LOCK.acquire(blocking=False):
                self.send_json({"error": "A file picker is already open"}, HTTPStatus.CONFLICT)
                return
            try:
                chosen = pick_native_path(kind=kind, title=title, initial=initial, types=types)
            finally:
                BROWSE_LOCK.release()
            if chosen is None:
                self.send_json({"path": None})
                return
            self.send_json({
                "path": display_selected_path(
                    chosen,
                    basename=as_bool(request.get("basename")),
                    relative_to=relative_to,
                )
            })
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
