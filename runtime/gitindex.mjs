// The git index (.git/index, versions 2 and 3) read and written directly:
// lg2 can add paths but cannot remove or reset single entries, which `git
// rm`, `git reset -- path`, `restore --staged` and `commit -a` all need.
// Extensions (the tree cache and friends) are dropped on write; git and
// libgit2 rebuild them.
import { zlibSync } from "../vendor/fflate/fflate.mjs";
import { digest } from "./digest.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (text) => Uint8Array.from(text.match(/../g), (h) => Number.parseInt(h, 16));

export function readIndex(bytes) {
  if (!bytes || bytes.length < 12 || decoder.decode(bytes.subarray(0, 4)) !== "DIRC") return { version: 2, entries: [] };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint32(4);
  if (version > 3) throw new Error(`index version ${version} is not supported here`);
  const count = dv.getUint32(8);
  const entries = [];
  let off = 12;
  for (let i = 0; i < count; i++) {
    const start = off;
    const fields = [];
    for (let f = 0; f < 10; f++) fields.push(dv.getUint32(off + f * 4));
    const oid = hex(bytes.subarray(off + 40, off + 60));
    const flags = dv.getUint16(off + 60);
    off += 62;
    let extended = 0;
    if (version >= 3 && flags & 0x4000) {
      extended = dv.getUint16(off);
      off += 2;
    }
    const end = bytes.indexOf(0, off);
    const path = decoder.decode(bytes.subarray(off, end));
    off = end + 1;
    const length = off - start;
    off = start + Math.ceil(length / 8) * 8;
    entries.push({ fields, oid, flags, extended, path, stage: (flags >> 12) & 3 });
  }
  return { version, entries };
}

export function writeIndex(index) {
  const entries = [...index.entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.stage - b.stage));
  const chunks = [];
  const header = new Uint8Array(12);
  const hv = new DataView(header.buffer);
  header.set(encoder.encode("DIRC"));
  const version = entries.some((e) => e.extended) ? 3 : 2;
  hv.setUint32(4, version);
  hv.setUint32(8, entries.length);
  chunks.push(header);
  for (const e of entries) {
    const path = encoder.encode(e.path);
    const extended = version >= 3 && e.extended ? 2 : 0;
    const length = Math.ceil((62 + extended + path.length + 1) / 8) * 8;
    const out = new Uint8Array(length);
    const dv = new DataView(out.buffer);
    e.fields.forEach((v, i) => dv.setUint32(i * 4, v >>> 0));
    out.set(unhex(e.oid), 40);
    const flags = (e.flags & 0xb000) | (extended ? 0x4000 : 0) | (e.stage << 12) | Math.min(path.length, 0xfff);
    dv.setUint16(60, flags);
    if (extended) dv.setUint16(62, e.extended);
    out.set(path, 62 + extended);
    chunks.push(out);
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const body = new Uint8Array(total + 20);
  let off = 0;
  for (const c of chunks) {
    body.set(c, off);
    off += c.length;
  }
  body.set(digest("sha1", body.subarray(0, total)), total);
  return body;
}

/** A fresh entry for a blob; zero stat data makes git re-check the file. */
export function entryFor(path, oid, mode) {
  const fields = [0, 0, 0, 0, 0, 0, mode, 0, 0, 0];
  return { fields, oid, flags: 0, extended: 0, path, stage: 0 };
}

/** Store a blob as a loose object; returns its id. */
export function writeBlob(store, gitDir, content) {
  const header = encoder.encode(`blob ${content.length}\0`);
  const raw = new Uint8Array(header.length + content.length);
  raw.set(header);
  raw.set(content, header.length);
  const oid = hex(digest("sha1", raw));
  const path = `${gitDir}/objects/${oid.slice(0, 2)}/${oid.slice(2)}`;
  if (!store.exists(path)) store.writeFile(path, zlibSync(raw));
  return oid;
}
