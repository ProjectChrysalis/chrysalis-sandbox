// The session end to end, through the same message protocol the engine
// uses: every case here is a command an agent ran that used to fail.
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Sandbox } from "./harness.mjs";

let sb;
beforeAll(() => {
  sb = new Sandbox({
    "a/one.txt": "1\n",
    "a/b/two.txt": "2\n",
    "keep.txt": "k\n",
    "card.json": JSON.stringify({ name: "Sélène", studio: { variants: [{ id: "v1", content: "hello ✨" }] } }),
    "persona.json": '{"description":"old"}',
  });
});
afterAll(() => sb.close());

describe("files", () => {
  test("mv of a directory moves its files, and syncs as such", async () => {
    await sb.run("mkdir -p m/n && echo x > m/n/f.txt");
    const r = await sb.run("mv m moved && ls -R moved");
    expect(r.code).toBe(0);
    expect(r.writes).toEqual(["moved/n/f.txt"]);
    expect(r.deletes).toEqual(["m/n/f.txt"]);
    expect(sb.read("moved/n/f.txt")).toBe("x\n");
  });

  test("large directories list, find and delete completely", async () => {
    const r = await sb.run("mkdir big && for i in $(seq 1 600); do : > big/file_with_a_long_name_$i.txt; done; ls big | wc -l; find big -type f | wc -l; rm -rf big; ls -d big 2>&1");
    expect(r.out.split("\n").slice(0, 2)).toEqual(["600", "600"]);
    expect(r.out).toContain("No such file");
  });

  test("only changed files come back", async () => {
    const r = await sb.run("cat keep.txt a/one.txt > /dev/null; echo more >> keep.txt");
    expect(r.writes).toEqual(["keep.txt"]);
    expect(sb.read("keep.txt")).toBe("k\nmore\n");
  });

  test("permission bits are real", async () => {
    const r = await sb.run("ls -l keep.txt; chmod +x keep.txt; stat -c %A keep.txt");
    expect(r.out).toContain("-rw-r--r--");
    expect(r.out).toContain("-rwxr-xr-x");
  });
});

describe("shell", () => {
  test("GNU-style options agents type", async () => {
    const r = await sb.run('grep -rn --include="*.txt" 2 .; find . -maxdepth 1 -type d | sort; head -c 3 card.json; echo; ls -R a | head -1; sort -k2 -n <<< "b 2\na 1"');
    expect(r.code).toBe(0);
    expect(r.out).toContain("./a/b/two.txt:1:2");
    expect(r.out).toContain('{"n');
    expect(r.out).toContain("a 1\nb 2");
  });

  test("grep -r with no path searches here and skips binaries", async () => {
    await sb.run("printf 'needle\\0bin' > bin.dat");
    const r = await sb.run("grep -rl needle; rm bin.dat");
    expect(r.out.trim()).toBe("");
  });

  test("child commands: xargs, find -exec, awk system() and pipes, env", async () => {
    const r = await sb.run('find a -name "*.txt" | sort | xargs cat; find a -name one.txt -exec wc -c {} +; echo x | xargs -I{} echo got {}; awk "BEGIN { system(\\"echo sys\\") }"; printf "b\\na\\n" | awk "{ print | \\"sort\\" }"; env FOO=bar sh -c "echo \\$FOO"');
    expect(r.out).toBe("2\n1\n2 a/one.txt\ngot x\nsys\na\nb\nbar\n");
  });

  test('"$@" next to a command substitution keeps its fields', async () => {
    const r = await sb.run('set -- 1 2; echo "x $@ y $(echo z)"');
    expect(r.out).toBe("x 1 2 y z\n");
  });

  test("scripts run by their #! line, from any directory", async () => {
    await sb.run("printf '#!/bin/sh\\necho \"args: $* in $(pwd)\"\\n' > t.sh && chmod +x t.sh");
    const r = await sb.run("./t.sh 1 2; cd a && bash ../t.sh x; sh -c pwd");
    expect(r.out).toBe("args: 1 2 in /workspace\nargs: x in /workspace/a\n/workspace/a\n");
  });
});

describe("python", () => {
  test("json with non-ASCII text, written in place", async () => {
    const r = await sb.run(`python3 -c "
import json
card = json.load(open('card.json'))
p = json.load(open('persona.json'))
p['description'] = card['studio']['variants'][0]['content']
json.dump(p, open('persona.json', 'w'), indent=2, ensure_ascii=False)
"`);
    expect(r.code).toBe(0);
    expect(JSON.parse(sb.read("persona.json")).description).toBe("hello ✨");
  });

  test("scripts, argv, stdin, subprocess and urllib", async () => {
    const r = await sb.run(`cd a && printf 'import sys, subprocess, urllib.request, json\\nprint(sys.argv[1:], sys.stdin.read().strip())\\nprint(subprocess.run(["ls"], capture_output=True, text=True).stdout.split())\\nprint(json.loads(urllib.request.urlopen("https://example.com/x").read())["url"])\\n' > s.py && echo in | python3 s.py p q`);
    expect(r.err).toBe("");
    expect(r.out).toBe("['p', 'q'] in\n['b', 'one.txt', 's.py']\nhttps://example.com/x\n");
  });
});

describe("node", () => {
  test("argv, async code, modules and exit codes", async () => {
    await sb.run(`printf 'export const k = 5;\\n' > m.mjs; printf 'module.exports = (a, b) => a + b;\\n' > add.js`);
    const r = await sb.run(`node -e 'console.log(process.argv.slice(1)); setTimeout(() => console.log(require("./add")(2, 3)), 10); (async () => { await null; console.log("async") })()' arg; echo 'import { k } from "./m.mjs"; console.log(k, import.meta.url)' > e.mjs; node e.mjs; node -e 'process.exit(3)'; echo rc=$?`);
    expect(r.out).toBe("[ 'arg' ]\nasync\n5\n5 file:///workspace/e.mjs\nrc=3\n");
  });
});

describe("jq", () => {
  test("real jq: assignment, --arg, regex", async () => {
    const r = await sb.run(`jq -c '.name |= ascii_upcase | .x = $v' --arg v 1 card.json; jq -r '.studio.variants[] | select(.content | test("hel")) | .id' card.json`);
    expect(r.out).toBe('{"name":"SéLèNE","studio":{"variants":[{"id":"v1","content":"hello ✨"}]},"x":"1"}\nv1\n');
  });
});

describe("git", () => {
  test("the everyday loop", async () => {
    const r = await sb.run('git init -q && git add -A && git commit -qm first && echo changed > keep.txt && git status --short && git commit -qam second && git log --format=%s && git show HEAD~1:keep.txt');
    expect(r.code).toBe(0);
    expect(r.out).toBe(" M keep.txt\nsecond\nfirst\nk\nmore\n");
  });

  test("blobs without a final newline come back whole", async () => {
    const r = await sb.run("git show HEAD:persona.json; echo; git restore --source=HEAD~1 persona.json; wc -c < persona.json; git restore persona.json");
    expect(r.out).toContain('"description": "hello ✨"\n}\n');
    expect(r.out).not.toContain("\n0\n");
  });

  test("nothing to commit is refused, branches switch", async () => {
    const r = await sb.run("git commit -m none; echo rc=$?; git switch -c dev && echo d > d.txt && git add d.txt && git commit -qm dev && git switch main && ls d.txt; git merge dev; ls d.txt");
    expect(r.out).toContain("nothing to commit, working tree clean\nrc=1");
    expect(r.out.trim().endsWith("d.txt")).toBe(true);
  });
});

describe("git on packed history", () => {
  test("log, show and status read a repository whose objects are packed", async () => {
    const packed = new Sandbox({ "a.txt": "one\n" });
    try {
      const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: packed.dir, stdio: "pipe" });
      git("init", "-q", "-b", "main");
      git("add", "-A");
      git("commit", "-qm", "packed one");
      packed.put("a.txt", "two\n");
      git("commit", "-qam", "packed two");
      git("gc", "-q");
      const r = await packed.run("git log --format=%s && git show HEAD~1:a.txt && git status --short && echo three > a.txt && git commit -qam three && git log --oneline | wc -l");
      expect(r.err).toBe("");
      expect(r.out).toBe("packed two\npacked one\none\n3\n");
    } finally {
      packed.close();
    }
  });
});

describe("network", () => {
  test("curl through the proxy", async () => {
    const r = await sb.run('curl -s -H "X-A: 1" -d a=1 https://example.com/p | jq -r ".method, .headers[\\"x-a\\"], .body"; curl -sf https://example.com/?status=404; echo rc=$?');
    expect(r.out).toBe("POST\n1\na=1\nrc=22\n");
  });
});
