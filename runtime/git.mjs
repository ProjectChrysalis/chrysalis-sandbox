// `git`: the command line agents type, on top of lg2 (libgit2's examples).
// lg2 does the object database work (commits, trees, packs, diffs, merges,
// network); this layer supplies git's own porcelain where lg2 has none or
// answers in a different dialect: status, log formats, show, branch,
// switch/checkout/restore of paths, reset of paths, rm, mv, add -A/-u,
// commit -a, rev-parse options, config --list, grep, clean, ls-tree.
import { runLg2 } from "./lg2.mjs";
import { entryFor, readIndex, writeBlob, writeIndex } from "./gitindex.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const text = (b) => decoder.decode(b);

const UNSUPPORTED = {
  "cherry-pick": "apply the change with `git show <commit> | git apply`, then commit",
  rebase: "merge instead, or rebuild the branch with `git show <commit> | git apply` per commit",
  bisect: "check out commits one at a time",
  worktree: "clone into another folder under repos/",
  submodule: "clone the other repository into repos/",
  "format-patch": "use `git show <commit> > change.patch`",
  am: "use `git apply` on the patch, then commit",
  gc: "nothing to do: the engine packs the workspace history itself",
};

/** Index files already matched to this session's stat values, by git dir. */
const refreshed = new Map();

export function gitCommands({ store, net, shell }) {
  const git = (ctx) => new Git(ctx, store, net, shell).main();
  return { git };
}

class Git {
  constructor(ctx, store, net, shell) {
    this.ctx = ctx;
    this.store = store;
    this.net = net;
    this.shell = shell;
    this.cwd = ctx.cwd;
  }

  // ------------------------------------------------------------ plumbing
  out(s) {
    this.ctx.stdout(typeof s === "string" ? encoder.encode(s) : s);
  }
  err(s) {
    this.ctx.stderr(typeof s === "string" ? encoder.encode(s) : s);
  }
  fatal(message, code = 128) {
    this.err(`fatal: ${message}\n`);
    return code;
  }
  /** lg2, captured. */
  lg(argv, cwd = this.repo?.root ?? this.cwd) {
    const out = [];
    const err = [];
    const code = runLg2({ store: this.store, net: this.net, argv, cwd, stdout: (b) => out.push(b), stderr: (b) => err.push(b) });
    return { code, out: concatBytes(out), err: cleanErr(text(concatBytes(err))) };
  }
  /** lg2, straight through to the caller's streams. */
  pass(argv, cwd = this.cwd) {
    const r = this.lg(argv, cwd);
    this.out(r.out);
    if (r.err) this.err(r.err);
    return r.code === 0 ? 0 : r.code > 128 ? 128 : r.code || 1;
  }
  findRepo(from = this.cwd) {
    for (let dir = from.replace(/\/+$/, "") || "/"; ; ) {
      if (this.store.isFile(`${dir === "/" ? "" : dir}/.git/HEAD`)) return { root: dir, gitDir: `${dir === "/" ? "" : dir}/.git` };
      if (dir === "/" || !dir) return null;
      dir = dir.slice(0, dir.lastIndexOf("/")) || "/";
    }
  }
  needRepo() {
    this.repo ??= this.findRepo();
    return this.repo;
  }
  rel(p) {
    const abs = this.ctx.resolve(p);
    const root = this.repo.root === "/" ? "" : this.repo.root;
    if (abs === root || abs === this.repo.root) return "";
    return abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : null;
  }
  /** A repo-relative path as the user sees it from the current directory. */
  display(relPath) {
    const root = this.repo.root === "/" ? "" : this.repo.root;
    const here = this.cwd === this.repo.root ? "" : this.cwd.slice(root.length + 1);
    if (!here) return relPath;
    const a = here.split("/");
    const b = relPath.split("/");
    let i = 0;
    while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
    return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
  }
  head() {
    const raw = text(this.store.readFile(`${this.repo.gitDir}/HEAD`) ?? new Uint8Array()).trim();
    const branch = raw.startsWith("ref: refs/heads/") ? raw.slice(16) : null;
    return { branch, raw, sha: this.resolve("HEAD") };
  }
  resolve(rev) {
    const r = this.lg(["rev-parse", rev]);
    const sha = text(r.out).trim();
    return r.code === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  }
  readRef(ref) {
    const loose = this.store.readFile(`${this.repo.gitDir}/${ref}`);
    if (loose) return text(loose).trim();
    for (const line of this.packedRefs()) if (line[1] === ref) return line[0];
    return null;
  }
  packedRefs() {
    const packed = this.store.readFile(`${this.repo.gitDir}/packed-refs`);
    if (!packed) return [];
    return text(packed)
      .split("\n")
      .filter((l) => l && !l.startsWith("#") && !l.startsWith("^"))
      .map((l) => l.split(" "));
  }
  refs(prefix) {
    const out = new Map();
    for (const [sha, name] of this.packedRefs()) if (name?.startsWith(prefix)) out.set(name, sha);
    const base = `${this.repo.gitDir}/${prefix}`;
    for (const file of this.store.walk(base.replace(/\/$/, ""))) out.set(`${prefix}${file.slice(base.length)}`, text(this.store.readFile(file)).trim());
    return new Map([...out].sort(([a], [b]) => (a < b ? -1 : 1)));
  }
  writeRef(ref, sha) {
    this.store.writeFile(`${this.repo.gitDir}/${ref}`, encoder.encode(`${sha}\n`));
  }
  index() {
    return readIndex(this.store.readFile(`${this.repo.gitDir}/index`));
  }
  saveIndex(index) {
    this.store.writeFile(`${this.repo.gitDir}/index`, writeIndex(index));
  }
  /** Files of a tree-ish under `dir` (repo-relative), path -> {mode, oid}. */
  tree(rev, dir = "") {
    const files = new Map();
    const visit = (prefix) => {
      const r = this.lg(["cat-file", "-p", prefix ? `${rev}:${prefix}` : `${rev}^{tree}`]);
      if (r.code !== 0) return false;
      for (const line of text(r.out).split("\n")) {
        const m = /^(\d+) (\w+) ([0-9a-f]{40})\t(.*)$/.exec(line);
        if (!m) continue;
        const path = prefix ? `${prefix}/${m[4]}` : m[4];
        if (m[2] === "tree") visit(path);
        else files.set(path, { mode: Number.parseInt(m[1], 8), oid: m[3] });
      }
      return true;
    };
    if (dir) {
      const r = this.lg(["cat-file", "-t", `${rev}:${dir}`]);
      const type = text(r.out).trim();
      if (type === "tree") visit(dir);
      else if (type === "blob") {
        const parent = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
        const all = new Map();
        const r2 = this.lg(["cat-file", "-p", parent ? `${rev}:${parent}` : `${rev}^{tree}`]);
        for (const line of text(r2.out).split("\n")) {
          const m = /^(\d+) blob ([0-9a-f]{40})\t(.*)$/.exec(line);
          if (m && (parent ? `${parent}/${m[3]}` : m[3]) === dir) all.set(dir, { mode: Number.parseInt(m[1], 8), oid: m[2] });
        }
        return all;
      }
      return files;
    }
    visit("");
    return files;
  }
  blob(spec) {
    const r = this.lg(["cat-file", "-p", spec]);
    return r.code === 0 ? r.out : null;
  }
  /** porcelain v1 lines as {x, y, path}, minus files the engine keeps out
   *  of the sandbox (they are not deleted, just not here). */
  porcelain() {
    const r = this.lg(["status", "--porcelain"]);
    return text(r.out)
      .split("\n")
      .filter(Boolean)
      .map((l) => ({ x: l[0], y: l[1], path: l.slice(3).replace(/^"(.*)"$/, "$1") }))
      .filter((e) => !(e.y === "D" && this.hidden(e.path)));
  }
  hidden(relPath) {
    const root = this.repo.root === "/" ? "" : this.repo.root;
    const abs = `${root}/${relPath}`;
    if (!abs.startsWith("/workspace/")) return false;
    const rel = abs.slice("/workspace/".length);
    return (this.store.hiddenPaths ?? []).some((re) => re.test(rel));
  }
  /** Match the index's stat data to what this session reports for files the
   *  engine listed unchanged (same size, same mtime), as `update-index
   *  --refresh` would. Otherwise every file differs by inode and ctime, and
   *  git reads the whole workspace to prove nothing changed. The refreshed
   *  index is not synced back; git's own writes of it are. */
  refreshIndex() {
    const path = `${this.repo.gitDir}/index`;
    if (!this.store.isFile(path)) return;
    const before = this.store.statSync(path);
    const key = `${before.ino}:${before.size}:${before.mtimeMs}`;
    if (refreshed.get(this.repo.gitDir) === key) return;
    const index = this.index();
    const root = this.repo.root === "/" ? "" : this.repo.root;
    let changed = false;
    for (const e of index.entries) {
      if (e.stage !== 0) continue;
      let st;
      try {
        st = this.store.statSync(`${root}/${e.path}`);
      } catch {
        continue;
      }
      if ((st.mode & 0o170000) !== 0o100000 || st.size !== e.fields[9]) continue;
      const indexed = e.fields[2] * 1000 + e.fields[3] / 1e6;
      if (Math.abs(indexed - st.mtimeMs) >= 1) continue;
      const m = Math.floor(st.mtimeMs);
      const c = Math.floor(st.ctimeMs);
      const want = [Math.floor(c / 1000), (c % 1000) * 1e6, Math.floor(m / 1000), (m % 1000) * 1e6, 7, st.ino, e.fields[6], 0, 0, st.size];
      if (want.some((v, i) => v !== e.fields[i])) {
        e.fields = want;
        changed = true;
      }
    }
    if (changed) this.store.quietly(() => this.store.writeFile(path, writeIndex(index)));
    const after = this.store.statSync(path);
    refreshed.set(this.repo.gitDir, `${after.ino}:${after.size}:${after.mtimeMs}`);
  }
  inSpec(relPath, specs) {
    if (!specs.length) return true;
    return specs.some((s) => s === "" || relPath === s || relPath.startsWith(`${s.replace(/\/$/, "")}/`) || globMatch(s, relPath));
  }
  specsOf(args) {
    const out = [];
    for (const a of args) {
      const r = this.rel(a);
      if (r === null) return { error: `${a}: '${a}' is outside repository at '${this.repo.root}'` };
      out.push(r);
    }
    return { specs: out };
  }

  // -------------------------------------------------------------- entry
  main() {
    let args = this.ctx.args.slice();
    // global options before the subcommand
    while (args.length && args[0].startsWith("-")) {
      const a = args.shift();
      if (a === "-C") {
        this.cwd = this.ctx.resolve(args.shift() ?? ".");
        this.ctx.cwd = this.cwd;
      } else if (a === "-c") args.shift();
      else if (a === "--version" || a === "-v") args.unshift("version");
      else if (a === "--help" || a === "-h") args.unshift("help");
      else if (a.startsWith("--git-dir") || a.startsWith("--work-tree")) {
        if (!a.includes("=")) args.shift();
      }
      // --no-pager, -P, --no-optional-locks, --literal-pathspecs: nothing to do
    }
    const sub = args.shift();
    if (!sub || sub === "help") {
      this.out(HELP);
      return sub ? 0 : 1;
    }
    if (sub === "version") {
      this.out("git version 2.47.0 (libgit2 in the Chrysalis sandbox)\n");
      return 0;
    }
    if (UNSUPPORTED[sub]) return this.fatal(`'${sub}' is not available in this sandbox's git; ${UNSUPPORTED[sub]}`, 1);
    const noRepo = new Set(["init", "clone", "ls-remote", "config"]);
    if (!noRepo.has(sub) && !this.needRepo()) return this.fatal("not a git repository (or any of the parent directories): .git");
    this.repo ??= this.findRepo();
    if (this.repo) this.refreshIndex();
    const handler = this[`cmd_${sub.replace(/-/g, "_")}`];
    if (handler) return handler.call(this, args);
    return this.pass([sub, ...args]);
  }

  // ----------------------------------------------------------- commands
  cmd_init(args) {
    let branch = null;
    let dir = null;
    let quiet = false;
    const rest = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-b" || a === "--initial-branch") branch = args[++i];
      else if (a.startsWith("--initial-branch=")) branch = a.slice(17);
      else if (a === "-q" || a === "--quiet") quiet = true;
      else if (a.startsWith("-")) rest.push(a);
      else dir = a;
    }
    const target = this.ctx.resolve(dir ?? ".");
    this.store.mkdirp(target);
    const existed = this.store.isFile(`${target}/.git/HEAD`);
    const r = this.lg(["init", ...rest, "."], target);
    if (r.code !== 0) {
      this.err(r.err);
      return 1;
    }
    if (branch && !existed) this.store.writeFile(`${target}/.git/HEAD`, encoder.encode(`ref: refs/heads/${branch}\n`));
    if (!quiet) this.out(`${existed ? "Reinitialized existing" : "Initialized empty"} Git repository in ${target}/.git/\n`);
    return 0;
  }

  cmd_clone(args) {
    const kept = [];
    let url = null;
    let dir = null;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (/^--(depth|shallow-since|shallow-exclude|filter|jobs|reference|origin|config)$/.test(a) || a === "-j" || a === "-o") {
        i++;
        continue;
      }
      if (/^--(depth|shallow-since|shallow-exclude|filter|jobs|reference|origin|config)=/.test(a) || /^--(single-branch|no-single-branch|recurse-submodules|recursive|shallow-submodules|no-tags|progress|quiet)$/.test(a) || a === "-q") continue;
      if (a === "-b" || a === "--branch") {
        kept.push("--branch", args[++i]);
        continue;
      }
      if (a.startsWith("-")) {
        kept.push(a);
        continue;
      }
      if (!url) url = a;
      else dir = a;
    }
    if (!url) return this.fatal("You must specify a repository to clone.");
    if (!/^https?:\/\//.test(url)) return this.fatal(`only https:// repositories can be cloned here, not ${url}`);
    dir ??= url.replace(/\/+$/, "").replace(/\.git$/, "").split("/").pop();
    const target = this.ctx.resolve(dir);
    if (this.store.exists(target) && this.store.readdirSync(target).length) return this.fatal(`destination path '${dir}' already exists and is not an empty directory.`);
    this.err(`Cloning into '${dir}'...\n`);
    this.store.mkdirp(target.slice(0, target.lastIndexOf("/")) || "/");
    const r = this.lg(["clone", ...kept, url, target], this.cwd);
    if (r.code !== 0) {
      this.store.remove(target);
      this.err(r.err || "fatal: clone failed\n");
      return 128;
    }
    return 0;
  }

  cmd_status(args) {
    const short = args.includes("-s") || args.includes("--short");
    const porcelain = args.some((a) => a.startsWith("--porcelain"));
    const branchLine = args.includes("-b") || args.includes("--branch");
    const specs = args.filter((a) => !a.startsWith("-"));
    const { specs: paths, error } = this.specsOf(specs);
    if (error) return this.fatal(error);
    const entries = this.porcelain().filter((e) => this.inSpec(e.path, paths));
    const head = this.head();
    if (short || porcelain) {
      if (branchLine) this.out(`## ${head.branch ?? "HEAD (no branch)"}${head.sha ? "" : " (no commits yet)"}\n`);
      for (const e of entries) this.out(`${e.x}${e.y} ${porcelain ? e.path : this.display(e.path)}\n`);
      return 0;
    }
    const lines = [head.branch ? `On branch ${head.branch}` : `HEAD detached at ${head.sha?.slice(0, 7)}`];
    if (!head.sha) lines.push("", "No commits yet");
    const names = { M: "modified:   ", A: "new file:   ", D: "deleted:    ", R: "renamed:    ", C: "copied:     ", T: "typechange: ", U: "both modified:" };
    const staged = entries.filter((e) => e.x !== " " && e.x !== "?");
    const unstaged = entries.filter((e) => e.y !== " " && e.y !== "?" && e.x !== "?");
    const untracked = entries.filter((e) => e.x === "?");
    if (staged.length) {
      lines.push("", "Changes to be committed:", '  (use "git restore --staged <file>..." to unstage)');
      for (const e of staged) lines.push(`\t${names[e.x] ?? `${e.x}: `}${this.display(e.path)}`);
    }
    if (unstaged.length) {
      lines.push("", "Changes not staged for commit:", '  (use "git add <file>..." to update what will be committed)', '  (use "git restore <file>..." to discard changes in working directory)');
      for (const e of unstaged) lines.push(`\t${names[e.y] ?? `${e.y}: `}${this.display(e.path)}`);
    }
    if (untracked.length) {
      lines.push("", "Untracked files:", '  (use "git add <file>..." to include in what will be committed)');
      for (const e of untracked) lines.push(`\t${this.display(e.path)}`);
    }
    lines.push("");
    if (!staged.length) {
      if (unstaged.length) lines.push('no changes added to commit (use "git add" and/or "git commit -a")');
      else if (untracked.length) lines.push('nothing added to commit but untracked files present (use "git add" to track)');
      else lines.push(head.sha ? "nothing to commit, working tree clean" : 'nothing to commit (create/copy files and use "git add" to track)');
    }
    this.out(`${lines.join("\n")}\n`);
    return 0;
  }

  cmd_add(args) {
    let all = false;
    let update = false;
    let dry = false;
    let verbose = false;
    const specs = [];
    let literal = false;
    for (const a of args) {
      if (literal || !a.startsWith("-") || a === "-") specs.push(a);
      else if (a === "--") literal = true;
      else if (a === "-A" || a === "--all" || a === "--no-ignore-removal") all = true;
      else if (a === "-u" || a === "--update") update = true;
      else if (a === "-n" || a === "--dry-run") dry = true;
      else if (a === "-v" || a === "--verbose") verbose = true;
      // -f/--force, -N, --intent-to-add, -p: -p needs a terminal; the rest are defaults here
      else if (a === "-p" || a === "--patch" || a === "-i" || a === "--interactive") return this.fatal("interactive staging needs a terminal; add whole files instead");
    }
    if (!specs.length && !all && !update) {
      this.err("Nothing specified, nothing added.\nhint: Maybe you wanted to say 'git add .'?\n");
      return 0;
    }
    const { specs: paths, error } = this.specsOf(specs);
    if (error) return this.fatal(error);
    const scope = paths.length ? paths : [""];
    const status = this.porcelain().filter((e) => this.inSpec(e.path, scope));
    const index = this.index();
    const tracked = new Set(index.entries.map((e) => e.path));
    // every literal pathspec must name something, as git insists
    for (const [i, p] of paths.entries()) {
      if (p === "" || /[*?[]/.test(p)) continue;
      const abs = this.ctx.resolve(specs[i]);
      const known = this.store.exists(abs) || [...tracked].some((t) => t === p || t.startsWith(`${p}/`));
      if (!known) return this.fatal(`pathspec '${specs[i]}' did not match any files`);
    }
    const toAdd = [];
    const toRemove = new Set();
    for (const e of status) {
      if (e.y === "D" || (e.x === "D" && e.y === " ")) {
        if (e.y === "D") toRemove.add(e.path);
      } else if (e.x === "?") {
        if (!update) toAdd.push(e.path);
      } else if (e.y !== " ") toAdd.push(e.path);
    }
    if (dry || verbose) {
      for (const p of toAdd) this.out(`add '${p}'\n`);
      for (const p of toRemove) this.out(`remove '${p}'\n`);
      if (dry) return 0;
    }
    if (toAdd.length) {
      const expanded = toAdd.filter((p) => !p.endsWith("/")).concat(toAdd.filter((p) => p.endsWith("/")).map((p) => p.replace(/\/$/, "")));
      for (let i = 0; i < expanded.length; i += 200) {
        // lg2's add takes no `--`: everything after one is ignored
        const r = this.lg(["add", ...expanded.slice(i, i + 200).map((p) => (p.startsWith("-") ? `./${p}` : p))]);
        if (r.code !== 0) {
          this.err(r.err);
          return 128;
        }
      }
    }
    if (toRemove.size) {
      const fresh = this.index();
      fresh.entries = fresh.entries.filter((e) => !toRemove.has(e.path));
      this.saveIndex(fresh);
    }
    return 0;
  }

  cmd_commit(args) {
    const messages = [];
    let all = false;
    let allowEmpty = false;
    let amend = false;
    let quiet = false;
    let noEdit = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-m" || a === "--message") messages.push(args[++i] ?? "");
      else if (a.startsWith("--message=")) messages.push(a.slice(10));
      else if (/^-[a-zA-Z]+$/.test(a) && a.includes("m") && !a.startsWith("--")) {
        if (a.includes("a")) all = true;
        if (a.includes("q")) quiet = true;
        messages.push(args[++i] ?? "");
      } else if (a === "-a" || a === "--all") all = true;
      else if (a === "-F" || a === "--file") {
        const f = args[++i];
        const bytes = f === "-" ? this.ctx.readAll() : this.store.readFile(this.ctx.resolve(f ?? ""));
        if (!bytes) return this.fatal(`could not read log file '${f}'`);
        messages.push(text(bytes));
      } else if (a === "--allow-empty") allowEmpty = true;
      else if (a === "--amend") amend = true;
      else if (a === "--no-edit") noEdit = true;
      else if (a === "-q" || a === "--quiet") quiet = true;
      // --no-verify, -s, --signoff, --author=: no hooks, no signatures here
    }
    const head = this.head();
    if (amend) {
      if (!head.sha) return this.fatal("You have nothing to amend.");
      const log = this.lg(["cat-file", "-p", "HEAD"]);
      const previous = text(log.out).split("\n\n").slice(1).join("\n\n").trim();
      const parent = this.resolve("HEAD~1");
      if (!parent) return this.fatal("amending the first commit is not supported here; commit again instead", 1);
      if (!messages.length) {
        if (!noEdit && !previous) return this.fatal("no commit message given");
        messages.push(previous);
      }
      if (all) this.cmd_add(["-u"]);
      this.lg(["reset", "--soft", parent]);
      allowEmpty = true;
    } else if (all) this.cmd_add(["-u"]);
    if (!messages.length) return this.fatal("no commit message given; use -m \"message\"", 1);
    const staged = this.porcelain().filter((e) => e.x !== " " && e.x !== "?");
    if (!staged.length && !allowEmpty) {
      this.cmd_status([]);
      return 1;
    }
    const message = messages.join("\n\n").replace(/\s+$/, "");
    const r = this.lg(["commit", "-m", message]);
    if (r.code !== 0) {
      this.err(r.err || "fatal: commit failed\n");
      return 1;
    }
    if (!quiet) {
      const after = this.head();
      const stat = head.sha ? text(this.lg(["diff", "--stat", "HEAD~1", "HEAD"]).out).trim().split("\n").pop() : `${staged.length} file${staged.length === 1 ? "" : "s"} changed`;
      this.out(`[${after.branch ?? "detached HEAD"}${head.sha ? "" : " (root-commit)"} ${after.sha?.slice(0, 7)}] ${message.split("\n")[0]}\n ${stat.trim()}\n`);
    }
    return 0;
  }

  /** Commits from lg2's log, parsed; with `patch`, each carries its diff. */
  commits(revArgs, { patch = false, limit = null, paths = [] } = {}) {
    const argv = ["log", "--topo-order"];
    if (patch) argv.push("-p");
    if (limit !== null) argv.push("-n", String(limit));
    argv.push(...revArgs);
    if (paths.length) argv.push("--", ...paths);
    const r = this.lg(argv);
    if (r.code !== 0) return { error: r.err };
    const commits = [];
    let current = null;
    let inMessage = false;
    for (const line of text(r.out).split("\n")) {
      const start = /^commit ([0-9a-f]{40})/.exec(line);
      if (start) {
        current = { sha: start[1], parents: [], author: "", email: "", date: null, message: [], patch: [] };
        commits.push(current);
        inMessage = false;
        continue;
      }
      if (!current) continue;
      if (line.startsWith("diff --git ") || (current.patch.length && !line.startsWith("    "))) {
        inMessage = false;
        current.patch.push(line);
        continue;
      }
      if (!inMessage) {
        const author = /^Author:\s*(.*?)\s*<(.*)>$/.exec(line);
        if (author) {
          current.author = author[1];
          current.email = author[2];
          continue;
        }
        const date = /^Date:\s+\w+ (\w+) (\d+) ([\d:]+) (\d+) ([+-]\d{4})$/.exec(line);
        if (date) {
          current.date = new Date(`${date[1]} ${date[2]} ${date[4]} ${date[3]} GMT${date[5]}`);
          current.tz = date[5];
          continue;
        }
        if (line.startsWith("Merge:")) {
          current.merge = line.slice(6).trim().split(/\s+/);
          continue;
        }
        if (line === "") {
          inMessage = true;
          continue;
        }
      } else if (line.startsWith("    ") || line === "") {
        current.message.push(line.slice(4));
      }
    }
    for (const c of commits) {
      while (c.message.length && c.message[c.message.length - 1] === "") c.message.pop();
      while (c.patch.length && c.patch[c.patch.length - 1] === "") c.patch.pop();
    }
    return { commits };
  }

  cmd_log(args, { show = false } = {}) {
    const o = { limit: show ? 1 : null, format: null, patch: show, stat: false, nameOnly: false, nameStatus: false, reverse: false, date: "default", grep: null, author: null };
    const revs = [];
    const paths = [];
    let afterDash = false;
    let explicitPatch = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (afterDash) {
        paths.push(a);
        continue;
      }
      if (a === "--") afterDash = true;
      else if (/^-\d+$/.test(a)) o.limit = Number(a.slice(1));
      else if (a === "-n" || a === "--max-count") o.limit = Number(args[++i]);
      else if (a.startsWith("--max-count=")) o.limit = Number(a.slice(12));
      else if (/^-n\d+$/.test(a)) o.limit = Number(a.slice(2));
      else if (a === "--oneline") o.format = "oneline";
      else if (a.startsWith("--pretty=") || a.startsWith("--format=")) o.format = a.slice(a.indexOf("=") + 1);
      else if (a === "--pretty" || a === "--format") o.format = args[++i];
      else if (a === "-p" || a === "-u" || a === "--patch") o.patch = explicitPatch = true;
      else if (a === "-s" || a === "--no-patch") o.patch = false;
      else if (a === "--stat" || a === "--shortstat" || a === "--numstat") o.stat = a;
      else if (a === "--name-only") o.nameOnly = true;
      else if (a === "--name-status") o.nameStatus = true;
      else if (a === "--reverse") o.reverse = true;
      else if (a.startsWith("--date=")) o.date = a.slice(7);
      else if (a.startsWith("--grep=")) o.grep = a.slice(7);
      else if (a === "--grep") o.grep = args[++i];
      else if (a.startsWith("--author=")) o.author = a.slice(9);
      else if (a === "--author") o.author = args[++i];
      else if (a.startsWith("-")) continue; // --graph, --decorate, --all, --no-color, --abbrev-commit: presentation only
      else if (!show && !this.resolve(a.split("..")[0] || "HEAD") && this.store.exists(this.ctx.resolve(a))) paths.push(a);
      else revs.push(a);
    }
    // `show --stat` and friends replace the patch unless -p asks for both
    if (show && !explicitPatch && (o.stat || o.nameOnly || o.nameStatus)) o.patch = false;
    if (show && revs.length === 1 && revs[0].includes(":") && !revs[0].includes("..")) {
      const bytes = this.blob(revs[0]);
      if (!bytes) return this.fatal(`path '${revs[0].split(":").slice(1).join(":")}' does not exist in '${revs[0].split(":")[0] || "HEAD"}'`);
      this.out(bytes);
      return 0;
    }
    if (!this.head().sha && !revs.length) {
      if (show) return this.fatal("your current branch does not have any commits yet");
      return this.fatal(`your current branch '${this.head().branch}' does not have any commits yet`);
    }
    const { specs: relPaths, error } = this.specsOf(paths);
    if (error) return this.fatal(error);
    const needPatch = o.patch || o.stat || o.nameOnly || o.nameStatus;
    const fetchLimit = o.grep || o.author ? null : o.limit;
    const lists = show && revs.length > 1 ? revs.map((r) => [r]) : [revs];
    let commits = [];
    for (const list of lists) {
      const { commits: found, error: e } = this.commits(list, { patch: needPatch, limit: show ? 1 : fetchLimit, paths: relPaths });
      if (e) {
        this.err(/not found|parse/.test(e) ? `fatal: ambiguous argument '${list.join(" ")}': unknown revision or path not in the working tree.\n` : e);
        return 128;
      }
      commits.push(...found);
    }
    if (o.grep) commits = commits.filter((c) => new RegExp(o.grep, "i").test(c.message.join("\n")));
    if (o.author) commits = commits.filter((c) => new RegExp(o.author, "i").test(`${c.author} <${c.email}>`));
    if (o.limit !== null && !show) commits = commits.slice(0, o.limit);
    if (o.reverse) commits.reverse();
    const blocks = commits.map((c) => {
      let header = formatCommit(c, o.format, o.date);
      const extra = [];
      if (o.stat) extra.push(statOf(c.patch, o.stat));
      if (o.nameOnly) extra.push(filesOf(c.patch).map((f) => f.path).join("\n"));
      if (o.nameStatus) extra.push(filesOf(c.patch).map((f) => `${f.status}\t${f.path}`).join("\n"));
      if (o.patch && c.patch.length) extra.push(c.patch.join("\n"));
      const body = extra.filter(Boolean).join("\n");
      if (!body) return header;
      if (o.format && !["short", "medium", "full", "fuller"].includes(o.format)) return `${header}\n${body}`;
      header = header.replace(/\n$/, "");
      return `${header}\n\n${body}`;
    });
    // one-line formats stack; the multi-line ones get a blank line between
    // commits. `format:` separates entries, everything else terminates them.
    const compact = o.format && !["short", "medium", "full", "fuller"].includes(o.format);
    const terminated = !o.format?.startsWith("format:");
    if (blocks.length) this.out(`${blocks.join(compact ? "\n" : "\n\n")}${terminated ? "\n" : ""}`);
    return 0;
  }

  cmd_show(args) {
    if (!args.some((a) => !a.startsWith("-"))) args = [...args, "HEAD"];
    return this.cmd_log(args, { show: true });
  }

  cmd_whatchanged(args) {
    return this.cmd_log(["--stat", ...args]);
  }

  cmd_diff(args) {
    const out = [];
    let quiet = false;
    let exitCode = false;
    let afterDash = false;
    for (const a of args) {
      if (afterDash) {
        out.push(a);
        continue;
      }
      if (a === "--") {
        afterDash = true;
        out.push(a);
      } else if (a === "--staged") out.push("--cached");
      else if (a === "--quiet") quiet = exitCode = true;
      else if (a === "--exit-code") exitCode = true;
      else if (a === "--no-index") return this.noIndexDiff(args.filter((x) => !x.startsWith("-")));
      else if (/^--(no-)?colou?r/.test(a) || a === "--no-ext-diff" || a === "-w" || a === "--ignore-all-space" || a === "--minimal") continue;
      else if (/^[^-].*\.\.\.?/.test(a) && !this.store.exists(this.ctx.resolve(a))) {
        const [from, to] = a.split(/\.\.\.?/);
        out.push(from || "HEAD", to || "HEAD");
      } else out.push(a);
    }
    const r = this.lg(["diff", ...out], this.cwd);
    if (r.code !== 0) {
      this.err(/revspec|looking up/.test(r.err) ? `fatal: bad revision '${out.find((x) => !x.startsWith("-")) ?? ""}'\n` : r.err);
      return 128;
    }
    if (!quiet) this.out(r.out);
    return exitCode && r.out.length ? 1 : 0;
  }

  noIndexDiff(files) {
    return this.shell.spawn(["diff", "-u", ...files], { cwd: this.cwd, env: this.ctx.env, stdin: this.ctx.stdin, stdout: this.ctx.stdout, stderr: this.ctx.stderr });
  }

  cmd_apply(args) {
    const check = args.includes("--check");
    const reverse = args.includes("-R") || args.includes("--reverse");
    const files = args.filter((a) => !a.startsWith("-"));
    const argv = ["patch", "-p1", "-N"];
    if (reverse) argv.push("-R");
    if (check) argv.push("--dry-run");
    const input = files.length ? this.store.readFile(this.ctx.resolve(files[0])) : this.ctx.readAll();
    if (!input) return this.fatal(`can't open patch '${files[0]}'`);
    let off = 0;
    return this.shell.spawn(argv, {
      cwd: this.repo.root,
      env: this.ctx.env,
      stdin: (max) => {
        const take = input.subarray(off, Math.min(input.length, off + max));
        off += take.length;
        return take;
      },
      stdout: args.includes("-q") ? () => {} : this.ctx.stdout,
      stderr: this.ctx.stderr,
    });
  }

  cmd_branch(args) {
    const head = this.head();
    const local = this.refs("refs/heads/");
    const remote = this.refs("refs/remotes/");
    const flags = new Set(args.filter((a) => a.startsWith("-")));
    const words = args.filter((a) => !a.startsWith("-"));
    if (flags.has("--show-current")) {
      this.out(head.branch ? `${head.branch}\n` : "");
      return 0;
    }
    const del = ["-d", "-D", "--delete"].find((f) => flags.has(f));
    if (del) {
      let code = 0;
      for (const name of words) {
        if (name === head.branch) {
          this.err(`error: cannot delete branch '${name}' used by worktree at '${this.repo.root}'\n`);
          code = 1;
          continue;
        }
        const sha = local.get(`refs/heads/${name}`);
        if (!sha) {
          this.err(`error: branch '${name}' not found\n`);
          code = 1;
          continue;
        }
        this.store.remove(`${this.repo.gitDir}/refs/heads/${name}`);
        this.dropPacked(`refs/heads/${name}`);
        this.out(`Deleted branch ${name} (was ${sha.slice(0, 7)}).\n`);
      }
      return code;
    }
    const move = ["-m", "-M", "--move"].find((f) => flags.has(f));
    if (move) {
      const [from, to] = words.length === 1 ? [head.branch, words[0]] : words;
      const sha = local.get(`refs/heads/${from}`);
      if (!sha) return this.fatal(`no branch named '${from}'`);
      if (local.has(`refs/heads/${to}`) && move !== "-M") return this.fatal(`a branch named '${to}' already exists`);
      this.store.remove(`${this.repo.gitDir}/refs/heads/${from}`);
      this.dropPacked(`refs/heads/${from}`);
      this.writeRef(`refs/heads/${to}`, sha);
      if (head.branch === from) this.store.writeFile(`${this.repo.gitDir}/HEAD`, encoder.encode(`ref: refs/heads/${to}\n`));
      return 0;
    }
    if (words.length && !flags.has("-l") && !flags.has("--list")) {
      const [name, start = "HEAD"] = words;
      if (!/^(?!-)(?!.*\.\.)[\w./-]+$/.test(name) || name.endsWith("/") || name.endsWith(".lock")) return this.fatal(`'${name}' is not a valid branch name`);
      if (local.has(`refs/heads/${name}`) && !flags.has("-f") && !flags.has("--force")) return this.fatal(`a branch named '${name}' already exists`);
      const sha = this.resolve(start);
      if (!sha) return this.fatal(`not a valid object name: '${start}'`);
      this.writeRef(`refs/heads/${name}`, sha);
      return 0;
    }
    const verbose = flags.has("-v") || flags.has("-vv") || flags.has("--verbose");
    const subject = (sha) => {
      const body = text(this.lg(["cat-file", "-p", sha]).out).split("\n\n")[1] ?? "";
      return body.split("\n")[0];
    };
    const show = (name, sha, current, prefix = "") => {
      this.out(`${current ? "* " : "  "}${prefix}${name}${verbose ? ` ${sha.slice(0, 7)} ${subject(sha)}` : ""}\n`);
    };
    const pattern = words[0];
    const pick = (name) => !pattern || globMatch(pattern, name);
    if (!flags.has("-r") && !flags.has("--remotes")) {
      if (!head.branch && head.sha) this.out(`* (HEAD detached at ${head.sha.slice(0, 7)})\n`);
      for (const [ref, sha] of local) {
        const name = ref.slice(11);
        if (pick(name)) show(name, sha, name === head.branch);
      }
    }
    if (flags.has("-a") || flags.has("--all") || flags.has("-r") || flags.has("--remotes")) {
      const prefix = flags.has("-r") || flags.has("--remotes") ? "" : "remotes/";
      for (const [ref, sha] of remote) if (pick(ref.slice(13))) show(ref.slice(13), sha, false, prefix);
    }
    return 0;
  }

  dropPacked(ref) {
    const path = `${this.repo.gitDir}/packed-refs`;
    const packed = this.store.readFile(path);
    if (!packed) return;
    const lines = text(packed).split("\n");
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].split(" ")[1] === ref) {
        if (lines[i + 1]?.startsWith("^")) i++;
        continue;
      }
      out.push(lines[i]);
    }
    this.store.writeFile(path, encoder.encode(out.join("\n")));
  }

  /** Moves HEAD (and the worktree) to a branch or commit. */
  switchTo(target, { create = false, start = null, detach = false } = {}) {
    const head = this.head();
    const local = this.refs("refs/heads/");
    if (create) {
      if (local.has(`refs/heads/${target}`)) return this.fatal(`a branch named '${target}' already exists`);
      const sha = this.resolve(start ?? "HEAD");
      if (!sha && head.sha) return this.fatal(`'${start}' is not a commit and a branch '${target}' cannot be created from it`);
      if (sha && start && sha !== head.sha) {
        const r = this.lg(["checkout", sha]);
        if (r.code !== 0) {
          this.err(r.err);
          return 1;
        }
      }
      if (sha) this.writeRef(`refs/heads/${target}`, sha);
      this.store.writeFile(`${this.repo.gitDir}/HEAD`, encoder.encode(`ref: refs/heads/${target}\n`));
      this.err(`Switched to a new branch '${target}'\n`);
      return 0;
    }
    if (!detach && !local.has(`refs/heads/${target}`)) {
      const remote = [...this.refs("refs/remotes/")].find(([ref]) => ref.endsWith(`/${target}`));
      if (remote) {
        this.writeRef(`refs/heads/${target}`, remote[1]);
        const r = this.lg(["checkout", target]);
        if (r.code !== 0) {
          this.err(r.err);
          return 1;
        }
        this.err(`branch '${target}' set up to track '${remote[0].slice(13)}'.\nSwitched to a new branch '${target}'\n`);
        return 0;
      }
    }
    if (target === head.branch) {
      this.err(`Already on '${target}'\n`);
      return 0;
    }
    const sha = this.resolve(target);
    if (!sha) return this.fatal(`invalid reference: ${target}`);
    const dirty = this.porcelain().filter((e) => e.x !== "?" && (e.x !== " " || e.y !== " "));
    const r = this.lg(["checkout", local.has(`refs/heads/${target}`) ? target : sha]);
    if (r.code !== 0 || /conflict/i.test(r.err)) {
      this.err(r.err.includes("conflict") ? `error: Your local changes would be overwritten by checkout:\n${dirty.map((e) => `\t${e.path}`).join("\n")}\nPlease commit your changes or stash them before you switch branches.\nAborting\n` : r.err);
      return 1;
    }
    if (local.has(`refs/heads/${target}`)) this.err(`Switched to branch '${target}'\n`);
    else this.err(`HEAD is now at ${sha.slice(0, 7)}\n`);
    return 0;
  }

  cmd_switch(args) {
    const words = args.filter((a) => !a.startsWith("-"));
    const create = args.includes("-c") || args.includes("-C") || args.includes("--create");
    const detach = args.includes("-d") || args.includes("--detach");
    if (!words.length) return this.fatal("missing branch or commit argument");
    return this.switchTo(words[0], { create, start: words[1], detach });
  }

  cmd_checkout(args) {
    const dash = args.indexOf("--");
    const before = dash >= 0 ? args.slice(0, dash) : args;
    const after = dash >= 0 ? args.slice(dash + 1) : [];
    const words = before.filter((a) => !a.startsWith("-"));
    const create = before.includes("-b") || before.includes("-B");
    if (create) return this.switchTo(words[0], { create: true, start: words[1] });
    if (dash >= 0) return this.restorePaths(after, { source: words[0] ?? null, staged: Boolean(words[0]), worktree: true });
    if (words.length === 1 && (this.refs("refs/heads/").has(`refs/heads/${words[0]}`) || this.resolve(words[0]) || [...this.refs("refs/remotes/")].some(([r]) => r.endsWith(`/${words[0]}`)))) {
      return this.switchTo(words[0], { detach: before.includes("--detach") });
    }
    if (words.length > 1 && this.resolve(words[0])) return this.restorePaths(words.slice(1), { source: words[0], staged: true, worktree: true });
    return this.restorePaths(words, { source: null, staged: false, worktree: true });
  }

  cmd_restore(args) {
    let source = null;
    let staged = false;
    let worktree = false;
    const paths = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-s" || a === "--source") source = args[++i];
      else if (a.startsWith("--source=")) source = a.slice(9);
      else if (a === "-S" || a === "--staged") staged = true;
      else if (a === "-W" || a === "--worktree") worktree = true;
      else if (a === "--") continue;
      else if (!a.startsWith("-")) paths.push(a);
    }
    if (!staged) worktree = true;
    return this.restorePaths(paths, { source, staged, worktree });
  }

  /** checkout/restore of paths: the index from `source` (when staged) and
   *  the files from the index, or from `source` directly. */
  restorePaths(paths, { source, staged, worktree }) {
    if (!paths.length) return this.fatal("you must specify path(s) to restore");
    const { specs, error } = this.specsOf(paths);
    if (error) return this.fatal(error);
    const index = this.index();
    const rev = source ?? (staged ? "HEAD" : null);
    const sourceFiles = new Map();
    if (rev) {
      if (!this.resolve(rev)) return this.fatal(`could not resolve ${rev}`);
      for (const s of specs) for (const [p, v] of this.tree(rev, s)) sourceFiles.set(p, v);
    }
    const fromIndex = new Map(index.entries.filter((e) => e.stage === 0).map((e) => [e.path, { mode: e.fields[6], oid: e.oid }]));
    for (const [i, s] of specs.entries()) {
      const known = (rev ? [...sourceFiles.keys()] : [...fromIndex.keys()]).some((p) => this.inSpec(p, [s]));
      const inIndex = [...fromIndex.keys()].some((p) => this.inSpec(p, [s]));
      if (!known && !(staged && inIndex)) return this.fatal(`pathspec '${paths[i]}' did not match any file(s) known to git`, 1);
    }
    if (staged) {
      const kept = index.entries.filter((e) => !this.inSpec(e.path, specs));
      for (const [p, v] of sourceFiles) kept.push(entryFor(p, v.oid, v.mode));
      index.entries = kept;
      this.saveIndex(index);
    }
    if (worktree) {
      const files = source || (staged && rev) ? sourceFiles : new Map([...fromIndex].filter(([p]) => this.inSpec(p, specs)));
      const root = this.repo.root === "/" ? "" : this.repo.root;
      for (const [p, v] of files) {
        const bytes = this.blob(v.oid);
        if (bytes) this.store.writeFile(`${root}/${p}`, bytes, { mode: v.mode & 0o777 });
      }
    }
    return 0;
  }

  cmd_reset(args) {
    const dash = args.indexOf("--");
    const words = (dash >= 0 ? args.slice(0, dash) : args).filter((a) => !a.startsWith("-"));
    const modes = args.filter((a) => /^--(soft|mixed|hard|merge|keep)$/.test(a));
    let paths = dash >= 0 ? args.slice(dash + 1) : [];
    let rev = null;
    if (words.length) {
      if (this.resolve(words[0]) && !(words.length === 1 && dash < 0 && this.store.exists(this.ctx.resolve(words[0])) && !this.refs("refs/heads/").has(`refs/heads/${words[0]}`))) {
        rev = words[0];
        paths = [...words.slice(1), ...paths];
      } else paths = [...words, ...paths];
    }
    if (paths.length) {
      if (modes.some((m) => m !== "--mixed")) return this.fatal(`Cannot do ${modes[0].slice(2)} reset with paths.`);
      return this.restorePaths(paths, { source: rev ?? "HEAD", staged: true, worktree: false });
    }
    if (!this.head().sha) {
      const index = this.index();
      index.entries = [];
      this.saveIndex(index);
      return 0;
    }
    const r = this.lg(["reset", ...modes, rev ?? "HEAD"]);
    if (r.code !== 0) {
      this.err(r.err || `fatal: could not reset to ${rev}\n`);
      return 128;
    }
    if (modes.includes("--hard")) {
      const sha = this.head().sha;
      const subject = (text(this.lg(["cat-file", "-p", sha]).out).split("\n\n")[1] ?? "").split("\n")[0];
      this.out(`HEAD is now at ${sha.slice(0, 7)} ${subject}\n`);
    } else if (!args.includes("-q")) {
      const unstaged = this.porcelain().filter((e) => e.y !== " " && e.x !== "?");
      if (unstaged.length) this.out(`Unstaged changes after reset:\n${unstaged.map((e) => `${e.y}\t${e.path}`).join("\n")}\n`);
    }
    return 0;
  }

  cmd_rm(args) {
    const cached = args.includes("--cached");
    const recursive = args.includes("-r") || args.includes("-rf") || args.includes("-fr");
    const quiet = args.includes("-q") || args.includes("--quiet");
    const words = args.filter((a) => !a.startsWith("-"));
    if (!words.length) return this.fatal("No pathspec was given. Which files should I remove?");
    const { specs, error } = this.specsOf(words);
    if (error) return this.fatal(error);
    const index = this.index();
    const removed = [];
    for (const [i, s] of specs.entries()) {
      const hits = index.entries.filter((e) => this.inSpec(e.path, [s]));
      if (!hits.length) return this.fatal(`pathspec '${words[i]}' did not match any files`);
      if (hits.some((e) => e.path !== s) && !recursive && !/[*?[]/.test(s)) return this.fatal(`not removing '${words[i]}' recursively without -r`);
      removed.push(...hits.map((e) => e.path));
    }
    const gone = new Set(removed);
    index.entries = index.entries.filter((e) => !gone.has(e.path));
    this.saveIndex(index);
    const root = this.repo.root === "/" ? "" : this.repo.root;
    for (const p of gone) {
      if (!cached) this.store.remove(`${root}/${p}`);
      if (!quiet) this.out(`rm '${p}'\n`);
    }
    return 0;
  }

  cmd_mv(args) {
    const words = args.filter((a) => !a.startsWith("-"));
    if (words.length < 2) return this.fatal("usage: git mv <source>... <destination>");
    const dest = words.pop();
    const destAbs = this.ctx.resolve(dest);
    const index = this.index();
    const root = this.repo.root === "/" ? "" : this.repo.root;
    for (const src of words) {
      const srcAbs = this.ctx.resolve(src);
      if (!this.store.exists(srcAbs)) return this.fatal(`bad source, source=${src}, destination=${dest}`);
      const target = this.store.isDir(destAbs) ? `${destAbs}/${srcAbs.split("/").pop()}` : destAbs;
      if (this.store.exists(target) && !args.includes("-f")) return this.fatal(`destination exists, source=${src}, destination=${dest}`);
      this.store.mkdirp(target.slice(0, target.lastIndexOf("/")) || "/");
      this.store.renameSync(srcAbs, target);
      const from = srcAbs.slice(root.length + 1);
      const to = target.slice(root.length + 1);
      for (const e of index.entries) {
        if (e.path === from) e.path = to;
        else if (e.path.startsWith(`${from}/`)) e.path = to + e.path.slice(from.length);
      }
    }
    this.saveIndex(index);
    return 0;
  }

  cmd_rev_parse(args) {
    let short = null;
    let abbrevRef = false;
    let quiet = false;
    const out = [];
    for (const a of args) {
      if (a === "--short") short = 7;
      else if (a.startsWith("--short=")) short = Number(a.slice(8)) || 7;
      else if (a === "--abbrev-ref") abbrevRef = true;
      else if (a === "--verify") continue;
      else if (a === "-q" || a === "--quiet") quiet = true;
      else if (a === "--show-toplevel") out.push(this.repo.root);
      else if (a === "--git-dir") out.push(this.cwd === this.repo.root ? ".git" : this.repo.gitDir);
      else if (a === "--absolute-git-dir") out.push(this.repo.gitDir);
      else if (a === "--is-inside-work-tree") out.push("true");
      else if (a === "--is-inside-git-dir" || a === "--is-bare-repository" || a === "--is-shallow-repository") out.push("false");
      else if (a === "--show-prefix") out.push(this.cwd === this.repo.root ? "" : `${this.cwd.slice((this.repo.root === "/" ? "" : this.repo.root).length + 1)}/`);
      else if (a === "--show-cdup") out.push(this.display("") || "");
      else if (a === "--symbolic-full-name") abbrevRef = "full";
      else if (a.startsWith("-")) continue;
      else {
        if (abbrevRef && (a === "HEAD" || a === "@")) {
          const head = this.head();
          out.push(abbrevRef === "full" ? (head.branch ? `refs/heads/${head.branch}` : "HEAD") : head.branch ?? "HEAD");
          continue;
        }
        const sha = this.resolve(a === "@" ? "HEAD" : a);
        if (!sha) {
          if (quiet) return 1;
          return this.fatal(`ambiguous argument '${a}': unknown revision or path not in the working tree.`);
        }
        out.push(short ? sha.slice(0, short) : sha);
      }
    }
    if (out.length) this.out(`${out.join("\n")}\n`);
    return 0;
  }

  cmd_rev_list(args) {
    const count = args.includes("--count");
    const rest = args.filter((a) => a !== "--count");
    const r = this.lg(["rev-list", ...rest]);
    if (r.code !== 0) {
      this.err(r.err);
      return 128;
    }
    if (count) this.out(`${text(r.out).split("\n").filter(Boolean).length}\n`);
    else this.out(r.out);
    return 0;
  }

  cmd_remote(args) {
    const config = text(this.store.readFile(`${this.repo.gitDir}/config`) ?? new Uint8Array());
    const remotes = [];
    let current = null;
    for (const line of config.split("\n")) {
      const header = /^\s*\[remote\s+"([^"]+)"\]/.exec(line);
      if (header) {
        current = { name: header[1], url: "" };
        remotes.push(current);
        continue;
      }
      if (/^\s*\[/.test(line)) current = null;
      const url = /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
      if (url && current) current.url = url[1];
    }
    const sub = args.find((a) => !a.startsWith("-"));
    if (!sub || sub === "show" && args.length === 1) {
      const verbose = args.includes("-v") || args.includes("--verbose");
      for (const r of remotes) this.out(verbose ? `${r.name}\t${r.url} (fetch)\n${r.name}\t${r.url} (push)\n` : `${r.name}\n`);
      return 0;
    }
    if (sub === "get-url") {
      const name = args[args.indexOf("get-url") + 1];
      const r = remotes.find((x) => x.name === name);
      if (!r) return this.fatal(`No such remote '${name}'`, 2);
      this.out(`${r.url}\n`);
      return 0;
    }
    return this.pass(["remote", ...args]);
  }

  cmd_config(args) {
    const global = args.includes("--global") || args.includes("--system");
    const rest = args.filter((a) => !/^--(global|system|local|file)$/.test(a));
    const files = [];
    this.repo ??= this.findRepo();
    if (!global && this.repo) files.push(`${this.repo.gitDir}/config`);
    const list = rest.includes("--list") || rest.includes("-l");
    if (list) {
      const entries = files.flatMap((f) => parseConfig(text(this.store.readFile(f) ?? new Uint8Array())));
      const globals = [["user.name", "Chrysalis"], ["user.email", "sandbox@chrysalis.local"], ["init.defaultbranch", "main"]];
      for (const [k, v] of [...globals, ...entries]) this.out(`${k}=${v}\n`);
      return 0;
    }
    const words = rest.filter((a) => !a.startsWith("-"));
    if (rest.includes("--unset") || rest.includes("--unset-all")) {
      if (!this.repo) return this.fatal("not in a git directory");
      const file = `${this.repo.gitDir}/config`;
      const updated = unsetConfig(text(this.store.readFile(file) ?? new Uint8Array()), words[0]);
      if (updated === null) return 5;
      this.store.writeFile(file, encoder.encode(updated));
      return 0;
    }
    if (words.length === 1 || rest.includes("--get")) {
      const key = words[0]?.toLowerCase();
      for (const f of files) {
        const hit = parseConfig(text(this.store.readFile(f) ?? new Uint8Array())).filter(([k]) => k === key).pop();
        if (hit) {
          this.out(`${hit[1]}\n`);
          return 0;
        }
      }
      const defaults = { "user.name": "Chrysalis", "user.email": "sandbox@chrysalis.local", "init.defaultbranch": "main" };
      if (defaults[key]) {
        this.out(`${defaults[key]}\n`);
        return 0;
      }
      return 1;
    }
    if (!this.repo && !global) return this.fatal("not in a git directory");
    return this.pass(["config", ...rest], this.repo?.root ?? this.cwd);
  }

  cmd_tag(args) {
    const listing = !args.length || args.includes("-l") || args.includes("--list") || (args.length === 1 && args[0] === "-n");
    if (listing) {
      const pattern = args.filter((a) => !a.startsWith("-"))[0];
      for (const ref of this.refs("refs/tags/").keys()) {
        const name = ref.slice(10);
        if (!pattern || globMatch(pattern, name)) this.out(`${name}\n`);
      }
      return 0;
    }
    const r = this.lg(["tag", ...args]);
    this.out(text(r.out).replace(/[ \t]+$/gm, ""));
    if (r.err) this.err(r.err);
    return r.code ? 1 : 0;
  }

  cmd_show_ref(args) {
    const wanted = args.filter((a) => !a.startsWith("-"));
    let found = false;
    for (const [ref, sha] of [...this.refs("refs/heads/"), ...this.refs("refs/remotes/"), ...this.refs("refs/tags/")]) {
      if (wanted.length && !wanted.some((w) => ref === w || ref.endsWith(`/${w}`))) continue;
      found = true;
      this.out(`${sha} ${ref}\n`);
    }
    return found ? 0 : 1;
  }

  cmd_ls_tree(args) {
    const recursive = args.includes("-r");
    const nameOnly = args.includes("--name-only") || args.includes("--name-status");
    const words = args.filter((a) => !a.startsWith("-"));
    const rev = words[0] ?? "HEAD";
    const prefix = words[1] ? this.rel(words[1]) ?? "" : this.rel(".") ?? "";
    if (recursive) {
      for (const [p, v] of this.tree(rev, prefix.replace(/\/$/, ""))) this.out(nameOnly ? `${p}\n` : `${v.mode.toString(8).padStart(6, "0")} blob ${v.oid}\t${p}\n`);
      return 0;
    }
    const r = this.lg(["cat-file", "-p", prefix ? `${rev}:${prefix.replace(/\/$/, "")}` : `${rev}^{tree}`]);
    if (r.code !== 0) return this.fatal(`Not a valid object name ${rev}`);
    for (const line of text(r.out).split("\n").filter(Boolean)) {
      const name = line.split("\t")[1];
      const full = prefix ? `${prefix.replace(/\/$/, "")}/${name}` : name;
      this.out(nameOnly ? `${full}\n` : `${line.split("\t")[0]}\t${full}\n`);
    }
    return 0;
  }

  cmd_ls_files(args) {
    const others = args.includes("-o") || args.includes("--others");
    const modified = args.includes("-m") || args.includes("--modified");
    const deleted = args.includes("-d") || args.includes("--deleted");
    const stage = args.includes("-s") || args.includes("--stage");
    const words = args.filter((a) => !a.startsWith("-"));
    const { specs, error } = this.specsOf(words.length ? words : ["."]);
    if (error) return this.fatal(error);
    if (others || modified || deleted) {
      const status = this.porcelain().filter((e) => this.inSpec(e.path, specs));
      for (const e of status) {
        if ((others && e.x === "?") || (modified && e.x !== "?" && e.y !== " ") || (deleted && e.y === "D")) this.out(`${this.display(e.path)}\n`);
      }
      return 0;
    }
    for (const e of this.index().entries) {
      if (!this.inSpec(e.path, specs)) continue;
      this.out(stage ? `${e.fields[6].toString(8)} ${e.oid} ${e.stage}\t${this.display(e.path)}\n` : `${this.display(e.path)}\n`);
    }
    return 0;
  }

  cmd_clean(args) {
    const force = args.some((a) => /^-[a-z]*f/.test(a) || a === "--force");
    const dry = args.some((a) => /^-[a-z]*n/.test(a) || a === "--dry-run");
    const dirs = args.some((a) => /^-[a-z]*d/.test(a));
    if (!force && !dry) return this.fatal("clean.requireForce defaults to true and neither -i, -n, nor -f given; refusing to clean");
    const { specs, error } = this.specsOf(args.filter((a) => !a.startsWith("-")));
    if (error) return this.fatal(error);
    const root = this.repo.root === "/" ? "" : this.repo.root;
    for (const e of this.porcelain()) {
      if (e.x !== "?" || !this.inSpec(e.path, specs)) continue;
      if (e.path.endsWith("/") && !dirs) continue;
      this.out(`${dry ? "Would remove" : "Removing"} ${this.display(e.path)}\n`);
      if (!dry) this.store.remove(`${root}/${e.path.replace(/\/$/, "")}`);
    }
    return 0;
  }

  cmd_grep(args) {
    const o = { i: false, n: false, l: false, c: false, w: false, F: false, v: false };
    const patterns = [];
    const words = [];
    let afterDash = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (afterDash || !a.startsWith("-")) words.push(a);
      else if (a === "--") afterDash = true;
      else if (a === "-e") patterns.push(args[++i]);
      else if (a === "--ignore-case") o.i = true;
      else if (a === "--line-number") o.n = true;
      else if (a === "--files-with-matches" || a === "--name-only") o.l = true;
      else if (a === "--count") o.c = true;
      else if (a === "--word-regexp") o.w = true;
      else if (a === "--fixed-strings") o.F = true;
      else if (a === "--invert-match") o.v = true;
      else if (/^-[a-zA-Z]+$/.test(a)) for (const f of a.slice(1)) if (f in o) o[f] = true;
    }
    if (!patterns.length) patterns.push(words.shift());
    if (patterns[0] === undefined) return this.fatal("no pattern given");
    const source = patterns.map((p) => (o.F ? p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : p.replace(/\\([|(){}+?])/g, "$1"))).join("|");
    const re = new RegExp(o.w ? `\\b(?:${source})\\b` : source, o.i ? "i" : "");
    const { specs, error } = this.specsOf(words.length ? words : ["."]);
    if (error) return this.fatal(error);
    const root = this.repo.root === "/" ? "" : this.repo.root;
    let any = false;
    for (const e of this.index().entries) {
      if (e.stage !== 0 || !this.inSpec(e.path, specs)) continue;
      const bytes = this.store.readFile(`${root}/${e.path}`);
      if (!bytes || bytes.subarray(0, 8000).includes(0)) continue;
      const lines = text(bytes).split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      let hits = 0;
      const shown = this.display(e.path);
      for (const [n, line] of lines.entries()) {
        if (re.test(line) === o.v) continue;
        hits++;
        if (!o.l && !o.c) this.out(`${shown}:${o.n ? `${n + 1}:` : ""}${line}\n`);
      }
      if (hits) {
        any = true;
        if (o.l) this.out(`${shown}\n`);
        if (o.c) this.out(`${shown}:${hits}\n`);
      }
    }
    return any ? 0 : 1;
  }

  cmd_merge(args) {
    const quiet = args.includes("-q") || args.includes("--quiet");
    const abort = args.includes("--abort");
    if (abort) return this.cmd_reset(["--hard", "-q", "HEAD"]);
    // lg2's merge takes the commit alone; the rest are defaults or cosmetics
    const kept = args.filter((a) => !/^(-q|--quiet|--no-edit|--ff|--no-stat|--stat|--progress|--no-progress|-v|--verbose)$/.test(a));
    const message = kept.indexOf("-m");
    if (message >= 0) kept.splice(message, 2);
    if (kept.includes("--no-ff") || kept.includes("--squash")) return this.fatal("--no-ff and --squash are not available here; plain merges are", 1);
    const r = this.lg(["merge", ...kept], this.repo.root);
    if (!quiet) this.out(r.out);
    if (r.err) this.err(r.err);
    if (/conflict/i.test(text(r.out) + r.err)) {
      this.out("Automatic merge failed; fix conflicts and then commit the result.\n");
      return 1;
    }
    return r.code ? 1 : 0;
  }

  cmd_pull(args) {
    const words = args.filter((a) => !a.startsWith("-"));
    const remote = words[0] ?? "origin";
    const head = this.head();
    const branch = words[1] ?? head.branch;
    const fetch = this.lg(["fetch", remote]);
    if (fetch.code !== 0) {
      this.err(fetch.err || `fatal: could not fetch from '${remote}'\n`);
      return 1;
    }
    return this.cmd_merge([`${remote}/${branch}`]);
  }
}

// -------------------------------------------------------------- helpers
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

/** lg2's stderr, minus its progress chatter and example-program noise. */
function cleanErr(s) {
  if (!s) return "";
  return s
    .replace(/Unable to open repository '%s' '[^']*' \[-3\] - could not find repository at '[^']*'/g, "fatal: not a git repository (or any of the parent directories): .git")
    .split("\n")
    .filter((l) => !/^checkout started: \d+ steps$/.test(l) && l !== "Bad news:" && !/^ERROR \d+: /.test(l) && !/^error: reference 'refs\/heads\/[^']+' not found$/.test(l))
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .replace(/^\n+/, "");
}

function globMatch(pattern, value) {
  if (!/[*?[]/.test(pattern)) return false;
  const re = pattern.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*");
  return new RegExp(`^${re}$`).test(value);
}

function parseConfig(source) {
  const out = [];
  let section = "";
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[([^\s\]"]+)(?:\s+"([^"]*)")?\]$/.exec(line);
    if (header) {
      section = header[2] !== undefined ? `${header[1].toLowerCase()}.${header[2]}` : header[1].toLowerCase();
      continue;
    }
    const kv = /^([^=\s]+)\s*(?:=\s*(.*))?$/.exec(line);
    if (kv) out.push([`${section}.${kv[1].toLowerCase()}`, (kv[2] ?? "true").replace(/^"(.*)"$/, "$1")]);
  }
  return out;
}

function unsetConfig(source, key) {
  const dot = key.lastIndexOf(".");
  const want = [key.slice(0, dot).toLowerCase(), key.slice(dot + 1).toLowerCase()];
  let section = "";
  let removed = false;
  const lines = source.split("\n").filter((raw) => {
    const line = raw.trim();
    const header = /^\[([^\s\]"]+)(?:\s+"([^"]*)")?\]$/.exec(line);
    if (header) {
      section = header[2] !== undefined ? `${header[1].toLowerCase()}.${header[2]}` : header[1].toLowerCase();
      return true;
    }
    const kv = /^([^=\s]+)/.exec(line);
    if (kv && section === want[0] && kv[1].toLowerCase() === want[1]) {
      removed = true;
      return false;
    }
    return true;
  });
  return removed ? lines.join("\n") : null;
}

const pad2 = (n) => String(n).padStart(2, "0");
function formatDate(date, tz = "+0000", style = "default") {
  if (!date) return "";
  const offset = (tz[0] === "-" ? -1 : 1) * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)));
  const local = new Date(date.getTime() + offset * 60000);
  const y = local.getUTCFullYear();
  const mo = pad2(local.getUTCMonth() + 1);
  const d = pad2(local.getUTCDate());
  const time = `${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}:${pad2(local.getUTCSeconds())}`;
  if (style === "short") return `${y}-${mo}-${d}`;
  if (style === "iso" || style === "iso8601") return `${y}-${mo}-${d} ${time} ${tz}`;
  if (style === "iso-strict") return `${y}-${mo}-${d}T${time}${tz.slice(0, 3)}:${tz.slice(3)}`;
  if (style === "unix") return String(Math.floor(date.getTime() / 1000));
  if (style === "relative") return relative(date);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${days[local.getUTCDay()]} ${months[local.getUTCMonth()]} ${local.getUTCDate()} ${time} ${y} ${tz}`;
}
function relative(date) {
  const s = Math.round((Date.now() - date.getTime()) / 1000);
  const unit = (n, u) => `${n} ${u}${n === 1 ? "" : "s"} ago`;
  if (s < 90) return unit(Math.max(s, 0), "second");
  if (s < 5400) return unit(Math.round(s / 60), "minute");
  if (s < 129600) return unit(Math.round(s / 3600), "hour");
  if (s < 1209600) return unit(Math.round(s / 86400), "day");
  if (s < 5184000) return unit(Math.round(s / 604800), "week");
  if (s < 31536000) return unit(Math.round(s / 2592000), "month");
  return unit(Math.round(s / 31536000), "year");
}

function formatCommit(c, format, dateStyle) {
  const subject = c.message[0] ?? "";
  const body = c.message.slice(1).join("\n").replace(/^\n+/, "");
  if (!format || format === "medium") {
    return [`commit ${c.sha}`, ...(c.merge ? [`Merge: ${c.merge.join(" ")}`] : []), `Author: ${c.author} <${c.email}>`, `Date:   ${formatDate(c.date, c.tz, dateStyle)}`, "", ...c.message.map((l) => (l ? `    ${l}` : ""))].join("\n");
  }
  if (format === "oneline") return `${c.sha.slice(0, 7)} ${subject}`;
  if (format === "short") return [`commit ${c.sha}`, `Author: ${c.author} <${c.email}>`, "", `    ${subject}`].join("\n");
  if (format === "full" || format === "fuller") return [`commit ${c.sha}`, `Author: ${c.author} <${c.email}>`, `Commit: ${c.author} <${c.email}>`, "", ...c.message.map((l) => (l ? `    ${l}` : ""))].join("\n");
  const template = format.replace(/^t?format:/, "");
  return template.replace(/%(x[0-9a-fA-F]{2}|[HhTtsbBnPp%]|a[neNEdDrtiIsh]|c[neNEdDrtiIsh]|d|D|G\?)/g, (m, key) => {
    if (key.startsWith("x")) return String.fromCharCode(Number.parseInt(key.slice(1), 16));
    switch (key) {
      case "H":
        return c.sha;
      case "h":
        return c.sha.slice(0, 7);
      case "s":
        return subject;
      case "b":
        return body ? `${body}\n` : "";
      case "B":
        return `${c.message.join("\n")}\n`;
      case "n":
        return "\n";
      case "%":
        return "%";
      case "P":
      case "p":
        return (c.merge ?? []).join(" ");
      case "d":
      case "D":
      case "G?":
        return "";
    }
    const who = key[1];
    const what = key[0];
    if (what !== "a" && what !== "c") return m;
    if (who === "n" || who === "N") return c.author;
    if (who === "e" || who === "E") return c.email;
    if (who === "d") return formatDate(c.date, c.tz, dateStyle);
    if (who === "D") return formatDate(c.date, c.tz, "default");
    if (who === "r") return relative(c.date);
    if (who === "t") return formatDate(c.date, c.tz, "unix");
    if (who === "i") return formatDate(c.date, c.tz, "iso");
    if (who === "I") return formatDate(c.date, c.tz, "iso-strict");
    if (who === "s") return formatDate(c.date, c.tz, "short");
    if (who === "h") return relative(c.date);
    return m;
  });
}

function filesOf(patch) {
  const files = [];
  let current = null;
  for (const line of patch) {
    const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (m) {
      current = { path: m[2], status: "M", add: 0, del: 0 };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("new file mode")) current.status = "A";
    else if (line.startsWith("deleted file mode")) current.status = "D";
    else if (line.startsWith("rename from")) current.status = "R";
    else if (line.startsWith("+") && !line.startsWith("+++")) current.add++;
    else if (line.startsWith("-") && !line.startsWith("---")) current.del++;
    else if (line.startsWith("Binary files")) current.binary = true;
  }
  return files;
}

function statOf(patch, kind) {
  const files = filesOf(patch);
  const adds = files.reduce((n, f) => n + f.add, 0);
  const dels = files.reduce((n, f) => n + f.del, 0);
  const summary = ` ${files.length} file${files.length === 1 ? "" : "s"} changed${adds ? `, ${adds} insertion${adds === 1 ? "" : "s"}(+)` : ""}${dels ? `, ${dels} deletion${dels === 1 ? "" : "s"}(-)` : ""}`;
  if (kind === "--shortstat") return summary;
  if (kind === "--numstat") return files.map((f) => `${f.binary ? "-" : f.add}\t${f.binary ? "-" : f.del}\t${f.path}`).join("\n");
  const width = Math.max(...files.map((f) => f.path.length), 0);
  const most = Math.max(...files.map((f) => f.add + f.del), 1);
  const scale = most > 50 ? 50 / most : 1;
  const lines = files.map((f) => {
    const n = f.add + f.del;
    const bar = "+".repeat(Math.round(f.add * scale)) + "-".repeat(Math.round(f.del * scale));
    return ` ${f.path.padEnd(width)} | ${f.binary ? "Bin" : String(n).padStart(String(most).length)} ${f.binary ? "" : bar}`.trimEnd();
  });
  return [...lines, summary].join("\n");
}

const HELP = `usage: git <command> [<args>]

Working with files:  status, add [-A|-u], rm, mv, restore [--staged], reset, clean, diff, apply
History:             commit [-a] [-m], log [--oneline|--format=|-p|--stat], show, blame, grep, ls-files, ls-tree
Branches:            branch, switch [-c], checkout [-b], merge, tag, stash
Remotes:             clone, fetch, pull, push, remote
Plumbing:            rev-parse, rev-list, cat-file, for-each-ref, show-ref, config, describe
`;
