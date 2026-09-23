#!/bin/sh
# Rebuild vendor/wasi-sh/dist/busybox.wasm: wasi-sh's own build at the pinned
# release, with this repo's config (busybox/busybox.config) and patches:
#   busybox/wasistubs.patch  child commands (xargs, find -exec, awk system()
#                            and pipes) run through the runtime's __host_spawn;
#                            stat() reports the store's permission bits
#   busybox/spawn.patch      spawn_and_wait() hands those children over
#   busybox/grep.patch       --include/--exclude/--exclude-dir, `grep -r` with
#                            no path searches ".", -r skips binary files
#   busybox/scripts.patch    ./script and /path/script reach the host, which
#                            runs them by their #! line
#   busybox/cmdsubst.patch   $(...) run in-process leaves the enclosing word's
#                            expansion state alone ("$@ $(cmd)" kept its fields)
# Needs zig (0.15.x); set ZIG_DIR to a zig folder when it is not on PATH.
set -e
repo=$(cd "$(dirname "$0")/.." && pwd)
work="${WORK:-$repo/cache/busybox}"
WASI_SH_REPO=https://github.com/alganet/wasi-sh.git
WASI_SH_COMMIT=53ac5800fbef5cf975d10c2677406ff30b5e37e5 # 0.11.0, the vendored src/

[ -n "$ZIG_DIR" ] && PATH="$ZIG_DIR:$PATH"
command -v zig >/dev/null || { echo "zig is not on PATH (or set ZIG_DIR)" >&2; exit 1; }

mkdir -p "$work"
src="$work/wasi-sh"
[ -d "$src/.git" ] || git clone -q "$WASI_SH_REPO" "$src"
git -C "$src" fetch -q origin "$WASI_SH_COMMIT" 2>/dev/null || true
git -C "$src" checkout -q -f "$WASI_SH_COMMIT"
git -C "$src" checkout -q -- build src

patch -s -p1 -d "$src" < "$repo/busybox/wasistubs.patch"
cp "$repo/busybox/busybox.config" "$src/build/busybox.config"
cp "$repo/busybox/spawn.patch" "$src/build/chrysalis-spawn.patch"
cp "$repo/busybox/grep.patch" "$src/build/chrysalis-grep.patch"
cp "$repo/busybox/scripts.patch" "$src/build/chrysalis-scripts.patch"
cp "$repo/busybox/cmdsubst.patch" "$src/build/chrysalis-cmdsubst.patch"
# Apply ours after wasi-sh's own patches, and drop its smoke test: that one
# runs the stock shim, which has no __host_spawn. bun test covers the binary.
sed -i.orig \
  -e 's|^patch -p1 -d "\$BB" < "\$here/applet-interrupt.patch"$|&\npatch -p1 -d "$BB" < "$here/chrysalis-spawn.patch"\npatch -p1 -d "$BB" < "$here/chrysalis-grep.patch"\npatch -p1 -d "$BB" < "$here/chrysalis-scripts.patch"\npatch -p1 -d "$BB" < "$here/chrysalis-cmdsubst.patch"|' \
  -e '/^# --- smoke test/,/^# dist\/ is not committed/{/^# dist\/ is not committed/!d;}' \
  -e 's|^  --wrap __wasilibc_fd_renumber \\$|  --wrap __wasilibc_fd_renumber --wrap stat --wrap lstat --wrap fstat --wrap fstatat \\|' \
  "$src/build/build.sh"
grep -q chrysalis-cmdsubst.patch "$src/build/build.sh" && grep -q "wrap fstatat" "$src/build/build.sh" || { echo "build.sh changed shape; update this script" >&2; exit 1; }

sh "$src/build/build.sh" --toolchain zig
cp "$src/dist/busybox.wasm" "$repo/vendor/wasi-sh/dist/busybox.wasm"
echo "installed vendor/wasi-sh/dist/busybox.wasm ($(wc -c < "$repo/vendor/wasi-sh/dist/busybox.wasm") bytes)"
