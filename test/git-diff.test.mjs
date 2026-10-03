import { execFileSync, spawnSync } from "node:child_process";
import { expect, test } from "bun:test";
import { Sandbox } from "./harness.mjs";

const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

test("diff selects files, directories and deleted paths with ordinary git arguments", async () => {
  const sb = new Sandbox({ "a/card.json": "old\n", "a/removed": "gone\n", "other": "original\n" });
  try {
    const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: sb.dir });
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-qm", "base");
    await sb.run("printf 'new\\n' > a/card.json; rm a/removed; printf 'changed\\n' > other");
    const compare = async (args) => {
      const expected = spawnSync("git", args, { cwd: sb.dir, encoding: "utf8" });
      const actual = await sb.run(`git ${args.map(quote).join(" ")}`);
      expect(actual.err).toBe("");
      expect(actual.code, `${args.join(" ")}: ${expected.stderr}`).toBe(expected.status);
      expect(actual.out).toBe(expected.stdout);
    };
    for (const args of [
      ["diff", "a/card.json"],
      ["diff", "--", "a/card.json"],
      ["diff", "-U1", "--", "a/card.json"],
      ["diff", "--numstat", "--", "a/card.json"],
      ["diff", "--name-only", "--", "a"],
      ["diff", "--name-status", "--", "a"],
      ["diff", "--", "a/removed"],
      ["diff", "--exit-code", "--", "a/card.json"],
      ["diff", "--quiet", "--", "a/card.json"],
      ["diff", "--quiet", "--", "missing"],
      ["-C", "a", "diff", "--", "card.json"],
    ]) await compare(args);
    const stat = await sb.run("git diff --stat -- a/card.json");
    expect(stat.code).toBe(0);
    expect(stat.err).toBe("");
    expect(stat.out).toContain("a/card.json");
    expect(stat.out).toContain("1 file changed, 1 insertion(+), 1 deletion(-)");
    expect(stat.out).not.toContain("other");
    git("add", "a/card.json");
    await compare(["diff", "--cached", "--numstat", "--", "a/card.json"]);
    await compare(["diff", "--staged", "--", "a/card.json"]);
    git("commit", "-qm", "changed");
    await compare(["diff", "HEAD~1", "HEAD", "--", "a/card.json"]);
  } finally { sb.close(); }
});
