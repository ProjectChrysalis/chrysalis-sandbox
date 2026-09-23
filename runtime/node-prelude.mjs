// The Node surface inside QuickJS. `prelude` is serialized with toString()
// and evaluated in the guest context, so it must not close over anything in
// this module: everything it reaches for arrives through `host`.
//
// host.write(fd, text|ArrayBuffer)   host.stdin() -> ArrayBuffer
// host.fs(op, ...args)               throws "CODE message" on failure
// host.spawn(json) -> json           host.http(json, body) -> json
// host.httpBody() -> ArrayBuffer     host.zlib(op, ArrayBuffer) -> ArrayBuffer
// host.digest(alg, ArrayBuffer) -> ArrayBuffer   host.compile(file, source) -> fn
// host.exit(code)                    host.cwd, host.argv, host.env, host.execPath
export function prelude(g, host) {
  "use strict";
  const hostArgv = JSON.parse(host.argv);
  const hostEnv = JSON.parse(host.env);
  let cwd = host.cwd;

  // ------------------------------------------------------------ text/bytes
  const utf8Encode = (s) => {
    const out = [];
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        const d = s.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) {
          c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
          i++;
        }
      }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  };
  const utf8Decode = (bytes) => {
    let out = "";
    const parts = [];
    for (let i = 0; i < bytes.length; ) {
      const b = bytes[i++];
      let c;
      if (b < 0x80) c = b;
      else if (b < 0xe0) c = ((b & 31) << 6) | (bytes[i++] & 63);
      else if (b < 0xf0) c = ((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
      else c = ((b & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
      if (c > 0xffff) {
        c -= 0x10000;
        out += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 1023));
      } else out += String.fromCharCode(c);
      if (out.length > 8192) {
        parts.push(out);
        out = "";
      }
    }
    parts.push(out);
    return parts.join("");
  };
  if (typeof g.TextEncoder !== "function") {
    g.TextEncoder = class TextEncoder {
      get encoding() {
        return "utf-8";
      }
      encode(s = "") {
        return utf8Encode(String(s));
      }
    };
  }
  if (typeof g.TextDecoder !== "function") {
    g.TextDecoder = class TextDecoder {
      constructor(label = "utf-8") {
        this.encoding = String(label).toLowerCase();
      }
      decode(b) {
        if (!b) return "";
        const bytes = b instanceof Uint8Array ? b : ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b);
        if (this.encoding === "latin1" || this.encoding === "ascii") {
          let s = "";
          for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
          return s;
        }
        return utf8Decode(bytes);
      }
    };
  }
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const b64encode = (bytes) => {
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=") + (i + 2 < bytes.length ? B64[n & 63] : "=");
    }
    return out;
  };
  const b64decode = (text) => {
    const clean = String(text).replace(/[^A-Za-z0-9+/_-]/g, "").replace(/-/g, "+").replace(/_/g, "/");
    const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
    let o = 0;
    for (let i = 0; i < clean.length; i += 4) {
      const n = (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1]) << 12) | ((B64.indexOf(clean[i + 2]) & 63) << 6) | (B64.indexOf(clean[i + 3]) & 63);
      out[o++] = (n >> 16) & 255;
      if (i + 2 < clean.length) out[o++] = (n >> 8) & 255;
      if (i + 3 < clean.length) out[o++] = n & 255;
    }
    return out.subarray(0, o);
  };
  g.btoa = (s) => b64encode(Uint8Array.from(String(s), (c) => c.charCodeAt(0) & 255));
  g.atob = (s) => {
    const bytes = b64decode(s);
    let out = "";
    for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
  };

  // ---------------------------------------------------------------- Buffer
  class Buffer extends Uint8Array {
    static from(value, encodingOrOffset, length) {
      if (typeof value === "string") {
        const enc = String(encodingOrOffset || "utf8").toLowerCase();
        if (enc === "base64" || enc === "base64url") return Buffer.fromBytes(b64decode(value));
        if (enc === "hex") {
          const out = new Buffer(value.length >> 1);
          for (let i = 0; i < out.length; i++) out[i] = parseInt(value.substr(i * 2, 2), 16);
          return out;
        }
        if (enc === "latin1" || enc === "binary" || enc === "ascii") return Buffer.fromBytes(Uint8Array.from(value, (c) => c.charCodeAt(0) & 255));
        return Buffer.fromBytes(utf8Encode(value));
      }
      if (value instanceof ArrayBuffer) return new Buffer(value, encodingOrOffset ?? 0, length ?? value.byteLength - (encodingOrOffset ?? 0));
      if (ArrayBuffer.isView(value)) return Buffer.fromBytes(new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice());
      if (value && value.type === "Buffer" && Array.isArray(value.data)) return Buffer.fromBytes(Uint8Array.from(value.data));
      if (Array.isArray(value)) return Buffer.fromBytes(Uint8Array.from(value));
      throw new TypeError("The first argument must be a string, Buffer, ArrayBuffer or Array");
    }
    static fromBytes(bytes) {
      const out = new Buffer(bytes.length);
      out.set(bytes);
      return out;
    }
    static alloc(size, fill) {
      const out = new Buffer(size);
      if (fill !== undefined) out.fill(typeof fill === "string" ? fill.charCodeAt(0) : fill);
      return out;
    }
    static allocUnsafe(size) {
      return new Buffer(size);
    }
    static isBuffer(v) {
      return v instanceof Buffer;
    }
    static byteLength(s, enc) {
      return typeof s === "string" ? Buffer.from(s, enc).length : s.byteLength;
    }
    static concat(list, total) {
      const size = total ?? list.reduce((n, b) => n + b.length, 0);
      const out = new Buffer(size);
      let off = 0;
      for (const b of list) {
        out.set(b.subarray(0, Math.max(0, size - off)), off);
        off += b.length;
        if (off >= size) break;
      }
      return out;
    }
    static isEncoding(e) {
      return ["utf8", "utf-8", "hex", "base64", "base64url", "latin1", "binary", "ascii"].includes(String(e).toLowerCase());
    }
    toString(enc = "utf8", start = 0, end = this.length) {
      const bytes = this.subarray(start, end);
      const e = String(enc).toLowerCase();
      if (e === "base64") return b64encode(bytes);
      if (e === "base64url") return b64encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      if (e === "hex") return Array.from(bytes, (b) => (b < 16 ? "0" : "") + b.toString(16)).join("");
      if (e === "latin1" || e === "binary" || e === "ascii") {
        let s = "";
        for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        return s;
      }
      return utf8Decode(bytes);
    }
    toJSON() {
      return { type: "Buffer", data: Array.from(this) };
    }
    equals(other) {
      if (other.length !== this.length) return false;
      for (let i = 0; i < this.length; i++) if (this[i] !== other[i]) return false;
      return true;
    }
    slice(start, end) {
      return this.subarray(start, end);
    }
    subarray(start, end) {
      const view = Uint8Array.prototype.subarray.call(this, start, end);
      return new Buffer(view.buffer, view.byteOffset, view.length);
    }
    write(string, offset = 0) {
      const bytes = utf8Encode(String(string));
      this.set(bytes.subarray(0, this.length - offset), offset);
      return Math.min(bytes.length, this.length - offset);
    }
    readUInt8(o = 0) {
      return this[o];
    }
    readUInt16LE(o = 0) {
      return this[o] | (this[o + 1] << 8);
    }
    readUInt32LE(o = 0) {
      return (this[o] | (this[o + 1] << 8) | (this[o + 2] << 16)) + this[o + 3] * 0x1000000;
    }
    readUInt32BE(o = 0) {
      return this[o] * 0x1000000 + ((this[o + 1] << 16) | (this[o + 2] << 8) | this[o + 3]);
    }
    readInt32LE(o = 0) {
      return this[o] | (this[o + 1] << 8) | (this[o + 2] << 16) | (this[o + 3] << 24);
    }
    writeUInt8(v, o = 0) {
      this[o] = v;
      return o + 1;
    }
    writeUInt32LE(v, o = 0) {
      this[o] = v & 255;
      this[o + 1] = (v >>> 8) & 255;
      this[o + 2] = (v >>> 16) & 255;
      this[o + 3] = (v >>> 24) & 255;
      return o + 4;
    }
    writeUInt32BE(v, o = 0) {
      this[o] = (v >>> 24) & 255;
      this[o + 1] = (v >>> 16) & 255;
      this[o + 2] = (v >>> 8) & 255;
      this[o + 3] = v & 255;
      return o + 4;
    }
  }
  g.Buffer = Buffer;
  const toBytes = (data, enc) => {
    if (typeof data === "string") return Buffer.from(data, enc);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return Buffer.from(String(data));
  };
  const toBuffer = (ab) => new Buffer(ab);
  const hostBytes = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

  // --------------------------------------------------------------- inspect
  const inspect = (value, options = {}) => {
    const depthLimit = options.depth === undefined ? 2 : options.depth === null ? Infinity : options.depth;
    const seen = new Set();
    const key = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));
    const fmt = (v, depth, top) => {
      if (typeof v === "string") return top ? v : JSON.stringify(v).replace(/^"|"$/g, "'").replace(/\\"/g, '"');
      if (typeof v === "number") return Object.is(v, -0) ? "-0" : String(v);
      if (typeof v === "bigint") return `${v}n`;
      if (v === undefined || v === null || typeof v === "boolean") return String(v);
      if (typeof v === "symbol") return v.toString();
      if (typeof v === "function") return v.name ? `[Function: ${v.name}]` : "[Function (anonymous)]";
      if (v instanceof Error) return v.stack && v.stack.includes(v.message) ? `${v.name}: ${v.message}\n${v.stack.split("\n").filter((l) => /^\s+at /.test(l)).join("\n")}`.trim() : `${v.name}: ${v.message}`;
      if (seen.has(v)) return "[Circular *1]";
      if (v instanceof Date) return isNaN(v) ? "Invalid Date" : v.toISOString();
      if (v instanceof RegExp) return String(v);
      if (depth > depthLimit) return Array.isArray(v) ? "[Array]" : "[Object]";
      seen.add(v);
      try {
        const wrap = (open, items, close) => {
          if (!items.length) return `${open}${close}`;
          const one = `${open} ${items.join(", ")} ${close}`;
          if (one.length <= 72 && !one.includes("\n")) return one;
          const pad = "  ".repeat(depth + 1);
          return `${open}\n${items.map((i) => pad + i.replace(/\n/g, `\n${pad}`)).join(",\n")}\n${"  ".repeat(depth)}${close}`;
        };
        if (v instanceof Buffer) return `<Buffer ${Array.from(v.subarray(0, 50), (b) => (b < 16 ? "0" : "") + b.toString(16)).join(" ")}${v.length > 50 ? ` ... ${v.length - 50} more bytes` : ""}>`;
        if (ArrayBuffer.isView(v)) return `${v.constructor.name}(${v.length}) [ ${Array.from(v.subarray(0, 100)).join(", ")} ]`;
        if (Array.isArray(v)) {
          const items = v.slice(0, 100).map((x) => fmt(x, depth + 1));
          if (v.length > 100) items.push(`... ${v.length - 100} more items`);
          return wrap("[", items, "]");
        }
        if (v instanceof Map) return wrap(`Map(${v.size}) {`, [...v].map(([k, x]) => `${fmt(k, depth + 1)} => ${fmt(x, depth + 1)}`), "}");
        if (v instanceof Set) return wrap(`Set(${v.size}) {`, [...v].map((x) => fmt(x, depth + 1)), "}");
        if (typeof v.then === "function") return "Promise { <pending> }";
        const items = Object.keys(v).map((k) => `${key(k)}: ${fmt(v[k], depth + 1)}`);
        const name = v.constructor && v.constructor !== Object && v.constructor.name ? `${v.constructor.name} ` : "";
        return wrap(`${name}{`, items, "}");
      } finally {
        seen.delete(v);
      }
    };
    return fmt(value, 0, true);
  };
  const format = (...args) => {
    let first = args[0];
    let rest = args.slice(1);
    if (typeof first === "string" && /%[sdifjoOc%]/.test(first)) {
      first = first.replace(/%([sdifjoOc%])/g, (m, t) => {
        if (t === "%") return "%";
        if (!rest.length) return m;
        const v = rest.shift();
        if (t === "s") return typeof v === "string" ? v : inspect(v, { depth: 1 });
        if (t === "d" || t === "i") return String(t === "i" ? parseInt(v) : Number(v));
        if (t === "f") return String(parseFloat(v));
        if (t === "j") return JSON.stringify(v);
        if (t === "c") return "";
        return inspect(v);
      });
      return [first, ...rest.map((v) => inspect(v))].join(" ");
    }
    return args.map((v) => inspect(v)).join(" ");
  };

  // ---------------------------------------------------------------- errors
  const fsError = (thrown, syscall, p) => {
    const text = String((thrown && thrown.message) || thrown);
    const m = /^([A-Z]+) (.*)$/.exec(text);
    const code = m ? m[1] : "EIO";
    const e = new Error(`${code}: ${m ? m[2] : text}, ${syscall} '${p}'`);
    e.code = code;
    e.syscall = syscall;
    e.path = p;
    e.errno = { ENOENT: -2, EEXIST: -17, ENOTDIR: -20, EISDIR: -21, ENOTEMPTY: -39, EINVAL: -22 }[code] ?? -5;
    return e;
  };
  const call = (syscall, p, op, ...args) => {
    try {
      return host.fs(op, ...args);
    } catch (thrown) {
      throw fsError(thrown, syscall, p);
    }
  };

  // ------------------------------------------------------------------ path
  const normalize = (p) => {
    const abs = p.startsWith("/");
    const out = [];
    for (const part of p.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if (out.length && out[out.length - 1] !== "..") out.pop();
        else if (!abs) out.push("..");
      } else out.push(part);
    }
    const joined = out.join("/");
    return abs ? `/${joined}` : joined || ".";
  };
  const path = {
    sep: "/",
    delimiter: ":",
    normalize: (p) => {
      const n = normalize(String(p));
      return String(p).endsWith("/") && n !== "/" ? `${n}/` : n;
    },
    join: (...parts) => normalize(parts.filter((x) => x !== "").join("/") || "."),
    resolve: (...parts) => {
      let r = cwd;
      for (const p of parts.map(String)) r = p.startsWith("/") ? p : `${r}/${p}`;
      return normalize(r);
    },
    isAbsolute: (p) => String(p).startsWith("/"),
    dirname: (p) => {
      const s = String(p).replace(/\/+$/, "");
      const i = s.lastIndexOf("/");
      return i < 0 ? "." : i === 0 ? "/" : s.slice(0, i);
    },
    basename: (p, ext) => {
      let b = String(p).replace(/\/+$/, "").split("/").pop() || "";
      if (ext && b.endsWith(ext) && b !== ext) b = b.slice(0, -ext.length);
      return b;
    },
    extname: (p) => {
      const b = path.basename(p);
      const i = b.lastIndexOf(".");
      return i <= 0 ? "" : b.slice(i);
    },
    relative: (from, to) => {
      const a = path.resolve(from).split("/").filter(Boolean);
      const b = path.resolve(to).split("/").filter(Boolean);
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
    },
    parse: (p) => {
      const base = path.basename(p);
      const ext = path.extname(p);
      const dir = path.dirname(p);
      return { root: String(p).startsWith("/") ? "/" : "", dir, base, ext, name: ext ? base.slice(0, -ext.length) : base };
    },
    format: (o) => (o.dir ? `${o.dir}/` : o.root || "") + (o.base || `${o.name || ""}${o.ext || ""}`),
    toNamespacedPath: (p) => p,
  };
  path.posix = path;
  const abs = (p) => path.resolve(String(p instanceof URL ? p.pathname : p));

  // -------------------------------------------------------------------- fs
  const statOf = (p, syscall) => {
    const s = JSON.parse(call(syscall, p, "stat", abs(p)));
    const d = (ms) => new Date(ms);
    return {
      dev: 1,
      ino: s.ino,
      mode: s.mode,
      nlink: 1,
      uid: 0,
      gid: 0,
      size: s.size,
      blksize: 4096,
      blocks: Math.ceil(s.size / 512),
      atimeMs: s.mtimeMs,
      mtimeMs: s.mtimeMs,
      ctimeMs: s.mtimeMs,
      birthtimeMs: s.mtimeMs,
      atime: d(s.mtimeMs),
      mtime: d(s.mtimeMs),
      ctime: d(s.mtimeMs),
      birthtime: d(s.mtimeMs),
      isFile: () => !s.dir,
      isDirectory: () => s.dir,
      isSymbolicLink: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
    };
  };
  const encOf = (o) => (typeof o === "string" ? o : o && o.encoding);
  const dirent = (dir, name, isDir) => ({
    name,
    parentPath: dir,
    path: dir,
    isFile: () => !isDir,
    isDirectory: () => isDir,
    isSymbolicLink: () => false,
  });
  const fs = {
    constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
    readFileSync(p, options) {
      const enc = encOf(options);
      if (p === 0 || p === "/dev/stdin") {
        const bytes = toBuffer(host.stdin());
        return enc ? bytes.toString(enc) : bytes;
      }
      const bytes = toBuffer(call("open", p, "read", abs(p)));
      return enc ? bytes.toString(enc) : bytes;
    },
    writeFileSync(p, data, options) {
      if (p === 1 || p === 2) return void host.write(p, typeof data === "string" ? data : hostBytes(toBytes(data)));
      call("open", p, "write", abs(p), hostBytes(toBytes(data, encOf(options))), (options && options.flag) === "a");
    },
    appendFileSync(p, data, options) {
      call("open", p, "write", abs(p), hostBytes(toBytes(data, encOf(options))), true);
    },
    existsSync(p) {
      try {
        return host.fs("exists", abs(p)) === "1";
      } catch {
        return false;
      }
    },
    statSync(p, options) {
      try {
        return statOf(p, "stat");
      } catch (e) {
        if (options && options.throwIfNoEntry === false && e.code === "ENOENT") return undefined;
        throw e;
      }
    },
    lstatSync(p, options) {
      return fs.statSync(p, options);
    },
    readdirSync(p, options) {
      const dir = abs(p);
      const entries = JSON.parse(call("scandir", p, "readdir", dir, options && options.recursive ? "1" : ""));
      if (options && options.withFileTypes) return entries.map(([name, isDir]) => dirent(path.join(dir, path.dirname(name)), path.basename(name), isDir));
      return entries.map(([name]) => name);
    },
    mkdirSync(p, options) {
      const recursive = options === true || (options && options.recursive);
      call("mkdir", p, "mkdir", abs(p), recursive ? "1" : "");
      return recursive ? abs(p) : undefined;
    },
    rmSync(p, options) {
      call("rm", p, "rm", abs(p), options && options.recursive ? "1" : "", options && options.force ? "1" : "");
    },
    rmdirSync(p, options) {
      call("rmdir", p, "rmdir", abs(p), options && options.recursive ? "1" : "");
    },
    unlinkSync(p) {
      call("unlink", p, "unlink", abs(p));
    },
    renameSync(a, b) {
      call("rename", a, "rename", abs(a), abs(b));
    },
    copyFileSync(a, b) {
      call("copyfile", a, "copy", abs(a), abs(b));
    },
    cpSync(a, b, options) {
      call("cp", a, "cp", abs(a), abs(b), options && options.recursive ? "1" : "");
    },
    realpathSync(p) {
      statOf(p, "realpath");
      return abs(p);
    },
    accessSync(p) {
      statOf(p, "access");
    },
    mkdtempSync(prefix) {
      const dir = `${prefix}${Math.random().toString(36).slice(2, 8)}`;
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
    chmodSync() {},
    utimesSync() {},
    symlinkSync() {
      const e = new Error("ENOSYS: symbolic links are not supported in the sandbox");
      e.code = "ENOSYS";
      throw e;
    },
    openSync(p, flags = "r") {
      return { __fd: true, path: abs(p), flags: String(flags), pos: 0 };
    },
    closeSync() {},
    readSync(fd, buffer, offset = 0, length = buffer.length - offset, position = null) {
      const data = new Uint8Array(call("read", fd.path, "read", fd.path));
      const start = position ?? fd.pos;
      const chunk = data.subarray(start, start + length);
      buffer.set(chunk, offset);
      if (position === null) fd.pos += chunk.length;
      return chunk.length;
    },
    writeSync(fd, data) {
      if (fd === 1 || fd === 2) return void host.write(fd, typeof data === "string" ? data : hostBytes(toBytes(data)));
      call("write", fd.path, "write", fd.path, hostBytes(toBytes(data)), fd.flags.startsWith("a") || fd.pos > 0);
      fd.pos += toBytes(data).length;
    },
    createWriteStream(p, options) {
      const target = abs(p);
      let first = !(options && options.flags === "a");
      const stream = new EventEmitter();
      stream.write = (chunk, enc, cb) => {
        call("write", p, "write", target, hostBytes(toBytes(chunk, typeof enc === "string" ? enc : undefined)), !first);
        first = false;
        if (typeof enc === "function") enc();
        else if (typeof cb === "function") cb();
        return true;
      };
      stream.end = (chunk, enc, cb) => {
        if (chunk !== undefined && typeof chunk !== "function") stream.write(chunk, enc);
        if (first) call("write", p, "write", target, new ArrayBuffer(0), false);
        const done = [chunk, enc, cb].find((x) => typeof x === "function");
        queueMicrotask(() => {
          if (done) done();
          stream.emit("finish");
          stream.emit("close");
        });
      };
      return stream;
    },
    createReadStream(p, options) {
      const stream = new EventEmitter();
      const enc = encOf(options);
      setTimeout(() => {
        try {
          const data = fs.readFileSync(p, enc);
          stream.emit("data", data);
          stream.emit("end");
          stream.emit("close");
        } catch (e) {
          stream.emit("error", e);
        }
      });
      stream.pipe = (dest) => {
        stream.on("data", (d) => dest.write(d));
        stream.on("end", () => dest.end && dest !== process.stdout && dest !== process.stderr && dest.end());
        return dest;
      };
      return stream;
    },
    watch() {
      throw new Error("fs.watch is not available in the sandbox");
    },
  };
  const promisifyFs = (names) => {
    const out = {};
    for (const name of names) {
      out[name] = (...args) =>
        new Promise((resolve, reject) => {
          try {
            resolve(fs[`${name}Sync`](...args));
          } catch (e) {
            reject(e);
          }
        });
    }
    out.access = (...args) =>
      new Promise((resolve, reject) => {
        try {
          fs.accessSync(...args);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    return out;
  };
  const SYNC = ["readFile", "writeFile", "appendFile", "stat", "lstat", "readdir", "mkdir", "rm", "rmdir", "unlink", "rename", "copyFile", "cp", "realpath", "mkdtemp", "chmod", "utimes"];
  fs.promises = promisifyFs(SYNC);
  for (const name of [...SYNC, "exists", "access"]) {
    fs[name] = (...args) => {
      const cb = typeof args[args.length - 1] === "function" ? args.pop() : null;
      let result;
      let error = null;
      try {
        result = name === "exists" ? fs.existsSync(...args) : fs[`${name}Sync`](...args);
      } catch (e) {
        error = e;
      }
      if (cb) queueMicrotask(() => (name === "exists" ? cb(result) : cb(error, result)));
    };
  }

  // ---------------------------------------------------------------- events
  class EventEmitter {
    constructor() {
      this._events = new Map();
    }
    on(name, fn) {
      if (!this._events) this._events = new Map();
      if (!this._events.has(name)) this._events.set(name, []);
      this._events.get(name).push(fn);
      return this;
    }
    addListener(name, fn) {
      return this.on(name, fn);
    }
    prependListener(name, fn) {
      this.on(name, fn);
      this._events.get(name).unshift(this._events.get(name).pop());
      return this;
    }
    once(name, fn) {
      const wrapper = (...args) => {
        this.off(name, wrapper);
        fn.apply(this, args);
      };
      wrapper.listener = fn;
      return this.on(name, wrapper);
    }
    off(name, fn) {
      const list = this._events && this._events.get(name);
      if (list) {
        const i = list.findIndex((x) => x === fn || x.listener === fn);
        if (i >= 0) list.splice(i, 1);
      }
      return this;
    }
    removeListener(name, fn) {
      return this.off(name, fn);
    }
    removeAllListeners(name) {
      if (name === undefined) this._events = new Map();
      else if (this._events) this._events.delete(name);
      return this;
    }
    emit(name, ...args) {
      const list = this._events && this._events.get(name);
      if (!list || !list.length) {
        if (name === "error") throw args[0];
        return false;
      }
      for (const fn of list.slice()) fn.apply(this, args);
      return true;
    }
    listeners(name) {
      return ((this._events && this._events.get(name)) || []).map((f) => f.listener || f);
    }
    listenerCount(name) {
      return this.listeners(name).length;
    }
    setMaxListeners() {
      return this;
    }
  }
  EventEmitter.EventEmitter = EventEmitter;
  EventEmitter.once = (emitter, name) => new Promise((resolve) => emitter.once(name, (...args) => resolve(args)));

  // ---------------------------------------------------------------- timers
  let clock = 0;
  let timerSeq = 0;
  const timers = new Map();
  const addTimer = (fn, ms, args, repeat) => {
    const id = ++timerSeq;
    const delay = Math.max(1, Number(ms) || 0);
    timers.set(id, { id, fn, at: clock + delay, delay, args, repeat, seq: id });
    return { __timer: id, ref() { return this; }, unref() { return this; }, hasRef: () => true, refresh() { return this; }, [Symbol.toPrimitive]: () => id };
  };
  const clearTimer = (t) => timers.delete(t && typeof t === "object" ? t.__timer : t);
  g.setTimeout = (fn, ms, ...args) => addTimer(fn, ms, args, false);
  g.setInterval = (fn, ms, ...args) => addTimer(fn, ms, args, true);
  g.setImmediate = (fn, ...args) => addTimer(fn, 0, args, false);
  g.clearTimeout = clearTimer;
  g.clearInterval = clearTimer;
  g.clearImmediate = clearTimer;
  if (typeof g.queueMicrotask !== "function") g.queueMicrotask = (fn) => Promise.resolve().then(fn);
  // One due timer per call; the host drains promise jobs in between, which
  // is the event loop with its clock fast-forwarded.
  g.__nextTimer = () => {
    let next = null;
    for (const t of timers.values()) if (!next || t.at < next.at || (t.at === next.at && t.seq < next.seq)) next = t;
    if (!next) return false;
    clock = next.at;
    if (next.repeat) {
      next.at = clock + next.delay;
      next.seq = ++timerSeq;
    } else timers.delete(next.id);
    next.fn(...next.args);
    return true;
  };
  const started = Date.now();
  g.performance = g.performance || { now: () => Date.now() - started + clock, timeOrigin: started };

  // --------------------------------------------------------------- process
  const exitHandlers = [];
  const writer = (fd) => ({
    write(chunk, enc, cb) {
      host.write(fd, typeof chunk === "string" ? chunk : hostBytes(toBytes(chunk)));
      const done = typeof enc === "function" ? enc : cb;
      if (done) queueMicrotask(done);
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) this.write(chunk);
    },
    on() {
      return this;
    },
    once() {
      return this;
    },
    isTTY: false,
    columns: 80,
    fd,
  });
  class ExitSignal {
    constructor(code) {
      this.code = code;
      this.__exit = true;
    }
  }
  const process = new EventEmitter();
  Object.assign(process, {
    argv: hostArgv,
    argv0: "node",
    execArgv: [],
    execPath: host.execPath,
    env: hostEnv,
    pid: 1,
    ppid: 0,
    platform: "linux",
    arch: "wasm32",
    version: "v22.0.0",
    versions: { node: "22.0.0", quickjs: "ng" },
    release: { name: "node" },
    exitCode: undefined,
    stdout: writer(1),
    stderr: writer(2),
    cwd: () => cwd,
    chdir: (d) => {
      const target = path.resolve(d);
      if (!fs.statSync(target).isDirectory()) throw fsError(new Error("ENOTDIR not a directory"), "chdir", d);
      cwd = target;
    },
    exit: (code) => {
      const status = code === undefined ? process.exitCode ?? 0 : code;
      host.exit(Number(status) || 0);
      throw new ExitSignal(status);
    },
    abort: () => {
      host.exit(134);
      throw new ExitSignal(134);
    },
    nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
    hrtime: Object.assign(
      (prev) => {
        const ns = Math.round(g.performance.now() * 1e6);
        const t = [Math.floor(ns / 1e9), ns % 1e9];
        return prev ? [t[0] - prev[0], t[1] - prev[1]] : t;
      },
      { bigint: () => BigInt(Math.round(g.performance.now() * 1e6)) },
    ),
    uptime: () => g.performance.now() / 1000,
    memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
    cpuUsage: () => ({ user: 0, system: 0 }),
    umask: () => 0o022,
    getuid: () => 1000,
    getgid: () => 1000,
    emitWarning: (w) => host.write(2, `(node) Warning: ${w}\n`),
    kill: () => true,
  });
  let stdinCache = null;
  const stdinData = () => (stdinCache ??= toBuffer(host.stdin()));
  process.stdin = Object.assign(new EventEmitter(), {
    isTTY: false,
    fd: 0,
    setEncoding(e) {
      this._enc = e;
      return this;
    },
    resume() {
      return this;
    },
    pause() {
      return this;
    },
    read() {
      return null;
    },
    [Symbol.asyncIterator]: async function* () {
      const data = stdinData();
      if (data.length) yield this._enc ? data.toString(this._enc) : data;
    },
  });
  const stdinOn = process.stdin.on.bind(process.stdin);
  let stdinScheduled = false;
  process.stdin.on = (name, fn) => {
    stdinOn(name, fn);
    if ((name === "data" || name === "end" || name === "readable") && !stdinScheduled) {
      stdinScheduled = true;
      setTimeout(() => {
        const data = stdinData();
        if (data.length) process.stdin.emit("data", process.stdin._enc ? data.toString(process.stdin._enc) : data);
        process.stdin.emit("end");
        process.stdin.emit("close");
      });
    }
    return process.stdin;
  };
  process.on = ((on) => (name, fn) => {
    if (name === "exit" || name === "beforeExit") exitHandlers.push([name, fn]);
    return on.call(process, name, fn);
  })(process.on);
  g.process = process;
  g.__exitHandlers = exitHandlers;
  g.__ExitSignal = ExitSignal;
  g.global = g;
  g.globalThis = g;

  // --------------------------------------------------------------- console
  const counts = new Map();
  const times = new Map();
  let groupIndent = "";
  const line = (fd) => (...args) => host.write(fd, `${groupIndent}${format(...args).replace(/\n/g, `\n${groupIndent}`)}\n`);
  g.console = {
    log: line(1),
    info: line(1),
    debug: line(1),
    warn: line(2),
    error: line(2),
    trace: (...args) => line(2)("Trace:", ...args),
    dir: (v, o) => host.write(1, `${inspect(v, o)}\n`),
    table: (rows) => {
      if (!rows || typeof rows !== "object") return line(1)(rows);
      const keys = [...new Set(Object.values(rows).flatMap((r) => (r && typeof r === "object" ? Object.keys(r) : ["Values"])))];
      const cells = Object.entries(rows).map(([i, r]) => [i, ...keys.map((k) => (r && typeof r === "object" ? (k in r ? inspect(r[k], { depth: 0 }) : "") : k === "Values" ? inspect(r) : ""))]);
      const header = ["(index)", ...keys];
      const widths = header.map((h, c) => Math.max(h.length, ...cells.map((row) => String(row[c]).length)) + 2);
      const rule = (l, m, r) => l + widths.map((w) => "─".repeat(w)).join(m) + r;
      const row = (r) => `│${r.map((v, c) => ` ${String(v).padEnd(widths[c] - 1)}`).join("│")}│`;
      host.write(1, `${[rule("┌", "┬", "┐"), row(header), rule("├", "┼", "┤"), ...cells.map(row), rule("└", "┴", "┘")].join("\n")}\n`);
    },
    assert: (ok, ...args) => {
      if (!ok) line(2)("Assertion failed:", ...args);
    },
    count: (label = "default") => {
      counts.set(label, (counts.get(label) || 0) + 1);
      line(1)(`${label}: ${counts.get(label)}`);
    },
    time: (label = "default") => times.set(label, g.performance.now()),
    timeEnd: (label = "default") => {
      line(1)(`${label}: ${(g.performance.now() - (times.get(label) ?? 0)).toFixed(3)}ms`);
      times.delete(label);
    },
    timeLog: (label = "default") => line(1)(`${label}: ${(g.performance.now() - (times.get(label) ?? 0)).toFixed(3)}ms`),
    group: (...args) => {
      if (args.length) line(1)(...args);
      groupIndent += "  ";
    },
    groupEnd: () => {
      groupIndent = groupIndent.slice(2);
    },
  };

  // ------------------------------------------------------------------ util
  const util = {
    format,
    inspect,
    promisify: (fn) => (...args) => new Promise((resolve, reject) => fn(...args, (err, value) => (err ? reject(err) : resolve(value)))),
    callbackify: (fn) => (...args) => {
      const cb = args.pop();
      fn(...args).then((v) => cb(null, v), (e) => cb(e));
    },
    inherits: (ctor, superCtor) => {
      Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
      Object.setPrototypeOf(ctor, superCtor);
    },
    deprecate: (fn) => fn,
    isDeepStrictEqual: (a, b) => deepEqual(a, b),
    types: { isPromise: (v) => v instanceof Promise, isDate: (v) => v instanceof Date, isRegExp: (v) => v instanceof RegExp },
    TextEncoder: g.TextEncoder,
    TextDecoder: g.TextDecoder,
    parseArgs: (config = {}) => {
      const args = config.args ?? process.argv.slice(2);
      const options = config.options ?? {};
      const values = {};
      const positionals = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        const long = /^--([^=]+)(?:=(.*))?$/.exec(a);
        const short = /^-([A-Za-z])$/.exec(a);
        const name = long ? long[1] : short ? Object.keys(options).find((k) => options[k].short === short[1]) : null;
        if (!name) {
          positionals.push(a);
          continue;
        }
        const spec = options[name] ?? { type: "boolean" };
        const value = spec.type === "string" ? (long && long[2] !== undefined ? long[2] : args[++i]) : true;
        if (spec.multiple) (values[name] ??= []).push(value);
        else values[name] = value;
      }
      for (const [k, spec] of Object.entries(options)) if (values[k] === undefined && spec.default !== undefined) values[k] = spec.default;
      return { values, positionals };
    },
  };
  const deepEqual = (a, b) => {
    if (Object.is(a, b)) return true;
    if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
    if (a instanceof Map && b instanceof Map) return a.size === b.size && [...a].every(([k, v]) => b.has(k) && deepEqual(v, b.get(k)));
    if (a instanceof Set && b instanceof Set) return a.size === b.size && [...a].every((v) => b.has(v));
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  };

  // ---------------------------------------------------------------- assert
  class AssertionError extends Error {
    constructor(message) {
      super(message);
      this.name = "AssertionError";
      this.code = "ERR_ASSERTION";
    }
  }
  const fail = (message, fallback) => {
    if (message instanceof Error) throw message;
    throw new AssertionError(message ?? fallback);
  };
  const assert = (v, m) => {
    if (!v) fail(m, `The expression evaluated to a falsy value:\n\n  assert(${inspect(v)})\n`);
  };
  Object.assign(assert, {
    ok: assert,
    AssertionError,
    fail: (m) => fail(m, "Failed"),
    equal: (a, b, m) => a == b || fail(m, `${inspect(a)} == ${inspect(b)}`),
    notEqual: (a, b, m) => a != b || fail(m, `${inspect(a)} != ${inspect(b)}`),
    strictEqual: (a, b, m) => Object.is(a, b) || fail(m, `Expected values to be strictly equal:\n\n${inspect(a)} !== ${inspect(b)}\n`),
    notStrictEqual: (a, b, m) => !Object.is(a, b) || fail(m, `Expected "actual" to be strictly unequal to: ${inspect(b)}`),
    deepEqual: (a, b, m) => deepEqual(a, b) || fail(m, `Expected values to be loosely deep-equal:\n\n${inspect(a)}\n\nshould loosely deep-equal\n\n${inspect(b)}`),
    deepStrictEqual: (a, b, m) => deepEqual(a, b) || fail(m, `Expected values to be strictly deep-equal:\n${inspect(a)}\n\nshould equal\n\n${inspect(b)}`),
    notDeepStrictEqual: (a, b, m) => !deepEqual(a, b) || fail(m, "Expected values not to be deep-equal"),
    throws: (fn, expected, m) => {
      try {
        fn();
      } catch (e) {
        if (expected instanceof RegExp && !expected.test(String(e && e.message))) fail(m, `The error message did not match ${expected}`);
        return;
      }
      fail(typeof expected === "string" ? expected : m, "Missing expected exception.");
    },
    doesNotThrow: (fn, m) => {
      try {
        fn();
      } catch (e) {
        fail(m, `Got unwanted exception.\nActual message: "${e && e.message}"`);
      }
    },
    rejects: async (p, expected, m) => {
      try {
        await (typeof p === "function" ? p() : p);
      } catch {
        return;
      }
      fail(m, "Missing expected rejection.");
    },
    match: (s, re, m) => re.test(s) || fail(m, `The input did not match the regular expression ${re}. Input:\n\n${inspect(s)}\n`),
  });
  assert.strict = assert;

  // ------------------------------------------------------------ child_process
  const spawnSync = (command, args, options = {}) => {
    const argv = [command, ...(args || [])].map(String);
    const shell = options.shell;
    const request = shell ? { command: argv.join(" ") } : { argv };
    const input = options.input;
    const answer = JSON.parse(
      host.spawn(
        JSON.stringify({
          ...request,
          cwd: options.cwd ? path.resolve(options.cwd) : cwd,
          env: options.env || process.env,
          stdin: input === undefined ? "" : b64encode(toBytes(input)),
        }),
      ),
    );
    if (answer.error) {
      const e = new Error(`spawnSync ${command} ENOENT`);
      e.code = "ENOENT";
      return { pid: 0, status: null, signal: null, output: [null, null, null], stdout: null, stderr: null, error: e };
    }
    const enc = options.encoding && options.encoding !== "buffer" ? options.encoding : null;
    const out = Buffer.fromBytes(b64decode(answer.stdout));
    const err = Buffer.fromBytes(b64decode(answer.stderr));
    const stdio = options.stdio;
    const inherit = stdio === "inherit" || (Array.isArray(stdio) && stdio[1] === "inherit");
    if (inherit) {
      if (out.length) host.write(1, hostBytes(out));
      if (err.length) host.write(2, hostBytes(err));
    }
    const o = enc ? out.toString(enc) : out;
    const e2 = enc ? err.toString(enc) : err;
    return { pid: 1, status: answer.code, signal: null, output: [null, o, e2], stdout: inherit ? null : o, stderr: inherit ? null : e2 };
  };
  const execSync = (command, options = {}) => {
    const r = spawnSync(String(command), [], { ...options, shell: true });
    const stdio = options.stdio;
    if (r.stderr && r.stderr.length && !(stdio === "pipe" || (Array.isArray(stdio) && stdio[2] === "pipe"))) host.write(2, hostBytes(toBytes(r.stderr)));
    if (r.status !== 0) {
      const e = new Error(`Command failed: ${command}\n${r.stderr ? r.stderr.toString() : ""}`);
      Object.assign(e, { status: r.status, stdout: r.stdout, stderr: r.stderr, output: r.output });
      throw e;
    }
    return r.stdout;
  };
  const child_process = {
    spawnSync,
    execSync,
    execFileSync: (file, args, options = {}) => {
      const r = spawnSync(file, args, options);
      if (r.error) throw r.error;
      if (r.status !== 0) {
        const e = new Error(`Command failed: ${file} ${(args || []).join(" ")}\n${r.stderr ? r.stderr.toString() : ""}`);
        Object.assign(e, { status: r.status, stdout: r.stdout, stderr: r.stderr });
        throw e;
      }
      return r.stdout;
    },
    exec: (command, options, cb) => {
      if (typeof options === "function") cb = options;
      const r = spawnSync(String(command), [], { ...(typeof options === "object" ? options : {}), shell: true, encoding: "utf8" });
      const e = r.status ? Object.assign(new Error(`Command failed: ${command}`), { code: r.status }) : null;
      setTimeout(() => cb && cb(e, r.stdout, r.stderr));
      return new EventEmitter();
    },
    execFile: (file, args, options, cb) => {
      cb = [args, options, cb].find((x) => typeof x === "function");
      const r = spawnSync(file, Array.isArray(args) ? args : [], { encoding: "utf8" });
      const e = r.error || (r.status ? Object.assign(new Error(`Command failed: ${file}`), { code: r.status }) : null);
      setTimeout(() => cb && cb(e, r.stdout, r.stderr));
      return new EventEmitter();
    },
    spawn: (command, args, options = {}) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      const chunks = [];
      child.stdin = { write: (d) => chunks.push(toBytes(d)), end: (d) => (d !== undefined && chunks.push(toBytes(d)), run()) };
      let ran = false;
      const run = () => {
        if (ran) return;
        ran = true;
        setTimeout(() => {
          const r = spawnSync(command, Array.isArray(args) ? args : [], { ...options, input: Buffer.concat(chunks) });
          if (r.error) return child.emit("error", r.error);
          if (r.stdout && r.stdout.length) child.stdout.emit("data", r.stdout);
          if (r.stderr && r.stderr.length) child.stderr.emit("data", r.stderr);
          child.stdout.emit("end");
          child.stderr.emit("end");
          child.exitCode = r.status;
          child.emit("exit", r.status, null);
          child.emit("close", r.status, null);
        });
      };
      setTimeout(run);
      return child;
    },
  };

  // ---------------------------------------------------------------- crypto
  const randomBytes = (n) => {
    const out = new Buffer(n);
    for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
    return out;
  };
  const crypto = {
    randomUUID: () => {
      const b = randomBytes(16);
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const h = b.toString("hex");
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    },
    randomBytes,
    randomInt: (min, max) => (max === undefined ? Math.floor(Math.random() * min) : min + Math.floor(Math.random() * (max - min))),
    getRandomValues: (arr) => {
      for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
      return arr;
    },
    createHash: (alg) => {
      const name = String(alg).toLowerCase();
      const parts = [];
      const hash = {
        update(data, enc) {
          parts.push(toBytes(data, enc));
          return hash;
        },
        digest(enc) {
          const data = Buffer.concat(parts);
          const out = Buffer.fromBytes(new Uint8Array(host.digest(name, hostBytes(data))));
          return enc ? out.toString(enc) : out;
        },
      };
      return hash;
    },
  };
  crypto.webcrypto = { getRandomValues: crypto.getRandomValues, randomUUID: crypto.randomUUID };
  if (!g.crypto) g.crypto = crypto.webcrypto;

  // ------------------------------------------------------------------ zlib
  const zlibCall = (op) => (data, _options) => toBuffer(host.zlib(op, hostBytes(toBytes(data))));
  const zlib = {
    gzipSync: zlibCall("gzip"),
    gunzipSync: zlibCall("gunzip"),
    deflateSync: zlibCall("deflate"),
    inflateSync: zlibCall("inflate"),
    deflateRawSync: zlibCall("deflateRaw"),
    inflateRawSync: zlibCall("inflateRaw"),
    unzipSync: zlibCall("gunzip"),
  };
  for (const name of ["gzip", "gunzip", "deflate", "inflate", "deflateRaw", "inflateRaw"]) {
    zlib[name] = (data, options, cb) => {
      cb = typeof options === "function" ? options : cb;
      let out;
      let error = null;
      try {
        out = zlib[`${name}Sync`](data);
      } catch (e) {
        error = e;
      }
      queueMicrotask(() => cb(error, out));
    };
  }

  // ------------------------------------------------------------------- net
  const fetchImpl = (input, init = {}) =>
    new Promise((resolve, reject) => {
      const url = String(input && input.url ? input.url : input);
      let headers = init.headers || {};
      if (typeof headers.entries === "function") headers = Object.fromEntries(headers.entries());
      const body = init.body === undefined || init.body === null ? new ArrayBuffer(0) : hostBytes(toBytes(typeof init.body === "object" && !ArrayBuffer.isView(init.body) && !(init.body instanceof ArrayBuffer) ? JSON.stringify(init.body) : init.body));
      const answer = JSON.parse(host.http(JSON.stringify({ url, method: (init.method || "GET").toUpperCase(), headers: Object.entries(headers) }), body));
      if (answer.error) return reject(new TypeError(`fetch failed: ${answer.error}`));
      const bytes = toBuffer(host.httpBody());
      const map = new Map(answer.headers);
      resolve({
        ok: answer.status >= 200 && answer.status < 300,
        status: answer.status,
        statusText: answer.reason || "",
        url,
        redirected: false,
        headers: { get: (k) => map.get(String(k).toLowerCase()) ?? null, has: (k) => map.has(String(k).toLowerCase()), entries: () => map.entries(), forEach: (fn) => map.forEach((v, k) => fn(v, k)), [Symbol.iterator]: () => map.entries() },
        text: async () => bytes.toString("utf8"),
        json: async () => JSON.parse(bytes.toString("utf8")),
        arrayBuffer: async () => hostBytes(bytes),
        bytes: async () => new Uint8Array(bytes),
        blob: async () => ({ size: bytes.length, arrayBuffer: async () => hostBytes(bytes), text: async () => bytes.toString("utf8") }),
      });
    });
  g.fetch = fetchImpl;
  if (typeof g.URL !== "function") {
    g.URL = class URL {
      constructor(url, base) {
        let s = String(url);
        if (base !== undefined && !/^[a-z][a-z0-9+.-]*:/i.test(s)) {
          const b = new URL(base);
          s = s.startsWith("/") ? `${b.origin}${s}` : `${b.origin}${b.pathname.replace(/[^/]*$/, "")}${s}`;
        }
        const m = /^([a-z][a-z0-9+.-]*:)(?:\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^:/?#]*)(?::(\d+))?)?([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(s);
        if (!m) throw new TypeError(`Invalid URL: ${url}`);
        this.protocol = m[1].toLowerCase();
        this.username = m[2] || "";
        this.password = m[3] || "";
        this.hostname = m[4] || "";
        this.port = m[5] || "";
        this.pathname = m[6] || (this.hostname ? "/" : "");
        this.search = m[7] && m[7] !== "?" ? m[7] : "";
        this.hash = m[8] && m[8] !== "#" ? m[8] : "";
        this.searchParams = new URLSearchParams(this.search);
      }
      get host() {
        return this.port ? `${this.hostname}:${this.port}` : this.hostname;
      }
      get origin() {
        return `${this.protocol}//${this.host}`;
      }
      get href() {
        const q = this.searchParams.toString();
        return `${this.protocol}${this.hostname ? "//" : ""}${this.username ? `${this.username}${this.password ? `:${this.password}` : ""}@` : ""}${this.host}${this.pathname}${q ? `?${q}` : ""}${this.hash}`;
      }
      toString() {
        return this.href;
      }
      toJSON() {
        return this.href;
      }
    };
  }
  if (typeof g.URLSearchParams !== "function") {
    g.URLSearchParams = class URLSearchParams {
      constructor(init = "") {
        this.list = [];
        if (typeof init === "string") {
          for (const part of init.replace(/^\?/, "").split("&")) {
            if (!part) continue;
            const [k, v = ""] = part.split("=");
            this.list.push([decodeURIComponent(k.replace(/\+/g, " ")), decodeURIComponent(v.replace(/\+/g, " "))]);
          }
        } else if (init && typeof init === "object") {
          for (const [k, v] of Array.isArray(init) ? init : Object.entries(init)) this.list.push([String(k), String(v)]);
        }
      }
      get(k) {
        const e = this.list.find(([n]) => n === k);
        return e ? e[1] : null;
      }
      getAll(k) {
        return this.list.filter(([n]) => n === k).map(([, v]) => v);
      }
      has(k) {
        return this.list.some(([n]) => n === k);
      }
      set(k, v) {
        this.delete(k);
        this.list.push([k, String(v)]);
      }
      append(k, v) {
        this.list.push([k, String(v)]);
      }
      delete(k) {
        this.list = this.list.filter(([n]) => n !== k);
      }
      entries() {
        return this.list[Symbol.iterator]();
      }
      keys() {
        return this.list.map(([k]) => k)[Symbol.iterator]();
      }
      values() {
        return this.list.map(([, v]) => v)[Symbol.iterator]();
      }
      forEach(fn) {
        for (const [k, v] of this.list) fn(v, k, this);
      }
      [Symbol.iterator]() {
        return this.entries();
      }
      toString() {
        return this.list.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
      }
    };
  }

  // ----------------------------------------------------------- the rest
  const os = {
    EOL: "\n",
    platform: () => "linux",
    type: () => "Linux",
    arch: () => "wasm32",
    release: () => "6.0.0-sandbox",
    hostname: () => "sandbox",
    homedir: () => hostEnv.HOME || "/workspace",
    tmpdir: () => "/tmp",
    userInfo: () => ({ username: "sandbox", uid: 1000, gid: 1000, shell: "/bin/sh", homedir: hostEnv.HOME || "/workspace" }),
    cpus: () => [{ model: "wasm", speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }],
    totalmem: () => 2 ** 31,
    freemem: () => 2 ** 30,
    uptime: () => g.performance.now() / 1000,
    loadavg: () => [0, 0, 0],
    networkInterfaces: () => ({}),
    endianness: () => "LE",
    availableParallelism: () => 1,
  };
  const readline = {
    createInterface: (options = {}) => {
      const rl = new EventEmitter();
      const input = options.input || process.stdin;
      rl.close = () => rl.emit("close");
      rl.question = (q, cb) => {
        host.write(1, q);
        const data = stdinData().toString("utf8");
        const first = data.split("\n")[0];
        stdinCache = Buffer.from(data.slice(first.length + 1));
        queueMicrotask(() => cb(first));
      };
      rl[Symbol.asyncIterator] = async function* () {
        const data = input === process.stdin ? stdinData().toString("utf8") : "";
        const lines = data.split("\n");
        if (lines[lines.length - 1] === "") lines.pop();
        yield* lines;
      };
      if (input === process.stdin) {
        setTimeout(() => {
          const data = stdinData().toString("utf8");
          const lines = data.split("\n");
          if (lines[lines.length - 1] === "") lines.pop();
          for (const l of lines) rl.emit("line", l);
          rl.emit("close");
        });
      }
      return rl;
    },
  };
  readline.promises = {
    createInterface: (options) => {
      const rl = readline.createInterface(options);
      rl.question = (q) => new Promise((resolve) => readline.createInterface(options).question(q, resolve));
      return rl;
    },
  };
  const stream = { Readable: EventEmitter, Writable: EventEmitter, Transform: EventEmitter, PassThrough: EventEmitter, Stream: EventEmitter, EventEmitter };
  const timersModule = { setTimeout: g.setTimeout, setInterval: g.setInterval, setImmediate: g.setImmediate, clearTimeout: g.clearTimeout, clearInterval: g.clearInterval };
  timersModule.promises = { setTimeout: (ms, value) => new Promise((r) => g.setTimeout(() => r(value), ms)), setImmediate: (value) => new Promise((r) => g.setImmediate(() => r(value))) };
  const url = { URL: g.URL, URLSearchParams: g.URLSearchParams, fileURLToPath: (u) => decodeURIComponent(String(u).replace(/^file:\/\//, "")), pathToFileURL: (p) => new g.URL(`file://${path.resolve(p)}`) };
  const stringDecoder = { StringDecoder: class StringDecoder { constructor(enc = "utf8") { this.enc = enc; } write(b) { return Buffer.from(b).toString(this.enc); } end(b) { return b ? this.write(b) : ""; } } };
  const workerThreads = { isMainThread: true, parentPort: null, workerData: null, threadId: 0 };
  const perfHooks = { performance: g.performance };
  const unavailable = (name) => new Proxy({}, { get: (_, key) => (key === "__esModule" ? false : () => { throw new Error(`${name} is not available in the sandbox (no sockets); use fetch() or curl`); }) });

  const builtins = {
    fs,
    "fs/promises": fs.promises,
    path,
    "path/posix": path,
    os,
    util,
    events: EventEmitter,
    assert,
    "assert/strict": assert,
    child_process,
    crypto,
    zlib,
    buffer: { Buffer, constants: { MAX_LENGTH: 2 ** 31 - 1 } },
    process,
    url,
    readline,
    "readline/promises": readline.promises,
    stream,
    timers: timersModule,
    "timers/promises": timersModule.promises,
    string_decoder: stringDecoder,
    worker_threads: workerThreads,
    perf_hooks: perfHooks,
    http: unavailable("http"),
    https: unavailable("https"),
    net: unavailable("net"),
    tls: unavailable("tls"),
    dns: unavailable("dns"),
  };

  // ---------------------------------------------------------------- modules
  const cache = new Map();
  const tryFile = (p) => {
    try {
      return host.fs("isfile", p) === "1" ? p : null;
    } catch {
      return null;
    }
  };
  const resolveFile = (request, fromDir) => {
    const base = path.resolve(fromDir, request);
    const direct = tryFile(base) || [".js", ".cjs", ".mjs", ".json"].map((e) => tryFile(base + e)).find(Boolean);
    if (direct) return direct;
    const pkg = tryFile(`${base}/package.json`);
    if (pkg) {
      try {
        const meta = JSON.parse(fs.readFileSync(pkg, "utf8"));
        const main = meta.main && resolveFile(`./${meta.main}`, base);
        if (main) return main;
      } catch {}
    }
    return [".js", ".cjs", ".mjs", ".json"].map((e) => tryFile(`${base}/index${e}`)).find(Boolean) || null;
  };
  const resolveRequest = (request, fromDir) => {
    const name = String(request).replace(/^node:/, "");
    if (Object.prototype.hasOwnProperty.call(builtins, name)) return { builtin: name };
    if (/^(\.{0,2}\/|\/)/.test(name)) {
      const file = resolveFile(name, fromDir);
      if (file) return { file };
    } else {
      for (let dir = fromDir; ; dir = path.dirname(dir)) {
        const file = resolveFile(`./node_modules/${name}`, dir);
        if (file) return { file };
        if (dir === "/") break;
      }
    }
    const e = new Error(`Cannot find module '${request}'${/^(\.{0,2}\/|\/)/.test(name) ? "" : "\n(npm packages are not installed in the sandbox; the Node built-ins are)"}`);
    e.code = "MODULE_NOT_FOUND";
    throw e;
  };
  const makeRequire = (fromDir) => {
    const require = (request) => {
      const r = resolveRequest(request, fromDir);
      if (r.builtin) return builtins[r.builtin];
      if (cache.has(r.file)) return cache.get(r.file).exports;
      if (r.file.endsWith(".json")) {
        const exports = JSON.parse(fs.readFileSync(r.file, "utf8"));
        cache.set(r.file, { exports });
        return exports;
      }
      const module = { exports: {}, filename: r.file, id: r.file, loaded: false, children: [], paths: [] };
      cache.set(r.file, module);
      g.__loadCjs(module, r.file, fs.readFileSync(r.file, "utf8").replace(/^#!.*/, ""));
      module.loaded = true;
      return module.exports;
    };
    require.resolve = (request) => {
      const r = resolveRequest(request, fromDir);
      return r.builtin ? `node:${r.builtin}` : r.file;
    };
    require.cache = {};
    require.main = undefined;
    return require;
  };
  g.__loadCjs = (module, file, source) => {
    const fn = host.compile(file, source);
    fn.call(module.exports, module.exports, makeRequire(path.dirname(file)), module, file, path.dirname(file));
  };
  g.__makeRequire = makeRequire;
  g.__builtins = builtins;
  g.__resolveModule = (request, fromFile) => {
    const r = resolveRequest(request, path.dirname(fromFile));
    return r.builtin ? `node:${r.builtin}` : r.file;
  };
  g.require = makeRequire(cwd);
  g.module = { exports: {} };
  g.exports = g.module.exports;
  g.structuredClone = g.structuredClone || ((v) => (v === undefined ? v : JSON.parse(JSON.stringify(v))));
  g.AbortController =
    g.AbortController ||
    class AbortController {
      constructor() {
        this.signal = Object.assign(new EventEmitter(), { aborted: false, addEventListener() {}, removeEventListener() {} });
      }
      abort() {
        this.signal.aborted = true;
      }
    };
}
