#!/bin/sh
set -eu
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cmake -S "$project_dir" -B "$project_dir/build" -DCMAKE_BUILD_TYPE=Release
cmake --build "$project_dir/build" --parallel
printf '\nBuilt %s\nRun: python3 %s/app.py\n' "$project_dir/build/va_render" "$project_dir"

