import { afterAll, beforeAll, expect, test } from "bun:test";
import { Sandbox } from "./harness.mjs";

let sb;
beforeAll(() => { sb = new Sandbox(); });
afterAll(() => sb.close());

for (const size of [4095, 4096, 4097, 8192, 128 * 1024]) {
  test(`quoted heredoc preserves ${size} bytes and later commands`, async () => {
    const body = "x".repeat(size - 1) + "\n";
    const r = await sb.run(`cat > large.txt <<'EOF'\n${body}EOF\nwc -c large.txt; echo after`);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toBe(`${size} large.txt\nafter\n`);
    expect(sb.read("large.txt")).toBe(body);
    expect((await sb.run("wc -c large.txt")).out).toBe(`${size} large.txt\n`);
  });
}

test("expanded heredocs and here strings buffer beyond the pipe boundary", async () => {
  const body = "z".repeat(8192);
  const r = await sb.run(`value=${body}; cat > expanded.txt <<EOF\n$value\nEOF\ncat > string.txt <<< "$value"; echo after`);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  expect(r.out).toBe("after\n");
  expect(sb.read("expanded.txt")).toBe(body + "\n");
  expect(sb.read("string.txt")).toBe(body + "\n");
});

test("large Python heredoc with output redirection and a following reader", async () => {
  const r = await sb.run(`python3 - <<'PY' > /tmp/analysis.txt 2>&1; sed -n '1,55p' /tmp/analysis.txt
${"# script padding\n".repeat(400)}print("analysis complete")
PY`);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  expect(r.out).toBe("analysis complete\n");
});

test("large script in scratch space runs on the next command without chunking", async () => {
  const script = "# padding\n".repeat(600) + 'print("scratch complete")\n';
  const wrote = await sb.run(`cat > /tmp/analysis.py <<'EOF'\n${script}EOF`);
  expect(wrote.err).toBe("");
  expect(wrote.code).toBe(0);
  const r = await sb.run("python3 /tmp/analysis.py 2>&1 | head -60");
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  expect(r.out).toBe("scratch complete\n");
});
