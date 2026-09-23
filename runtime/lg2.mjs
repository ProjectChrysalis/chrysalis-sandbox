// libgit2's command-line examples (wasm-git's lg2) over the session store.
// The store is mounted into lg2's Emscripten filesystem at /workspace and
// /tmp as a live view, so git reads and writes the same files the shell sees
// with no copying, and stdout/stderr arrive as raw bytes (binary blobs stay
// intact through `git show rev:file > out`). Remote URLs reach the network
// through the engine proxy.
const EMPTY = new Uint8Array(0);
// lg2 never flushes its line-buffered stdout on return, so output without a
// final newline (a blob, a commit message) would surface at the start of the
// NEXT call. After every call a config read in a private repository prints
// this line, which pushes out whatever was pending; it is then cut off.
const FLUSH_DIR = "/.chrysalis-flush";
const FLUSH_MARK = "chrysalis-flush-4c1e";
const FLUSH_BYTES = new TextEncoder().encode(`${FLUSH_MARK}\n`);

let lg = null;

export async function preloadLg2(wasmModule) {
  if (lg) return lg;
  const { default: factory } = await import("../vendor/wasm-git/lg2.js");
  const module = await factory({
    noInitialRun: true,
    instantiateWasm(imports, done) {
      WebAssembly.instantiate(wasmModule, imports).then((instance) => done(instance));
      return {};
    },
    stdout: (byte) => lg?.__sink.out(byte),
    stderr: (byte) => lg?.__sink.err(byte),
    print: () => {},
    printErr: () => {},
  });
  module.__sink = { out() {}, err() {} };
  const FS = module.FS;
  // libgit2 reads its global config from HOME, which lg2 leaves at the
  // Emscripten default.
  const gitconfig = "[user]\n\tname = Chrysalis\n\temail = sandbox@chrysalis.local\n[init]\n\tdefaultBranch = main\n";
  for (const home of ["/home/web_user", "/root"]) {
    FS.mkdirTree(home);
    FS.writeFile(`${home}/.gitconfig`, gitconfig);
  }
  FS.mkdirTree("/workspace");
  FS.mkdirTree(FLUSH_DIR);
  FS.chdir(FLUSH_DIR);
  module.callMain(["init", "."]);
  module.callMain(["config", "user.name", FLUSH_MARK]);
  FS.chdir("/");
  lg = module;
  return lg;
}

const ERRNO = { ENOENT: 44, EEXIST: 20, ENOTEMPTY: 55, EISDIR: 31, ENOTDIR: 54, EINVAL: 28, EPERM: 63, EBUSY: 10, EACCES: 2 };

function storeFs(FS, store) {
  const fail = (error) => {
    if (error instanceof FS.ErrnoError) throw error;
    throw new FS.ErrnoError(ERRNO[error && error.code] ?? 29);
  };
  const guard = (fn) => {
    try {
      return fn();
    } catch (error) {
      return fail(error);
    }
  };
  const child = (parent, name) => `${FS.getPath(parent).replace(/\/$/, "")}/${name}`;
  const u8 = (buffer, offset, length) => new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
  const ops = {
    mount() {
      return ops.createNode(null, "/", 0o40777);
    },
    createNode(parent, name, mode) {
      const node = FS.createNode(parent, name, mode, 0);
      node.node_ops = ops.node_ops;
      node.stream_ops = ops.stream_ops;
      return node;
    },
    node_ops: {
      getattr(node) {
        const st = guard(() => store.statSync(FS.getPath(node)));
        const dir = (st.mode & 0o170000) === 0o040000;
        return {
          dev: 7,
          ino: st.ino,
          mode: st.mode,
          nlink: st.nlink,
          uid: 0,
          gid: 0,
          rdev: 0,
          size: dir ? 4096 : st.size,
          atime: new Date(st.atimeMs),
          mtime: new Date(st.mtimeMs),
          ctime: new Date(st.ctimeMs),
          blksize: 4096,
          blocks: Math.ceil(st.size / 4096),
        };
      },
      setattr(node, attr) {
        const meta = {};
        if (attr.mode != null) meta.mode = attr.mode;
        if (attr.size !== undefined) meta.size = attr.size;
        if (attr.mtime != null) meta.mtimeMs = +attr.mtime;
        if (attr.atime != null) meta.atimeMs = +attr.atime;
        guard(() => store.touchSync(FS.getPath(node), meta));
      },
      lookup(parent, name) {
        const st = guard(() => store.statSync(child(parent, name)));
        return ops.createNode(parent, name, st.mode);
      },
      mknod(parent, name, mode) {
        const path = child(parent, name);
        if (FS.isDir(mode)) guard(() => store.mkdirSync(path, { mode: mode & 0o7777 }));
        else if (FS.isFile(mode)) guard(() => store.createFileSync(path, { mode: mode & 0o7777 }));
        else throw new FS.ErrnoError(ERRNO.EPERM);
        return ops.createNode(parent, name, mode);
      },
      rename(oldNode, newDir, newName) {
        try {
          FS.hashRemoveNode(FS.lookupNode(newDir, newName));
        } catch {
          // nothing there yet
        }
        guard(() => store.renameSync(FS.getPath(oldNode), child(newDir, newName)));
        // FS.rename re-hashes the node under node.name once this returns.
        oldNode.name = newName;
      },
      unlink(parent, name) {
        guard(() => store.unlinkSync(child(parent, name)));
      },
      rmdir(parent, name) {
        guard(() => store.rmdirSync(child(parent, name)));
      },
      readdir(node) {
        return [".", "..", ...guard(() => store.readdirSync(FS.getPath(node)))];
      },
      symlink() {
        throw new FS.ErrnoError(ERRNO.EPERM);
      },
      readlink() {
        throw new FS.ErrnoError(ERRNO.EINVAL);
      },
    },
    stream_ops: {
      read(stream, buffer, offset, length, position) {
        const data = store.readFile(FS.getPath(stream.node));
        if (!data) throw new FS.ErrnoError(ERRNO.ENOENT);
        if (position >= data.length) return 0;
        const size = Math.min(data.length - position, length);
        u8(buffer, offset, size).set(data.subarray(position, position + size));
        return size;
      },
      write(stream, buffer, offset, length, position) {
        if (!length) return 0;
        guard(() => store.writeSync(FS.getPath(stream.node), u8(buffer, offset, length).slice(), position));
        return length;
      },
      // libgit2 maps pack files and indexes. The mapping is a copy in lg2's
      // heap (MEMFS's own mmap does the allocating); writes come back
      // through msync.
      mmap(stream, length, position, prot, flags) {
        const data = store.readFile(FS.getPath(stream.node));
        if (!data) throw new FS.ErrnoError(ERRNO.ENOENT);
        return lg.MEMFS.stream_ops.mmap({ node: { mode: stream.node.mode, contents: data, usedBytes: data.length } }, length, position, prot, flags);
      },
      msync(stream, buffer, offset, length) {
        ops.stream_ops.write(stream, buffer, 0, length, offset);
        return 0;
      },
      llseek(stream, offset, whence) {
        let position = offset;
        if (whence === 1) position += stream.position;
        else if (whence === 2 && FS.isFile(stream.node.mode)) position += store.statSync(FS.getPath(stream.node)).size;
        if (position < 0) throw new FS.ErrnoError(ERRNO.EINVAL);
        return position;
      },
    },
  };
  return ops;
}

/** Run lg2 with argv in `cwd`, bytes to `stdout`/`stderr`. */
export function runLg2({ store, net, argv, cwd, stdout, stderr }) {
  const FS = lg.FS;
  // A fresh mount per call: the shell changes the store between git calls,
  // and Emscripten caches nodes by name.
  for (const point of ["/workspace", "/tmp"]) {
    try {
      FS.unmount(point);
    } catch {
      // not mounted yet
    }
    try {
      FS.mkdirTree(point);
    } catch {
      // exists
    }
    store.mkdirp(point);
    FS.mount(storeFs(FS, store), {}, point);
  }
  const outChunks = [];
  const errChunks = [];
  let out = new Uint8Array(4096);
  let outLen = 0;
  let err = new Uint8Array(1024);
  let errLen = 0;
  lg.__sink.out = (byte) => {
    if (outLen === out.length) {
      outChunks.push(out);
      out = new Uint8Array(out.length * 2);
      outLen = 0;
    }
    out[outLen++] = byte & 0xff;
  };
  lg.__sink.err = (byte) => {
    if (errLen === err.length) {
      errChunks.push(err);
      err = new Uint8Array(err.length * 2);
      errLen = 0;
    }
    err[errLen++] = byte & 0xff;
  };
  const connections = new Map();
  let nextConnection = 1;
  Object.assign(lg, {
    emscriptenhttpconnect(url, _buffersize, method = "GET", headers = {}) {
      const id = nextConnection++;
      connections.set(id, { url, method, headers: Object.entries(headers ?? {}), body: [], response: null, offset: 0 });
      return id;
    },
    emscriptenhttpwrite(id, pointer, length) {
      connections.get(id).body.push(lg.HEAPU8.slice(pointer, pointer + length));
    },
    emscriptenhttpread(id, pointer, size) {
      const c = connections.get(id);
      if (!c.response) {
        const body = c.body.length ? concat(c.body) : null;
        const res = net.request({ url: c.url, method: c.method, headers: c.headers, body });
        if (res.error) {
          stderr(new TextEncoder().encode(`git: ${res.error}\n`));
          c.response = EMPTY;
          return 0;
        }
        if (res.status >= 400) {
          stderr(new TextEncoder().encode(`git: ${c.url.replace(/\?.*$/, "")}: HTTP ${res.status}\n`));
          c.response = EMPTY;
          return 0;
        }
        c.response = res.body;
      }
      const n = Math.min(size, c.response.length - c.offset);
      lg.HEAPU8.set(c.response.subarray(c.offset, c.offset + n), pointer);
      c.offset += n;
      return n;
    },
    emscriptenhttpfree(id) {
      connections.delete(id);
    },
  });
  let code = 0;
  try {
    FS.chdir(cwd);
    code = lg.callMain([...argv]);
  } catch (error) {
    if (typeof error === "number") code = error;
    else if (error && typeof error.status === "number") code = error.status;
    else {
      stderr(new TextEncoder().encode(`git: ${(error && error.message) || error}\n`));
      code = 128;
    }
  } finally {
    FS.chdir(FLUSH_DIR);
    try {
      lg.callMain(["config", "user.name"]);
    } catch {
      // the flush is best effort; the output is checked below
    }
    FS.chdir("/");
  }
  outChunks.push(out.subarray(0, outLen));
  errChunks.push(err.subarray(0, errLen));
  let output = concat(outChunks);
  const tail = output.subarray(output.length - FLUSH_BYTES.length);
  if (tail.length === FLUSH_BYTES.length && tail.every((b, i) => b === FLUSH_BYTES[i])) output = output.subarray(0, output.length - FLUSH_BYTES.length);
  stdout(output);
  stderr(concat(errChunks));
  return code;
}

function concat(chunks) {
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
