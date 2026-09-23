// `node`: QuickJS-ng with the Node surface from node-prelude.mjs. Scripts run
// to completion synchronously: promise jobs drain between timers, and timers
// fire in order on a fast-forwarded clock, so async code finishes instead of
// being cut off when the call returns. CommonJS and ES modules both load from
// the workspace; npm packages are not installed here.
import { deflateSync, gunzipSync, gzipSync, inflateSync, unzlibSync, zlibSync } from "../vendor/fflate/fflate.mjs";
import { prelude } from "./node-prelude.mjs";
import { digest } from "./digest.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const VERSION = "v22.0.0";

let QuickJS = null;
export async function preloadNode() {
  if (QuickJS) return;
  const { newQuickJSWASMModuleFromVariant, variant } = await import("../vendor/quickjs/quickjs.mjs");
  QuickJS = await newQuickJSWASMModuleFromVariant(variant);
}

const USAGE = "Usage: node [-e code | -p code | script.js] [arguments]\n";

export function nodeCommands({ store, shell, net }) {
  const node = (ctx) => {
    const args = ctx.args.slice();
    let code = null;
    let filename = null;
    let print = false;
    let module = false;
    while (args.length && args[0].startsWith("-")) {
      const a = args.shift();
      if (a === "-v" || a === "--version") {
        ctx.print(`${VERSION}\n`);
        return 0;
      }
      if (a === "-h" || a === "--help") {
        ctx.print(USAGE);
        return 0;
      }
      if (a === "-e" || a === "--eval" || a === "-p" || a === "--print") {
        code = args.shift() ?? "";
        print = a === "-p" || a === "--print";
        break;
      }
      if (a === "--input-type=module") module = true;
      else if (a === "-" || a === "--") break;
      // --experimental-*, --no-warnings, --enable-source-maps: nothing to do
    }
    if (code === null) {
      if (args.length && args[0] !== "-") {
        filename = ctx.resolve(args.shift());
        const bytes = store.readFile(filename);
        if (!bytes) return ctx.fail(`node: cannot find module '${filename}'`);
        code = decoder.decode(bytes).replace(/^#!.*/, "");
        if (filename.endsWith(".mjs")) module = true;
        else if (!filename.endsWith(".cjs")) module = looksLikeModule(code) || nearestPackageType(filename) === "module";
      } else {
        if (args[0] === "-") args.shift();
        code = decoder.decode(ctx.readAll());
        module ||= looksLikeModule(code);
      }
    } else if (!module) module = looksLikeModule(code) && !print;
    if (!QuickJS) return ctx.fail("node: the JavaScript engine did not load");
    return run(ctx, { code, filename, argv: ["/usr/bin/node", ...(filename ? [filename] : []), ...args], print, module });
  };

  const nearestPackageType = (file) => {
    for (let dir = file.slice(0, file.lastIndexOf("/")); dir; dir = dir.slice(0, dir.lastIndexOf("/"))) {
      const bytes = store.readFile(`${dir}/package.json`);
      if (bytes) {
        try {
          return JSON.parse(decoder.decode(bytes)).type ?? "commonjs";
        } catch {
          return "commonjs";
        }
      }
    }
    return "commonjs";
  };

  const run = (ctx, { code, filename, argv, print, module }) => {
    const runtime = QuickJS.newRuntime();
    runtime.setMaxStackSize(4 * 1024 * 1024);
    const vm = runtime.newContext();
    let exitCode = null;
    let httpBody = new Uint8Array(0);
    const host = vm.newObject();

    const toHandle = (value) => {
      if (value === undefined || value === null) return vm.undefined;
      if (typeof value === "string") return vm.newString(value);
      if (typeof value === "number") return vm.newNumber(value);
      if (value instanceof Uint8Array) return vm.newArrayBuffer(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
      if (value instanceof ArrayBuffer) return vm.newArrayBuffer(value);
      return vm.newString(String(value));
    };
    const fromHandle = (h) => {
      const type = vm.typeof(h);
      if (type === "string") return vm.getString(h);
      if (type === "number") return vm.getNumber(h);
      if (type === "boolean") return vm.dump(h);
      if (type === "undefined") return undefined;
      try {
        const life = vm.getArrayBuffer(h);
        const copy = life.value.slice();
        life.dispose();
        return copy;
      } catch {
        return vm.dump(h);
      }
    };
    const define = (name, fn) => {
      const f = vm.newFunction(name, (...hs) => {
        const result = fn(...hs.map(fromHandle));
        return result && typeof result === "object" && result.__handle ? result.__handle : toHandle(result);
      });
      vm.setProp(host, name, f);
      f.dispose();
    };
    const fsError = (code, message) => {
      throw new Error(`${code} ${message}`);
    };
    const bytesArg = (b) => (b instanceof Uint8Array ? b : encoder.encode(String(b ?? "")));

    define("write", (fd, data) => {
      const bytes = typeof data === "string" ? encoder.encode(data) : bytesArg(data);
      if (fd === 2) ctx.stderr(bytes);
      else ctx.stdout(bytes);
    });
    define("stdin", () => ctx.readAll());
    define("exit", (code) => {
      exitCode ??= Number(code) & 0xff;
    });
    define("compile", (file, source) => {
      const r = vm.evalCode(`(function (exports, require, module, __filename, __dirname) {${source}\n})`, file);
      if (r.error) {
        const message = describe(r.error);
        r.error.dispose();
        throw new SyntaxError(message);
      }
      return { __handle: r.value };
    });
    define("fs", (op, a, b, c) => {
      const isDir = (p) => store.isDir(p);
      switch (op) {
        case "read": {
          if (isDir(a)) fsError("EISDIR", "illegal operation on a directory");
          const bytes = store.readFile(a);
          if (!bytes) fsError("ENOENT", "no such file or directory");
          return bytes.slice();
        }
        case "write": {
          const parent = a.slice(0, a.lastIndexOf("/")) || "/";
          if (!isDir(parent)) fsError("ENOENT", "no such file or directory");
          if (isDir(a)) fsError("EISDIR", "illegal operation on a directory");
          const data = bytesArg(b);
          if (c && store.isFile(a)) {
            const size = store.statSync(a).size;
            store.writeSync(a, data, size);
          } else store.writeFile(a, data);
          return undefined;
        }
        case "exists":
          return store.exists(a) ? "1" : "0";
        case "isfile":
          return store.isFile(a) ? "1" : "0";
        case "stat": {
          if (!store.exists(a)) fsError("ENOENT", "no such file or directory");
          const st = store.statSync(a);
          return JSON.stringify({ dir: isDir(a), size: st.size, mtimeMs: st.mtimeMs, mode: st.mode, ino: st.ino });
        }
        case "readdir": {
          if (!store.exists(a)) fsError("ENOENT", "no such file or directory");
          if (!isDir(a)) fsError("ENOTDIR", "not a directory");
          const out = [];
          const walk = (dir, rel) => {
            for (const name of store.readdirSync(dir).sort()) {
              const full = `${dir.replace(/\/$/, "")}/${name}`;
              const d = isDir(full);
              out.push([rel ? `${rel}/${name}` : name, d]);
              if (b && d) walk(full, rel ? `${rel}/${name}` : name);
            }
          };
          walk(a, "");
          return JSON.stringify(out);
        }
        case "mkdir": {
          if (b) {
            store.mkdirp(a);
            return undefined;
          }
          if (store.exists(a)) fsError("EEXIST", "file already exists");
          const parent = a.slice(0, a.lastIndexOf("/")) || "/";
          if (!isDir(parent)) fsError("ENOENT", "no such file or directory");
          store.mkdirSync(a, { mode: 0o755 });
          return undefined;
        }
        case "rm":
        case "rmdir": {
          if (!store.exists(a)) {
            if (op === "rm" && c) return undefined;
            fsError("ENOENT", "no such file or directory");
          }
          if (isDir(a) && !b) {
            if (op === "rm") fsError("EISDIR", "is a directory (use recursive)");
            if (store.readdirSync(a).length) fsError("ENOTEMPTY", "directory not empty");
          }
          store.remove(a);
          return undefined;
        }
        case "unlink":
          if (!store.exists(a)) fsError("ENOENT", "no such file or directory");
          if (isDir(a)) fsError("EISDIR", "is a directory");
          store.unlinkSync(a);
          return undefined;
        case "rename":
          if (!store.exists(a)) fsError("ENOENT", "no such file or directory");
          store.mkdirp(b.slice(0, b.lastIndexOf("/")) || "/");
          if (store.isFile(b) && store.isFile(a)) store.unlinkSync(b);
          store.renameSync(a, b);
          return undefined;
        case "copy": {
          const bytes = store.readFile(a);
          if (!bytes) fsError("ENOENT", "no such file or directory");
          store.writeFile(isDir(b) ? `${b}/${a.split("/").pop()}` : b, bytes);
          return undefined;
        }
        case "cp": {
          if (!store.exists(a)) fsError("ENOENT", "no such file or directory");
          if (isDir(a)) {
            if (!c) fsError("EISDIR", "is a directory (use recursive)");
            for (const file of store.walk(a)) store.writeFile(b + file.slice(a.length), store.readFile(file));
            store.mkdirp(b);
          } else store.writeFile(b, store.readFile(a));
          return undefined;
        }
        default:
          fsError("ENOSYS", `unsupported operation ${op}`);
      }
      return undefined;
    });
    define("spawn", (json) => {
      const req = JSON.parse(json);
      const r = shell.capture({ ...req, stdin: base64Decode(req.stdin ?? "") });
      return JSON.stringify({ code: r.code, error: r.error, stdout: base64Encode(r.stdout ?? new Uint8Array()), stderr: base64Encode(r.stderr ?? new Uint8Array()) });
    });
    define("http", (json, body) => {
      const req = JSON.parse(json);
      const res = net.request({ url: req.url, method: req.method, headers: req.headers, body: body && body.length ? body : null });
      httpBody = res.body;
      return JSON.stringify({ status: res.status, headers: res.headers, error: res.error });
    });
    define("httpBody", () => httpBody);
    define("zlib", (op, data) => {
      const fns = { gzip: gzipSync, gunzip: gunzipSync, deflate: zlibSync, inflate: unzlibSync, deflateRaw: deflateSync, inflateRaw: inflateSync };
      return fns[op](data);
    });
    define("digest", (alg, data) => {
      const out = digest(alg, data);
      if (!out) throw new Error(`Digest method not supported: ${alg}`);
      return out;
    });
    for (const [name, value] of Object.entries({ argv: JSON.stringify(argv), env: JSON.stringify(ctx.env), cwd: ctx.cwd, execPath: "/usr/bin/node" })) {
      const h = vm.newString(value);
      vm.setProp(host, name, h);
      h.dispose();
    }
    vm.setProp(vm.global, "__host", host);
    host.dispose();

    const describe = (errorHandle) => {
      const stack = vm.getProp(errorHandle, "stack");
      const message = vm.getProp(errorHandle, "message");
      const name = vm.getProp(errorHandle, "name");
      const s = vm.typeof(stack) === "string" ? vm.getString(stack) : "";
      const m = vm.typeof(message) === "string" ? vm.getString(message) : "";
      const n = vm.typeof(name) === "string" ? vm.getString(name) : "";
      stack.dispose();
      message.dispose();
      name.dispose();
      if (!m && !n) {
        const dumped = vm.dump(errorHandle);
        return typeof dumped === "string" ? dumped : `Uncaught ${JSON.stringify(dumped)}`;
      }
      return `${n || "Error"}: ${m}${s ? `\n${s.replace(/\n$/, "")}` : ""}`;
    };
    const isExit = (errorHandle) => {
      const marker = vm.getProp(errorHandle, "__exit");
      const exit = vm.typeof(marker) === "boolean" && vm.dump(marker);
      marker.dispose();
      return exit;
    };
    // An uncaught error ends the program with status 1, as in Node; exit()
    // carries its own status.
    const settle = (errorHandle) => {
      if (isExit(errorHandle)) {
        const c = vm.getProp(errorHandle, "code");
        exitCode ??= Number(vm.dump(c)) & 0xff;
        c.dispose();
      } else {
        ctx.stderr(encoder.encode(`${describe(errorHandle)}\n`));
        exitCode ??= 1;
      }
      errorHandle.dispose();
    };
    const evalOrSettle = (source, file) => {
      const r = vm.evalCode(source, file);
      if (r.error) {
        settle(r.error);
        return null;
      }
      return r.value;
    };
    const drain = () => {
      for (;;) {
        if (exitCode !== null) return;
        const jobs = runtime.executePendingJobs(-1);
        if (jobs.error) {
          settle(jobs.error);
          return;
        }
        if (exitCode !== null) return;
        const more = evalOrSettle("__nextTimer()", "<timers>");
        if (more === null) return;
        const again = vm.dump(more);
        more.dispose();
        if (!again) {
          if (runtime.hasPendingJob()) continue;
          return;
        }
      }
    };

    try {
      const setup = evalOrSettle(`(${prelude.toString()})(globalThis, globalThis.__host)`, "<node>");
      if (setup === null) return exitCode ?? 1;
      setup.dispose();
      const exportsOf = evalOrSettle("JSON.stringify(Object.fromEntries(Object.entries(__builtins).map(([k, v]) => [k, Object.keys(v).filter((n) => /^[A-Za-z_$][\\w$]*$/.test(n) && n !== 'default')])))", "<node>");
      const builtinExports = JSON.parse(vm.getString(exportsOf));
      exportsOf.dispose();

      if (module) {
        runtime.setModuleLoader(
          (name) => {
            if (name.startsWith("node:")) {
              const key = name.slice(5);
              const names = builtinExports[key] ?? [];
              return `const m = globalThis.__builtins[${JSON.stringify(key)}];\nexport default m;\n${names.map((n) => `export const ${n} = m[${JSON.stringify(n)}];`).join("\n")}`;
            }
            const file = name.replace(/^file:\/\//, "");
            const bytes = store.readFile(file);
            if (!bytes) throw new Error(`Cannot find module '${file}'`);
            const text = decoder.decode(bytes).replace(/^#!.*/, "");
            if (file.endsWith(".json")) return `export default ${text};`;
            if (file.endsWith(".cjs") || (!file.endsWith(".mjs") && !looksLikeModule(text) && nearestPackageType(file) !== "module")) {
              return `const m = globalThis.__makeRequire(${JSON.stringify(file.slice(0, file.lastIndexOf("/")) || "/")})(${JSON.stringify(file)});\nexport default m;`;
            }
            return withImportMeta(text, file);
          },
          (base, request) => {
            const r = request.replace(/^node:/, "");
            if (Object.hasOwn(builtinExports, r)) return `node:${r}`;
            const from = base.replace(/^file:\/\//, "");
            const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) || "/" : ctx.cwd;
            const spec = request.replace(/^file:\/\//, "");
            const resolved = resolveModuleFile(store, spec.startsWith("/") ? spec : `${dir}/${spec}`);
            if (!resolved) throw new Error(`Cannot find module '${request}' imported from ${from}`);
            return `file://${resolved}`;
          },
        );
        const main = filename ?? `${ctx.cwd.replace(/\/$/, "")}/[eval1]`;
        const r = vm.evalCode(withImportMeta(code, main), `file://${main}`, { type: "module" });
        if (r.error) settle(r.error);
        else {
          drain();
          const state = vm.getPromiseState(r.value);
          if (state.type === "rejected") {
            settle(state.error);
          } else if (state.type === "fulfilled" && state.value && state.value !== r.value) state.value.dispose?.();
          r.value.dispose();
        }
      } else {
        const file = filename ?? "[eval]";
        const source = filename ? `__loadCjs({ exports: {}, filename: ${JSON.stringify(file)}, id: ".", loaded: false, children: [], paths: [] }, ${JSON.stringify(file)}, ${JSON.stringify(code)})` : code;
        const r = vm.evalCode(source, file);
        if (r.error) settle(r.error);
        else {
          if (print) {
            const shown = vm.evalCode("(v) => __builtins.util.inspect(v)", "<print>");
            const text = vm.callFunction(shown.value, vm.undefined, r.value);
            ctx.stdout(encoder.encode(`${vm.getString(text.value)}\n`));
            text.value.dispose();
            shown.value.dispose();
          }
          r.value.dispose();
          drain();
        }
      }
      if (exitCode === null || exitCode === 0) {
        const code = exitCode ?? 0;
        const done = vm.evalCode(`(() => { const c = process.exitCode ?? ${code}; process.emit("exit", c); return c; })()`, "<exit>");
        if (done.error) settle(done.error);
        else {
          exitCode ??= Number(vm.dump(done.value)) & 0xff;
          done.value.dispose();
        }
      }
      return exitCode ?? 0;
    } finally {
      try {
        vm.dispose();
        runtime.dispose();
      } catch {
        // a context with leaked handles still frees its memory with the runtime
      }
    }
  };

  const notAvailable = (name) => (ctx) =>
    ctx.fail(`${name}: npm packages cannot be installed in the sandbox. Write the code with Node's built-ins, or ask for an app dependency (app_deps runs outside the sandbox).`);
  return { node, nodejs: node, npm: notAvailable("npm"), npx: notAvailable("npx"), yarn: notAvailable("yarn"), pnpm: notAvailable("pnpm") };
}

function looksLikeModule(code) {
  return /^\s*(import\s*[\w{*'"]|export\s+(default|const|let|var|function|class|async|\{|\*))/m.test(code) || /\bimport\.meta\b/.test(code) || /^\s*await\s/m.test(code);
}

/** import.meta comes from quickjs-libc, which this build does not include,
 *  so the fields scripts use are written into the source as it loads. */
function withImportMeta(code, file) {
  const dir = file.slice(0, file.lastIndexOf("/")) || "/";
  return code
    .replace(/\bimport\.meta\.url\b/g, JSON.stringify(`file://${file}`))
    .replace(/\bimport\.meta\.filename\b/g, JSON.stringify(file))
    .replace(/\bimport\.meta\.dirname\b/g, JSON.stringify(dir))
    .replace(/\bimport\.meta\.main\b/g, "true");
}

function resolveModuleFile(store, base) {
  const norm = base.replace(/\/\.\//g, "/").replace(/\/+/g, "/");
  const clean = [];
  for (const part of norm.split("/")) {
    if (part === "..") clean.pop();
    else if (part && part !== ".") clean.push(part);
  }
  const p = `/${clean.join("/")}`;
  for (const candidate of [p, `${p}.js`, `${p}.mjs`, `${p}.cjs`, `${p}.json`, `${p}/index.js`, `${p}/index.mjs`]) {
    if (store.isFile(candidate)) return candidate;
  }
  return null;
}

export function base64Encode(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64Decode(text) {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
