/**
 * vendor/python: CPython for WASI (the official-recipe builds published by
 * brettcannon/cpython-wasi-build), made small enough to ship:
 *   python.wasm       the interpreter with its DWARF and name sections dropped
 *   python314.zip     the standard library as bytecode, stored (zipimport
 *                     reads it without zlib, which this build lacks), minus
 *                     what cannot work without processes, sockets or C
 *                     extensions the build does not have
 * The bytecode is compiled by this same interpreter, running on the sandbox's
 * own shim, so its magic number always matches.
 *
 *   bun scripts/build-python.ts
 */
import fs from "node:fs";
import path from "node:path";
import { unzipSync, zipSync } from "fflate";
import { WasiShim, WasiExit } from "../vendor/wasi-sh/src/shim.mjs";
import { completeImports } from "../runtime/wasi-extra.mjs";
import { Store } from "../runtime/store.mjs";
import { stripCustomSections } from "./strip-wasm";

const RELEASE = {
  version: "3.14.7",
  url: "https://github.com/brettcannon/cpython-wasi-build/releases/download/v3.14.7/python-3.14.7-wasi_sdk-24.zip",
  sha256: "2e064d3fb8172471d39d741348efa722349c40b96301f69968dff714999c584b",
};
const LIB = "lib/python3.14/";
const SKIP_DIRS = new Set(["test", "tests", "idle_test", "idlelib", "tkinter", "turtledemo", "ensurepip", "venv", "pydoc_data", "_pyrepl", "ctypes", "sqlite3", "dbm", "multiprocessing", "curses", "__phello__", "lib2to3", "site-packages"]);
const SKIP_FILES = new Set(["turtle.py", "antigravity.py", "this.py", "pty.py", "tty.py"]);

const root = path.resolve(import.meta.dir, "..");
const out = path.join(root, "vendor", "python");
const cache = path.join(root, "cache", `python-${RELEASE.version}.zip`);

if (!fs.existsSync(cache)) {
  console.log(`fetching CPython ${RELEASE.version} for WASI ...`);
  const res = await fetch(RELEASE.url);
  if (!res.ok) throw new Error(`${RELEASE.url}: HTTP ${res.status}`);
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, new Uint8Array(await res.arrayBuffer()));
}
const archive = new Uint8Array(fs.readFileSync(cache));
const hash = new Bun.CryptoHasher("sha256").update(archive).digest("hex");
if (hash !== RELEASE.sha256) throw new Error(`python archive sha256 mismatch: ${hash}`);
const entries = unzipSync(archive);

// ---- the interpreter, custom sections dropped
const pythonWasm = stripCustomSections(entries["python.wasm"]!);

// ---- the standard library, compiled in place by the interpreter itself
const store = new Store({ tracked: [] });
const libRoot = "/usr/local/lib/python3.14";
for (const [name, bytes] of Object.entries(entries)) {
  if (!name.startsWith(LIB) || name.endsWith("/")) continue;
  const rel = name.slice(LIB.length);
  const parts = rel.split("/");
  if (parts.slice(0, -1).some((d) => SKIP_DIRS.has(d)) || SKIP_FILES.has(rel)) continue;
  if (!rel.endsWith(".py")) continue;
  store.writeFile(`${libRoot}/${rel}`, bytes, { borrow: true });
}
store.writeFile(`${libRoot}/sitecustomize.py`, new Uint8Array(fs.readFileSync(path.join(root, "runtime", "sitecustomize.py"))));

const module = new WebAssembly.Module(pythonWasm);
const errors: string[] = [];
const shim = new WasiShim({
  args: ["python3", "-I", "-m", "compileall", "-q", "-b", "-d", libRoot, libRoot],
  env: { PYTHONHOME: "/usr/local", LANG: "C.UTF-8" },
  files: {},
  fs: store,
  stdout: (b: Uint8Array) => errors.push(new TextDecoder().decode(b)),
  stderr: (b: Uint8Array) => errors.push(new TextDecoder().decode(b)),
});
const instance = new WebAssembly.Instance(module, completeImports(shim, shim.imports()) as WebAssembly.Imports);
shim.bindMemory(instance.exports.memory as WebAssembly.Memory);
let code = 0;
try {
  (instance.exports._start as () => void)();
} catch (error) {
  if (!(error instanceof WasiExit)) throw error;
  code = (error as WasiExit).code;
}
if (code !== 0) throw new Error(`compileall failed (${code}):\n${errors.join("")}`);

const zipped: Record<string, [Uint8Array, { level: 0 }]> = {};
for (const file of store.walk(libRoot)) {
  if (!file.endsWith(".pyc")) continue;
  zipped[file.slice(libRoot.length + 1)] = [store.readFile(file)!.slice(), { level: 0 }];
}
const stdlib = zipSync(zipped, { level: 0 });

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "python.wasm"), pythonWasm);
fs.writeFileSync(path.join(out, "python314.zip"), stdlib);
fs.writeFileSync(path.join(out, "LICENSE"), entries["LICENSE"]!);
console.log(`python.wasm ${(pythonWasm.length / 1e6).toFixed(1)}MB, python314.zip ${(stdlib.length / 1e6).toFixed(1)}MB (${Object.keys(zipped).length} modules)`);
