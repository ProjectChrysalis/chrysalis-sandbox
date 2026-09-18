// Extra host builtins for the sandbox shell: the busybox build leaves gaps
// (no which/base64/tee/rg/jq/archivers/diff) and agents reach for them.
// Everything here works on the same in-memory store, synchronously.
import { gunzipSync, gzipSync, unzipSync, zipSync } from "../vendor/fflate/fflate.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Commands the runtime itself provides (native applets are listed separately). */
const HOST_BUILTINS = new Set([
  "which", "whoami", "id", "hostname", "base64", "readlink", "tee", "ln", "tree",
  "rg", "jq", "diff", "cmp", "gzip", "gunzip", "zcat", "tar", "zip", "unzip", "timeout",
  "wget", "file", "strings", "ps", "df", "uptime",
  "python3", "python", "node", "nodejs", "git", "curl", "bash", "dash",
]);

/** argv is [command, ...user args] for host builtins; some paths insert
 *  Emscripten's program name first, so drop it when it appears. */
const argsOf = (ctx) => {
  const a = ctx.argv.slice(1);
  return a[0] === "./this.program" ? a.slice(1) : a;
};
const cwdOf = (ctx) => (typeof ctx.cwd === "string" && ctx.cwd.startsWith("/") ? ctx.cwd : "/workspace");
const norm = (p) => p.replace(/\/{2,}/g, "/");
const resolve = (ctx, p) => {
  const s = String(p);
  return norm(s.startsWith("/") ? s : `${cwdOf(ctx).replace(/\/$/, "")}/${s}`);
};

export function makeExtraTools({ store, nested, net }) {
  const snapshot = () => store.snapshot();
  const read = (ctx, p) => {
    const path = resolve(ctx, p);
    const bytes = snapshot()[path];
    if (!bytes) throw new Error(`${p}: No such file or directory`);
    return bytes;
  };
  const write = (path, bytes) => {
    store.createFileSync(path, 0o644);
    store.writeSync(path, bytes, 0);
    store.touchSync(path, { size: bytes.length });
  };
  const isDir = (path) => {
    const base = `${path.replace(/\/$/, "")}/`;
    return Object.keys(snapshot()).some((k) => k.startsWith(base));
  };
  const walk = (dir) => {
    const base = `${dir.replace(/\/$/, "")}/`;
    return Object.keys(snapshot())
      .filter((k) => k.startsWith(base))
      .sort();
  };
  const stdinBytes = (ctx) => (typeof ctx.stdin === "function" ? ctx.stdin() : new Uint8Array());
  const fail = (ctx, message) => {
    ctx.stderr(`${message}\n`);
    return 1;
  };

  // ---------------------------------------------------------------- identity
  const whoami = (ctx) => {
    ctx.stdout("sandbox\n");
    return 0;
  };
  const id = (ctx) => {
    ctx.stdout("uid=1000(sandbox) gid=1000(sandbox) groups=1000(sandbox)\n");
    return 0;
  };
  const hostname = (ctx) => {
    ctx.stdout("chrysalis-sandbox\n");
    return 0;
  };

  // ------------------------------------------------------------------- which
  const APPLETS = new Set(
    "busybox sh ash cat ls cp mv rm rmdir mkdir ln chmod touch stat du dd df find grep egrep fgrep sed awk sort uniq head tail wc tr cut paste tee xargs expr test true false printf echo seq yes env printenv date sleep uname pwd id whoami hostname sync mktemp realpath dirname basename readlink sha256sum sha1sum md5sum cksum xxd hexdump od strings fold tac nl comm join split truncate file tree more less vi kill ps free uptime diff cmp patch tar gzip gunzip zcat bzip2 xz zip unzip wget nc ping login su passwd groups logname nohup nice ionice chrt taskset".split(" "),
  );
  const which = (ctx) => {
    let missing = false;
    for (const name of argsOf(ctx)) {
      const known = APPLETS.has(name) || HOST_BUILTINS.has(name);
      if (!known) {
        missing = true;
        continue;
      }
      ctx.stdout(`/usr/bin/${name}\n`);
    }
    return missing ? 1 : 0;
  };

  // ------------------------------------------------------------------ base64
  const base64 = (ctx) => {
    const argv = argsOf(ctx);
    const decode = argv.includes("-d") || argv.includes("--decode");
    const files = argv.filter((a) => !a.startsWith("-"));
    let data = files.length ? files.map((f) => read(ctx, f)).reduce((a, b) => concat(a, b), new Uint8Array()) : stdinBytes(ctx);
    if (decode) {
      const text = decoder.decode(data).replace(/\s+/g, "");
      const bin = atob(text);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
      ctx.stdout(out);
    } else {
      let bin = "";
      for (let i = 0; i < data.length; i += 8192) bin += String.fromCharCode(...data.subarray(i, i + 8192));
      ctx.stdout(`${btoa(bin)}\n`);
    }
    return 0;
  };
  const concat = (a, b) => {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  };

  // ------------------------------------------------------- readlink / tee / ln
  const readlink = (ctx) => {
    const argv = argsOf(ctx).filter((a) => a !== "-f" && a !== "--canonicalize");
    if (!argv.length) return fail(ctx, "readlink: missing operand");
    for (const p of argv) ctx.stdout(`${resolve(ctx, p)}\n`);
    return 0;
  };
  const tee = (ctx) => {
    const argv = argsOf(ctx);
    const append = argv.includes("-a");
    const names = argv.filter((a) => !a.startsWith("-"));
    const data = stdinBytes(ctx);
    ctx.stdout(data);
    for (const name of names) {
      const path = resolve(ctx, name);
      const next = append && snapshot()[path] ? concat(snapshot()[path], data) : data;
      write(path, next);
    }
    return 0;
  };
  const ln = (ctx) => {
    const argv = argsOf(ctx).filter((a) => !a.startsWith("-"));
    if (argv.length !== 2) return fail(ctx, "ln: need a source and a destination");
    const [target, link] = argv;
    const bytes = read(ctx, target);
    const path = resolve(ctx, link);
    mkdirp(path);
    write(path, bytes);
    return 0;
  };
  const mkdirp = (path) => {
    const segments = path.split("/").filter(Boolean);
    let current = "";
    for (const segment of segments) {
      current += `/${segment}`;
      try {
        store.statSync(current);
      } catch {
        store.mkdirSync(current, 0o755);
      }
    }
  };

  // -------------------------------------------------------------------- tree
  const tree = (ctx) => {
    const argv = argsOf(ctx);
    let depth = Number.POSITIVE_INFINITY;
    let showAll = false;
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "-L") depth = Number(argv[++i] ?? 0);
      else if (argv[i] === "-a") showAll = true;
      else if (!argv[i].startsWith("-")) rest.push(argv[i]);
    }
    const root = resolve(ctx, rest[0] ?? ".");
    let dirs = 0;
    let files = 0;
    const lines = [root];
    const visit = (dir, prefix, level) => {
      if (level > depth) return;
      const names = new Set();
      for (const path of walk(dir)) {
        const rel = path.slice(dir.replace(/\/$/, "").length + 1);
        names.add(rel.split("/")[0]);
      }
      const entries = [...names].sort().filter((name) => showAll || !name.startsWith("."));
      entries.forEach((name, i) => {
        const last = i === entries.length - 1;
        const path = `${dir.replace(/\/$/, "")}/${name}`;
        lines.push(`${prefix}${last ? "└── " : "├── "}${name}`);
        if (isDir(path)) {
          dirs++;
          visit(path, `${prefix}${last ? "    " : "│   "}`, level + 1);
        } else {
          files++;
        }
      });
    };
    visit(root, "", 1);
    ctx.stdout(`${lines.join("\n")}\n\n${dirs} directories, ${files} files\n`);
    return 0;
  };

  // ---------------------------------------------------------------------- rg
  const rg = (ctx) => {
    const argv = argsOf(ctx);
    let ignoreCase = false;
    let filesOnly = false;
    let fixed = false;
    let listFiles = false;
    let glob = null;
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === "-i" || a === "--ignore-case") ignoreCase = true;
      else if (a === "-F" || a === "--fixed-strings") fixed = true;
      else if (a === "-l" || a === "--files-with-matches") filesOnly = true;
      else if (a === "--files") listFiles = true;
      else if (a === "-g" || a === "--glob") glob = argv[++i] ?? null;
      else if (a === "-n" || a === "--line-number" || a === "-H" || a === "--with-filename" || a === "--no-heading" || a === "-S" || a === "--smart-case" || a === "--hidden" || a === "-uu" || a === "-u") continue;
      else if (a.startsWith("-")) continue;
      else rest.push(a);
    }
    const paths = rest.length > 1 ? rest.slice(1) : ["."];
    const pattern = rest[0] ?? "";
    const globRe = glob ? globToRegExp(glob) : null;
    const matcher = fixed
      ? (line) => (ignoreCase ? line.toLowerCase().includes(pattern.toLowerCase()) : line.includes(pattern))
      : (() => {
          let re;
          try {
            re = new RegExp(pattern, ignoreCase ? "i" : "");
          } catch (e) {
            return null;
          }
          return (line) => re.test(line);
        })();
    if (!matcher) return fail(ctx, `rg: invalid regex: ${pattern}`);
    const targets = [];
    for (const p of paths) {
      const abs = resolve(ctx, p);
      if (isDir(abs)) targets.push(...walk(abs));
      else targets.push(abs);
    }
    let matched = false;
    for (const path of targets) {
      if (globRe && !globRe.test(path)) continue;
      if (listFiles) {
        ctx.stdout(`${display(ctx, path)}\n`);
        continue;
      }
      const bytes = snapshot()[path];
      if (!bytes || bytes.includes(0)) continue;
      const lines = decoder.decode(bytes).split("\n");
      let fileMatched = false;
      lines.forEach((line, i) => {
        if (!matcher(line)) return;
        fileMatched = true;
        if (filesOnly) return;
        ctx.stdout(`${display(ctx, path)}:${i + 1}:${line}\n`);
      });
      if (fileMatched) matched = true;
      if (fileMatched && filesOnly) ctx.stdout(`${display(ctx, path)}\n`);
    }
    return matched || listFiles ? 0 : 1;
  };
  const display = (ctx, path) => (path.startsWith("/workspace/") ? path.slice("/workspace/".length) : path);
  const globToRegExp = (glob) => {
    if (!glob.includes("*")) return new RegExp(`(^|/)${glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&")}$`);
    const pattern = glob
      .split(",")
      .map((g) => g.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*"))
      .join("|");
    return new RegExp(`(${pattern})$`);
  };

  // ---------------------------------------------------------------------- jq
  const jq = (ctx) => {
    const argv = argsOf(ctx);
    let raw = false;
    let compact = false;
    const rest = [];
    for (const a of argv) {
      if (a === "-r" || a === "--raw-output") raw = true;
      else if (a === "-c" || a === "--compact-output") compact = true;
      else if (a === "-e" || a === "--exit-status") continue;
      else if (a === "." && !rest.length) rest.push(a);
      else if (!a.startsWith("-") || a === ".") rest.push(a);
    }
    const filter = rest[0] ?? ".";
    const file = rest[1];
    let input;
    try {
      input = JSON.parse(decoder.decode(file ? read(ctx, file) : stdinBytes(ctx)));
    } catch {
      return fail(ctx, "jq: invalid JSON input");
    }
    let value;
    try {
      value = runFilter(input, filter);
    } catch (e) {
      return fail(ctx, `jq: ${(e && e.message) || e}`);
    }
    if (value === undefined) {
      ctx.stdout("null\n");
      return 1;
    }
    if (raw && typeof value === "string") ctx.stdout(`${value}\n`);
    else ctx.stdout(`${JSON.stringify(value, null, compact ? 0 : 2)}\n`);
    return 0;
  };
  const runFilter = (input, filter) => {
    const stages = splitTop(filter, "|");
    let value = input;
    for (const rawStage of stages) {
      const stage = rawStage.trim();
      if (stage === ".") continue;
      if (stage === "length") {
        value = value == null ? 0 : typeof value === "object" ? Object.keys(value).length : value.length;
        continue;
      }
      if (stage === "keys") {
        value = Object.keys(value ?? {}).sort();
        continue;
      }
      if (stage === "type") {
        value = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
        continue;
      }
      if (stage === "first") {
        value = Array.isArray(value) ? value[0] : undefined;
        continue;
      }
      if (stage === "last") {
        value = Array.isArray(value) ? value[value.length - 1] : undefined;
        continue;
      }
      if (!stage.startsWith(".")) throw new Error(`unsupported filter: ${stage}`);
      const bare = stage.replace(/\.(?=\[)/g, "").replace(/\s+/g, "");
      const tokens = stage.match(/\[\s*(\d*)\s*\]|\."([^"]+)"|\.[A-Za-z_][\w-]*/g) ?? [];
      if (tokens.join("") !== bare) throw new Error(`unsupported filter: ${stage}`);
      for (const token of tokens) {
        const bracket = token.match(/^\[\s*(\d*)\s*\]$/);
        if (bracket) {
          if (value == null) {
            value = undefined;
            break;
          }
          if (bracket[1] === "") value = Array.isArray(value) ? value : Object.values(value);
          else value = value[Number(bracket[1])];
          continue;
        }
        const key = token.startsWith('."') ? token.slice(2, -1) : token.slice(1);
        value = value == null ? undefined : value[key];
      }
    }
    return value;
  };
  const splitTop = (text, sep) => {
    const out = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      else if (c === sep && depth === 0) {
        out.push(text.slice(start, i));
        start = i + 1;
      }
    }
    out.push(text.slice(start));
    return out;
  };

  // ------------------------------------------------------------ diff and cmp
  const diff = (ctx) => {
    const argv = argsOf(ctx);
    const quiet = argv.includes("-q");
    const files = argv.filter((a) => !a.startsWith("-"));
    if (files.length !== 2) return fail(ctx, "diff: need two files");
    const a = decoder.decode(read(ctx, files[0])).split("\n");
    const b = decoder.decode(read(ctx, files[1])).split("\n");
    const same = a.length === b.length && a.every((line, i) => line === b[i]);
    if (same) return 0;
    if (quiet) {
      ctx.stdout(`Files ${files[0]} and ${files[1]} differ\n`);
      return 1;
    }
    if (a.length > 1500 || b.length > 1500) {
      ctx.stdout(`Files ${files[0]} and ${files[1]} differ (too large for a line diff)\n`);
      return 1;
    }
    const ops = diffOps(a, b);
    ctx.stdout(`--- ${files[0]}\n+++ ${files[1]}\n`);
    ctx.stdout(`@@ -1,${a.length} +1,${b.length} @@\n`);
    for (const op of ops) ctx.stdout(`${op.prefix}${op.line}\n`);
    return 1;
  };
  const diffOps = (a, b) => {
    const n = a.length;
    const m = b.length;
    const width = m + 1;
    const lcs = new Int32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * width + j] = a[i] === b[j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
      }
    }
    const ops = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        ops.push({ prefix: " ", line: a[i++] });
        j++;
      } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
        ops.push({ prefix: "-", line: a[i++] });
      } else {
        ops.push({ prefix: "+", line: b[j++] });
      }
    }
    while (i < n) ops.push({ prefix: "-", line: a[i++] });
    while (j < m) ops.push({ prefix: "+", line: b[j++] });
    return ops;
  };
  const cmp = (ctx) => {
    const files = argsOf(ctx).filter((a) => !a.startsWith("-"));
    if (files.length !== 2) return fail(ctx, "cmp: need two files");
    const a = read(ctx, files[0]);
    const b = read(ctx, files[1]);
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      if (a[i] !== b[i]) {
        ctx.stdout(`${files[0]} ${files[1]} differ: byte ${i + 1}, line 1\n`);
        return 1;
      }
    }
    if (a.length !== b.length) {
      ctx.stdout(`cmp: EOF on ${a.length < b.length ? files[0] : files[1]} after byte ${len}\n`);
      return 1;
    }
    return 0;
  };

  // --------------------------------------------------------------- fflate IO
  const gzip = (ctx) => {
    const argv = argsOf(ctx);
    const toStdout = argv.includes("-c");
    const keep = argv.includes("-k");
    const files = argv.filter((a) => !a.startsWith("-"));
    if (!files.length) {
      ctx.stdout(gzipSync(stdinBytes(ctx)));
      return 0;
    }
    for (const name of files) {
      const path = resolve(ctx, name);
      const bytes = gzipSync(read(ctx, name));
      if (toStdout) ctx.stdout(bytes);
      else {
        write(`${path}.gz`, bytes);
        if (!keep) {
          try {
            store.unlinkSync(path);
          } catch {
            /* nothing */
          }
        }
      }
    }
    return 0;
  };
  const gunzip = (ctx) => {
    const argv = argsOf(ctx);
    const toStdout = argv.includes("-c");
    const keep = argv.includes("-k");
    const files = argv.filter((a) => !a.startsWith("-"));
    if (!files.length) {
      try {
        ctx.stdout(gunzipSync(stdinBytes(ctx)));
      } catch {
        return fail(ctx, "gunzip: invalid gzip data");
      }
      return 0;
    }
    for (const name of files) {
      const path = resolve(ctx, name);
      let bytes;
      try {
        bytes = gunzipSync(read(ctx, name));
      } catch {
        return fail(ctx, `gunzip: ${name}: not in gzip format`);
      }
      if (toStdout) ctx.stdout(bytes);
      else {
        const out = path.endsWith(".gz") ? path.slice(0, -3) : `${path}.out`;
        write(out, bytes);
        if (!keep) {
          try {
            store.unlinkSync(path);
          } catch {
            /* nothing */
          }
        }
      }
    }
    return 0;
  };
  const zcat = (ctx) => gunzip(ctx);

  const tar = (ctx) => {
    const argv = argsOf(ctx);
    const flags = argv.find((a) => /^[a-z-]+$/.test(a) && !a.startsWith("--") && /[cxt]/.test(a)) ?? argv[0] ?? "";
    const mode = flags.includes("c") ? "c" : flags.includes("x") ? "x" : flags.includes("t") ? "t" : "";
    const gz = flags.includes("z") || argv.some((a) => a.endsWith(".gz") || a.endsWith(".tgz"));
    const files = [];
    let dir = null;
    let flagsToken = null;
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === "-C") dir = resolve(ctx, argv[++i] ?? ".");
      else if (a === "-f") continue;
      else if (/^[a-z-]*[cxt][a-z-]*$/.test(a) && !a.startsWith("--")) flagsToken = a;
      else if (a.startsWith("-") && /^[a-z-]+$/.test(a.slice(1))) continue;
      else files.push(a);
    }
    if (!mode) return fail(ctx, "tar: specify one of -c, -x or -t");
    const tarPath = files.shift();
    const base = dir ?? cwdOf(ctx);
    if (mode === "c") {
      if (!tarPath) return fail(ctx, "tar: missing archive name");
      const entries = [];
      for (const f of files.length ? files : ["."]) {
        const abs = dir ? norm(`${dir}/${f}`) : resolve(ctx, f);
        if (isDir(abs)) {
          for (const p of walk(abs)) {
            entries.push({ name: relTo(base, p), bytes: snapshot()[p] });
          }
        } else {
          entries.push({ name: relTo(base, abs), bytes: snapshot()[abs] });
        }
      }
      let out = tarCreate(entries);
      if (gz) out = gzipSync(out);
      write(resolve(ctx, tarPath), out);
      return 0;
    }
    let data;
    try {
      data = read(ctx, tarPath);
    } catch (e) {
      return fail(ctx, `tar: ${e.message}`);
    }
    if (gz || (data[0] === 0x1f && data[1] === 0x8b)) data = gunzipSync(data);
    const entries = tarRead(data);
    if (mode === "t") {
      for (const e of entries) ctx.stdout(`${e.name}\n`);
      return 0;
    }
    for (const entry of entries) {
      const path = norm(`${base}/${entry.name}`);
      if (entry.dir) mkdirp(path);
      else {
        mkdirp(path);
        write(path, entry.bytes);
      }
    }
    return 0;
  };
  const relTo = (base, path) => norm(path).replace(new RegExp(`^${base.replace(/\/$/, "")}/?`), "").replace(/^\//, "") || ".";
  const tarCreate = (entries) => {
    const blocks = [];
    for (const entry of entries) {
      const name = entry.name.endsWith("/") ? entry.name : entry.name;
      const size = entry.bytes?.length ?? 0;
      const header = new Uint8Array(512);
      const put = (offset, length, text) => {
        const bytes = encoder.encode(text);
        header.set(bytes.subarray(0, length), offset);
      };
      const octal = (value, length) => value.toString(8).padStart(length - 1, "0") + "\0";
      put(0, 100, name.length > 100 ? name.slice(-100) : name);
      put(100, 8, octal(0o644, 8));
      put(108, 8, octal(0, 8));
      put(116, 8, octal(0, 8));
      put(124, 12, octal(size, 12));
      put(136, 12, octal(Math.floor(Date.now() / 1000), 12));
      header.fill(0x20, 148, 156);
      header[156] = 0x30;
      put(257, 6, "ustar\0");
      put(263, 2, "00");
      let sum = 0;
      for (const byte of header) sum += byte;
      put(148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
      blocks.push(header);
      if (entry.bytes?.length) {
        blocks.push(entry.bytes);
        const pad = (512 - (entry.bytes.length % 512)) % 512;
        if (pad) blocks.push(new Uint8Array(pad));
      }
    }
    blocks.push(new Uint8Array(1024));
    const total = blocks.reduce((n, b) => n + b.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const b of blocks) {
      out.set(b, off);
      off += b.length;
    }
    return out;
  };
  const tarRead = (data) => {
    const entries = [];
    let off = 0;
    while (off + 512 <= data.length) {
      const header = data.subarray(off, off + 512);
      if (header.every((b) => b === 0)) break;
      const text = (start, length) => decoder.decode(header.subarray(start, start + length)).replace(/\0.*$/, "").trim();
      const name = text(0, 100) + (text(345, 155) ? `/${text(345, 155)}` : "");
      const size = Number.parseInt(text(124, 12) || "0", 8);
      const type = String.fromCharCode(header[156] || 0x30);
      off += 512;
      if (type === "5") {
        entries.push({ name: name.replace(/\/$/, "") + "/", dir: true });
        continue;
      }
      entries.push({ name, bytes: data.subarray(off, off + size) });
      off += Math.ceil(size / 512) * 512;
    }
    return entries;
  };

  const zip = (ctx) => {
    const argv = argsOf(ctx);
    const recursive = argv.includes("-r");
    const files = argv.filter((a) => !a.startsWith("-"));
    const archive = files.shift();
    if (!archive) return fail(ctx, "zip: missing archive name");
    const tree = {};
    for (const f of files) {
      const abs = resolve(ctx, f);
      if (isDir(abs)) {
        for (const p of walk(abs)) tree[relTo(cwdOf(ctx), p)] = snapshot()[p];
      } else {
        tree[relTo(cwdOf(ctx), abs)] = snapshot()[abs];
      }
    }
    if (!recursive && !Object.keys(tree).length) return fail(ctx, "zip: nothing to do");
    write(resolve(ctx, archive), zipSync(tree, { level: 6 }));
    return 0;
  };
  const unzip = (ctx) => {
    const argv = argsOf(ctx).filter((a) => a !== "-o" && a !== "-q");
    const archive = argv[0];
    if (!archive) return fail(ctx, "unzip: missing archive name");
    let entries;
    try {
      entries = unzipSync(read(ctx, archive));
    } catch {
      return fail(ctx, `unzip: ${archive}: not a zip archive`);
    }
    const base = argv[1] ? resolve(ctx, argv[1]) : cwdOf(ctx);
    for (const [name, bytes] of Object.entries(entries)) {
      const path = norm(`${base}/${name}`);
      if (name.endsWith("/")) mkdirp(path);
      else {
        mkdirp(path);
        write(path, bytes);
      }
    }
    return 0;
  };

  // ------------------------------------------------------------------ timeout
  const timeout = (ctx) => {
    const argv = argsOf(ctx);
    const seconds = Number(argv[0]);
    const command = argv.slice(1);
    if (!command.length) return fail(ctx, "timeout: missing command");
    ctx.stderr(`timeout: warning: this sandbox runs synchronously and cannot enforce the ${seconds}s limit\n`);
    if (!nested) return 127;
    const quote = (a) => `'${String(a).replace(/'/g, "'\\''")}'`;
    return nested(ctx, ["-c", command.map(quote).join(" ")]);
  };

  // ------------------------------------------------------------------ wget
  const wget = (ctx) => {
    const argv = argsOf(ctx);
    let output = null;
    let url = null;
    const quiet = argv.includes("-q");
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === "-O" || a === "--output-document") {
        output = argv[++i] ?? null;
        continue;
      }
      if (a === "-q" || a === "--quiet" || a === "-c" || a === "--continue" || a === "--no-check-certificate" || a === "-nv") continue;
      if (a.startsWith("-")) continue;
      url = a;
    }
    if (!url) return fail(ctx, "wget: missing URL");
    if (!net) return fail(ctx, "wget: network is disabled (Settings, Agent)");
    const res = net(url, "GET", null, []);
    if (res.error) return fail(ctx, `wget: ${res.error}`);
    if (output && output !== "-") {
      write(resolve(ctx, output), encoder.encode(res.body));
    } else {
      ctx.stdout(res.body);
    }
    return res.status >= 400 ? 8 : 0;
  };

  // ------------------------------------------------------- system-ish fakes
  const file = (ctx) => {
    const files = argsOf(ctx).filter((a) => !a.startsWith("-"));
    if (!files.length) return fail(ctx, "file: missing file");
    for (const name of files) {
      let bytes;
      try {
        bytes = read(ctx, name);
      } catch {
        ctx.stdout(`${name}: cannot open\n`);
        continue;
      }
      ctx.stdout(`${name}: ${sniff(name, bytes)}\n`);
    }
    return 0;
  };
  const sniff = (name, bytes) => {
    const head = decoder.decode(bytes.subarray(0, 512));
    if (bytes.length === 0) return "empty";
    if (head.includes("\u0000")) return "data";
    if (/^\s*<(!doctype|html)/i.test(head)) return "HTML document";
    if (/^\s*[{[]/.test(head)) return "JSON text";
    if (/^#!/.test(head)) return `script, ${head.split("\n")[0].slice(2, 40)}`;
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    const types = {
      js: "JavaScript source", mjs: "JavaScript source", ts: "TypeScript source", tsx: "TypeScript source",
      json: "JSON text", md: "Markdown text", txt: "Unicode text", css: "CSS stylesheet",
      png: "PNG image data", jpg: "JPEG image data", jpeg: "JPEG image data", gif: "GIF image data",
      webp: "Web/P image", svg: "SVG image data", wasm: "WebAssembly binary", gz: "gzip compressed data",
      zip: "Zip archive data", tar: "tar archive", py: "Python script", sh: "shell script", yaml: "YAML text", yml: "YAML text",
    };
    return types[ext] ?? "ASCII text";
  };
  const strings = (ctx) => {
    const argv = argsOf(ctx);
    const min = Number(argv.find((a) => /^-\d+$/.test(a))?.slice(1) ?? 4);
    const files = argv.filter((a) => !a.startsWith("-"));
    const sources = files.length ? files.map((f) => read(ctx, f)) : [stdinBytes(ctx)];
    for (const bytes of sources) {
      const text = decoder.decode(bytes);
      const matches = text.match(new RegExp(`[\\x20-\\x7e]{${min},}`, "g")) ?? [];
      for (const m of matches) ctx.stdout(`${m}\n`);
    }
    return 0;
  };
  const ps = (ctx) => {
    ctx.stdout("  PID USER     STAT COMMAND\n    1 sandbox  S    sh\n");
    return 0;
  };
  const df = (ctx) => {
    const bytes = Object.values(snapshot()).reduce((n, b) => n + b.length, 0);
    ctx.stdout("Filesystem     1K-blocks      Used Available Use% Mounted on\n");
    ctx.stdout(`workspace       67108864  ${String(Math.ceil(bytes / 1024)).padStart(8)}  67000000   1% /workspace\n`);
    return 0;
  };
  const uptime = (ctx) => {
    const seconds = Math.floor(performance.now() / 1000);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    ctx.stdout(` ${new Date().toTimeString().slice(0, 8)} up ${h}:${String(m).padStart(2, "0")}, 1 user, load average: 0.00, 0.00, 0.00\n`);
    return 0;
  };

  const tools = {
    which,
    whoami,
    id,
    hostname,
    base64,
    readlink,
    tee,
    ln,
    tree,
    rg,
    jq,
    diff,
    cmp,
    gzip,
    gunzip,
    zcat,
    tar,
    zip,
    unzip,
    timeout,
    wget,
    file,
    strings,
    ps,
    df,
    uptime,
  };
  return tools;
}
