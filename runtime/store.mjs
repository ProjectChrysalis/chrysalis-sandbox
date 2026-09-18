// In-memory synchronous store for wasi-sh, ZenFS FileSystem shape.
// Path-addressed, no fd state; InodeLike fields are numbers (as the shim expects).
const nowMs = () => Date.now();

const S_IFDIR = 0o40000;
const S_IFREG = 0o100000;

class FsError extends Error {
  constructor(code, path) {
    super(`${code}: ${path}`);
    this.code = code;
    this.errno = { ENOENT: 2, EEXIST: 17, ENOTDIR: 20, EISDIR: 21, EINVAL: 22, ENOTEMPTY: 39, EACCES: 13 }[code];
  }
}

export function createStore() {
  const nodes = new Map(); // path -> { ino, dir?, content?, mode, times }
  let nextIno = 2;
  const norm = (p) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  const node = (path) => {
    const entry = nodes.get(norm(path));
    if (!entry) throw new FsError("ENOENT", path);
    return entry;
  };
  const dirNode = (path) => {
    const entry = node(path);
    if (!entry.dir) throw new FsError("ENOTDIR", path);
    return entry;
  };
  const stamp = (entry) => {
    const t = nowMs();
    entry.atimeMs = t;
    entry.mtimeMs = t;
    entry.ctimeMs = t;
    entry.birthtimeMs = entry.birthtimeMs ?? t;
  };
  const makeDir = (path, mode = 0o755) => {
    const entry = { ino: nextIno++, dir: true, mode: S_IFDIR | (mode & 0o7777), nlink: 2 };
    stamp(entry);
    nodes.set(norm(path), entry);
    return entry;
  };
  const makeFile = (path, content = new Uint8Array(0), mode = 0o644) => {
    const entry = { ino: nextIno++, content, mode: S_IFREG | (mode & 0o7777), nlink: 1 };
    stamp(entry);
    nodes.set(norm(path), entry);
    return entry;
  };
  const ensureParents = (path) => {
    const segments = norm(path).split("/").filter(Boolean);
    let cur = "";
    for (let i = 0; i < segments.length - 1; i++) {
      cur += `/${segments[i]}`;
      if (!nodes.has(cur)) makeDir(cur);
    }
  };
  const inodeLike = (entry) => ({
    ino: entry.ino,
    nlink: entry.nlink ?? (entry.dir ? 2 : 1),
    mode: entry.mode,
    uid: 0,
    gid: 0,
    size: entry.dir ? 0 : entry.content.length,
    atimeMs: entry.atimeMs,
    mtimeMs: entry.mtimeMs,
    ctimeMs: entry.ctimeMs,
    birthtimeMs: entry.birthtimeMs,
  });

  makeDir("/");
  makeDir("/tmp", 0o1777);
  makeDir("/workspace", 0o777);

  return {
    statSync(path) {
      return inodeLike(node(path));
    },
    readdirSync(path) {
      dirNode(path);
      const base = norm(path) === "/" ? "/" : `${norm(path)}/`;
      const names = new Set();
      for (const key of nodes.keys()) {
        if (key !== norm(path) && key.startsWith(base)) {
          const rest = key.slice(base.length).split("/")[0];
          if (rest) names.add(rest);
        }
      }
      return [...names];
    },
    createFileSync(path, options = {}) {
      if (nodes.has(norm(path))) nodes.delete(norm(path));
      ensureParents(path);
      const mode = typeof options === "number" ? options : options?.mode ?? 0o644;
      return inodeLike(makeFile(path, new Uint8Array(0), mode));
    },
    mkdirSync(path, options = {}) {
      ensureParents(path);
      if (nodes.has(norm(path))) throw new FsError("EEXIST", path);
      const mode = typeof options === "number" ? options : options?.mode ?? 0o755;
      return inodeLike(makeDir(path, mode));
    },
    rmdirSync(path) {
      dirNode(path);
      const base = `${norm(path)}/`;
      for (const key of nodes.keys()) if (key.startsWith(base)) throw new FsError("ENOTEMPTY", path);
      nodes.delete(norm(path));
    },
    unlinkSync(path) {
      node(path);
      nodes.delete(norm(path));
    },
    renameSync(from, to) {
      node(from);
      ensureParents(to);
      nodes.set(norm(to), nodes.get(norm(from)));
      nodes.delete(norm(from));
    },
    linkSync(target, link) {
      nodes.set(norm(link), node(target));
    },
    readSync(path, buffer, start = 0, end = Infinity) {
      const entry = node(path);
      if (entry.dir) throw new FsError("EISDIR", path);
      const slice = entry.content.subarray(start, Math.min(end, entry.content.length));
      buffer.set(slice, 0);
      return slice.length;
    },
    writeSync(path, buffer, offset = 0) {
      const entry = node(path);
      if (entry.dir) throw new FsError("EISDIR", path);
      if (offset + buffer.length > entry.content.length) {
        const grown = new Uint8Array(offset + buffer.length);
        grown.set(entry.content);
        entry.content = grown;
      }
      entry.content.set(buffer, offset);
      entry.mtimeMs = nowMs();
      return buffer.length;
    },
    touchSync(path, metadata = {}) {
      const entry = node(path);
      if (metadata.mode !== undefined) entry.mode = (entry.mode & 0o170000) | (metadata.mode & 0o7777);
      if (metadata.mtimeMs !== undefined) entry.mtimeMs = metadata.mtimeMs;
      if (metadata.atimeMs !== undefined) entry.atimeMs = metadata.atimeMs;
      if (metadata.size !== undefined && !entry.dir) {
        const resized = new Uint8Array(metadata.size);
        resized.set(entry.content.subarray(0, metadata.size));
        entry.content = resized;
      }
    },
    syncSync() {},
    snapshot() {
      const out = {};
      for (const [path, entry] of nodes) {
        if (entry.dir) continue;
        out[path] = entry.content.slice();
      }
      return out;
    },
  };
}
