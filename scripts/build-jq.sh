#!/bin/sh
# Rebuild vendor/jq/jq.wasm: jq with its bundled oniguruma (regex functions
# included), compiled for WASI with zig and jq/wasi.c linked in.
# Needs zig (0.15.x); set ZIG_DIR to a zig folder when it is not on PATH.
set -e
repo=$(cd "$(dirname "$0")/.." && pwd)
work="${WORK:-$repo/cache/jq}"
JQ_VERSION=1.7.1
JQ_SHA256=478c9ca129fd2e3443fe27314b455e211e0d8c60bc8ff7df703873deeee580c2

[ -n "$ZIG_DIR" ] && PATH="$ZIG_DIR:$PATH"
command -v zig >/dev/null || { echo "zig is not on PATH (or set ZIG_DIR)" >&2; exit 1; }
zig=$(command -v zig)

mkdir -p "$work"
tarball="$work/jq-$JQ_VERSION.tar.gz"
[ -f "$tarball" ] || curl -sSfLo "$tarball" "https://github.com/jqlang/jq/releases/download/jq-$JQ_VERSION/jq-$JQ_VERSION.tar.gz"
echo "$JQ_SHA256  $tarball" | sha256sum -c - >/dev/null
rm -rf "$work/jq-$JQ_VERSION"
tar -C "$work" -xzf "$tarball"
src="$work/jq-$JQ_VERSION"

cat > "$work/cc" <<CC
#!/bin/sh
exec "$zig" cc --target=wasm32-wasi -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_PROCESS_CLOCKS -lwasi-emulated-signal -lwasi-emulated-mman -lwasi-emulated-process-clocks "\$@"
CC
chmod +x "$work/cc"
"$work/cc" -O2 -c "$repo/jq/wasi.c" -o "$work/wasi.o"
(cd "$src" && CC="$work/cc" AR="$zig ar" RANLIB="$zig ranlib" ./configure --host=wasm32-wasi \
  --with-oniguruma=builtin --disable-docs --disable-maintainer-mode --disable-valgrind \
  --disable-shared --enable-static --enable-all-static >/dev/null)
make -C "$src/modules/oniguruma" -j"$(nproc)" >/dev/null
make -C "$src" src/builtin.inc src/config_opts.inc src/version.h >/dev/null
make -C "$src" -j"$(nproc)" libjq.la >/dev/null
make -C "$src" jq LIBS="$work/wasi.o" >/dev/null
mkdir -p "$repo/vendor/jq"
bun "$repo/scripts/strip-wasm.ts" "$src/jq" "$repo/vendor/jq/jq.wasm"
cp "$src/COPYING" "$repo/vendor/jq/COPYING"
echo "installed vendor/jq/jq.wasm ($(wc -c < "$repo/vendor/jq/jq.wasm") bytes)"
