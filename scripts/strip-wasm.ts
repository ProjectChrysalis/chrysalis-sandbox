/**
 * Drop a wasm module's custom sections (DWARF, names, producers): they are
 * most of a debug build's size and nothing at runtime reads them.
 *
 *   bun scripts/strip-wasm.ts in.wasm out.wasm
 */
import fs from "node:fs";

export function stripCustomSections(wasm: Uint8Array): Uint8Array {
  const keep: Uint8Array[] = [wasm.subarray(0, 8)];
  let p = 8;
  const leb = () => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = wasm[p++]!;
      result |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return result >>> 0;
  };
  while (p < wasm.length) {
    const start = p;
    const id = wasm[p++]!;
    const size = leb();
    p += size;
    if (id !== 0) keep.push(wasm.subarray(start, p));
  }
  const merged = new Uint8Array(keep.reduce((n, b) => n + b.length, 0));
  let off = 0;
  for (const b of keep) {
    merged.set(b, off);
    off += b.length;
  }
  return merged;
}

if (import.meta.main) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error("usage: bun scripts/strip-wasm.ts in.wasm out.wasm");
  fs.writeFileSync(output, stripCustomSections(new Uint8Array(fs.readFileSync(input))));
}
