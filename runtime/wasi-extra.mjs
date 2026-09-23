// WASI calls the busybox build never made but CPython and jq do, plus the
// permission-bit lookup the busybox build links against.
// They sit on the shim's own fd table and store, so positions, dup'd fds and
// unlinked-but-open files behave exactly as they do for fd_read/fd_write.
const E = { SUCCESS: 0, BADF: 8, INVAL: 28, NOTSUP: 58, SPIPE: 70 };
const LINUX_TO_WASI = { ENOENT: 44, EISDIR: 31, ENOTDIR: 54, EEXIST: 20, ENOTEMPTY: 55, EINVAL: 28, EPERM: 63, EACCES: 2, ENOSPC: 51 };
const errnoOf = (error) => LINUX_TO_WASI[error && error.code] ?? 29;

export function completeImports(shim, imports) {
  const w = shim;
  const p1 = (imports.wasi_snapshot_preview1 ??= {});
  const fileFd = (fd) => {
    const f = w.fds.get(fd);
    if (!f) return { errno: E.BADF };
    if (f.type !== "file" || f.device) return { errno: E.SPIPE };
    return { f };
  };
  const at = (fd, offset, fn) => {
    const { f, errno } = fileFd(fd);
    if (!f) return errno;
    const cell = w.pos(f);
    const saved = cell.v;
    const append = f.append;
    cell.v = Number(offset);
    f.append = false;
    try {
      return fn();
    } finally {
      cell.v = saved;
      f.append = append;
    }
  };

  p1.clock_res_get ??= (_id, out) => {
    w.dv().setBigUint64(out, 1000n, true);
    return E.SUCCESS;
  };
  p1.fd_advise ??= () => E.SUCCESS;
  p1.fd_allocate ??= () => E.SUCCESS;
  p1.fd_sync ??= () => E.SUCCESS;
  p1.fd_datasync ??= () => E.SUCCESS;
  p1.fd_tell ??= (fd, out) => {
    const f = w.fds.get(fd);
    if (!f) return E.BADF;
    if (f.type !== "file") return E.SPIPE;
    w.dv().setBigUint64(out, BigInt(w.pos(f).v), true);
    return E.SUCCESS;
  };
  p1.fd_pread ??= (fd, iovs, n, offset, out) =>
    at(fd, offset, () => {
      const bufs = w.iovecs(iovs, n);
      const { data, errno } = w.readFd(fd, bufs.reduce((a, b) => a + b.length, 0), false);
      let o = 0;
      for (const b of bufs) {
        const take = Math.min(b.length, data.length - o);
        b.set(data.subarray(o, o + take));
        o += take;
        if (o >= data.length) break;
      }
      w.dv().setUint32(out, o, true);
      return errno;
    });
  p1.fd_pwrite ??= (fd, iovs, n, offset, out) =>
    at(fd, offset, () => {
      let total = 0;
      for (const b of w.iovecs(iovs, n)) {
        const errno = w.writeFd(fd, b);
        if (errno) {
          w.dv().setUint32(out, total, true);
          return total ? E.SUCCESS : errno;
        }
        total += b.length;
      }
      w.dv().setUint32(out, total, true);
      return E.SUCCESS;
    });
  p1.fd_filestat_set_size ??= (fd, size) => {
    const { f, errno } = fileFd(fd);
    if (!f) return errno;
    if (f.gone) {
      const next = new Uint8Array(Number(size));
      next.set(f.gone.data.subarray(0, next.length));
      f.gone.data = next;
      return E.SUCCESS;
    }
    try {
      w.store.touchSync(f.path, { size: Number(size) });
    } catch (error) {
      return errnoOf(error);
    }
    return E.SUCCESS;
  };
  p1.fd_filestat_set_times ??= (fd, atim, mtim, flags) => {
    const f = w.fds.get(fd);
    if (!f) return E.BADF;
    if (f.path === undefined || f.gone || f.device) return E.SUCCESS;
    const now = Date.now();
    const meta = {};
    if (flags & 1) meta.atimeMs = Number(atim) / 1e6;
    if (flags & 2) meta.atimeMs = now;
    if (flags & 4) meta.mtimeMs = Number(mtim) / 1e6;
    if (flags & 8) meta.mtimeMs = now;
    try {
      w.store.touchSync(f.path, meta);
    } catch (error) {
      return errnoOf(error);
    }
    return E.SUCCESS;
  };
  p1.fd_renumber ??= (from, to) => {
    const f = w.fds.get(from);
    if (!f) return E.BADF;
    w.fds.set(to, f);
    w.fds.delete(from);
    return E.SUCCESS;
  };
  // A readdir result shorter than the buffer means "end of directory" to
  // wasi-libc, so the buffer must be filled to the last byte, the final entry
  // cut short, whenever more entries follow. Stopping before an entry that
  // does not fit made every directory past ~70 names end early for ls, find,
  // rm -r and Python alike.
  p1.fd_readdir = (fd, buf, len, cookie, out) => {
    const f = w.fds.get(fd);
    if (!f || f.type !== "dir") return E.BADF;
    // The listing is taken once per pass (cookie 0) and kept on the open
    // directory: `rm -r` deletes between calls, and re-listing would shift
    // every later entry under the cookie and skip it.
    if (cookie === 0n || !f.listing) {
      try {
        f.listing = w.readdirAt(f.path);
      } catch (error) {
        return errnoOf(error);
      }
    }
    const names = f.listing;
    const encoder = new TextEncoder();
    const bytes = w.bytes();
    const view = w.dv();
    let used = 0;
    for (let index = Number(cookie); index < names.length && used < len; index++) {
      const name = encoder.encode(names[index]);
      const child = w.statAt(`${f.path.replace(/\/$/, "")}/${names[index]}`);
      const entry = new Uint8Array(24 + name.length);
      const ev = new DataView(entry.buffer);
      ev.setBigUint64(0, BigInt(index + 1), true);
      ev.setBigUint64(8, BigInt(child ? child.ino : 0), true);
      ev.setUint32(16, name.length, true);
      ev.setUint8(20, child && (child.mode & 0o170000) === 0o040000 ? 3 : 4);
      entry.set(name, 24);
      const take = Math.min(entry.length, len - used);
      bytes.set(entry.subarray(0, take), buf + used);
      used += take;
    }
    view.setUint32(out, used, true);
    return E.SUCCESS;
  };
  // Permission bits for busybox's stat() wrappers (WASI's filestat has none).
  const env = (imports.env ??= {});
  env.__host_mode = (pathPtr, fd) => {
    let path = pathPtr ? w.cstr(pathPtr) : null;
    if (!path || !path.startsWith("/")) {
      const base = w.fds.get(fd)?.path;
      if (base === undefined) return -1;
      path = path ? `${base.replace(/\/$/, "")}/${path}` : base;
    }
    try {
      return w.store.statSync(path).mode & 0o7777;
    } catch {
      return -1;
    }
  };
  // No sockets: the network is reached through curl/wget and Python's
  // urllib, which go through the engine's proxy.
  for (const name of ["sock_accept", "sock_recv", "sock_send", "sock_shutdown"]) p1[name] ??= () => E.NOTSUP;
  return imports;
}
