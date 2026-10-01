import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, test } from "bun:test";
import { Sandbox } from "./harness.mjs";

const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const native = (sb, args, input) => spawnSync("git", args, { cwd: sb.dir, encoding: "utf8", input });
const git = (sb, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: sb.dir, encoding: "utf8" }).trim();
const compare = async (sb, args, input) => {
  const expected = native(sb, args, input);
  const command = `git ${args.map(quote).join(" ")}`;
  const actual = await sb.run(input === undefined ? command : `printf %s ${quote(input)} | ${command}`);
  expect(actual.err).toBe("");
  expect(actual.code).toBe(expected.status);
  expect(actual.out).toBe(expected.stdout);
};

describe("git compatibility", () => {
  test("merge-base and ancestry agree on packed, diverged and merged history", async () => {
    const sb = new Sandbox({ "a": "base" });
    try {
      git(sb, "init", "-q", "-b", "main");
      git(sb, "add", "a");
      git(sb, "commit", "-qm", "base");
      const base = git(sb, "rev-parse", "HEAD");
      git(sb, "checkout", "-qb", "side");
      sb.put("side", "side");
      git(sb, "add", "side");
      git(sb, "commit", "-qm", "side");
      git(sb, "checkout", "-q", "main");
      sb.put("main", "main");
      git(sb, "add", "main");
      git(sb, "commit", "-qm", "main");
      git(sb, "gc", "-q");
      for (const args of [["merge-base", "main", "side"], ["merge-base", "--all", "main", "side"], ["merge-base", "--is-ancestor", base, "main"], ["merge-base", "--is-ancestor", "side", "main"], ["merge-base", "--is-ancestor", "main", "main"]]) await compare(sb, args);
      git(sb, "merge", "--no-ff", "-qm", "merge", "side");
      await compare(sb, ["merge-base", "--is-ancestor", "side", "main"]);
      const invalid = await sb.run("git merge-base --is-ancestor missing main");
      expect(invalid.code).toBe(128);
    } finally { sb.close(); }
  });

  test("check-ignore agrees on nested rules, exclusions, negations and tracked files", async () => {
    const sb = new Sandbox({
      ".gitignore": "*.log\n!important.log\n/build/\n!build/keep.txt\ncache/**/temp?.[ch]\n\\#literal\nspace\\ \n/tracked\n",
      "sub/.gitignore": "*.tmp\n!keep.tmp\n",
      "tracked": "tracked",
    });
    try {
      git(sb, "init", "-q", "-b", "main");
      git(sb, "add", "-f", "tracked");
      sb.put(".git/info/exclude", "*.bak\n");
      const paths = ["x.log", "important.log", "build", "build/", "build/keep.txt", "sub/build/keep.txt", "sub/a.tmp", "sub/keep.tmp", "x.bak", "cache/temp1.c", "cache/a/b/temp2.h", "#literal", "space ", "plain", "tracked"];
      await compare(sb, ["check-ignore", "-v", ...paths]);
      await compare(sb, ["check-ignore", ...paths]);
      await compare(sb, ["check-ignore", "--no-index", "-v", "tracked"]);
      await compare(sb, ["check-ignore", "-v", "-n", "plain", "x.log", "tracked"]);
      await compare(sb, ["check-ignore", "--stdin", "-v"], paths.join("\n") + "\n");
      await compare(sb, ["check-ignore", "-q", "plain"]);
      await compare(sb, ["check-ignore", "-q", "x.log"]);
      await compare(sb, ["check-ignore", "-v", "important.log"]);
      await compare(sb, ["check-ignore", "important.log"]);
      await compare(sb, ["check-ignore", "-q", "important.log"]);
      await compare(sb, ["-C", "sub", "check-ignore", "-v", "a.tmp", "keep.tmp", "../x.log"]);
      const expected = native(sb, ["check-ignore", "--stdin", "-v", "-z"], "x.log\0plain\0");
      const actual = await sb.run("printf 'x.log\\0plain\\0' | git check-ignore --stdin -v -z");
      expect(actual.code).toBe(expected.status);
      expect(actual.out).toBe(expected.stdout);
      sb.put("global-ignore", "*.global\n");
      git(sb, "config", "core.excludesFile", "global-ignore");
      await compare(sb, ["check-ignore", "-v", "x.global"]);
    } finally { sb.close(); }
  });

  test("merge-base preserves all best bases in a criss-cross merge", async () => {
    const sb = new Sandbox({ "a": "a" });
    try {
      git(sb, "init", "-q", "-b", "main");
      git(sb, "add", "a");
      git(sb, "commit", "-qm", "root");
      const root = git(sb, "rev-parse", "HEAD");
      const tree = git(sb, "rev-parse", "HEAD^{tree}");
      const commit = (message, ...parents) => git(sb, "commit-tree", tree, "-m", message, ...parents.flatMap((p) => ["-p", p]));
      const a = commit("a", root);
      const b = commit("b", root);
      const left = commit("left", a, b);
      const right = commit("right", b, a);
      const expected = native(sb, ["merge-base", "--all", left, right]);
      const actual = await sb.run(`git merge-base --all ${left} ${right}`);
      expect(actual.code).toBe(0);
      expect(actual.err).toBe("");
      expect(actual.out.trim().split("\n").sort()).toEqual(expected.stdout.trim().split("\n").sort());
      const unrelated = commit("unrelated");
      await compare(sb, ["merge-base", left, unrelated]);
    } finally { sb.close(); }
  });
});

test("Python heredoc edits work from a subdirectory", async () => {
  const sb = new Sandbox({ "a/keep.txt": "old" });
  try {
    const r = await sb.run("cd a && python3 - <<'PY'\nfrom pathlib import Path\nPath('keep.txt').write_text('changed')\nPY\ncat keep.txt");
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    expect(sb.read("a/keep.txt")).toBe("changed");
    expect(r.out).toBe("changed");
  } finally { sb.close(); }
});
