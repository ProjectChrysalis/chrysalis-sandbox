// python3: CPython for WASI on the session store, the standard library
// mounted from its zip. The interpreter runs as its own WASI instance per
// call; network (urllib) and child processes (subprocess, os.system) reach
// the host through /dev/host, which sitecustomize wires up.
import { WasiShim, WasiExit } from "../vendor/wasi-sh/src/shim.mjs";
import { completeImports } from "./wasi-extra.mjs";
import { bytesSync, preloadBytes, preloadWasm, wasmSync } from "./loader.mjs";
import { fixedInput } from "./shell.mjs";
import { base64Decode, base64Encode } from "./node.mjs";

const WASM = "vendor/python/python.wasm";
const STDLIB = "vendor/python/python314.zip";
const STDLIB_PATH = "/usr/local/lib/python314.zip";
const VERSION = "Python 3.14.7";

export function preloadPython() {
  return Promise.all([preloadWasm(WASM), preloadBytes(STDLIB)]);
}

export function pythonCommands({ store, shell, net }) {
  const mount = () => {
    if (store.isFile(STDLIB_PATH)) return;
    store.quietly(() => store.writeFile(STDLIB_PATH, bytesSync(STDLIB), { borrow: true }));
  };

  const port = {
    request(verb, payload) {
      const req = JSON.parse(new TextDecoder().decode(payload));
      if (verb === "http") {
        const res = net.request({ url: req.url, method: req.method, headers: req.headers, body: req.body ? base64Decode(req.body) : null });
        return JSON.stringify({ status: res.status, headers: res.headers, body: res.error ? "" : base64Encode(res.body), error: res.error });
      }
      if (verb === "spawn") {
        const r = shell.capture({ ...req, stdin: base64Decode(req.stdin ?? "") });
        return JSON.stringify({ code: r.code, error: r.error, stdout: base64Encode(r.stdout ?? new Uint8Array()), stderr: base64Encode(r.stderr ?? new Uint8Array()) });
      }
      throw new Error(`unknown request ${verb}`);
    },
  };

  const python = (ctx) => {
    const args = ctx.args;
    if (args[0] === "--version" || args[0] === "-V") {
      ctx.print(`${VERSION}\n`);
      return 0;
    }
    if (args[0] === "-m" && (args[1] === "pip" || args[1] === "venv" || args[1] === "ensurepip")) return pip(ctx);
    mount();
    // The interpreter opens a script before sitecustomize enters the shell's
    // directory, so a relative script path is made absolute here.
    const argv = args.slice();
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === "-c" || a === "-m" || a === "-") break;
      if (a === "-W" || a === "-X" || a === "--check-hash-based-pycs") {
        i++;
        continue;
      }
      if (a.startsWith("-")) continue;
      if (!a.startsWith("/")) argv[i] = ctx.resolve(a);
      break;
    }
    // The interpreter reads a script from stdin only when no program is
    // given; everything else keeps stdin for the program.
    const shim = new WasiShim({
      args: ["python3", ...argv],
      env: {
        ...ctx.env,
        PWD: ctx.cwd,
        PYTHONHOME: "/usr/local",
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONUTF8: "1",
        LANG: "C.UTF-8",
        HOME: ctx.env.HOME || "/workspace",
      },
      files: {},
      fs: store,
      stdout: (b) => ctx.stdout(b),
      stderr: (b) => ctx.stderr(b),
      input: fixedInput(ctx.readAll()),
      host: port,
    });
    const imports = completeImports(shim, shim.imports());
    const instance = new WebAssembly.Instance(wasmSync(WASM), imports);
    shim.bindMemory(instance.exports.memory);
    try {
      instance.exports._start();
      return 0;
    } catch (error) {
      if (error instanceof WasiExit) return error.code;
      return ctx.fail(`python3: ${(error && error.message) || error}`);
    }
  };

  const pip = (ctx) =>
    ctx.fail(
      "pip: packages cannot be installed in the sandbox. The standard library is all here: json, csv, re, urllib for HTTP, zipfile, pathlib, datetime, statistics and the rest.",
    );

  return { python3: python, python: python, pip, pip3: pip };
}
