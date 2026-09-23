// The session's filesystem: an in-memory tree in the wasi-sh store shape
// (path-addressed, synchronous, Linux errno), shared by the shell, its
// applets, git, python and node for the life of the worker.
//
// Beyond the contract it keeps a dirty set: every file path created, written,
// truncated, renamed or removed under a tracked root since the last
// takeChanges(). That set is what goes back to the engine after a command, so
// a run that touches one file syncs one file.
import { fsError } from "../vendor/wasi-sh/src/fs.mjs";

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const EMPTY = new Uint8Array(0);

const normalize = (path) => {
  const out = [];
  for (const part of String(path).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out;
};
const join = (segments) => `/${segments.join("/")}`;

export class Store {
  constructor({ tracked = ["/workspace", "/tmp"] } = {}) {
    this.nextIno = 2;
    this.root = this.#dir(0o755);
    this.root.ino = 1;
    this.tracked = tracked.map((p) => `${p.replace(/\/+$/, "")}/`);
    this.dirty = new Set();
    this.tracking = true;
    /** Fetches a lazy file's bytes by its source key; set by the session. */
    this.fetchContent = null;
    for (const p of ["/tmp", ...tracked]) this.mkdirp(p);
  }

  // ------------------------------------------------------------- internals
  #times(node) {
    const now = Date.now();
    node.atimeMs = now;
    node.mtimeMs = now;
    node.ctimeMs = now;
    node.birthtimeMs = now;
    return node;
  }
  #dir(mode) {
    return this.#times({ ino: this.nextIno++, mode: S_IFDIR | (mode & 0o7777), nlink: 2, uid: 0, gid: 0, children: new Map() });
  }
  #file(mode, data = EMPTY, size = data.length, owned = false) {
    return this.#times({ ino: this.nextIno++, mode: S_IFREG | (mode & 0o7777), nlink: 1, uid: 0, gid: 0, data, size, owned });
  }
  #lookup(segments) {
    let node = this.root;
    for (const name of segments) {
      if (!node.children) return null;
      node = node.children.get(name);
      if (!node) return null;
    }
    return node;
  }
  #require(path) {
    const node = this.#lookup(normalize(path));
    if (!node) throw fsError("ENOENT", path);
    return node;
  }
  #parent(path) {
    const segments = normalize(path);
    if (!segments.length) throw fsError("EBUSY", path);
    const parent = this.#lookup(segments.slice(0, -1));
    if (!parent) throw fsError("ENOENT", path);
    if (!parent.children) throw fsError("ENOTDIR", path);
    return { parent, name: segments[segments.length - 1], abs: join(segments) };
  }
  #touched(node) {
    const now = Date.now();
    node.mtimeMs = now;
    node.ctimeMs = now;
  }
  #attach(parent, name, node) {
    parent.children.set(name, node);
    if (node.children) parent.nlink++;
    this.#touched(parent);
  }
  #detach(parent, name) {
    const node = parent.children.get(name);
    parent.children.delete(name);
    if (node?.children) parent.nlink--;
    this.#touched(parent);
  }
  #mark(abs) {
    if (!this.tracking) return;
    for (const root of this.tracked) {
      if (abs.startsWith(root)) {
        this.dirty.add(abs);
        return;
      }
    }
  }
  #markTree(abs, node) {
    if (!node.children) return this.#mark(abs);
    for (const [name, child] of node.children) this.#markTree(`${abs}/${name}`, child);
  }
  /** A lazy file's bytes arrive on first use. */
  #load(node) {
    if (!node.lazy) return;
    const bytes = this.fetchContent(node.lazy);
    if (bytes.length !== node.size) node.size = bytes.length;
    node.data = bytes;
    node.owned = false;
    node.lazy = null;
  }
  /** A file about to change in place: borrowed bytes are copied first, and
   *  capacity grows geometrically so appends stay linear. */
  #reserve(node, size) {
    this.#load(node);
    if (node.owned && size <= node.data.length) return;
    const need = Math.max(size, node.size);
    const capacity = need > node.data.length ? Math.max(need, Math.min(node.data.length * 2, need + (64 << 20))) : need;
    const next = new Uint8Array(capacity);
    next.set(node.data.subarray(0, node.size));
    node.data = next;
    node.owned = true;
  }
  #stat(node) {
    return {
      ino: node.ino,
      nlink: node.nlink,
      size: node.children ? 0 : node.size,
      mode: node.mode,
      uid: node.uid,
      gid: node.gid,
      atimeMs: node.atimeMs,
      mtimeMs: node.mtimeMs,
      ctimeMs: node.ctimeMs,
      birthtimeMs: node.birthtimeMs,
    };
  }

  // -------------------------------------------------------------- contract
  statSync(path) {
    return this.#stat(this.#require(path));
  }
  readdirSync(path) {
    const node = this.#require(path);
    if (!node.children) throw fsError("ENOTDIR", path);
    return [...node.children.keys()];
  }
  createFileSync(path, options = {}) {
    const { parent, name, abs } = this.#parent(path);
    if (parent.children.has(name)) throw fsError("EEXIST", path);
    const node = this.#file(options.mode ?? 0o644);
    this.#attach(parent, name, node);
    this.#mark(abs);
    return this.#stat(node);
  }
  mkdirSync(path, options = {}) {
    const { parent, name } = this.#parent(path);
    if (parent.children.has(name)) throw fsError("EEXIST", path);
    const node = this.#dir(options.mode ?? 0o755);
    this.#attach(parent, name, node);
    return this.#stat(node);
  }
  rmdirSync(path) {
    const { parent, name } = this.#parent(path);
    const node = parent.children.get(name);
    if (!node) throw fsError("ENOENT", path);
    if (!node.children) throw fsError("ENOTDIR", path);
    if (node.children.size) throw fsError("ENOTEMPTY", path);
    this.#detach(parent, name);
  }
  unlinkSync(path) {
    const { parent, name, abs } = this.#parent(path);
    const node = parent.children.get(name);
    if (!node) throw fsError("ENOENT", path);
    if (node.children) throw fsError("EISDIR", path);
    node.nlink--;
    this.#detach(parent, name);
    this.#mark(abs);
  }
  renameSync(from, to) {
    const src = this.#parent(from);
    const node = src.parent.children.get(src.name);
    if (!node) throw fsError("ENOENT", from);
    const dst = this.#parent(to);
    if (src.abs === dst.abs) return;
    if (node.children && `${dst.abs}/`.startsWith(`${src.abs}/`)) throw fsError("EINVAL", to);
    const existing = dst.parent.children.get(dst.name);
    if (existing) {
      if (existing.children) {
        if (!node.children) throw fsError("EISDIR", to);
        if (existing.children.size) throw fsError("ENOTEMPTY", to);
      } else if (node.children) throw fsError("ENOTDIR", to);
      existing.nlink--;
      this.#detach(dst.parent, dst.name);
    }
    this.#markTree(src.abs, node);
    this.#detach(src.parent, src.name);
    this.#attach(dst.parent, dst.name, node);
    this.#markTree(dst.abs, node);
    node.ctimeMs = Date.now();
  }
  linkSync(target, link) {
    const node = this.#require(target);
    if (node.children) throw fsError("EPERM", target);
    const { parent, name, abs } = this.#parent(link);
    if (parent.children.has(name)) throw fsError("EEXIST", link);
    node.nlink++;
    this.#attach(parent, name, node);
    this.#mark(abs);
  }
  readSync(path, buffer, start, end) {
    const node = this.#require(path);
    if (node.children) throw fsError("EISDIR", path);
    this.#load(node);
    const from = Math.min(start, node.size);
    const to = Math.min(end, node.size, from + buffer.length);
    buffer.set(node.data.subarray(from, to), 0);
    if (to - from < buffer.length) buffer.fill(0, to - from);
    node.atimeMs = Date.now();
  }
  writeSync(path, buffer, offset) {
    const node = this.#require(path);
    if (node.children) throw fsError("EISDIR", path);
    const end = offset + buffer.length;
    this.#reserve(node, end);
    if (offset > node.size) node.data.fill(0, node.size, offset);
    node.data.set(buffer, offset);
    if (end > node.size) node.size = end;
    this.#touched(node);
    this.#mark(join(normalize(path)));
  }
  touchSync(path, metadata = {}) {
    const node = this.#require(path);
    if (metadata.size !== undefined && !node.children) {
      this.#load(node);
      const size = Number(metadata.size);
      if (size > node.size) {
        this.#reserve(node, size);
        node.data.fill(0, node.size, size);
      }
      node.size = size;
      this.#touched(node);
      this.#mark(join(normalize(path)));
    }
    if (metadata.mode !== undefined) node.mode = (node.mode & S_IFMT) | (metadata.mode & 0o7777);
    if (metadata.uid !== undefined) node.uid = metadata.uid;
    if (metadata.gid !== undefined) node.gid = metadata.gid;
    if (metadata.atimeMs !== undefined) node.atimeMs = metadata.atimeMs;
    if (metadata.mtimeMs !== undefined) node.mtimeMs = metadata.mtimeMs;
    node.ctimeMs = metadata.ctimeMs ?? Date.now();
  }
  syncSync() {}

  // --------------------------------------------------------------- helpers
  exists(path) {
    return this.#lookup(normalize(path)) !== null;
  }
  isDir(path) {
    return Boolean(this.#lookup(normalize(path))?.children);
  }
  isFile(path) {
    const node = this.#lookup(normalize(path));
    return Boolean(node && !node.children);
  }
  /** The file's bytes as a view (no copy), or null. Callers must not keep it
   *  across a write to the same file. */
  readFile(path) {
    const node = this.#lookup(normalize(path));
    if (!node || node.children) return null;
    this.#load(node);
    return node.data.subarray(0, node.size);
  }
  /** Replace a file's contents, creating it and its parents. `borrow` hands
   *  the buffer over without a copy; the store copies before its first write. */
  writeFile(path, bytes, { borrow = false, mode } = {}) {
    const segments = normalize(path);
    this.mkdirp(join(segments.slice(0, -1)));
    const { parent, name, abs } = this.#parent(path);
    const existing = parent.children.get(name);
    if (existing?.children) throw fsError("EISDIR", path);
    const data = borrow ? bytes : bytes.slice();
    if (existing) {
      existing.lazy = null;
      existing.data = data;
      existing.size = data.length;
      existing.owned = !borrow;
      if (mode !== undefined) existing.mode = S_IFREG | (mode & 0o7777);
      this.#touched(existing);
    } else {
      this.#attach(parent, name, this.#file(mode ?? 0o644, data, data.length, !borrow));
    }
    this.#mark(abs);
  }
  /** A file whose bytes load through fetchContent(source) when first read.
   *  Replaces whatever was at the path; never marked dirty. */
  lazy(path, size, mtimeMs, source) {
    const segments = normalize(path);
    this.mkdirp(join(segments.slice(0, -1)));
    const { parent, name } = this.#parent(path);
    const existing = parent.children.get(name);
    if (existing?.children) this.remove(path);
    const node = existing && !existing.children ? existing : this.#file(0o644);
    node.data = EMPTY;
    node.size = size;
    node.owned = false;
    node.lazy = source;
    node.mtimeMs = mtimeMs;
    node.ctimeMs = mtimeMs;
    if (!existing || existing.children) this.#attach(parent, name, node);
  }
  mkdirp(path) {
    let node = this.root;
    const segments = normalize(path);
    for (let i = 0; i < segments.length; i++) {
      let next = node.children.get(segments[i]);
      if (!next) {
        next = this.#dir(0o755);
        this.#attach(node, segments[i], next);
      } else if (!next.children) throw fsError("ENOTDIR", join(segments.slice(0, i + 1)));
      node = next;
    }
  }
  /** rm -rf. Missing paths are fine. */
  remove(path) {
    const segments = normalize(path);
    if (!segments.length) return;
    const parent = this.#lookup(segments.slice(0, -1));
    const name = segments[segments.length - 1];
    const node = parent?.children?.get(name);
    if (!node) return;
    this.#markTree(join(segments), node);
    this.#detach(parent, name);
  }
  /** Every file under `dir` (absolute paths, sorted per directory). */
  *walk(dir, { skipDirs } = {}) {
    const start = this.#lookup(normalize(dir));
    if (!start) return;
    if (!start.children) {
      yield join(normalize(dir));
      return;
    }
    const stack = [[join(normalize(dir)).replace(/^\/$/, ""), start]];
    while (stack.length) {
      const [base, node] = stack.pop();
      const names = [...node.children.keys()].sort().reverse();
      const files = [];
      for (const name of names) {
        const child = node.children.get(name);
        if (child.children) {
          if (!skipDirs?.has(name)) stack.push([`${base}/${name}`, child]);
        } else files.push(`${base}/${name}`);
      }
      yield* files.reverse();
    }
  }
  /** Every directory under `dir`, `dir` excluded. */
  *walkDirs(dir) {
    const start = this.#lookup(normalize(dir));
    if (!start?.children) return;
    const stack = [[join(normalize(dir)).replace(/^\/$/, ""), start]];
    while (stack.length) {
      const [base, node] = stack.pop();
      for (const name of [...node.children.keys()].sort().reverse()) {
        const child = node.children.get(name);
        if (!child.children) continue;
        yield `${base}/${name}`;
        stack.push([`${base}/${name}`, child]);
      }
    }
  }
  totalBytes() {
    let total = 0;
    const visit = (node) => {
      if (node.children) for (const child of node.children.values()) visit(child);
      else total += node.size;
    };
    visit(this.root);
    return total;
  }
  /** Apply writes/deletes without marking them dirty: they came from the
   *  engine, so echoing them back would be noise. */
  quietly(fn) {
    const was = this.tracking;
    this.tracking = false;
    try {
      return fn();
    } finally {
      this.tracking = was;
    }
  }
  /** The dirty set as it stands now: files that exist (with their bytes) and
   *  paths that are gone. Clears the set. */
  takeChanges() {
    const writes = new Map();
    const deletes = [];
    for (const path of this.dirty) {
      const bytes = this.readFile(path);
      if (bytes) writes.set(path, bytes.slice());
      else deletes.push(path);
    }
    this.dirty.clear();
    return { writes, deletes };
  }
}
