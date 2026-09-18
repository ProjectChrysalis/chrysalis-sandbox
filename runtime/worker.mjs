// Custom wasi-sh worker for the Chrysalis sandbox: mounts files into an
// in-memory store, answers `snapshot` requests with the resulting tree, and
// registers host builtins: git (vendored libgit2), python3 (MicroPython on
// wasi) and node (QuickJS) — all synchronous, all on the same store.
// One worker hosts one guest run; the page keeps it alive to collect changes,
// then terminates it.
import { serve } from "../vendor/wasi-sh/src/worker.mjs";
import { hostBuiltins } from "../vendor/wasi-sh/src/options.mjs";
import { WasiShim, WasiExit } from "../vendor/wasi-sh/src/shim.mjs";
import { createStore } from "./store.mjs";
import { makeExtraTools } from "./tools.mjs";

const store = createStore();

/** Routes libgit2's stdout/stderr into the guest call currently running. */
const sinks = { out: null, err: null };

function fixedInput(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data ?? []);
  let off = 0;
  return {
    pollReadable: () => off < bytes.length,
    read(max) {
      const take = bytes.subarray(off, Math.min(off + max, bytes.length));
      off += take.length;
      return take;
    },
    readBlocking(max) {
      return this.read(max);
    },
    wait: () => {},
    closed: () => off >= bytes.length,
  };
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const bytesToB64String = (bytes) => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(bin);
};
const b64ToBytes = (b64) => {
  const bin = atob(String(b64));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
};
const concatBytes = (a, b) => {
  const out = new Uint8Array((a?.length ?? 0) + b.length);
  if (a) out.set(a, 0);
  out.set(b, a?.length ?? 0);
  return out;
};

async function builtins() {
  // ---------------------------------------------------------------- python
  const pythonBytes = await fetch(new URL("../vendor/micropython/micropython-wasi.wasm", import.meta.url)).then((r) => {
    if (!r.ok) throw new Error(`micropython wasm: HTTP ${r.status}`);
    return r.arrayBuffer();
  });
  const pythonModule = await WebAssembly.compile(pythonBytes);

  const runPython = (ctx) => {
    const stdinBytes = typeof ctx.stdin === "function" ? ctx.stdin() : new Uint8Array();
    const cwd = ctx.cwd ?? "/workspace";
    // WASI has no process cwd: a fresh instance starts at the preopen root,
    // so make the shell's cwd explicit before user code runs.
    const raw = ctx.argv.slice(1);
    let args = raw;
    if (raw[0] === "-c" && raw.length > 1) {
      args = ["-c", `import os as _os\n_os.chdir(${JSON.stringify(cwd)})\n${raw.slice(1).join(" ")}`];
    } else if (raw.length > 0 && !raw[0].startsWith("-")) {
      const script = raw[0].startsWith("/") ? raw[0] : `${cwd.replace(/\/$/, "")}/${raw[0]}`;
      const rest = raw.slice(1);
      args = [
        "-c",
        [
          "import os as _os, sys as _sys",
          `_os.chdir(${JSON.stringify(cwd)})`,
          "try:",
          `    _sys.argv = ${JSON.stringify([raw[0], ...rest])}`,
          "except Exception:",
          "    pass",
          `exec(open(${JSON.stringify(script)}).read())`,
          "",
        ].join("\n"),
      ];
    }
    const shim = new WasiShim({
      args: ["micropython", ...args],
      env: { HOME: "/workspace", PWD: cwd, TERM: "dumb", LANG: "C.UTF-8" },
      files: {},
      fs: store,
      stdout: (text) => ctx.stdout(text),
      stderr: (text) => ctx.stderr(text),
      input: fixedInput(stdinBytes),
    });
    try {
      const imports = shim.imports();
      const wasi = (imports.wasi_snapshot_preview1 ??= {});
      // MicroPython links calls the busybox build never made; a no-op sync is
      // honest for the in-memory store.
      wasi.fd_sync ??= () => 0;
      const instance = new WebAssembly.Instance(pythonModule, {
        ...imports,
        // The artifact links a `host` C module for host callbacks; the sandbox
        // does not expose those, so they answer "unavailable".
        micropython_wasm: { host_result_cap: () => 0, host_call: () => -1 },
      });
      shim.bindMemory(instance.exports.memory);
      try {
        instance.exports._start();
        return 0;
      } catch (error) {
        if (error instanceof WasiExit) return error.code;
        ctx.stderr(`python3: ${(error && error.message) || error}\n`);
        return 1;
      }
    } catch (error) {
      ctx.stderr(`python3: ${(error && error.message) || error}\n`);
      return 1;
    }
  };

  // ------------------------------------------------------------------- git
  const gitProxy = new URL(self.location.href).searchParams.get("gitProxy") ?? "";
  const proxied = (url) => (gitProxy ? `${gitProxy}${encodeURIComponent(url)}` : url);
  const unproxied = (url) =>
    gitProxy && url.startsWith(gitProxy) ? decodeURIComponent(url.slice(gitProxy.length)) : url;
  /** Remote URLs live in the workspace as the real https URLs; only the call
   *  and libgit2's own copy see the proxy form. */
  const rewriteConfig = (data, transform) => {
    const text = decoder.decode(data);
    const next = text.replace(/(^|\n)(\s*url\s*=\s*)(\S+)/g, (m, lead, key, url) => `${lead}${key}${transform(url)}`);
    return next === text ? data : encoder.encode(next);
  };

  const { default: initGit } = await import("../vendor/wasm-git/lg2.js");
  const lg = await initGit({
    ENV: { HOME: "/root", GIT_CONFIG_NOSYSTEM: "1" },
    print: (text) => sinks.out?.(`${text}\n`),
    printErr: (text) => sinks.err?.(`${text}\n`),
  });
  const FS = lg.FS;
  try {
    lg.ENV = { ...(lg.ENV ?? {}), HOME: "/root", GIT_CONFIG_NOSYSTEM: "1" };
  } catch {
    /* ENV stays as compiled in */
  }
  const gitconfig = "[user]\n\tname = Chrysalis\n\temail = sandbox@chrysalis.local\n";
  for (const home of ["/root", "/home/web_user"]) {
    try {
      FS.mkdirTree(home);
      FS.writeFile(`${home}/.gitconfig`, encoder.encode(gitconfig));
    } catch {
      /* not mountable */
    }
  }

  const ensureDir = (dir) => {
    try {
      FS.mkdirTree(dir);
    } catch {
      /* exists */
    }
  };

  const storeIntoFs = () => {
    for (const [path, content] of Object.entries(store.snapshot())) {
      const parent = path.slice(0, path.lastIndexOf("/")) || "/";
      ensureDir(parent);
      FS.writeFile(path, content);
    }
  };

  const walkFs = (dir, out) => {
    let names;
    try {
      names = FS.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === "." || name === "..") continue;
      const path = dir === "/" ? `/${name}` : `${dir}/${name}`;
      let st;
      try {
        st = FS.stat(path);
      } catch {
        continue;
      }
      if (FS.isDir(st.mode)) walkFs(path, out);
      else if (FS.isFile(st.mode)) out.push(path);
    }
  };

  const fsIntoStore = () => {
    const live = new Set();
    const found = [];
    for (const root of ["/workspace", "/tmp"]) walkFs(root, found);
    for (const path of found) {
      live.add(path);
      const bytes = FS.readFile(path, { encoding: "binary" });
      store.createFileSync(path, 0o644);
      store.writeSync(path, bytes, 0);
      store.touchSync(path, { size: bytes.length });
    }
    for (const path of Object.keys(store.snapshot())) {
      const tracked = path.startsWith("/workspace/") || path.startsWith("/tmp/");
      if (!tracked || live.has(path)) continue;
      try {
        store.unlinkSync(path);
      } catch {
        /* already gone */
      }
    }
  };

  // ------------------------------------------------------------------ node
  const { newQuickJSWASMModuleFromVariant, variant } = await import("../vendor/quickjs/quickjs.mjs");
  const QuickJS = await newQuickJSWASMModuleFromVariant(variant);

  const NODE_PRELUDE = `
    var __out = __host_stdout, __err = __host_stderr;
    var __fmt = function (a) {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.stack || a.message;
      try { return JSON.stringify(a); } catch (e) { return String(a); }
    };
    globalThis.console = {
      log: function () { __out([].slice.call(arguments).map(__fmt).join(" ") + "\\n"); },
      info: function () { __out([].slice.call(arguments).map(__fmt).join(" ") + "\\n"); },
      warn: function () { __err([].slice.call(arguments).map(__fmt).join(" ") + "\\n"); },
      error: function () { __err([].slice.call(arguments).map(__fmt).join(" ") + "\\n"); },
    };
    globalThis.process = {
      argv: JSON.parse(__host_argv()),
      env: JSON.parse(__host_env()),
      cwd: function () { return __host_cwd(); },
      exit: function (code) { throw new Error("__exit:" + (code == null ? 0 : code)); },
      version: "v20.0.0-sandbox",
      platform: "linux",
    };
    globalThis.path = {
      sep: "/",
      join: function () {
        var parts = [].slice.call(arguments).filter(Boolean).map(String);
        return parts.join("/").replace(/\\/+/g, "/");
      },
      resolve: function () {
        var r = "";
        [].slice.call(arguments).forEach(function (p) {
          p = String(p);
          r = p.charAt(0) === "/" ? p : (r.replace(/\\/+$/, "") + "/" + p);
        });
        return r.replace(/\\/+/g, "/");
      },
      dirname: function (p) { return String(p).replace(/\\/[^/]*$/, "") || "/"; },
      basename: function (p) { return String(p).replace(/^.*\\//, ""); },
      extname: function (p) { var m = /\\.[^./]*$/.exec(String(p)); return m ? m[0] : ""; },
      normalize: function (p) { return String(p); },
      relative: function (a, b) { return String(b).indexOf(String(a)) === 0 ? String(b).slice(String(a).length).replace(/^\\//, "") : String(b); },
    };
    globalThis.fs = {
      readFileSync: function (p, enc) {
        if (typeof enc === "string" && enc !== "binary") return __fs_read(String(p), enc);
        return Buffer.from(__fs_read_b64(String(p)), "base64");
      },
      writeFileSync: function (p, d) {
        if (typeof d === "string") __fs_write(String(p), d, false);
        else __fs_write_b64(String(p), Buffer.from(d).toString("base64"), false);
      },
      appendFileSync: function (p, d) {
        if (typeof d === "string") __fs_write(String(p), d, true);
        else __fs_write_b64(String(p), Buffer.from(d).toString("base64"), true);
      },
      existsSync: function (p) { return __fs_exists(String(p)); },
      readdirSync: function (p) { return JSON.parse(__fs_readdir(String(p))); },
      mkdirSync: function (p) { __fs_mkdir(String(p)); },
      rmSync: function (p) { __fs_rm(String(p)); },
      unlinkSync: function (p) { __fs_rm(String(p)); },
      rmdirSync: function (p) { __fs_rm(String(p)); },
      statSync: function (p) {
        var s = JSON.parse(__fs_stat(String(p)));
        return { size: s.size, isDirectory: function () { return s.dir; }, isFile: function () { return !s.dir; }, mtimeMs: 0 };
      },
    };
    globalThis.require = function (name) {
      if (name === "fs") return globalThis.fs;
      if (name === "path") return globalThis.path;
      if (name === "process") return globalThis.process;
      throw new Error("Cannot find module '" + name + "'");
    };
    globalThis.module = { exports: {} };
    globalThis.exports = globalThis.module.exports;
    globalThis.global = globalThis;
    globalThis.__filename = __host_filename();
    globalThis.__dirname = globalThis.path.dirname(__host_filename());
    var __B64CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    var __b64FromBytes = function (bytes) {
      var out = "";
      for (var i = 0; i < bytes.length; i += 3) {
        var b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
        out += __B64CHARS[b0 >> 2];
        out += __B64CHARS[((b0 & 3) << 4) | ((b1 === undefined ? 0 : b1) >> 4)];
        out += b1 === undefined ? "=" : __B64CHARS[((b1 & 15) << 2) | ((b2 === undefined ? 0 : b2) >> 6)];
        out += b2 === undefined ? "=" : __B64CHARS[b2 & 63];
      }
      return out;
    };
    var __b64ToBytes = function (text) {
      var clean = String(text).replace(/[^A-Za-z0-9+/=]/g, "");
      var out = [];
      for (var i = 0; i < clean.length; i += 4) {
        var n = (__B64CHARS.indexOf(clean[i]) << 18) | (__B64CHARS.indexOf(clean[i + 1]) << 12) | ((__B64CHARS.indexOf(clean[i + 2]) & 63) << 6) | (__B64CHARS.indexOf(clean[i + 3]) & 63);
        out.push((n >> 16) & 255);
        if (clean[i + 2] !== "=") out.push((n >> 8) & 255);
        if (clean[i + 3] !== "=") out.push(n & 255);
      }
      return out;
    };
    var __utf8Encode = function (str) {
      var out = [];
      for (var i = 0; i < str.length; i++) {
        var c = str.charCodeAt(i);
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
          var c2 = str.charCodeAt(++i);
          var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
          out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
        } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
      return out;
    };
    var __utf8Decode = function (bytes) {
      var out = "";
      for (var i = 0; i < bytes.length; ) {
        var b = bytes[i++];
        if (b < 0x80) out += String.fromCharCode(b);
        else if (b < 0xe0) out += String.fromCharCode(((b & 31) << 6) | (bytes[i++] & 63));
        else if (b < 0xf0) out += String.fromCharCode(((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63));
        else {
          var cp = ((b & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
          cp -= 0x10000;
          out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023));
        }
      }
      return out;
    };
    globalThis.TextEncoder = function () {
      this.encode = function (s) { return new Uint8Array(__utf8Encode(String(s))); };
    };
    globalThis.TextDecoder = function () {
      this.decode = function (b) { return __utf8Decode(b instanceof Uint8Array ? b : new Uint8Array(b || [])); };
    };
    globalThis.btoa = function (s) {
      var bytes = [];
      for (var i = 0; i < String(s).length; i++) bytes.push(String(s).charCodeAt(i) & 255);
      return __b64FromBytes(bytes);
    };
    globalThis.atob = function (s) {
      var bytes = __b64ToBytes(s);
      var out = "";
      for (var i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
      return out;
    };
    var __asBuffer = function (bytes) {
      if (!bytes.__isBuffer) {
        bytes.toString = function (enc) {
          if (enc === "base64") return __b64FromBytes(this);
          if (enc === "hex") {
            var out = "";
            for (var i = 0; i < this.length; i++) out += (this[i] < 16 ? "0" : "") + this[i].toString(16);
            return out;
          }
          if (enc === "latin1" || enc === "binary") {
            var bin = "";
            for (var j = 0; j < this.length; j++) bin += String.fromCharCode(this[j]);
            return bin;
          }
          return __utf8Decode(this);
        };
        bytes.__isBuffer = true;
      }
      return bytes;
    };
    globalThis.Buffer = {
      from: function (v, enc) {
        if (v instanceof Uint8Array) return __asBuffer(v);
        if (typeof v === "string") {
          if (enc === "base64") return __asBuffer(new Uint8Array(__b64ToBytes(v)));
          if (enc === "hex") {
            var out = [];
            for (var i = 0; i < v.length; i += 2) out.push(parseInt(v.substr(i, 2), 16));
            return __asBuffer(new Uint8Array(out));
          }
          return __asBuffer(new Uint8Array(__utf8Encode(v)));
        }
        if (v && typeof v.length === "number") return __asBuffer(new Uint8Array(v));
        return __asBuffer(new Uint8Array(0));
      },
      alloc: function (n) { return __asBuffer(new Uint8Array(n)); },
      concat: function (list) {
        var total = 0;
        for (var i = 0; i < list.length; i++) total += list[i].length;
        var out = new Uint8Array(total);
        var off = 0;
        for (var j = 0; j < list.length; j++) { out.set(list[j], off); off += list[j].length; }
        return __asBuffer(out);
      },
      isBuffer: function (v) { return !!(v && v.__isBuffer); },
      byteLength: function (s) { return __utf8Encode(String(s)).length; },
    };
    globalThis.os = {
      platform: function () { return "linux"; },
      arch: function () { return "wasm32"; },
      tmpdir: function () { return "/tmp"; },
      homedir: function () { return "/workspace"; },
      hostname: function () { return "chrysalis-sandbox"; },
      EOL: "\\n",
      cpus: function () { return []; },
    };
    globalThis.crypto = {
      randomUUID: function () {
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
          var r = (Math.random() * 16) | 0;
          return (c === "x" ? r : (r & 3) | 8).toString(16);
        });
      },
    };
    globalThis.setTimeout = function (fn) { if (typeof fn === "function") fn(); return 0; };
    globalThis.setInterval = globalThis.setTimeout;
    globalThis.clearTimeout = function () {};
    globalThis.clearInterval = function () {};
  `;

  const runNode = (ctx) => {
    const cwd = ctx.cwd ?? "/workspace";
    const args = ctx.argv.slice(1);
    let filename = "/eval.js";
    let code = null;
    let scriptArgs = [];
    if (args[0] === "-e" || args[0] === "--eval") {
      code = args[1] ?? "";
      scriptArgs = args.slice(2);
    } else if (args[0] && !args[0].startsWith("-")) {
      const p = args[0].startsWith("/") ? args[0] : `${cwd.replace(/\/$/, "")}/${args[0]}`;
      const bytes = store.snapshot()[p];
      if (!bytes) {
        ctx.stderr(`node: cannot find module '${args[0]}'\n`);
        return 1;
      }
      code = decoder.decode(bytes);
      filename = p;
      scriptArgs = args.slice(1);
    } else {
      ctx.stderr("node: usage: node [-e code | script.js] [args...]\n");
      return 1;
    }

    const runtime = QuickJS.newRuntime();
    const vm = runtime.newContext();
    const handles = [];
    const define = (name, impl) => {
      const handle = vm.newFunction(name, (...argHandles) => {
        const result = impl(...argHandles.map((h) => vm.dump(h)));
        if (result === undefined) return vm.undefined;
        if (typeof result === "number") return vm.newNumber(result);
        if (typeof result === "boolean") return result ? vm.true : vm.false;
        return vm.newString(String(result));
      });
      handles.push(handle);
      vm.setProp(vm.global, name, handle);
    };
    const resolvePath = (p) => (String(p).startsWith("/") ? String(p) : `${cwd.replace(/\/$/, "")}/${String(p).replace(/^\.\//, "")}`);
    const snapshot = () => store.snapshot();

    define("__host_stdout", (text) => ctx.stdout(String(text)));
    define("__host_stderr", (text) => ctx.stderr(String(text)));
    define("__host_cwd", () => cwd);
    define("__host_argv", () => JSON.stringify(["node", filename, ...scriptArgs]));
    define("__host_filename", () => filename);
    define("__host_env", () => JSON.stringify({ HOME: "/workspace", PWD: cwd, PATH: "/" }));
    define("__fs_read", (p) => {
      const bytes = snapshot()[resolvePath(p)];
      if (!bytes) throw new Error(`ENOENT: no such file or directory, open '${p}'`);
      return decoder.decode(bytes);
    });
    define("__fs_read_b64", (p) => {
      const bytes = snapshot()[resolvePath(p)];
      if (!bytes) throw new Error(`ENOENT: no such file or directory, open '${p}'`);
      return bytesToB64String(bytes);
    });
    define("__fs_write_b64", (p, b64, append) => {
      const path = resolvePath(p);
      const data = b64ToBytes(String(b64));
      const next = append ? concatBytes(snapshot()[path], data) : data;
      store.createFileSync(path, 0o644);
      store.writeSync(path, next, 0);
      store.touchSync(path, { size: next.length });
      return undefined;
    });
    define("__fs_write", (p, data, append) => {
      const path = resolvePath(p);
      const next = encoder.encode(`${append ? decoder.decode(snapshot()[path] ?? new Uint8Array()) : ""}${String(data)}`);
      store.createFileSync(path, 0o644);
      store.writeSync(path, next, 0);
      store.touchSync(path, { size: next.length });
      return undefined;
    });
    define("__fs_exists", (p) => Boolean(snapshot()[resolvePath(p)]));
    define("__fs_readdir", (p) => {
      const dir = resolvePath(p).replace(/\/$/, "");
      const base = `${dir}/`;
      const names = new Set();
      for (const key of Object.keys(snapshot())) {
        if (!key.startsWith(base)) continue;
        const rest = key.slice(base.length).split("/")[0];
        if (rest) names.add(rest);
      }
      return JSON.stringify([...names]);
    });
    define("__fs_mkdir", (p) => {
      const segments = resolvePath(p).split("/").filter(Boolean);
      let current = "";
      for (const segment of segments) {
        current += `/${segment}`;
        try {
          store.statSync(current);
        } catch {
          store.mkdirSync(current, 0o755);
        }
      }
      return undefined;
    });
    define("__fs_rm", (p) => {
      try {
        store.unlinkSync(resolvePath(p));
      } catch {
        /* missing */
      }
      return undefined;
    });
    define("__fs_stat", (p) => {
      const path = resolvePath(p);
      try {
        return JSON.stringify({ dir: false, size: snapshot()[path]?.length ?? 0 });
      } catch {
        return JSON.stringify({ dir: false, size: 0 });
      }
    });

    const describe = (handle) => {
      const dumped = vm.dump(handle);
      if (typeof dumped === "string") return dumped;
      if (dumped && typeof dumped === "object" && "message" in dumped) return String(dumped.message ?? dumped);
      return String(dumped);
    };

    try {
      const prelude = vm.evalCode(NODE_PRELUDE);
      const preludeError = prelude.error;
      prelude.value?.dispose?.();
      if (preludeError) {
        ctx.stderr(`node: ${describe(preludeError)}\n`);
        preludeError.dispose();
        return 1;
      }
      const result = vm.evalCode(code, filename);
      const resultError = result.error;
      result.value?.dispose?.();
      if (resultError) {
        const text = describe(resultError);
        resultError.dispose();
        const exit = /__exit:(\d+)/.exec(text);
        if (exit) return Number(exit[1]);
        ctx.stderr(`${text}\n`);
        return 1;
      }
      return 0;
    } finally {
      for (const handle of handles) handle.dispose();
      vm.dispose();
      runtime.dispose();
    }
  };

  // ------------------------------------------------------------------ curl
  const runCurl = (ctx) => {
    if (!gitProxy) {
      ctx.stderr("curl: network is disabled (Settings, Agent)\n");
      return 6;
    }
    const args = ctx.argv.slice(1);
    let method = null;
    let data = null;
    let url = null;
    let outputFile = null;
    let writeOut = "";
    const headers = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-s" || a === "--silent" || a === "-S" || a === "-f" || a === "-L" || a === "--location" || a === "--compressed") continue;
      if (a === "-X" || a === "--request") {
        method = args[++i] ?? null;
        continue;
      }
      if (a === "-d" || a === "--data" || a === "--data-raw" || a === "--data-binary" || a === "--data-urlencode") {
        data = args[++i] ?? "";
        method ??= "POST";
        continue;
      }
      if (a === "-H" || a === "--header") {
        const raw = args[++i] ?? "";
        const at = raw.indexOf(":");
        if (at > 0) headers.push([raw.slice(0, at).trim(), raw.slice(at + 1).trim()]);
        continue;
      }
      if (a === "-o" || a === "--output") {
        outputFile = args[++i] ?? null;
        continue;
      }
      if (a === "-w" || a === "--write-out") {
        writeOut = args[++i] ?? "";
        continue;
      }
      if (a === "-u" || a === "--user" || a === "--connect-timeout" || a === "--max-time" || a === "-m") {
        i++;
        continue;
      }
      if (a.startsWith("-")) continue;
      url = a;
    }
    if (!url) {
      ctx.stderr("curl: no URL specified\n");
      return 2;
    }
    const xhr = new XMLHttpRequest();
    try {
      xhr.open(method ?? "GET", gitProxy + encodeURIComponent(url), false);
      for (const [name, value] of headers) xhr.setRequestHeader(name, value);
      xhr.send(data);
    } catch (error) {
      ctx.stderr(`curl: ${(error && error.message) || error}\n`);
      return 7;
    }
    const body = xhr.responseText ?? "";
    if (outputFile && !outputFile.startsWith("/dev/")) {
      const path = outputFile.startsWith("/") ? outputFile : `${(ctx.cwd ?? "/workspace").replace(/\/$/, "")}/${outputFile}`;
      const bytes = encoder.encode(body);
      store.createFileSync(path, 0o644);
      store.writeSync(path, bytes, 0);
      store.touchSync(path, { size: bytes.length });
    } else if (!outputFile) {
      ctx.stdout(body);
      if (body && !body.endsWith("\n")) ctx.stdout("\n");
    }
    if (writeOut) {
      ctx.stdout(
        writeOut
          .replace(/%\{http_code\}/g, String(xhr.status))
          .replace(/%\{size_download\}/g, String(body.length))
          .replace(/\\n/g, "\n"),
      );
    }
    return xhr.status >= 400 ? 22 : 0;
  };

  /** Locate the repository from the command's cwd (the store's view). */
  const gitRepo = (ctx) => {
    const files = store.snapshot();
    const cwd = String(ctx.cwd ?? "/workspace").replace(/\/+$/, "");
    for (let dir = cwd; ; ) {
      if (files[`${dir}/.git/HEAD`]) {
        const gitDir = `${dir}/.git`;
        const head = decoder.decode(files[`${gitDir}/HEAD`] ?? new Uint8Array()).trim();
        const current = head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : null;
        return { root: dir, gitDir, head, current, files };
      }
      const cut = dir.lastIndexOf("/");
      if (cut <= 0) break;
      dir = dir.slice(0, cut);
    }
    return null;
  };
  const readGitRef = (repo, ref) => {
    const loose = repo.files[`${repo.gitDir}/${ref}`];
    if (loose) return decoder.decode(loose).trim();
    const packed = repo.files[`${repo.gitDir}/packed-refs`] ? decoder.decode(repo.files[`${repo.gitDir}/packed-refs`]) : "";
    for (const line of packed.split("\n")) {
      const [sha, name] = line.split(" ");
      if (name === ref) return sha;
    }
    return null;
  };
  const gitMeta = (ctx) => {
    const first = userArgsOf(ctx)[0];
    if (first === "--version" || first === "-v") {
      ctx.stdout("git version 2.44.0 (libgit2, chrysalis sandbox)\n");
      return 0;
    }
    if (first === "--help" || first === "-h") {
      ctx.stdout("usage: git <command> [<args>]\n\ncommands: add, branch, clone, commit, diff, fetch, init, log, push, remote, rev-parse, show, status\n");
      return 0;
    }
    return null;
  };
  const gitRemotes = (ctx) => {
    const repo = gitRepo(ctx);
    if (!repo) {
      ctx.stderr("fatal: not a git repository (or any of the parent directories): .git\n");
      return 128;
    }
    const config = repo.files[`${repo.gitDir}/config`] ? decoder.decode(repo.files[`${repo.gitDir}/config`]) : "";
    const remotes = [];
    let name = null;
    let url = null;
    for (const line of config.split("\n")) {
      const header = line.match(/^\s*\[remote\s+"([^"]+)"\]/);
      if (header) {
        if (name && url) remotes.push({ name, url });
        name = header[1];
        url = null;
        continue;
      }
      const value = line.match(/^\s*url\s*=\s*(\S+)/);
      if (value && name) url = value[1];
    }
    if (name && url) remotes.push({ name, url });
    const args = userArgsOf(ctx).slice(1);
    const target = args.find((a) => !a.startsWith("-"));
    if (target === "get-url") {
      const wanted = args[args.indexOf("get-url") + 1];
      const found = remotes.find((r) => r.name === wanted);
      if (!found) {
        ctx.stderr(`error: No such remote '${wanted}'\n`);
        return 2;
      }
      ctx.stdout(`${found.url}\n`);
      return 0;
    }
    const verbose = args.includes("-v") || args.includes("--verbose");
    for (const remote of remotes) {
      if (verbose) {
        ctx.stdout(`${remote.name}\t${remote.url} (fetch)\n${remote.name}\t${remote.url} (push)\n`);
      } else {
        ctx.stdout(`${remote.name}\n`);
      }
    }
    return 0;
  };
  const gitRevParse = (ctx) => {
    const repo = gitRepo(ctx);
    if (!repo) {
      ctx.stderr("fatal: not a git repository (or any of the parent directories): .git\n");
      return 128;
    }
    const args = userArgsOf(ctx).slice(1);
    const wants = args.filter((a) => !a.startsWith("-"));
    if (args.includes("--is-inside-work-tree")) {
      ctx.stdout("true\n");
      return 0;
    }
    if (args.includes("--abbrev-ref")) {
      ctx.stdout(`${repo.current ?? "HEAD"}\n`);
      return 0;
    }
    const ref = wants[0] && wants[0] !== "HEAD" ? (readGitRef(repo, `refs/heads/${wants[0]}`) ?? readGitRef(repo, wants[0]) ?? wants[0]) : readGitRef(repo, repo.head.startsWith("ref: ") ? repo.head.slice(5) : "");
    if (!ref) {
      ctx.stderr(`fatal: ambiguous argument '${wants[0] ?? "HEAD"}'\n`);
      return 128;
    }
    ctx.stdout(`${args.includes("--short") ? ref.slice(0, 7) : ref}\n`);
    return 0;
  };

  /** `git branch` reads and writes the repository's refs directly: the CLI's
   *  command set has no branch listing, and the files are the source of truth
   *  either way. */
  const runGitBranch = (ctx) => {
    const files = store.snapshot();
    const cwd = String(ctx.cwd ?? "/workspace").replace(/\/+$/, "");
    let root = null;
    for (let dir = cwd; ; ) {
      if (files[`${dir}/.git/HEAD`]) {
        root = dir;
        break;
      }
      const cut = dir.lastIndexOf("/");
      if (cut <= 0) break;
      dir = dir.slice(0, cut);
    }
    if (!root) {
      ctx.stderr("fatal: not a git repository (or any of the parent directories): .git\n");
      return 128;
    }
    const gitDir = `${root}/.git`;
    const head = decoder.decode(files[`${gitDir}/HEAD`] ?? new Uint8Array()).trim();
    const current = head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : null;
    const args = userArgsOf(ctx).slice(1);
    const readRef = (ref) => {
      const loose = files[`${gitDir}/${ref}`];
      if (loose) return decoder.decode(loose).trim();
      const packed = files[`${gitDir}/packed-refs`] ? decoder.decode(files[`${gitDir}/packed-refs`]) : "";
      for (const line of packed.split("\n")) {
        const [sha, name] = line.split(" ");
        if (name === ref) return sha;
      }
      return null;
    };
    if (args.includes("--show-current")) {
      ctx.stdout(`${current ?? "HEAD"}\n`);
      return 0;
    }
    const local = new Set();
    const remote = new Set();
    for (const path of Object.keys(files)) {
      if (path.startsWith(`${gitDir}/refs/heads/`)) local.add(path.slice(`${gitDir}/refs/heads/`.length));
      else if (path.startsWith(`${gitDir}/refs/remotes/`)) remote.add(path.slice(`${gitDir}/refs/remotes/`.length));
    }
    const packed = files[`${gitDir}/packed-refs`] ? decoder.decode(files[`${gitDir}/packed-refs`]) : "";
    for (const line of packed.split("\n")) {
      if (!line || line.startsWith("#") || line.startsWith("^")) continue;
      const at = line.indexOf(" ");
      if (at <= 0) continue;
      const ref = line.slice(at + 1).trim();
      if (ref.startsWith("refs/heads/")) local.add(ref.slice("refs/heads/".length));
      else if (ref.startsWith("refs/remotes/")) remote.add(ref.slice("refs/remotes/".length));
    }
    const positional = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (["-d", "-D", "--delete", "-t", "--track", "-m", "-M", "--move", "-c", "-C", "--copy"].includes(a)) {
        positional.push({ flag: a, value: args[++i] ?? null });
        continue;
      }
      if (a.startsWith("-")) continue;
      positional.push({ value: a });
    }
    const remove = positional.find((p) => p.flag === "-d" || p.flag === "-D" || p.flag === "--delete");
    if (remove) {
      const name = remove.value;
      if (!name) {
        ctx.stderr("fatal: branch name required\n");
        return 128;
      }
      if (name === current) {
        ctx.stderr(`error: cannot delete branch '${name}' checked out at '${root}'\n`);
        return 1;
      }
      const path = `${gitDir}/refs/heads/${name}`;
      if (!files[path]) {
        ctx.stderr(`error: branch '${name}' not found\n`);
        return 1;
      }
      try {
        store.unlinkSync(path);
      } catch {
        /* already gone */
      }
      ctx.stdout(`Deleted branch ${name}.\n`);
      return 0;
    }
    const create = positional.find((p) => typeof p.value === "string");
    if (create && !args.includes("-l") && !args.includes("--list")) {
      const name = create.value;
      const startArg = positional[positional.indexOf(create) + 1]?.value ?? null;
      const start = startArg ? (readRef(`refs/heads/${startArg}`) ?? readRef(`refs/remotes/${startArg}`) ?? (/^[0-9a-f]{7,40}$/.test(startArg) ? startArg : null)) : readRef(head.startsWith("ref: ") ? head.slice(5) : "");
      if (!start) {
        ctx.stderr(`fatal: not a valid object name: '${startArg ?? "HEAD"}'\n`);
        return 128;
      }
      const path = `${gitDir}/refs/heads/${name}`;
      if (files[path]) {
        ctx.stderr(`fatal: a branch named '${name}' already exists\n`);
        return 128;
      }
      const bytes = encoder.encode(`${start}\n`);
      store.createFileSync(path, 0o644);
      store.writeSync(path, bytes, 0);
      store.touchSync(path, { size: bytes.length });
      return 0;
    }
    for (const name of [...local].sort()) ctx.stdout(`${name === current ? "*" : " "} ${name}\n`);
    if (args.includes("-a") || args.includes("--all")) {
      for (const name of [...remote].sort()) ctx.stdout(`  remotes/${name}\n`);
    }
    return 0;
  };

  // ------------------------------------------------------------------ bash
  // The busybox build ships `sh`/`ash`, not `bash`; scripts and agents reach
  // for bash anyway, so bash/dash run a nested busybox shell on the same
  // store, with the same builtins, in the caller's cwd and environment.
  const busyboxModule = await WebAssembly.compile(
    await fetch(new URL("../vendor/wasi-sh/dist/busybox.wasm", import.meta.url)).then((r) => {
      if (!r.ok) throw new Error(`busybox wasm: HTTP ${r.status}`);
      return r.arrayBuffer();
    }),
  );
  let handlers = null;
  let nestedBuiltins = null;
  /** User args only: some dispatch paths put Emscripten's program name first. */
  const userArgsOf = (ctx) => {
    const a = ctx.argv.slice(1);
    return a[0] === "./this.program" ? a.slice(1) : a;
  };
  const runNestedShell = (ctx, userArgs = userArgsOf(ctx)) => {
    const shim = new WasiShim({
      args: ["busybox", "sh", ...userArgs],
      env: ctx.env ?? {},
      files: {},
      fs: store,
      stdout: (text) => ctx.stdout(text),
      stderr: (text) => ctx.stderr(text),
      input: fixedInput(typeof ctx.stdin === "function" ? ctx.stdin() : new Uint8Array()),
      builtins: nestedBuiltins,
    });
    try {
      const instance = new WebAssembly.Instance(busyboxModule, shim.imports());
      shim.bindMemory(instance.exports.memory);
      try {
        instance.exports._start();
        return 0;
      } catch (error) {
        if (error instanceof WasiExit) return error.code;
        ctx.stderr(`bash: ${(error && error.message) || error}\n`);
        return 1;
      }
    } catch (error) {
      ctx.stderr(`bash: ${(error && error.message) || error}\n`);
      return 1;
    }
  };

  const extraTools = makeExtraTools({
    store,
    nested: (ctx, userArgs) => runNestedShell(ctx, userArgs),
    net: (url, method, body, headers) => {
      if (!gitProxy) return { status: 0, body: "", error: "network is disabled (Settings, Agent)" };
      const xhr = new XMLHttpRequest();
      try {
        xhr.open(method, gitProxy + encodeURIComponent(url), false);
        for (const [name, value] of headers ?? []) xhr.setRequestHeader(name, value);
        xhr.send(body ?? null);
      } catch (error) {
        return { status: 0, body: "", error: (error && error.message) || String(error) };
      }
      return { status: xhr.status, body: xhr.responseText ?? "" };
    },
  });

  handlers = {
    ...extraTools,
    bash: (ctx) => runNestedShell(ctx),
    dash: (ctx) => runNestedShell(ctx),
    python3: runPython,
    python: runPython,
    node: runNode,
    nodejs: runNode,
    curl: runCurl,
    git(ctx) {
      const version = gitMeta(ctx);
      if (version !== null) return version;
      const first = userArgsOf(ctx)[0];
      if (first === "branch") return runGitBranch(ctx);
      if (first === "remote") return gitRemotes(ctx);
      if (first === "rev-parse") return gitRevParse(ctx);
      const previousOut = sinks.out;
      const previousErr = sinks.err;
      sinks.out = (text) => ctx.stdout(text);
      sinks.err = (text) => ctx.stderr(text);
      try {
        // Remote URLs stay real in the workspace; libgit2's copy sees the
        // proxy form so its HTTP goes through the engine.
        const rewriteStoredConfigs = (transform) => {
          if (!gitProxy) return;
          for (const [path, content] of Object.entries(store.snapshot())) {
            if (!path.endsWith(".git/config")) continue;
            const rewritten = rewriteConfig(content, transform);
            if (rewritten === content) continue;
            store.createFileSync(path, 0o644);
            store.writeSync(path, rewritten, 0);
            store.touchSync(path, { size: rewritten.length });
          }
        };
        rewriteStoredConfigs(proxied);
        storeIntoFs();
        const cwd = ctx.cwd && ctx.cwd.startsWith("/") ? ctx.cwd : "/workspace";
        ensureDir(cwd);
        FS.chdir(cwd);
        let code = 0;
        try {
          let args = userArgsOf(ctx);
          // the CLI has no -A/--all; "." adds every change the same way
          if (args[0] === "add") args = args.map((a) => (a === "-A" || a === "--all" ? "." : a));
          if (gitProxy) args = args.map((a) => (/^https?:\/\//.test(a) ? proxied(a) : a));
          // The libgit2 CLI takes a smaller option surface than git; drop the
          // flags it cannot parse (and their values) with a warning instead of
          // failing the whole command on them.
          const UNSUPPORTED = /^--depth(=|$)|^--shallow-since(=|$)|^--shallow-exclude(=|$)|^--single-branch$|^--no-single-branch$|^--filter(=|$)|^--recurse-submodules(=|$)|^--remote-submodules$/;
          const kept = [];
          for (let i = 0; i < args.length; i++) {
            if (UNSUPPORTED.test(args[i])) {
              ctx.stderr(`git: warning: ignoring unsupported option: ${args[i]}\n`);
              if (!args[i].includes("=") && /^--(depth|shallow-since|shallow-exclude|filter)$/.test(args[i])) i++;
              continue;
            }
            kept.push(args[i]);
          }
          args = kept;
          // The libgit2 CLI requires an explicit directory for init; git does not.
          if (args[0] === "init" && !args.slice(1).some((a) => !a.startsWith("-"))) args = [...args, "."];
          code = lg.callMain(args);
        } catch (error) {
          if (typeof error === "number") code = error;
          else {
            ctx.stderr(`git: ${(error && error.message) || error}\n`);
            code = 1;
          }
        }
        fsIntoStore();
        rewriteStoredConfigs(unproxied);
        return code;
      } finally {
        sinks.out = previousOut;
        sinks.err = previousErr;
      }
    },
  };
  nestedBuiltins = hostBuiltins(handlers);
  return handlers;
}

serve({
  fs: () => store,
  builtins,
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "snapshot") return;
  const files = store.snapshot();
  const list = Object.entries(files).map(([path, content]) => ({ path, content }));
  self.postMessage({ type: "snapshot", files: list }, list.map((f) => f.content.buffer));
});
