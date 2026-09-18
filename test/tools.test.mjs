// Tool-level tests: every host builtin runs against a real store with a fake
// shell context. The browser path is covered by the engine's end-to-end runs;
// this suite is the fast net for filters, archivers and file tools.
import { describe, expect, it } from "bun:test";
import { createStore } from "../runtime/store.mjs";
import { makeExtraTools } from "../runtime/tools.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function makeCtx(argv, options = {}) {
  const out = [];
  const err = [];
  return {
    ctx: {
      argv: [argv[0], ...argv.slice(1)],
      cwd: options.cwd ?? "/workspace",
      stdout: (text) => out.push(typeof text === "string" ? text : decoder.decode(text)),
      stderr: (text) => err.push(typeof text === "string" ? text : decoder.decode(text)),
      stdin: () => encoder.encode(options.stdin ?? ""),
      env: {},
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

function fixture() {
  const store = createStore();
  const write = (path, content) => {
    const bytes = typeof content === "string" ? encoder.encode(content) : content;
    store.createFileSync(path, 0o644);
    store.writeSync(path, bytes, 0);
    store.touchSync(path, { size: bytes.length });
  };
  write("/workspace/doc.json", '{"a":1,"b":[{"x":2},{"x":3}],"s":"hi there","n":2.7}');
  write("/workspace/existing.txt", "line one\nline two\n");
  write("/workspace/modified.txt", "after\n");
  const tools = makeExtraTools({ store, nested: undefined, net: undefined });
  const run = (name, args, options) => {
    const { ctx, out, err } = makeCtx([name, ...args], options);
    const code = tools[name](ctx);
    return { code, out: out(), err: err() };
  };
  return { store, write, tools, run, read: (path) => decoder.decode(store.snapshot()[path] ?? new Uint8Array()) };
}

describe("jq", () => {
  const jq = (filter, options = {}) => {
    const f = fixture();
    const m = /^(-[rc]+ )+(.*)$/.exec(filter);
    const flags = m ? m[1].trim().split(" ") : [];
    const expr = m ? m[2] : filter;
    return { ...f.run("jq", [...flags, expr, "/workspace/doc.json"], options), f };
  };

  it("arithmetic, comparisons and logic", () => {
    expect(jq(".a+1").out).toBe("2\n");
    expect(jq(".a * 10 - 5").out).toBe("5\n");
    expect(jq(".a == 1").out).toBe("true\n");
    expect(jq(".a != 1 or .s == \"hi there\"").out).toBe("true\n");
  });

  it("streams, pipes and select", () => {
    expect(jq("-r .b[] | .x").out).toBe("2\n3\n");
    expect(jq("-c [.b[] | select(.x > 2) | .x]").out).toBe("[3]\n");
    expect(jq("-c .b | map(.x + 1)").out).toBe("[3,4]\n");
    expect(jq("-c .b | map(.x) | add").out).toBe("5\n");
  });

  it("array and object construction", () => {
    expect(jq("-c {n: .a, xs: [.b[].x]}").out).toBe('{"n":1,"xs":[2,3]}\n');
    expect(jq("-c [.b[].x, .a]").out).toBe("[2,3,1]\n");
  });

  it("keys, length, type, tostring, tonumber", () => {
    expect(jq("-c keys").out).toBe('["a","b","n","s"]\n');
    expect(jq(".b | length").out).toBe("2\n");
    expect(jq(".a | type").out).toBe('"number"\n');
    expect(jq(".a | tostring").out).toBe('"1"\n');
    expect(jq(".s | length").out).toBe("8\n");
    expect(jq('-c .a | tojson | fromjson').out).toBe("1\n");
  });

  it("string helpers and formats", () => {
    expect(jq("-c .s | split(\" \")").out).toBe('["hi","there"]\n');
    expect(jq("-r .s | @base64").out).toBe("aGkgdGhlcmU=\n");
    expect(jq("-r .s | @base64 | @base64d").out).toBe("hi there\n");
    expect(jq("-r .s | @tsv").out).toBe("hi there\n");
    expect(jq("-c [(.n | floor), (.n | ceil)]").out).toBe("[2,3]\n");
    expect(jq("-c .nope[0]?").out).toBe("null\n");
  });

  it("-r and -c", () => {
    expect(jq("-r .s").out).toBe("hi there\n");
    expect(jq("-c .b").out).toBe('[{"x":2},{"x":3}]\n');
  });

  it("missing paths and //", () => {
    expect(jq('-r .nope // "fallback"').out).toBe("fallback\n");
    expect(jq("-c .nope[0]?").code).toBe(0);
  });

  it("reports unsupported filters instead of guessing", () => {
    const bad = jq(".a +");
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("unsupported filter");
  });

  it("invalid JSON input fails", () => {
    const f = fixture();
    const res = f.run("jq", [".", "/workspace/existing.txt"]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("invalid JSON");
  });
});

describe("archivers", () => {
  it("tar create, list, extract (gz)", () => {
    const f = fixture();
    const created = f.run("tar", ["czf", "/tmp/out.tgz", "-C", "/workspace", "doc.json"]);
    expect(created.code).toBe(0);
    const listed = f.run("tar", ["tzf", "/tmp/out.tgz"]);
    expect(listed.out).toBe("doc.json\n");
    f.run("tar", ["xzf", "/tmp/out.tgz", "-C", "/tmp/extract"]);
    expect(f.read("/tmp/extract/doc.json")).toContain('"a":1');
  });

  it("tar without compression", () => {
    const f = fixture();
    f.run("tar", ["cf", "/tmp/plain.tar", "/workspace/existing.txt"]);
    const listed = f.run("tar", ["tf", "/tmp/plain.tar"]);
    expect(listed.out).toContain("existing.txt");
    f.run("tar", ["xf", "/tmp/plain.tar", "-C", "/tmp/p"]);
    expect(f.read("/tmp/p/existing.txt")).toBe("line one\nline two\n");
  });

  it("gzip, gunzip, zcat", () => {
    const f = fixture();
    expect(f.run("gzip", ["-k", "/workspace/existing.txt"]).code).toBe(0);
    expect(f.run("gunzip", ["-c", "/workspace/existing.txt.gz"]).out).toBe("line one\nline two\n");
    expect(f.run("zcat", ["/workspace/existing.txt.gz"]).out).toBe("line one\nline two\n");
  });

  it("zip and unzip", () => {
    const f = fixture();
    expect(f.run("zip", ["/tmp/a.zip", "/workspace/doc.json"]).code).toBe(0);
    expect(f.run("unzip", ["/tmp/a.zip", "/tmp/unz"]).code).toBe(0);
    expect(f.read("/tmp/unz/doc.json")).toContain('"a":1');
  });
});

describe("text tools", () => {
  it("diff shows changes and returns 1", () => {
    const f = fixture();
    f.write("/workspace/other.txt", "line one\nline three\n");
    const res = f.run("diff", ["/workspace/existing.txt", "/workspace/other.txt"]);
    expect(res.code).toBe(1);
    expect(res.out).toContain("-line two");
    expect(res.out).toContain("+line three");
    expect(f.run("diff", ["/workspace/existing.txt", "/workspace/existing.txt"]).code).toBe(0);
  });

  it("cmp", () => {
    const f = fixture();
    f.write("/workspace/a.txt", "abc");
    f.write("/workspace/b.txt", "abd");
    expect(f.run("cmp", ["/workspace/a.txt", "/workspace/b.txt"]).code).toBe(1);
    expect(f.run("cmp", ["/workspace/a.txt", "/workspace/a.txt"]).code).toBe(0);
  });

  it("rg finds, filters and exits 1 on nothing", () => {
    const f = fixture();
    const hit = f.run("rg", ["-n", "line two", "/workspace"]);
    expect(hit.out).toBe("existing.txt:2:line two\n");
    expect(hit.code).toBe(0);
    expect(f.run("rg", ["LINE TWO", "/workspace"]).code).toBe(1);
    expect(f.run("rg", ["-i", "LINE TWO", "/workspace"]).out).toContain("line two");
    expect(f.run("rg", ["--files", "/workspace"]).out).toContain("doc.json");
  });

  it("tree and fd", () => {
    const f = fixture();
    f.write("/workspace/sub/nested.js", "x");
    expect(f.run("tree", ["-L", "1", "/workspace"]).out).toContain("existing.txt");
    expect(f.run("tree", []).out).toContain("existing.txt");
    expect(f.run("fd", ["nested"]).out).toBe("sub/nested.js\n");
    expect(f.run("fd", ["-e", "js"]).out).toBe("sub/nested.js\n");
    expect(f.run("fd", ["-t", "d"]).out).toContain("sub\n");
    expect(f.run("fd", []).out).toContain("doc.json\n");
  });

  it("file and strings", () => {
    const f = fixture();
    expect(f.run("file", ["/workspace/doc.json"]).out).toContain("JSON");
    f.write("/workspace/bin.dat", new Uint8Array([0, 1, 2, 3, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x00]));
    expect(f.run("file", ["/workspace/bin.dat"]).out).toContain("data");
    expect(f.run("strings", ["/workspace/bin.dat"]).out).toBe("hello\n");
  });

  it("base64, tee, ln, readlink, chmod", () => {
    const f = fixture();
    expect(f.run("base64", [], { stdin: "hello" }).out).toBe("aGVsbG8=\n");
    expect(f.run("base64", ["-d"], { stdin: "aGVsbG8=" }).out).toBe("hello");
    const teed = f.run("tee", ["/tmp/tee.txt"], { stdin: "x\ny\n" });
    expect(teed.out).toBe("x\ny\n");
    expect(f.read("/tmp/tee.txt")).toBe("x\ny\n");
    f.run("ln", ["/workspace/existing.txt", "/tmp/link.txt"]);
    expect(f.read("/tmp/link.txt")).toBe("line one\nline two\n");
    expect(f.run("readlink", ["-f", "/tmp/link.txt"]).out).toBe("/tmp/link.txt\n");
    expect(f.run("chmod", ["755", "/workspace/existing.txt"]).code).toBe(0);
    expect(f.store.statSync("/workspace/existing.txt").mode & 0o777).toBe(0o755);
  });

  it("which knows builtins and applets", () => {
    const f = fixture();
    expect(f.run("which", ["jq", "tar"]).out).toBe("/usr/bin/jq\n/usr/bin/tar\n");
    expect(f.run("which", ["nope"]).code).toBe(1);
  });

  it("whoami, id, hostname, df, ps", () => {
    const f = fixture();
    expect(f.run("whoami", []).out).toBe("sandbox\n");
    expect(f.run("id", []).out).toContain("uid=1000");
    expect(f.run("hostname", []).out).toBe("chrysalis-sandbox\n");
    expect(f.run("df", []).out).toContain("/workspace");
    expect(f.run("ps", []).out).toContain("sh");
  });
});
