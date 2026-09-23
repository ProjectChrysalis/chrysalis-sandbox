// Host commands for what busybox does not cover: rg, fd, jq (real jq, as its
// own WASI program), curl/wget through the engine proxy, archives (tar, gzip,
// zip) on fflate, and the small system commands scripts probe for.
import { WasiShim, WasiExit } from "../vendor/wasi-sh/src/shim.mjs";
import { gunzipSync, gzipSync, unzipSync, zipSync } from "../vendor/fflate/fflate.mjs";
import { completeImports } from "./wasi-extra.mjs";
import { preloadWasm, wasmSync } from "./loader.mjs";
import { fixedInput } from "./shell.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const JQ = "vendor/jq/jq.wasm";

/** busybox applets in this build (busybox/busybox.config). */
export const APPLETS = "ash awk base32 base64 basename bc cal cat cksum cmp comm cp crc32 cut date dc dd diff dirname dos2unix du echo egrep env expand expr factor false fgrep find fold getopt grep hd head hexdump install ls md5sum mkdir mktemp mv nl nproc od paste patch printenv printf pwd readlink realpath rev rm rmdir sed seq sha1sum sha256sum sha3sum sha512sum shuf sleep sort split stat strings stty sum tac tail tee test touch tr tree true truncate tsort uname unexpand uniq unix2dos unlink wc xargs xxd yes".split(" ");

export function preloadTools() {
  return preloadWasm(JQ);
}

const RG_TYPES = {
  js: ["js", "mjs", "cjs", "jsx"],
  ts: ["ts", "tsx", "mts", "cts"],
  py: ["py", "pyi"],
  json: ["json", "jsonl"],
  md: ["md", "markdown", "mdx"],
  css: ["css", "scss", "sass", "less"],
  html: ["html", "htm"],
  yaml: ["yml", "yaml"],
  toml: ["toml"],
  sh: ["sh", "bash"],
  rust: ["rs"],
  go: ["go"],
  java: ["java"],
  c: ["c", "h"],
  cpp: ["cpp", "cc", "hpp", "hh", "cxx"],
  svg: ["svg"],
  txt: ["txt"],
  xml: ["xml"],
  vue: ["vue"],
  svelte: ["svelte"],
};

export function makeTools({ store, net, shell }) {
  const exists = (p) => store.exists(p);
  const isDir = (p) => store.isDir(p);
  const readFile = (ctx, p) => {
    const path = ctx.resolve(p);
    if (isDir(path)) throw new Error(`${p}: Is a directory`);
    const bytes = store.readFile(path);
    if (!bytes) throw new Error(`${p}: No such file or directory`);
    return bytes;
  };
  const writeFile = (path, bytes) => {
    store.mkdirp(path.slice(0, path.lastIndexOf("/")) || "/");
    store.writeFile(path, bytes);
  };
  const display = (ctx, path, arg) => {
    if (arg && arg.startsWith("/")) return path;
    const base = ctx.cwd.replace(/\/$/, "");
    if (path.startsWith(`${base}/`)) return path.slice(base.length + 1);
    return path;
  };

  // ---------------------------------------------------------- identity
  const which = (ctx) => {
    let missing = false;
    for (const name of ctx.args.filter((a) => !a.startsWith("-"))) {
      if (name.includes("/")) {
        if (store.isFile(ctx.resolve(name))) ctx.print(`${name}\n`);
        else missing = true;
        continue;
      }
      if (shell.commands.has(name) || APPLETS.includes(name)) ctx.print(`/usr/bin/${name}\n`);
      else missing = true;
    }
    return missing ? 1 : 0;
  };

  // ---------------------------------------------------------------- jq
  const jq = (ctx) => {
    const shim = new WasiShim({
      args: ["jq", ...ctx.args],
      env: { ...ctx.env, PWD: ctx.cwd },
      files: {},
      fs: store,
      stdout: (b) => ctx.stdout(b),
      stderr: (b) => ctx.stderr(b),
      input: fixedInput(ctx.args.includes("-n") || ctx.args.includes("--null-input") ? new Uint8Array(0) : ctx.readAll()),
    });
    const instance = new WebAssembly.Instance(wasmSync(JQ), completeImports(shim, shim.imports()));
    shim.bindMemory(instance.exports.memory);
    try {
      instance.exports._start();
      return 0;
    } catch (error) {
      if (error instanceof WasiExit) return error.code;
      return ctx.fail(`jq: ${(error && error.message) || error}`);
    }
  };

  // ---------------------------------------------------------------- rg
  const gitignores = new Map();
  const ignoreRules = (dir) => {
    if (gitignores.has(dir)) return gitignores.get(dir);
    const bytes = store.readFile(`${dir}/.gitignore`);
    const rules = [];
    if (bytes) {
      for (const raw of decoder.decode(bytes).split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const negate = line.startsWith("!");
        let pattern = negate ? line.slice(1) : line;
        const dirOnly = pattern.endsWith("/");
        pattern = pattern.replace(/\/$/, "");
        const anchored = pattern.includes("/");
        rules.push({ negate, dirOnly, re: globRe(pattern.replace(/^\//, ""), anchored) });
      }
    }
    gitignores.set(dir, rules);
    return rules;
  };
  /** Walk `root`, yielding files; skips .git, hidden entries and
   *  .gitignore'd paths unless told not to. */
  function* walkFiles(root, { hidden = false, ignore = true, maxDepth = Infinity, dirs = false } = {}) {
    if (!isDir(root)) {
      if (exists(root)) yield root;
      return;
    }
    const stack = [[root, 0, []]];
    while (stack.length) {
      const [dir, depth, inherited] = stack.pop();
      const rules = ignore ? [...inherited, ...ignoreRules(dir).map((r) => ({ ...r, base: dir }))] : [];
      const names = store.readdirSync(dir).sort().reverse();
      const files = [];
      for (const name of names) {
        if (name === ".git") continue;
        if (!hidden && name.startsWith(".")) continue;
        const full = `${dir === "/" ? "" : dir}/${name}`;
        const dir2 = isDir(full);
        if (ignore && ignored(rules, full, dir2)) continue;
        if (dir2) {
          if (dirs && depth + 1 <= maxDepth) files.push(full);
          if (depth + 1 < maxDepth) stack.push([full, depth + 1, rules]);
        } else if (depth + 1 <= maxDepth) files.push(full);
      }
      yield* files.reverse();
    }
  }
  const ignored = (rules, full, dir) => {
    let out = false;
    for (const r of rules) {
      if (r.dirOnly && !dir) continue;
      const rel = full.slice(r.base.length + 1);
      if (r.re.test(rel)) out = !r.negate;
    }
    return out;
  };

  const rg = (ctx) => {
    const argv = ctx.args;
    const o = { i: false, smart: false, F: false, w: false, x: false, v: false, n: true, l: false, L: false, c: false, o: false, q: false, files: false, hidden: false, ignore: true, before: 0, after: 0, max: Infinity, maxDepth: Infinity, filename: null, heading: false, onlyType: [], notType: [], globs: [] };
    const patterns = [];
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      const value = () => {
        const eq = a.indexOf("=");
        return eq > 0 && a.startsWith("--") ? a.slice(eq + 1) : argv[++i];
      };
      if (a === "--") {
        rest.push(...argv.slice(i + 1));
        break;
      }
      if (!a.startsWith("-") || a === "-") {
        rest.push(a);
        continue;
      }
      const long = a.split("=")[0];
      switch (long) {
        case "-i":
        case "--ignore-case":
          o.i = true;
          break;
        case "-S":
        case "--smart-case":
          o.smart = true;
          break;
        case "-s":
        case "--case-sensitive":
          o.i = false;
          o.smart = false;
          break;
        case "-F":
        case "--fixed-strings":
          o.F = true;
          break;
        case "-w":
        case "--word-regexp":
          o.w = true;
          break;
        case "-x":
        case "--line-regexp":
          o.x = true;
          break;
        case "-v":
        case "--invert-match":
          o.v = true;
          break;
        case "-n":
        case "--line-number":
          o.n = true;
          break;
        case "-N":
        case "--no-line-number":
          o.n = false;
          break;
        case "-l":
        case "--files-with-matches":
          o.l = true;
          break;
        case "--files-without-match":
          o.L = true;
          break;
        case "-c":
        case "--count":
        case "--count-matches":
          o.c = true;
          break;
        case "-o":
        case "--only-matching":
          o.o = true;
          break;
        case "-q":
        case "--quiet":
          o.q = true;
          break;
        case "--files":
          o.files = true;
          break;
        case "--hidden":
          o.hidden = true;
          break;
        case "--no-ignore":
        case "--no-ignore-vcs":
          o.ignore = false;
          break;
        case "-u":
          o.ignore = false;
          break;
        case "-uu":
        case "-uuu":
          o.ignore = false;
          o.hidden = true;
          break;
        case "-A":
        case "--after-context":
          o.after = Number(value());
          break;
        case "-B":
        case "--before-context":
          o.before = Number(value());
          break;
        case "-C":
        case "--context":
          o.before = o.after = Number(value());
          break;
        case "-m":
        case "--max-count":
          o.max = Number(value());
          break;
        case "-d":
        case "--max-depth":
        case "--maxdepth":
          o.maxDepth = Number(value());
          break;
        case "-e":
        case "--regexp":
          patterns.push(value());
          break;
        case "-g":
        case "--glob":
        case "--iglob":
          o.globs.push(value());
          break;
        case "-t":
        case "--type":
          o.onlyType.push(value());
          break;
        case "-T":
        case "--type-not":
          o.notType.push(value());
          break;
        case "-H":
        case "--with-filename":
          o.filename = true;
          break;
        case "-I":
        case "--no-filename":
          o.filename = false;
          break;
        case "--heading":
          o.heading = true;
          break;
        default:
          if (/^-[A-Za-z]{2,}$/.test(a)) {
            // clustered short flags: -in, -il, -nw
            argv.splice(i + 1, 0, ...a.slice(1).split("").map((c) => `-${c}`));
          }
        // --no-heading, --color, --sort, --trim, -z, -U, -j: accepted, no effect here
      }
    }
    if (!patterns.length && !o.files) {
      if (!rest.length) return ctx.fail("rg: no pattern given", 2);
      patterns.push(rest.shift());
    }
    const paths = rest.length ? rest : ["."];
    let flags = "";
    if (o.i || (o.smart && !patterns.some((p) => /[A-Z]/.test(p)))) flags += "i";
    let re;
    try {
      const sources = patterns.map((p) => {
        let s = p;
        const inline = /^\(\?([a-z]+)\)/.exec(s);
        if (inline) {
          if (inline[1].includes("i")) flags += flags.includes("i") ? "" : "i";
          s = s.slice(inline[0].length);
        }
        return o.F ? s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : s;
      });
      let source = sources.join("|");
      if (o.w) source = `\\b(?:${source})\\b`;
      if (o.x) source = `^(?:${source})$`;
      re = new RegExp(source, `${flags}g`);
    } catch (error) {
      return ctx.fail(`rg: regex parse error: ${error.message}`, 2);
    }
    const typeExts = (names) => names.flatMap((t) => RG_TYPES[t] ?? [t]);
    const onlyExts = typeExts(o.onlyType);
    const notExts = typeExts(o.notType);
    const include = o.globs.filter((g) => !g.startsWith("!")).map((g) => globRe(g, g.includes("/")));
    const exclude = o.globs.filter((g) => g.startsWith("!")).map((g) => globRe(g.slice(1), g.includes("/")));
    const wanted = (file, rel) => {
      const name = file.slice(file.lastIndexOf("/") + 1);
      const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
      if (onlyExts.length && !onlyExts.includes(ext)) return false;
      if (notExts.includes(ext)) return false;
      if (include.length && !include.some((g) => g.test(rel) || g.test(name))) return false;
      if (exclude.some((g) => g.test(rel) || g.test(name))) return false;
      return true;
    };
    const targets = [];
    for (const p of paths) {
      const abs = ctx.resolve(p);
      if (!exists(abs)) {
        ctx.stderr(encoder.encode(`rg: ${p}: No such file or directory (os error 2)\n`));
        continue;
      }
      if (!isDir(abs)) {
        targets.push([abs, p, true]);
        continue;
      }
      for (const file of walkFiles(abs, { hidden: o.hidden, ignore: o.ignore, maxDepth: o.maxDepth })) {
        const rel = file.slice(abs.length + 1);
        if (wanted(file, rel)) targets.push([file, p, false]);
      }
    }
    const showName = o.filename ?? !(targets.length === 1 && targets[0][2]);
    let matched = false;
    const out = [];
    const flush = () => {
      if (out.length) ctx.print(out.splice(0).join(""));
    };
    for (const [file, arg, explicit] of targets) {
      const bytes = store.readFile(file);
      if (!bytes) continue;
      if (!explicit && bytes.subarray(0, 8192).includes(0)) continue;
      const name = display(ctx, file, arg.startsWith("/") ? arg : null).replace(/^\.\//, "");
      if (o.files) {
        out.push(`${name}\n`);
        continue;
      }
      const lines = decoder.decode(bytes).split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      let hits = 0;
      let lastPrinted = -1;
      const pending = [];
      const prefix = (n, sep) => `${showName && !o.heading ? `${name}${sep}` : ""}${o.n ? `${n + 1}${sep}` : ""}`;
      for (let n = 0; n < lines.length && hits < o.max; n++) {
        re.lastIndex = 0;
        const line = lines[n];
        const found = re.test(line);
        if (found === o.v) continue;
        hits++;
        matched = true;
        if (o.q) return 0;
        if (o.l || o.L || o.c) continue;
        if (o.heading && hits === 1) pending.push(`${name}\n`);
        if (o.before || o.after) {
          const from = Math.max(lastPrinted + 1, n - o.before);
          if (lastPrinted >= 0 && from > lastPrinted + 1) pending.push("--\n");
          for (let k = from; k < n; k++) pending.push(`${prefix(k, "-")}${lines[k]}\n`);
        }
        if (o.o && !o.v) {
          re.lastIndex = 0;
          for (const m of line.matchAll(re)) pending.push(`${prefix(n, ":")}${m[0]}\n`);
        } else pending.push(`${prefix(n, ":")}${line}\n`);
        lastPrinted = n;
        if (o.after) {
          let k = n + 1;
          for (; k < lines.length && k <= n + o.after; k++) {
            re.lastIndex = 0;
            if (re.test(lines[k]) !== o.v) break;
            pending.push(`${prefix(k, "-")}${lines[k]}\n`);
            lastPrinted = k;
          }
        }
      }
      if (o.l && hits) out.push(`${name}\n`);
      else if (o.L && !hits) out.push(`${name}\n`);
      else if (o.c && hits) out.push(showName ? `${name}:${hits}\n` : `${hits}\n`);
      else if (pending.length) {
        out.push(...pending);
        if (o.heading) out.push("\n");
      }
      if (out.length > 512) flush();
    }
    flush();
    if (o.L) return 0;
    return matched || o.files ? 0 : 1;
  };

  // ---------------------------------------------------------------- fd
  const fd = (ctx) => {
    const argv = ctx.args;
    const o = { type: null, exts: [], hidden: false, ignore: true, maxDepth: Infinity, absolute: false, glob: false, fullPath: false, exclude: [], exec: null, execBatch: null, caseSensitive: null };
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === "-t" || a === "--type") o.type = argv[++i];
      else if (a.startsWith("--type=")) o.type = a.slice(7);
      else if (a === "-e" || a === "--extension") o.exts.push(String(argv[++i]).replace(/^\./, ""));
      else if (a.startsWith("--extension=")) o.exts.push(a.slice(12).replace(/^\./, ""));
      else if (a === "-H" || a === "--hidden") o.hidden = true;
      else if (a === "-I" || a === "--no-ignore") o.ignore = false;
      else if (a === "-u" || a === "--unrestricted") {
        o.hidden = true;
        o.ignore = false;
      } else if (a === "-d" || a === "--max-depth" || a === "--maxdepth") o.maxDepth = Number(argv[++i]);
      else if (a.startsWith("--max-depth=")) o.maxDepth = Number(a.slice(12));
      else if (a === "-a" || a === "--absolute-path") o.absolute = true;
      else if (a === "-g" || a === "--glob") o.glob = true;
      else if (a === "-p" || a === "--full-path") o.fullPath = true;
      else if (a === "-E" || a === "--exclude") o.exclude.push(globRe(argv[++i], false));
      else if (a === "-s" || a === "--case-sensitive") o.caseSensitive = true;
      else if (a === "-i" || a === "--ignore-case") o.caseSensitive = false;
      else if (a === "-x" || a === "--exec" || a === "-X" || a === "--exec-batch") {
        const cmd = [];
        for (i++; i < argv.length && argv[i] !== ";"; i++) cmd.push(argv[i]);
        if (a === "-x" || a === "--exec") o.exec = cmd;
        else o.execBatch = cmd;
      } else if (a.startsWith("-")) continue;
      else rest.push(a);
    }
    const pattern = rest[0] ?? "";
    const roots = rest.length > 1 ? rest.slice(1) : ["."];
    let re = null;
    if (pattern) {
      const insensitive = o.caseSensitive === false || (o.caseSensitive === null && !/[A-Z]/.test(pattern));
      try {
        re = o.glob ? globRe(pattern, o.fullPath, insensitive) : new RegExp(pattern, insensitive ? "i" : "");
      } catch (error) {
        return ctx.fail(`fd: invalid pattern: ${error.message}`, 1);
      }
    }
    const found = [];
    for (const r of roots) {
      const abs = ctx.resolve(r);
      if (!isDir(abs)) return ctx.fail(`[fd error]: '${r}' is not a directory.`, 1);
      for (const path of walkFiles(abs, { hidden: o.hidden, ignore: o.ignore, maxDepth: o.maxDepth, dirs: o.type !== "f" && o.type !== "file" })) {
        const dir = isDir(path);
        if ((o.type === "f" || o.type === "file") && dir) continue;
        if ((o.type === "d" || o.type === "directory") && !dir) continue;
        const name = path.slice(path.lastIndexOf("/") + 1);
        if (o.exts.length && !o.exts.some((e) => name.endsWith(`.${e}`))) continue;
        if (o.exclude.some((g) => g.test(name))) continue;
        if (re && !re.test(o.fullPath ? path : name)) continue;
        const shown = o.absolute ? path : r === "." ? path.slice(ctx.cwd.replace(/\/$/, "").length + 1) : `${r.replace(/\/$/, "")}/${path.slice(abs.length + 1)}`;
        found.push(dir ? `${shown}/` : shown);
      }
    }
    if (o.exec || o.execBatch) {
      let code = 0;
      const sub = (cmd, file) => cmd.map((c) => c.replace(/\{\}/g, file).replace(/\{\/\}/g, file.split("/").pop()).replace(/\{\.\}/g, file.replace(/\.[^./]*$/, "")));
      const run = (argv2) => shell.spawn(argv2, { cwd: ctx.cwd, env: ctx.env, stdin: () => new Uint8Array(0), stdout: ctx.stdout, stderr: ctx.stderr });
      if (o.exec) for (const f of found) code = run(o.exec.some((c) => c.includes("{")) ? sub(o.exec, f.replace(/\/$/, "")) : [...o.exec, f.replace(/\/$/, "")]) || code;
      else code = run([...o.execBatch.filter((c) => c !== "{}"), ...found.map((f) => f.replace(/\/$/, ""))]);
      return code;
    }
    if (found.length) ctx.print(`${found.join("\n")}\n`);
    return 0;
  };

  // ----------------------------------------------------------- archives
  const gzipTool = (mode) => (ctx) => {
    const argv = ctx.args;
    const flags = argv.filter((a) => a.startsWith("-") && a !== "-").join("");
    const decompress = mode === "gunzip" || mode === "zcat" || flags.includes("d");
    const toStdout = mode === "zcat" || flags.includes("c");
    const keep = flags.includes("k");
    const level = Number((/[1-9]/.exec(flags) ?? ["6"])[0]);
    const files = argv.filter((a) => !a.startsWith("-") || a === "-");
    const transform = (bytes, name) => {
      if (!decompress) return gzipSync(bytes, { level });
      try {
        return gunzipSync(bytes);
      } catch {
        throw new Error(`${name}: not in gzip format`);
      }
    };
    if (!files.length || files[0] === "-") {
      ctx.stdout(transform(ctx.readAll(), "stdin"));
      return 0;
    }
    for (const name of files) {
      const path = ctx.resolve(name);
      const out = transform(readFile(ctx, name), name);
      if (toStdout) ctx.stdout(out);
      else {
        const target = decompress ? (path.endsWith(".gz") ? path.slice(0, -3) : path.endsWith(".tgz") ? `${path.slice(0, -4)}.tar` : `${path}.out`) : `${path}.gz`;
        writeFile(target, out);
        if (!keep) store.remove(path);
      }
    }
    return 0;
  };

  const tar = (ctx) => {
    const argv = ctx.args.slice();
    let mode = "";
    let gz = false;
    let verbose = false;
    let archive = null;
    let dir = null;
    let toStdout = false;
    let strip = 0;
    const excludes = [];
    const names = [];
    // the first word may be a bare flag cluster: `tar czf out.tgz dir`
    if (argv[0] && !argv[0].startsWith("-") && /^[a-zA-Z]+$/.test(argv[0])) argv[0] = `-${argv[0]}`;
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a.startsWith("--")) {
        const [key, val] = a.split(/=(.*)/);
        if (key === "--file") archive = val ?? argv[++i];
        else if (key === "--directory") dir = val ?? argv[++i];
        else if (key === "--strip-components") strip = Number(val ?? argv[++i]);
        else if (key === "--exclude") excludes.push(globRe(val ?? argv[++i], false));
        else if (key === "--gzip" || key === "--gunzip") gz = true;
        else if (key === "--extract" || key === "--get") mode = "x";
        else if (key === "--create") mode = "c";
        else if (key === "--list") mode = "t";
        else if (key === "--to-stdout") toStdout = true;
        else if (key === "--verbose") verbose = true;
        continue;
      }
      if (a.startsWith("-") && a.length > 1) {
        const letters = a.slice(1);
        for (let k = 0; k < letters.length; k++) {
          const c = letters[k];
          if ("cxt".includes(c)) mode = c;
          else if (c === "z") gz = true;
          else if (c === "v") verbose = true;
          else if (c === "O") toStdout = true;
          else if (c === "f") {
            archive = letters.slice(k + 1) || argv[++i];
            break;
          } else if (c === "C") {
            dir = letters.slice(k + 1) || argv[++i];
            break;
          } else if (c === "j" || c === "J") return ctx.fail("tar: bzip2 and xz archives are not supported here; gzip is", 2);
        }
        continue;
      }
      names.push(a);
    }
    if (!mode) return ctx.fail("tar: You must specify one of the '-ctx' options", 2);
    const base = dir ? ctx.resolve(dir) : ctx.cwd;
    if (mode === "c") {
      const entries = [];
      for (const name of names.length ? names : ["."]) {
        const abs = dir ? `${base.replace(/\/$/, "")}/${name}`.replace(/\/\.$/, "") : ctx.resolve(name);
        if (!exists(abs)) return ctx.fail(`tar: ${name}: Cannot stat: No such file or directory`, 2);
        const rel = (p) => {
          const b = base.replace(/\/$/, "");
          return p.startsWith(`${b}/`) ? p.slice(b.length + 1) : p.replace(/^\//, "");
        };
        if (isDir(abs)) {
          entries.push({ name: `${rel(abs) || "."}/`, dir: true });
          for (const d of store.walkDirs(abs)) entries.push({ name: `${rel(d)}/`, dir: true });
          for (const f of store.walk(abs)) entries.push({ name: rel(f), bytes: store.readFile(f), mode: store.statSync(f).mode & 0o777 });
        } else entries.push({ name: rel(abs), bytes: store.readFile(abs), mode: store.statSync(abs).mode & 0o777 });
      }
      const kept = entries.filter((e) => !excludes.some((g) => g.test(e.name.replace(/\/$/, "").split("/").pop()) || g.test(e.name.replace(/\/$/, ""))));
      if (verbose) ctx.stderr(encoder.encode(kept.map((e) => `${e.name}\n`).join("")));
      let out = tarCreate(kept);
      if (gz || /\.(tgz|tar\.gz)$/.test(archive ?? "")) out = gzipSync(out);
      if (!archive || archive === "-") ctx.stdout(out);
      else writeFile(ctx.resolve(archive), out);
      return 0;
    }
    let data = !archive || archive === "-" ? ctx.readAll() : readFile(ctx, archive);
    if (data[0] === 0x1f && data[1] === 0x8b) data = gunzipSync(data);
    let entries;
    try {
      entries = tarRead(data);
    } catch (error) {
      return ctx.fail(`tar: ${error.message}`, 2);
    }
    const pick = (name) => !names.length || names.some((n) => name === n || name.startsWith(`${n.replace(/\/$/, "")}/`));
    for (const e of entries) {
      if (!pick(e.name) || excludes.some((g) => g.test(e.name.split("/").pop()))) continue;
      if (mode === "t") {
        ctx.print(`${e.name}${e.dir && !e.name.endsWith("/") ? "/" : ""}\n`);
        continue;
      }
      const parts = e.name.split("/").filter((p) => p && p !== ".");
      if (parts.some((p) => p === "..")) {
        ctx.stderr(encoder.encode(`tar: ${e.name}: skipping a path that leaves the target directory\n`));
        continue;
      }
      const stripped = parts.slice(strip);
      if (!stripped.length) continue;
      if (verbose) ctx.stderr(encoder.encode(`${e.name}\n`));
      if (toStdout) {
        if (!e.dir && e.bytes) ctx.stdout(e.bytes);
        continue;
      }
      const target = `${base.replace(/\/$/, "")}/${stripped.join("/")}`;
      if (e.dir) store.mkdirp(target);
      else if (e.bytes) {
        writeFile(target, e.bytes.slice());
        if (e.mode) store.touchSync(target, { mode: e.mode });
      }
    }
    return 0;
  };

  const zip = (ctx) => {
    const argv = ctx.args;
    const recursive = argv.some((a) => /^-[a-zA-Z]*r/.test(a));
    const junk = argv.some((a) => /^-[a-zA-Z]*j/.test(a));
    const quiet = argv.some((a) => /^-[a-zA-Z]*q/.test(a));
    const x = argv.indexOf("-x");
    const excludes = x >= 0 ? argv.slice(x + 1).map((g) => globRe(g, g.includes("/"))) : [];
    const words = (x >= 0 ? argv.slice(0, x) : argv).filter((a) => !a.startsWith("-"));
    const archive = words.shift();
    if (!archive) return ctx.fail("zip: missing archive name", 16);
    const target = ctx.resolve(archive.endsWith(".zip") || archive.includes(".") ? archive : `${archive}.zip`);
    const tree = {};
    const base = ctx.cwd.replace(/\/$/, "");
    const add = (file) => {
      const name = junk ? file.split("/").pop() : file.startsWith(`${base}/`) ? file.slice(base.length + 1) : file.replace(/^\//, "");
      if (excludes.some((g) => g.test(name))) return;
      tree[name] = store.readFile(file).slice();
      if (!quiet) ctx.print(`  adding: ${name}\n`);
    };
    for (const w of words) {
      const abs = ctx.resolve(w);
      if (!exists(abs)) return ctx.fail(`zip warning: name not matched: ${w}`, 12);
      if (isDir(abs)) {
        if (!recursive) continue;
        for (const f of store.walk(abs)) add(f);
      } else add(abs);
    }
    if (!Object.keys(tree).length) return ctx.fail("zip error: Nothing to do!", 12);
    writeFile(target, zipSync(tree, { level: 6 }));
    return 0;
  };

  const unzip = (ctx) => {
    const argv = ctx.args;
    const list = argv.includes("-l");
    const pipe = argv.includes("-p");
    const quiet = argv.some((a) => /^-[a-zA-Z]*q/.test(a));
    const d = argv.indexOf("-d");
    const words = argv.filter((a, i) => !a.startsWith("-") && i !== d + 1);
    const archive = words.shift();
    if (!archive) return ctx.fail("unzip: missing archive name", 10);
    let entries;
    try {
      entries = unzipSync(readFile(ctx, archive));
    } catch (error) {
      return ctx.fail(`unzip: cannot find or open ${archive}: ${error.message}`, 9);
    }
    const base = d >= 0 ? ctx.resolve(argv[d + 1]) : ctx.cwd;
    const pick = (name) => !words.length || words.some((w) => name === w || globRe(w, true).test(name));
    if (list) {
      let total = 0;
      ctx.print("  Length      Name\n---------  ----\n");
      for (const [name, bytes] of Object.entries(entries)) {
        if (!pick(name)) continue;
        total += bytes.length;
        ctx.print(`${String(bytes.length).padStart(9)}  ${name}\n`);
      }
      ctx.print(`---------  ----\n${String(total).padStart(9)}  ${Object.keys(entries).length} files\n`);
      return 0;
    }
    if (!quiet && !pipe) ctx.print(`Archive:  ${archive}\n`);
    for (const [name, bytes] of Object.entries(entries)) {
      if (!pick(name)) continue;
      if (name.split("/").some((p) => p === "..") || name.startsWith("/")) {
        ctx.stderr(encoder.encode(`unzip: skipping ${name}: it leaves the target directory\n`));
        continue;
      }
      if (pipe) {
        ctx.stdout(bytes);
        continue;
      }
      const target = `${base.replace(/\/$/, "")}/${name}`;
      if (name.endsWith("/")) store.mkdirp(target);
      else {
        writeFile(target, bytes);
        if (!quiet) ctx.print(`  inflating: ${name}\n`);
      }
    }
    return 0;
  };

  // ---------------------------------------------------------------- net
  const curl = (ctx) => {
    const argv = ctx.args;
    let method = null;
    const data = [];
    let url = null;
    let output = null;
    let remoteName = false;
    let writeOut = "";
    let head = false;
    let include = false;
    let fail = false;
    let silent = false;
    let showError = false;
    let verbose = false;
    let get = false;
    const headers = [];
    const form = [];
    const readData = (value, binary) => {
      if (value.startsWith("@")) {
        const bytes = value === "@-" ? ctx.readAll() : readFile(ctx, value.slice(1));
        return binary ? bytes : encoder.encode(decoder.decode(bytes).replace(/[\r\n]/g, ""));
      }
      return encoder.encode(value);
    };
    for (let i = 0; i < argv.length; i++) {
      let a = argv[i];
      let inline = null;
      if (a.startsWith("--") && a.includes("=")) {
        inline = a.slice(a.indexOf("=") + 1);
        a = a.slice(0, a.indexOf("="));
      }
      const value = () => inline ?? argv[++i] ?? "";
      if (/^-[a-zA-Z]{2,}$/.test(a)) {
        const letters = a.slice(1).split("");
        const takesValue = new Set(["X", "H", "d", "o", "w", "u", "A", "e", "b", "F", "m"]);
        const expanded = [];
        for (let k = 0; k < letters.length; k++) {
          expanded.push(`-${letters[k]}`);
          if (takesValue.has(letters[k]) && k < letters.length - 1) {
            expanded.push(letters.slice(k + 1).join(""));
            break;
          }
        }
        argv.splice(i, 1, ...expanded);
        i--;
        continue;
      }
      switch (a) {
        case "-X":
        case "--request":
          method = value().toUpperCase();
          break;
        case "-d":
        case "--data":
        case "--data-ascii":
          data.push(readData(value(), false));
          break;
        case "--data-raw":
          data.push(encoder.encode(value()));
          break;
        case "--data-binary":
          data.push(readData(value(), true));
          break;
        case "--data-urlencode": {
          const v = value();
          const eq = v.indexOf("=");
          data.push(encoder.encode(eq >= 0 ? `${v.slice(0, eq)}=${encodeURIComponent(v.slice(eq + 1))}` : encodeURIComponent(v)));
          break;
        }
        case "--json":
          data.push(readData(value(), true));
          headers.push(["content-type", "application/json"], ["accept", "application/json"]);
          break;
        case "-F":
        case "--form":
          form.push(value());
          break;
        case "-H":
        case "--header": {
          const h = value();
          const at = h.indexOf(":");
          if (at > 0) headers.push([h.slice(0, at).trim(), h.slice(at + 1).trim()]);
          break;
        }
        case "-A":
        case "--user-agent":
          headers.push(["user-agent", value()]);
          break;
        case "-e":
        case "--referer":
          headers.push(["referer", value()]);
          break;
        case "-b":
        case "--cookie":
          headers.push(["cookie", value()]);
          break;
        case "-u":
        case "--user":
          headers.push(["authorization", `Basic ${btoa(value())}`]);
          break;
        case "-o":
        case "--output":
          output = value();
          break;
        case "-O":
        case "--remote-name":
          remoteName = true;
          break;
        case "-w":
        case "--write-out":
          writeOut = value();
          break;
        case "-I":
        case "--head":
          head = true;
          break;
        case "-i":
        case "--include":
          include = true;
          break;
        case "-f":
        case "--fail":
        case "--fail-with-body":
          fail = true;
          break;
        case "-s":
        case "--silent":
          silent = true;
          break;
        case "-S":
        case "--show-error":
          showError = true;
          break;
        case "-v":
        case "--verbose":
          verbose = true;
          break;
        case "-G":
        case "--get":
          get = true;
          break;
        case "--url":
          url = value();
          break;
        case "-m":
        case "--max-time":
        case "--connect-timeout":
        case "--retry":
        case "--retry-delay":
        case "--retry-max-time":
        case "-r":
        case "--range":
        case "--limit-rate":
        case "-K":
        case "--config":
        case "-c":
        case "--cookie-jar":
          value();
          break;
        default:
          if (!a.startsWith("-")) url = a;
        // -L, -k, --compressed, -#, --no-progress-meter, -N: the proxy follows
        // redirects and decompresses already
      }
    }
    if (!url) return ctx.fail("curl: no URL specified!", 2);
    if (!/^[a-z]+:\/\//i.test(url)) url = `http://${url}`;
    let body = data.length ? concatBytes(data.flatMap((d, i) => (i ? [encoder.encode("&"), d] : [d]))) : null;
    if (get && body) {
      url += (url.includes("?") ? "&" : "?") + decoder.decode(body);
      body = null;
    }
    if (form.length) {
      const boundary = `----chrysalis${Math.random().toString(16).slice(2)}`;
      const parts = [];
      for (const f of form) {
        const eq = f.indexOf("=");
        const name = f.slice(0, eq);
        const v = f.slice(eq + 1);
        if (v.startsWith("@")) {
          const file = v.slice(1).split(";")[0];
          parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${file.split("/").pop()}"\r\nContent-Type: application/octet-stream\r\n\r\n`), readFile(ctx, file), encoder.encode("\r\n"));
        } else parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${v}\r\n`));
      }
      parts.push(encoder.encode(`--${boundary}--\r\n`));
      body = concatBytes(parts);
      headers.push(["content-type", `multipart/form-data; boundary=${boundary}`]);
    }
    if (body && data.length && !form.length && !headers.some(([h]) => h.toLowerCase() === "content-type")) headers.push(["content-type", "application/x-www-form-urlencoded"]);
    const m = method ?? (head ? "HEAD" : body ? "POST" : "GET");
    if (verbose) ctx.stderr(encoder.encode(`> ${m} ${url}\n${headers.map(([k, v]) => `> ${k}: ${v}\n`).join("")}>\n`));
    const res = net.request({ url, method: m, headers, body });
    if (res.error) {
      if (!silent || showError) ctx.stderr(encoder.encode(`curl: (7) ${res.error}\n`));
      return /resolve|lookup|ENOTFOUND/i.test(res.error) ? 6 : 7;
    }
    const headerText = `HTTP/1.1 ${res.status}\r\n${res.headers.map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n`;
    if (verbose) ctx.stderr(encoder.encode(headerText.replace(/^/gm, "< ")));
    if (fail && res.status >= 400) {
      if (!silent || showError) ctx.stderr(encoder.encode(`curl: (22) The requested URL returned error: ${res.status}\n`));
      if (!argv.includes("--fail-with-body")) return 22;
    }
    const chunks = [];
    if (include || head) chunks.push(encoder.encode(headerText));
    if (!head) chunks.push(res.body);
    const payload = concatBytes(chunks);
    if (remoteName) output = decodeURIComponent(new URL(url).pathname.split("/").pop() || "index.html");
    if (output && output !== "-") writeFile(ctx.resolve(output), payload);
    else ctx.stdout(payload);
    if (writeOut) {
      const type = res.headers.find(([k]) => k === "content-type")?.[1] ?? "";
      ctx.print(
        writeOut
          .replace(/%\{http_code\}|%\{response_code\}/g, String(res.status))
          .replace(/%\{size_download\}/g, String(res.body.length))
          .replace(/%\{content_type\}/g, type)
          .replace(/%\{url_effective\}/g, url)
          .replace(/%\{time_total\}/g, "0.000")
          .replace(/\\n/g, "\n")
          .replace(/\\t/g, "\t"),
      );
    }
    return fail && res.status >= 400 ? 22 : 0;
  };

  const wget = (ctx) => {
    const argv = ctx.args;
    let output = null;
    let prefix = null;
    let quiet = false;
    const urls = [];
    const headers = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === "-O" || a === "--output-document") output = argv[++i];
      else if (a.startsWith("--output-document=")) output = a.slice(18);
      else if (a.startsWith("-O") && a.length > 2) output = a.slice(2);
      else if (a === "-P" || a === "--directory-prefix") prefix = argv[++i];
      else if (a === "-q" || a === "--quiet" || a === "-nv") quiet = true;
      else if (a === "--header") {
        const h = argv[++i] ?? "";
        const at = h.indexOf(":");
        if (at > 0) headers.push([h.slice(0, at).trim(), h.slice(at + 1).trim()]);
      } else if (a === "-U" || a === "--user-agent") headers.push(["user-agent", argv[++i]]);
      else if (!a.startsWith("-")) urls.push(a);
    }
    if (!urls.length) return ctx.fail("wget: missing URL", 1);
    let code = 0;
    for (const url of urls) {
      const res = net.request({ url, headers });
      if (res.error) {
        ctx.stderr(encoder.encode(`wget: ${res.error}\n`));
        code = 4;
        continue;
      }
      if (res.status >= 400) {
        ctx.stderr(encoder.encode(`wget: server returned error: HTTP ${res.status}\n`));
        code = 8;
        continue;
      }
      if (output === "-") ctx.stdout(res.body);
      else {
        const name = output ?? (decodeURIComponent(new URL(url).pathname.split("/").pop() || "") || "index.html");
        const target = ctx.resolve(prefix ? `${prefix}/${name}` : name);
        writeFile(target, res.body);
        if (!quiet) ctx.stderr(encoder.encode(`saved '${display(ctx, target)}' (${res.body.length} bytes)\n`));
      }
    }
    return code;
  };

  // --------------------------------------------------- system-ish answers
  const file = (ctx) => {
    const names = ctx.args.filter((a) => !a.startsWith("-"));
    const brief = ctx.args.includes("-b");
    const mime = ctx.args.includes("-i") || ctx.args.includes("--mime-type");
    if (!names.length) return ctx.fail("Usage: file [-bi] FILE...");
    for (const name of names) {
      const path = ctx.resolve(name);
      let kind;
      if (isDir(path)) kind = mime ? "inode/directory" : "directory";
      else {
        const bytes = store.readFile(path);
        kind = bytes ? sniff(name, bytes, mime) : "cannot open (No such file or directory)";
      }
      ctx.print(brief ? `${kind}\n` : `${name}: ${kind}\n`);
    }
    return 0;
  };

  const chmod = (ctx) => {
    const argv = ctx.args;
    const recursive = argv.includes("-R");
    const [spec, ...paths] = argv.filter((a) => a !== "-R" && a !== "-v" && a !== "-f" && a !== "-c");
    if (!spec || !paths.length) return ctx.fail("chmod: usage: chmod [-R] MODE FILE...");
    let failed = false;
    const apply = (path) => {
      const current = store.statSync(path).mode & 0o7777;
      let next = current;
      if (/^[0-7]{3,4}$/.test(spec)) next = Number.parseInt(spec, 8);
      else {
        for (const clause of spec.split(",")) {
          const m = /^([ugoa]*)([+\-=])([rwxXst]*)$/.exec(clause);
          if (!m) throw new Error(`chmod: invalid mode: '${spec}'`);
          const who = m[1] || "a";
          let mask = 0;
          for (const letter of m[3]) {
            const bits = letter === "r" ? 4 : letter === "w" ? 2 : letter === "x" || letter === "X" ? 1 : 0;
            if (who.includes("a") || who.includes("u")) mask |= bits << 6;
            if (who.includes("a") || who.includes("g")) mask |= bits << 3;
            if (who.includes("a") || who.includes("o")) mask |= bits;
          }
          next = m[2] === "+" ? next | mask : m[2] === "-" ? next & ~mask : (next & ~(who.includes("a") ? 0o777 : 0)) | mask;
        }
      }
      store.touchSync(path, { mode: next });
    };
    for (const name of paths) {
      const path = ctx.resolve(name);
      if (!exists(path)) {
        ctx.stderr(encoder.encode(`chmod: cannot access '${name}': No such file or directory\n`));
        failed = true;
        continue;
      }
      apply(path);
      if (recursive && isDir(path)) {
        for (const d of store.walkDirs(path)) apply(d);
        for (const f of store.walk(path)) apply(f);
      }
    }
    return failed ? 1 : 0;
  };

  const ln = (ctx) => {
    const argv = ctx.args.filter((a) => !a.startsWith("-"));
    const force = ctx.args.some((a) => /^-[a-z]*f/.test(a));
    if (argv.length < 2) return ctx.fail("ln: missing destination file operand");
    const dest = argv.pop();
    const destAbs = ctx.resolve(dest);
    for (const target of argv) {
      // No links exist in this filesystem; a copy is the closest thing that
      // keeps scripts working.
      const src = ctx.resolve(target);
      if (!exists(src)) return ctx.fail(`ln: failed to access '${target}': No such file or directory`);
      const to = isDir(destAbs) ? `${destAbs}/${src.split("/").pop()}` : destAbs;
      if (exists(to) && !force) return ctx.fail(`ln: failed to create link '${dest}': File exists`);
      if (isDir(src)) {
        for (const f of store.walk(src)) writeFile(to + f.slice(src.length), store.readFile(f).slice());
      } else writeFile(to, store.readFile(src).slice());
    }
    return 0;
  };

  const timeout = (ctx) => {
    const argv = ctx.args.slice();
    while (argv[0]?.startsWith("-")) {
      const a = argv.shift();
      if (a === "-s" || a === "-k" || a === "--signal" || a === "--kill-after") argv.shift();
    }
    argv.shift(); // the duration: the sandbox's own per-command limit applies instead
    if (!argv.length) return ctx.fail("timeout: missing operand", 125);
    return shell.spawn(argv, { cwd: ctx.cwd, env: ctx.env, stdin: ctx.stdin, stdout: ctx.stdout, stderr: ctx.stderr });
  };

  return {
    which,
    jq,
    rg,
    fd,
    fdfind: fd,
    tar,
    gzip: gzipTool("gzip"),
    gunzip: gzipTool("gunzip"),
    zcat: gzipTool("zcat"),
    zip,
    unzip,
    curl,
    wget,
    file,
    chmod,
    ln,
    timeout,
    nohup: timeout,
    whoami: (ctx) => (ctx.print("sandbox\n"), 0),
    id: (ctx) => (ctx.print("uid=1000(sandbox) gid=1000(sandbox) groups=1000(sandbox)\n"), 0),
    hostname: (ctx) => (ctx.print("sandbox\n"), 0),
    ps: (ctx) => (ctx.print("  PID TTY          TIME CMD\n    1 ?        00:00:00 sh\n"), 0),
    df: (ctx) => {
      const used = Math.ceil(store.totalBytes() / 1024);
      ctx.print(`Filesystem     1K-blocks      Used Available Use% Mounted on\nsandbox          ${String(used + 1048576).padStart(8)} ${String(used).padStart(9)}   1048576   ${Math.min(99, Math.round((used / (used + 1048576)) * 100))}% /\n`);
      return 0;
    },
    uptime: (ctx) => (ctx.print(` ${new Date().toTimeString().slice(0, 8)} up 0 min,  1 user,  load average: 0.00, 0.00, 0.00\n`), 0),
    clear: () => 0,
  };
}

// ------------------------------------------------------------ helpers
function concatBytes(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** A glob as a RegExp over a relative path: `*` stays within a segment, `**`
 *  crosses them, {a,b} alternates; unanchored globs match at any depth. */
export function globRe(glob, anchored, insensitive = false) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += glob[i + 2] === "/" ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end < 0) re += "\\{";
      else {
        re += `(?:${glob
          .slice(i + 1, end)
          .split(",")
          .map((alt) => alt.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]"))
          .join("|")})`;
        i = end;
      }
    } else if (c === "[") {
      const end = glob.indexOf("]", i);
      if (end < 0) re += "\\[";
      else {
        re += `[${glob.slice(i + 1, end).replace(/^!/, "^")}]`;
        i = end;
      }
    } else re += c.replace(/[.+^$()|\\]/g, "\\$&");
  }
  return new RegExp(anchored ? `^${re}$` : `(?:^|/)${re}$`, insensitive ? "i" : "");
}

function sniff(name, bytes, mime) {
  const head = bytes.subarray(0, 16);
  const starts = (...sig) => sig.every((b, i) => head[i] === b);
  const kinds = [
    [starts(0x89, 0x50, 0x4e, 0x47), "PNG image data", "image/png"],
    [starts(0xff, 0xd8, 0xff), "JPEG image data", "image/jpeg"],
    [starts(0x47, 0x49, 0x46, 0x38), "GIF image data", "image/gif"],
    [starts(0x52, 0x49, 0x46, 0x46) && decoder.decode(bytes.subarray(8, 12)) === "WEBP", "RIFF (little-endian) data, Web/P image", "image/webp"],
    [starts(0x52, 0x49, 0x46, 0x46) && decoder.decode(bytes.subarray(8, 12)) === "WAVE", "RIFF (little-endian) data, WAVE audio", "audio/x-wav"],
    [starts(0x49, 0x44, 0x33) || starts(0xff, 0xfb), "Audio file with ID3 / MPEG ADTS", "audio/mpeg"],
    [starts(0x4f, 0x67, 0x67, 0x53), "Ogg data", "audio/ogg"],
    [starts(0x00, 0x61, 0x73, 0x6d), "WebAssembly (wasm) binary module", "application/wasm"],
    [starts(0x1f, 0x8b), "gzip compressed data", "application/gzip"],
    [starts(0x50, 0x4b, 0x03, 0x04), "Zip archive data", "application/zip"],
    [starts(0x25, 0x50, 0x44, 0x46), "PDF document", "application/pdf"],
  ];
  for (const [hit, text, type] of kinds) if (hit) return mime ? type : text;
  if (bytes.length === 0) return mime ? "inode/x-empty" : "empty";
  if (bytes.subarray(0, 8000).includes(0)) return mime ? "application/octet-stream" : "data";
  const text = decoder.decode(bytes.subarray(0, 1024));
  if (/^#!/.test(text)) return mime ? "text/x-shellscript" : `${text.split("\n")[0].slice(2).trim()} script, ASCII text executable`;
  if (/^\s*<(!doctype html|html)/i.test(text)) return mime ? "text/html" : "HTML document, UTF-8 Unicode text";
  if (/^\s*<svg|^\s*<\?xml[^>]*>\s*<svg/i.test(text)) return mime ? "image/svg+xml" : "SVG Scalable Vector Graphics image";
  if (/^\s*[{[]/.test(text) && /\.(json|jsonl)$/i.test(name)) return mime ? "application/json" : "JSON text data";
  const ascii = !/[^\x00-\x7f]/.test(text);
  return mime ? "text/plain" : `${ascii ? "ASCII" : "UTF-8 Unicode"} text`;
}

const TAR_BLOCK = 512;
function tarCreate(entries) {
  const blocks = [];
  const header = (name, size, type, mode) => {
    const h = new Uint8Array(TAR_BLOCK);
    const put = (offset, length, text) => h.set(encoder.encode(text).subarray(0, length), offset);
    const octal = (value, length) => `${value.toString(8).padStart(length - 1, "0")}\0`;
    let short = name;
    let prefix = "";
    if (encoder.encode(name).length > 100) {
      const cut = name.lastIndexOf("/", name.length - 1 - (name.endsWith("/") ? 1 : 0));
      if (cut > 0 && cut <= 155 && name.length - cut - 1 <= 100) {
        prefix = name.slice(0, cut);
        short = name.slice(cut + 1);
      } else {
        blocks.push(header("././@LongLink", encoder.encode(name).length + 1, "L", 0o644));
        const long = new Uint8Array(Math.ceil((encoder.encode(name).length + 1) / TAR_BLOCK) * TAR_BLOCK);
        long.set(encoder.encode(name));
        blocks.push(long);
        short = name.slice(0, 100);
      }
    }
    put(0, 100, short);
    put(100, 8, octal(mode || (type === "5" ? 0o755 : 0o644), 8));
    put(108, 8, octal(0, 8));
    put(116, 8, octal(0, 8));
    put(124, 12, octal(size, 12));
    put(136, 12, octal(Math.floor(Date.now() / 1000), 12));
    h.fill(0x20, 148, 156);
    h[156] = type.charCodeAt(0);
    put(257, 6, "ustar\0");
    put(263, 2, "00");
    put(265, 32, "sandbox");
    put(297, 32, "sandbox");
    if (prefix) put(345, 155, prefix);
    let sum = 0;
    for (const b of h) sum += b;
    put(148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
    return h;
  };
  for (const e of entries) {
    if (e.dir) {
      blocks.push(header(e.name, 0, "5", 0o755));
      continue;
    }
    const size = e.bytes?.length ?? 0;
    blocks.push(header(e.name, size, "0", e.mode));
    if (size) {
      blocks.push(e.bytes);
      const pad = (TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK;
      if (pad) blocks.push(new Uint8Array(pad));
    }
  }
  blocks.push(new Uint8Array(TAR_BLOCK * 2));
  return concatBytes(blocks);
}

function tarRead(data) {
  const entries = [];
  let off = 0;
  let longName = null;
  while (off + TAR_BLOCK <= data.length) {
    const h = data.subarray(off, off + TAR_BLOCK);
    if (h.every((b) => b === 0)) break;
    const field = (start, length) => {
      const raw = h.subarray(start, start + length);
      const end = raw.indexOf(0);
      return decoder.decode(end >= 0 ? raw.subarray(0, end) : raw);
    };
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const type = String.fromCharCode(h[156] || 0x30);
    const mode = Number.parseInt(field(100, 8).trim() || "644", 8);
    const prefix = field(345, 155);
    let name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = null;
    off += TAR_BLOCK;
    const body = data.subarray(off, off + size);
    off += Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
    if (Number.isNaN(size)) throw new Error("This does not look like a tar archive");
    if (type === "L") {
      longName = decoder.decode(body).replace(/\0.*$/s, "");
      continue;
    }
    if (type === "x" || type === "g") {
      const path = /\d+ path=([^\n]*)\n/.exec(decoder.decode(body));
      if (path && type === "x") longName = path[1];
      continue;
    }
    name = name.replace(/^\.\//, "");
    if (type === "5") entries.push({ name, dir: true });
    else if (type === "0" || type === "\0" || type === "7") entries.push({ name, bytes: body, mode: mode & 0o777 });
  }
  return entries;
}
