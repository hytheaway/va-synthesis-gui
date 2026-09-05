# va-synthesis-gui

A local browser-based workbench for the [`va-synthesis`](https://github.com/hytheaway/va-synthesis) virtual acoustics engine. Drop in a WAV file, place a source and listener in a room, choose a propagation model, adjust its parameters, and download the rendered result.

## Initialize, Build, and Run

Requirements: CMake 3.22+, a C++20 compiler, and Python 3.10+.

After cloning this repo, you'll need to create and validate virtual Python environment to install dependencies for PFFDTD to work properly. Follow these steps from this repo root (example shows Conda with miniforge3):

```sh
git submodule update --init --recursive
cd submodules/va-synthesis/submodules/pffdtd
conda create -n va-pffdtd -c conda-forge \
    python=3.11.15 \
    numpy=1.26.4 \
    h5py \
    scipy \
    numba \
    resampy \
    tqdm \
    psutil \
    memory_profiler \
    matplotlib \
    pytest
conda activate va-pffdtd
```

Navigate to the `va-synthesis` submodule root (`va-synthesis-gui/submodules/va-synthesis/`) and validate the environment:
```sh
cd ..
cd ..
python -m pip check
python -c "import numpy, h5py, scipy, numba, resampy, tqdm, psutil, memory_profiler, matplotlib"

python tools/prepare_pffdtd_job.py --help
python tools/pffdtd_bridge.py --help
```

If the CLI help menu appears for for each of these files, the packages have been installed successfully. Then, check imports across the PFFDTD integration:
```sh
PYTHONPATH="$PWD/submodules/pffdtd/python" \
python -c "from sim_setup import sim_setup; from fdtd.sim_fdtd import SimEngine; from fdtd.process_outputs import ProcessOutputs; print('PFFDTD imports passed')"
```

Navigate to this repo root (`va-synthesis-gui/`) and build:
```sh
cd ..
cd ..
./scripts/build.sh
```

PFFDTD needs a Python interpreter that can import its numerical packages. Those packages are under `va-synthesis-gui/submodules/va-synthesis/submodules/pffdtd/python/`. Create that environment with any tool you prefer, then point this app at the resulting interpreter:

```sh
export VA_PFFDTD_PYTHON=/absolute/path/to/python
"$VA_PFFDTD_PYTHON" -c \
  'import h5py, numba, numpy, resampy, scipy; import sys; print(sys.executable)'
```

For example, if you followed the PFFDTD setup from the [va-synthesis repo](https://github.com/hytheaway/va-synthesis), you should have:

```sh
export VA_PFFDTD_PYTHON=~/miniforge3/envs/va-pffdtd/bin/python
"$VA_PFFDTD_PYTHON" -c \
  'import h5py, numba, numpy, resampy, scipy; import sys; print(sys.executable)'
```

If `VA_PFFDTD_PYTHON` is unset, the app uses `python3` (then `python`) from `PATH`. You can also manually set the Python interpreter in the web app.

Then rebuild so CMake enables both adapters:

```sh
./scripts/build.sh
grep 'VA_ENABLE_BRT\|VA_ENABLE_PFFDTD' build/CMakeCache.txt
```

Both cache values should be `ON`. If so, you can finally run (with your enabled virtual environment) with:

```sh
python3 app.py
```

Open <http://127.0.0.1:8765> if the browser does not open automatically. Audio stays on the local machine. The current file host accepts PCM WAV (16/24/32-bit) and 32-bit float WAV, downmixes multichannel input to mono, and exports a normalized mono 24-bit WAV.

## Acoustic modes

- **Geometrical** uses BRTLibrary's scattering delay network when BRT is built, with deterministic specular ray tracing as its portable fallback. Both use a generated six-surface shoebox room with material absorption, reflections, distance attenuation, and travel-time delay.
- **Wave-based** uses a minimal FDTD solver by default. PFFDTD is selectable from the dropdown.
- **Hybrid** combines low-frequency FDTD (either minimal or PFFDTD) and high-frequency geometrical room impulse responses at an adjustable crossover.

## More info

PFFDTD is selectable as an option for both the wave and hybrid modes. PFFDTD still requires a prepared simulation job matching the configured source and receiver count. macOS has some multiprocessing/pickling issues, so make sure you are following the "Prepare a job" section of [pffdtd.md](https://github.com/hytheaway/va-synthesis/blob/main/docs/pffdtd.md) found in [`va-synthesis`](https://github.com/hytheaway/va-synthesis/). On Linux, you can avoid these issues by using `fork` instead of `spawn` for pickling. See [`pffdtd.md`](https://github.com/hytheaway/va-synthesis/blob/main/docs/pffdtd.md) for more info on this.

The Python host only serves static assets, accepts the local WAV upload, and starts `build/va_render`. The C++ renderer handles WAV conversion, constructs `va::Scene`, selects a `va::PropagationSolver`, calls `va::Engine::render`, and writes the output WAV.
