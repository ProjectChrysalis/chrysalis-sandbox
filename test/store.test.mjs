// The session store: the wasi-sh conformance suite (what the shim relies on)
// plus the change tracking the engine sync is built on.
import { describe, expect, it } from "bun:test";
import { conformanceCases } from "../vendor/wasi-sh/src/fs-conformance.mjs";
import { Store } from "../runtime/store.mjs";

const bytes = (s) => new TextEncoder().encode(s);
const text = (b) => new TextDecoder().decode(b);

describe("conformance", () => {
  for (const c of conformanceCases()) {
    it(c.name, () => {
      const store = new Store();
      c.run(store, "/case");
    });
  }
});

describe("change tracking", () => {
  it("reports writes and deletes under tracked roots only", () => {
    const store = new Store();
    store.quietly(() => store.writeFile("/workspace/keep.txt", bytes("k")));
    store.writeFile("/workspace/a/b.txt", bytes("b"));
    store.writeFile("/elsewhere.txt", bytes("x"));
    store.unlinkSync("/workspace/keep.txt");
    const { writes, deletes } = store.takeChanges();
    expect([...writes.keys()]).toEqual(["/workspace/a/b.txt"]);
    expect(deletes).toEqual(["/workspace/keep.txt"]);
    expect(store.takeChanges().writes.size).toBe(0);
  });

  it("a directory rename moves every file under it", () => {
    const store = new Store();
    store.quietly(() => {
      store.writeFile("/workspace/d/one.txt", bytes("1"));
      store.writeFile("/workspace/d/e/two.txt", bytes("2"));
    });
    store.renameSync("/workspace/d", "/workspace/z");
    expect(store.isDir("/workspace/d")).toBe(false);
    expect(text(store.readFile("/workspace/z/e/two.txt"))).toBe("2");
    const { writes, deletes } = store.takeChanges();
    expect([...writes.keys()].sort()).toEqual(["/workspace/z/e/two.txt", "/workspace/z/one.txt"]);
    expect(deletes.sort()).toEqual(["/workspace/d/e/two.txt", "/workspace/d/one.txt"]);
  });

  it("appends grow geometrically and read back exactly", () => {
    const store = new Store();
    store.createFileSync("/tmp/log", { mode: 0o644, uid: 0, gid: 0 });
    let expected = "";
    for (let i = 0; i < 2000; i++) {
      const line = `line ${i}\n`;
      store.writeSync("/tmp/log", bytes(line), expected.length);
      expected += line;
    }
    expect(text(store.readFile("/tmp/log"))).toBe(expected);
    store.touchSync("/tmp/log", { size: 5 });
    expect(text(store.readFile("/tmp/log"))).toBe("line ");
    store.touchSync("/tmp/log", { size: 7 });
    expect([...store.readFile("/tmp/log").subarray(5)]).toEqual([0, 0]);
  });

  it("borrowed buffers are never written through", () => {
    const store = new Store();
    const mine = bytes("abc");
    store.writeFile("/workspace/f", mine, { borrow: true });
    store.writeSync("/workspace/f", bytes("X"), 0);
    expect(text(mine)).toBe("abc");
    expect(text(store.readFile("/workspace/f"))).toBe("Xbc");
  });

  it("walk lists files in sorted order", () => {
    const store = new Store();
    for (const p of ["b/2", "a/1", "a/c/3", "z"]) store.writeFile(`/workspace/${p}`, bytes(p));
    expect([...store.walk("/workspace")]).toEqual(["/workspace/z", "/workspace/a/1", "/workspace/a/c/3", "/workspace/b/2"]);
  });
});
