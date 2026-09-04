#!/usr/bin/env python3
"""Small dependency-free local host for the VA Synthesis browser UI."""

from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
import webbrowser


ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
MAX_UPLOAD = 128 * 1024 * 1024


def find_pffdtd_python() -> Path | None:
    configured = os.environ.get("VA_PFFDTD_PYTHON")
    candidates = [
        Path(configured).expanduser() if configured else None,
        Path.home() / "miniforge3" / "envs" / "va-pffdtd" / "bin" / "python",
        Path.home() / "miniforge3" / "envs" / "pffdtd" / "bin" / "python",
    ]
    return next((candidate for candidate in candidates if candidate and candidate.is_file()), None)


class Handler(SimpleHTTPRequestHandler):
    server_version = "VASynthesisGUI/0.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_ROOT), **kwargs)

    def do_GET(self) -> None:
        if urlparse(self.path).path == "/api/health":
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
                                component["detail"] = f"Adapter and Miniforge runtime verified: {pffdtd_python}"
                            else:
                                component["status"] = "limited"
                                component["detail"] = "Adapter is built, but the Miniforge runtime import check failed"
                        else:
                            component["status"] = "limited"
                            component["detail"] = "Adapter is built, but no PFFDTD Python environment was found"
                capabilities["renderer"] = str(renderer)
                self.send_json(capabilities)
            except Exception as error:
                self.send_json({"ready": False, "error": str(error)})
            return
        super().do_GET()

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
            with tempfile.TemporaryDirectory(prefix="va-synthesis-") as directory:
                source = Path(directory) / "input.wav"
                result = Path(directory) / "rendered.wav"
                source.write_bytes(audio)
                command = [str(self.server.renderer), "--input", str(source), "--output", str(result)]  # type: ignore[attr-defined]
                for key, value in request.items():
                    if key == "fileName" or value is None:
                        continue
                    command.extend(("--" + key, str(value).lower() if isinstance(value, bool) else str(value)))
                completed = subprocess.run(
                    command, cwd=ROOT, capture_output=True, text=True, timeout=900, check=False
                )
                if completed.returncode != 0:
                    message = completed.stderr.strip().removeprefix("error: ")
                    raise RuntimeError(message or "The acoustic renderer failed")
                payload = result.read_bytes()
            raw_stem = Path(str(request.get("fileName", "audio.wav"))).stem
            stem = "".join(character for character in raw_stem if character.isalnum() or character in "-_")[:80] or "audio"
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Disposition", f'attachment; filename="{stem}-va.wav"')
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("X-VA-Message", completed.stdout.strip())
            self.end_headers()
            self.wfile.write(payload)
        except (ValueError, KeyError, json.JSONDecodeError) as error:
            self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
        except subprocess.TimeoutExpired:
            self.send_json({"error": "The simulation exceeded the 15 minute limit"}, HTTPStatus.REQUEST_TIMEOUT)
        except Exception as error:
            self.send_json({"error": str(error)}, HTTPStatus.UNPROCESSABLE_ENTITY)

    def send_json(self, value: object, status: HTTPStatus = HTTPStatus.OK) -> None:
        payload = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, message: str, *args: object) -> None:
        print(f"[va-gui] {message % args}")


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
    url = f"http://{args.host}:{args.port}"
    print(f"VA Synthesis is running at {url}")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping VA Synthesis")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
