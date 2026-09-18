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
  "wget", "file", "strings", "ps", "df", "uptime", "chmod", "fd",
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
  // A small jq over value streams: paths, arithmetic/comparison/logic, pipes,
  // array and object construction, and the functions agents actually use.
  // Anything outside the grammar says "unsupported filter" instead of guessing.
  const jq = (ctx) => {
    const argv = argsOf(ctx);
    let raw = false;
    let compact = false;
    let exitStatus = false;
    const rest = [];
    for (const a of argv) {
      if (a === "-r" || a === "--raw-output") raw = true;
      else if (a === "-c" || a === "--compact-output") compact = true;
      else if (a === "-e" || a === "--exit-status") exitStatus = true;
      else if (a === "-j" || a === "--join-output" || a === "-n" || a === "--null-input") continue;
      else rest.push(a);
    }
    const filter = rest[0] ?? ".";
    const file = rest[1];
    let inputs;
    if (argv.includes("-n") || argv.includes("--null-input")) inputs = [null];
    else {
      try {
        inputs = [JSON.parse(decoder.decode(file ? read(ctx, file) : stdinBytes(ctx)))];
      } catch {
        return fail(ctx, "jq: invalid JSON input");
      }
    }
    let values;
    try {
      values = evaluateJq(parseJq(filter), inputs);
    } catch (e) {
      return fail(ctx, `jq: ${(e && e.message) || e}`);
    }
    for (const value of values) {
      if (value === undefined) ctx.stdout("null\n");
      else if (raw && typeof value === "string") ctx.stdout(`${value}\n`);
      else ctx.stdout(`${JSON.stringify(value, null, compact ? 0 : 2)}\n`);
    }
    if (exitStatus) return values.length && values.some((v) => v !== false && v !== null) ? 0 : 1;
    return 0;
  };

  const jqTruthy = (v) => v !== false && v !== null && v !== undefined;
  const jqLength = (v) => {
    if (v == null) return 0;
    if (typeof v === "number") return Math.abs(v);
    if (typeof v === "string") return [...v].length;
    return Object.keys(v).length;
  };
  const jqKeys = (v) => {
    if (Array.isArray(v)) return v.map((_, i) => i);
    if (v && typeof v === "object") return Object.keys(v).sort();
    return [];
  };
  const jqType = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
  const jqEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const jqAdd = (a, b) => {
    if (a == null) return b;
    if (b == null) return a;
    if (typeof a === "number" && typeof b === "number") return a + b;
    if (typeof a === "string" && typeof b === "string") return a + b;
    if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
    if (typeof a === "object" && typeof b === "object") return { ...a, ...b };
    if (typeof a === "string" || typeof b === "string") return String(a) + String(b);
    return Number(a) + Number(b);
  };
  const jqSum = (v) => {
    if (!Array.isArray(v)) return v ?? null;
    if (!v.length) return null;
    return v.reduce((acc, item) => (acc === null ? item : jqAdd(acc, item)), null);
  };


  const applyJqOp = (op, l, r) => {
    if (op === "or") return jqTruthy(l) || jqTruthy(r);
    if (op === "and") return jqTruthy(l) && jqTruthy(r);
    switch (op) {
      case "+": return jqAdd(l, r);
      case "-": return Number(l) - Number(r);
      case "*": return Number(l) * Number(r);
      case "/": return Number(l) / Number(r);
      case "%": return Number(l) % Number(r);
      case "==": return jqEqual(l, r);
      case "!=": return !jqEqual(l, r);
      case "<": return l < r;
      case "<=": return l <= r;
      case ">": return l > r;
      case ">=": return l >= r;
    }
    throw new Error(`unsupported operator: ${op}`);
  };

  const parseJq = (text) => {
    let pos = 0;
    const ws = () => {
      while (pos < text.length && /\s/.test(text[pos])) pos++;
    };
    const peek = (s) => {
      ws();
      return text.startsWith(s, pos);
    };
    const eat = (s) => {
      if (!peek(s)) throw new Error(`unsupported filter: ${text}`);
      pos += s.length;
    };
    const tryEat = (s) => {
      if (peek(s)) {
        pos += s.length;
        return true;
      }
      return false;
    };
    const keyword = (word) => {
      ws();
      const m = new RegExp(`^${word}\\b`).test(text.slice(pos));
      if (m) pos += word.length;
      return m;
    };
    const ident = () => {
      ws();
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(pos));
      if (!m) throw new Error(`unsupported filter: ${text}`);
      pos += m[0].length;
      return m[0];
    };
    const jqString = () => {
      ws();
      if (text[pos] !== '"') throw new Error(`unsupported filter: ${text}`);
      let out = "";
      pos++;
      while (pos < text.length && text[pos] !== '"') {
        if (text[pos] === "\\") {
          const c = text[pos + 1];
          out += c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c;
          pos += 2;
        } else {
          out += text[pos++];
        }
      }
      pos++;
      return out;
    };
    const jqNumber = () => {
      ws();
      const m = /^\d+(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(pos));
      if (!m) throw new Error(`unsupported filter: ${text}`);
      pos += m[0].length;
      return Number(m[0]);
    };

    const parsePipe = () => {
      let left = parseComma();
      while (tryEat("|")) left = { k: "pipe", left, right: parseComma() };
      return left;
    };
    const parseComma = () => {
      let left = parseAlt();
      while (tryEat(",")) left = { k: "comma", left, right: parseAlt() };
      return left;
    };
    const parseAlt = () => {
      let left = parseOr();
      while (tryEat("//")) left = { k: "alt", left, right: parseOr() };
      return left;
    };
    const parseOr = () => {
      let left = parseAnd();
      while (keyword("or")) left = { k: "bin", op: "or", left, right: parseAnd() };
      return left;
    };
    const parseAnd = () => {
      let left = parseCompare();
      while (keyword("and")) left = { k: "bin", op: "and", left, right: parseCompare() };
      return left;
    };
    const parseCompare = () => {
      const left = parseAdditive();
      for (const op of ["==", "!=", "<=", ">=", "<", ">"]) {
        if (peek(op)) {
          pos += op.length;
          return { k: "bin", op, left, right: parseAdditive() };
        }
      }
      return left;
    };
    const parseAdditive = () => {
      let left = parseMultiplicative();
      for (;;) {
        if (peek("+")) {
          pos++;
          left = { k: "bin", op: "+", left, right: parseMultiplicative() };
        } else if (peek("-")) {
          pos++;
          left = { k: "bin", op: "-", left, right: parseMultiplicative() };
        } else return left;
      }
    };
    const parseMultiplicative = () => {
      let left = parseUnary();
      for (;;) {
        if (peek("*")) {
          pos++;
          left = { k: "bin", op: "*", left, right: parseUnary() };
        } else if (peek("/") && !peek("//")) {
          pos++;
          left = { k: "bin", op: "/", left, right: parseUnary() };
        } else if (peek("%")) {
          pos++;
          left = { k: "bin", op: "%", left, right: parseUnary() };
        } else return left;
      }
    };
    const parseUnary = () => {
      ws();
      if (peek("-")) {
        pos++;
        return { k: "neg", value: parseUnary() };
      }
      if (keyword("not")) return { k: "not", value: parseUnary() };
      return parsePostfix();
    };
    const parsePostfix = () => {
      let node = parsePrimary();
      for (;;) {
        ws();
        if (peek(".[") || (peek("[") && node.k !== "identity")) {
          // index or iterate applied to the current node
          node = { k: "pipe", left: node, right: parsePath("[") };
        } else if (peek(".") && !peek("..")) {
          node = { k: "pipe", left: node, right: parsePath(".") };
        } else return node;
      }
    };
    const parsePath = (start) => {
      const steps = [];
      if (start === ".") {
        pos++;
        steps.push({ k: "key", value: parseSegment() });
      }
      for (;;) {
        ws();
        if (peek("[")) {
          pos++;
          ws();
          if (peek("]")) {
            pos++;
            steps.push({ k: "iterate" });
          } else if (text[pos] === '"') {
            steps.push({ k: "index", value: jqString() });
            eat("]");
          } else {
            const m = /^-?\d+/.exec(text.slice(pos));
            if (!m) throw new Error(`unsupported filter: ${text}`);
            pos += m[0].length;
            steps.push({ k: "index", value: Number(m[0]) });
            eat("]");
          }
          continue;
        }
        if (peek(".")) {
          pos++;
          steps.push({ k: "key", value: parseSegment() });
          continue;
        }
        break;
      }
      return steps.length ? { k: "path", steps } : { k: "identity" };
    };
    const parseSegment = () => {
      ws();
      if (text[pos] === '"') return jqString();
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(pos));
      if (!m) throw new Error(`unsupported filter: ${text}`);
      pos += m[0].length;
      return m[0];
    };
    const ZERO_ARG = new Set(["length", "keys", "type", "first", "last", "add", "tostring", "tonumber", "tojson", "fromjson", "ascii_downcase", "ascii_upcase", "empty", "now", "floor", "ceil", "round"]);
    const ARG_FUNCS = new Set(["map", "select", "has", "split", "join", "any", "all", "contains", "startswith", "endswith", "ltrimstr", "rtrimstr"]);
    const parsePrimary = () => {
      ws();
      if (text[pos] === "(") {
        pos++;
        const inner = parsePipe();
        eat(")");
        return inner;
      }
      if (text[pos] === "[") {
        pos++;
        ws();
        if (text[pos] === "]") {
          pos++;
          return { k: "array", value: { k: "identity" } };
        }
        const inner = parsePipe();
        eat("]");
        return { k: "array", value: inner };
      }
      if (text[pos] === "{") {
        pos++;
        const entries = [];
        ws();
        if (text[pos] !== "}") {
          for (;;) {
            ws();
            let key;
            if (text[pos] === '"') key = jqString();
            else key = ident();
            ws();
            if (tryEat(":")) entries.push([key, parseAlt()]);
            else entries.push([key, { k: "path", steps: [{ k: "key", value: key }] }]);
            if (tryEat(",")) continue;
            break;
          }
        }
        eat("}");
        return { k: "object", entries };
      }
      if (text[pos] === ".") {
        if (/^\.\s*[A-Za-z_"]/.test(text.slice(pos)) || /^\.\s*\[/.test(text.slice(pos))) return parsePath(".");
        pos++;
        return { k: "identity" };
      }
      if (text[pos] === "@") {
        pos++;
        const name = ident();
        return { k: "format", name };
      }
      if (text[pos] === '"') return { k: "literal", value: jqString() };
      if (/\d/.test(text[pos] ?? "")) return { k: "literal", value: jqNumber() };
      if (keyword("true")) return { k: "literal", value: true };
      if (keyword("false")) return { k: "literal", value: false };
      if (keyword("null")) return { k: "literal", value: null };
      if (/^[A-Za-z_]/.test(text[pos] ?? "")) {
        const name = ident();
        if (tryEat("(")) {
          if (!ARG_FUNCS.has(name)) throw new Error(`unsupported function: ${name}`);
          const args = [];
          ws();
          if (text[pos] !== ")") {
            for (;;) {
              args.push(parseAlt());
              if (tryEat(",")) continue;
              break;
            }
          }
          eat(")");
          return { k: "call", name, args };
        }
        if (!ZERO_ARG.has(name)) throw new Error(`unsupported filter: ${text}`);
        return { k: "call", name, args: [] };
      }
      throw new Error(`unsupported filter: ${text}`);
    };

    const program = parsePipe();
    ws();
    if (pos < text.length) throw new Error(`unsupported filter: ${text}`);
    return program;
  };

  const navigateJq = (input, steps) => {
    let stream = [input];
    for (const step of steps) {
      const next = [];
      for (const value of stream) {
        if (step.k === "iterate") {
          if (Array.isArray(value)) next.push(...value);
          else if (value && typeof value === "object") next.push(...Object.values(value));
        } else if (step.k === "index") {
          if (Array.isArray(value)) {
            const index = Number(step.value);
            if (index >= 0 && index < value.length) next.push(value[index]);
          } else if (value && typeof value === "object") {
            if (step.value in value) next.push(value[step.value]);
          } else if (value == null) next.push(null);
        } else if (value == null) next.push(null);
        else next.push(value[step.value] ?? null);
      }
      stream = next;
    }
    return stream;
  };

  const evaluateJq = (node, inputs) => {
    switch (node.k) {
      case "identity":
        return inputs;
      case "literal":
        return inputs.map(() => node.value);
      case "path": {
        const out = [];
        for (const input of inputs) out.push(...navigateJq(input, node.steps));
        return out;
      }
      case "comma":
        return [...evaluateJq(node.left, inputs), ...evaluateJq(node.right, inputs)];
      case "pipe":
        return evaluateJq(node.right, evaluateJq(node.left, inputs));
      case "bin": {
        const results = [];
        for (const input of inputs) {
          const left = evaluateJq(node.left, [input]);
          const right = evaluateJq(node.right, [input]);
          for (const l of left) {
            for (const r of right) results.push(applyJqOp(node.op, l, r));
          }
        }
        return results;
      }
      case "alt": {
        const left = evaluateJq(node.left, inputs).filter(jqTruthy);
        return left.length ? left : evaluateJq(node.right, inputs);
      }
      case "neg":
        return evaluateJq(node.value, inputs).map((v) => -Number(v));
      case "not":
        return evaluateJq(node.value, inputs).map((v) => !jqTruthy(v));
      case "array":
        return [evaluateJq(node.value, inputs)];
      case "object": {
        const out = {};
        for (const [key, value] of node.entries) out[key] = evaluateJq(value, inputs)[0] ?? null;
        return [out];
      }
      case "format": {
        const value = inputs[0];
        if (node.name === "base64") return [btoa(typeof value === "string" ? value : JSON.stringify(value))];
        if (node.name === "base64d") return [atob(String(value))];
        if (node.name === "tsv") return [Array.isArray(value) ? value.map((v) => String(v ?? "")).join("\t") : String(value)];
        if (node.name === "csv") return [Array.isArray(value) ? value.map((v) => (typeof v === "string" && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : String(v ?? ""))).join(",") : String(value)];
        if (node.name === "json") return [JSON.stringify(value)];
        throw new Error(`unsupported filter: @${node.name}`);
      }
      case "call": {
        const first = inputs[0];
        const arg = (i) => (node.args[i] ? evaluateJq(node.args[i], inputs) : []);
        switch (node.name) {
          case "length": return [jqLength(first)];
          case "keys": return [jqKeys(first)];
          case "type": return [jqType(first)];
          case "first": return node.args.length ? evaluateJq(node.args[0], inputs).slice(0, 1) : [Array.isArray(first) ? first[0] : first];
          case "last": return node.args.length ? evaluateJq(node.args[0], inputs).slice(-1) : [Array.isArray(first) ? first[first.length - 1] : first];
          case "add": return [jqSum(first)];
          case "tostring": return inputs.map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
          case "tonumber": return inputs.map((v) => Number(v));
          case "tojson": return inputs.map((v) => JSON.stringify(v));
          case "fromjson": return inputs.map((v) => JSON.parse(String(v)));
          case "ascii_downcase": return inputs.map((v) => String(v).toLowerCase());
          case "ascii_upcase": return inputs.map((v) => String(v).toUpperCase());
          case "split": return [String(first).split(String(arg(0)[0] ?? ""))];
          case "join": return [Array.isArray(first) ? first.map((v) => String(v ?? "")).join(String(arg(0)[0] ?? "")) : String(first)];
          case "map": return [evaluateJq(node.args[0], Array.isArray(first) ? first : [first])];
          case "select": {
            const kept = [];
            for (const input of inputs) if (evaluateJq(node.args[0], [input]).some(jqTruthy)) kept.push(input);
            return kept;
          }
          case "has": {
            const key = arg(0)[0];
            if (Array.isArray(first)) return [typeof key === "number" && key >= 0 && key < first.length];
            if (first && typeof first === "object") return [key in first];
            return [false];
          }
          case "any": return [inputs.some((v) => (Array.isArray(v) ? v.some(jqTruthy) : jqTruthy(v)))];
          case "all": return [inputs.every((v) => (Array.isArray(v) ? v.every(jqTruthy) : jqTruthy(v)))];
          case "contains": return [JSON.stringify(first).includes(String(arg(0)[0]))];
          case "startswith": return [String(first).startsWith(String(arg(0)[0]))];
          case "endswith": return [String(first).endsWith(String(arg(0)[0]))];
          case "ltrimstr": return [typeof first === "string" && first.startsWith(String(arg(0)[0])) ? first.slice(String(arg(0)[0]).length) : first];
          case "rtrimstr": return [typeof first === "string" && first.endsWith(String(arg(0)[0])) ? first.slice(0, -String(arg(0)[0]).length) : first];
          case "floor": return inputs.map((v) => Math.floor(Number(v)));
          case "ceil": return inputs.map((v) => Math.ceil(Number(v)));
          case "round": return inputs.map((v) => Math.round(Number(v)));
          case "empty": return [];
          case "now": return [Date.now() / 1000];
          default: throw new Error(`unsupported function: ${node.name}`);
        }
      }
      default:
        throw new Error("unsupported filter");
    }
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

  // ------------------------------------------------------------------ chmod
  const chmod = (ctx) => {
    const argv = argsOf(ctx);
    const recursive = argv.includes("-R") || argv.includes("-r");
    const rest = argv.filter((a) => !a.startsWith("-"));
    const [spec, ...paths] = rest;
    if (!spec || !paths.length) return fail(ctx, "chmod: usage: chmod [-R] MODE FILE...");
    const applyOne = (path) => {
      let current;
      try {
        current = store.statSync(path).mode & 0o777;
      } catch {
        return false;
      }
      let next;
      if (/^[0-7]{3,4}$/.test(spec)) {
        next = Number.parseInt(spec, 8);
      } else {
        const m = spec.match(/^([ugoa]*)([+\-=])([rwxXst]*)$/);
        if (!m) return false;
        const who = m[1] || "a";
        let mask = 0;
        for (const letter of m[3]) {
          const bits = letter === "r" ? 0o4 : letter === "w" ? 0o2 : 0o1;
          if (who === "a" || who.includes("u")) mask |= bits << 6;
          if (who === "a" || who.includes("g")) mask |= bits << 3;
          if (who === "a" || who.includes("o")) mask |= bits;
        }
        next = m[2] === "+" ? current | mask : m[2] === "-" ? current & ~mask : mask;
      }
      try {
        store.touchSync(path, { mode: next });
        return true;
      } catch {
        return false;
      }
    };
    let failed = false;
    for (const name of paths) {
      const path = resolve(ctx, name);
      if (recursive && isDir(path)) {
        for (const file of walk(path)) if (!applyOne(file)) failed = true;
      } else if (!applyOne(path)) {
        ctx.stderr(`chmod: cannot access '${name}'\n`);
        failed = true;
      }
    }
    return failed ? 1 : 0;
  };


  // --------------------------------------------------------------------- fd
  const fd = (ctx) => {
    const argv = argsOf(ctx);
    let hidden = false;
    let type = null;
    let ext = null;
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === "-H" || a === "--hidden" || a === "-u" || a === "--no-ignore") hidden = true;
      else if (a === "-t" || a === "--type") type = argv[++i];
      else if (a === "-e" || a === "--extension") ext = String(argv[++i] ?? "").replace(/^\./, "");
      else if (a.startsWith("-")) continue;
      else rest.push(a);
    }
    const pattern = rest.length > 1 || (rest.length === 1 && !isDir(resolve(ctx, rest[0]))) ? rest.shift() : null;
    const root = resolve(ctx, rest[0] ?? ".");
    const re = pattern ? new RegExp(pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*"), "i") : null;
    let found = false;
    for (const path of walk(root)) {
      const name = path.split("/").pop() ?? "";
      if (!hidden && name.startsWith(".")) continue;
      if (type === "f" && isDir(path)) continue;
      if (type === "d") continue;
      if (ext && !name.endsWith(`.${ext}`)) continue;
      if (re && !re.test(name)) continue;
      found = true;
      ctx.stdout(`${display(ctx, path)}\n`);
    }
    return found ? 0 : 1;
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
    chmod,
    fd,
  };
  return tools;
}
