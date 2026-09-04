# VA Synthesis GUI

A local browser-based workbench for the [`va-synthesis`](submodules/va-synthesis) virtual acoustics engine. Drop in a WAV file, place a source and listener in a room, choose a propagation model, adjust its parameters, and download the rendered result.

## Run

Requirements: CMake 3.22+, a C++20 compiler, and Python 3.10+.

```sh
git submodule update --init --recursive
./scripts/build.sh
python3 app.py
```

Open <http://127.0.0.1:8765> if the browser does not open automatically. Audio stays on the local machine. The current file host accepts PCM WAV (16/24/32-bit) and 32-bit float WAV, downmixes multichannel input to mono, and exports a normalized mono 24-bit WAV.

## Acoustic modes

- **Geometrical** uses BRTLibrary's scattering delay network when BRT is built, with deterministic specular ray tracing as its portable fallback. Both use a generated six-surface shoebox room with material absorption, reflections, distance attenuation, and travel-time delay.
- **Wave-based** uses the compact reference Cartesian FDTD solver by default, so the application works without external runtime dependencies.
- **Hybrid** combines low-frequency FDTD and high-frequency ray-traced room impulse responses at an adjustable crossover.

## Initialize BRTLibrary and PFFDTD

Initialize `va-synthesis` and all of its nested dependencies from the GUI repository root:

```sh
git submodule update --init --recursive
```

This fetches BRTLibrary, its Eigen and rapidobj dependencies, and PFFDTD at the commits pinned by `va-synthesis`.

PFFDTD needs a Python interpreter that can import its numerical packages. The pinned fork lists those packages under `submodules/va-synthesis/submodules/pffdtd/python/`. Create that environment with any tool you prefer, then point this app at the resulting interpreter:

```sh
export VA_PFFDTD_PYTHON=/absolute/path/to/python
"$VA_PFFDTD_PYTHON" -c \
  'import h5py, numba, numpy, resampy, scipy; import sys; print(sys.executable)'
```

For example, if you followed the PFFDTD setup from the va-synthesis repo, you should have:

```sh
export VA_PFFDTD_PYTHON=~/miniforge3/envs/va-pffdtd/bin/python
"$VA_PFFDTD_PYTHON" -c \
  'import h5py, numba, numpy, resampy, scipy; import sys; print(sys.executable)'
```

If `VA_PFFDTD_PYTHON` is unset, the app uses `python3` (then `python`) from `PATH`. You can also set the interpreter in the Advanced PFFDTD fields.

Then rebuild so CMake enables both adapters:

```sh
./scripts/build.sh
grep 'VA_ENABLE_BRT\|VA_ENABLE_PFFDTD' build/CMakeCache.txt
```

Both cache values should be `ON`.

The Advanced section for wave/hybrid modes can then select the production PFFDTD adapter. PFFDTD still requires a prepared simulation job matching the configured source and receiver count. See [`pffdtd.md`](submodules/va-synthesis/docs/pffdtd.md) for job preparation and execution details. Upstream currently notes that macOS support is limited by Python multiprocessing/pickling behavior; the environment and adapter are installed here, but some full simulations may still require Linux.

At the currently pinned revisions, BRT's SDN self-check passes on this machine and is the automatic geometrical default. The BRT image-source adapter compiles but does not produce reflected arrivals in its upstream regression test; the app's capability indicator reports that method as limited instead of silently claiming it is ready.

## Architecture

The dependency-free Python host only serves static assets, accepts the local WAV upload, and starts `build/va_render`. The C++ renderer owns WAV conversion, constructs the neutral `va::Scene`, selects a `va::PropagationSolver`, calls `va::Engine::render`, and writes the output WAV. This keeps all acoustics and convolution inside `va-synthesis` rather than reimplementing it in the UI.
