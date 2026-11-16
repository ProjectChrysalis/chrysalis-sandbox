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
  test("rg reads piped, redirected and explicit stdin, including empty pipes", async () => {
    const r = await sb.run("printf 'alpha\\nbeta\\n' | rg beta; printf 'one\\ntwo\\n' | rg -n two -; printf '' | rg k; printf 'EMPTY=%s\\n' $?; printf '' | sh -c 'rg k'; printf 'NESTED=%s\\n' $?; rg 2 < a/b/two.txt");
    expect(r.err).toBe("");
    expect(r.out).toBe("beta\n2:two\nEMPTY=1\nNESTED=1\n2\n");
  });

  test("sleep waits instead of immediately reporting success", async () => {
    const start = performance.now();
    const r = await sb.run("sleep 1; printf awake");
    expect(r.code).toBe(0);
    expect(r.out).toBe("awake");
    expect(performance.now() - start).toBeGreaterThanOrEqual(900);
  });

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

describe("bash", () => {
  const run = async (command) => {
    const r = await sb.run(command, { timeout: 20_000 });
    return { code: r.code, out: r.out, err: r.err };
  };

  test("process substitution and background jobs run without a fork", async () => {
    expect(await run("diff <(echo a) <(echo b) >/dev/null; echo $?")).toMatchObject({ out: "1\n", err: "" });
    expect(await run("while read l; do echo \"<$l>\"; done < <(printf 'x\\ny\\n')")).toMatchObject({ out: "<x>\n<y>\n" });
    expect(await run("echo hi | tee >(tr a-z A-Z) >/dev/null; sleep 0.1 & wait; echo $?")).toMatchObject({ out: "HI\n0\n", err: "" });
  });

  test("arrays, associative arrays and their expansions", async () => {
    expect((await run('a=(x "y z"); a+=(w); echo ${#a[@]} "${a[1]}" ${a[-1]} ${!a[@]}; printf "<%s>" "${a[@]}"; echo')).out).toBe("3 y z w 0 1 2\n<x><y z><w>\n");
    expect((await run('declare -A m=([k]=v [two words]="x y"); m[n]=1; echo ${#m[@]} "${m[two words]}"; for k in "${!m[@]}"; do echo "$k"; done | sort')).out).toBe("3 x y\nk\nn\ntwo words\n");
    expect((await run('a=(a.txt b.txt); echo "${a[@]%.txt}" "${a[@]/#/p-}" "${a[@]:1}"; e=(); echo "[${e[@]}]" ${#e[@]}')).out).toBe("a b p-a.txt p-b.txt b.txt\n[] 0\n");
    expect((await run("printf 'l1\\nl2\\n' | { mapfile -t L; echo ${#L[@]} ${L[1]}; }; echo 'a b  c' | { read -a w; echo ${w[2]}; }")).out).toBe("2 l2\nc\n");
  });

  test("subshells preserve array elements and restore parent values", async () => {
    expect((await run('declare -A m=([k]="a b"); (m[k]=changed; m[new]=child; echo ${#m[@]}); printf "<%s>\\n" "${!m[@]}" "${m[k]}"')).out).toBe("2\n<k>\n<a b>\n");
    expect((await run('a=([3]=x); b=$(printf "%s" "${!a[@]}"); echo "$b" "${!a[@]}"; (a[3]=y); echo ${a[3]}')).out).toBe("3 3\nx\n");
  });

  test("[[ ]], (( )), C-style for, regex captures and pattern operators", async () => {
    expect((await run('touch fa.txt; [[ foo == f* ]] && echo a; [[ foo == "f*" ]] || echo b; [[ "a b" == a\\ * ]] && echo c; [[ x2 =~ ^x([0-9])$ ]] && echo ${BASH_REMATCH[1]}; rm fa.txt')).out).toBe("a\nb\nc\n2\n");
    expect((await run("for ((i=0; i<3; i++)); do printf $i; done; echo; n=5; ((n+=2)); echo $n $((n*2)); ((0)) || echo zero")).out).toBe("012\n7 14\nzero\n");
    expect((await run("x=Hello; echo ${x^^} ${x,,} ${x/#H/J} ${x/%o/0} ${x:1:3} ${#x}; y=x; echo ${!y}")).out).toBe("HELLO hello Jello Hell0 ell 5\nHello\n");
  });

  test("brace expansion", async () => {
    expect((await run("echo {a,b}{1,2} x{1..3}y {05..07} {a..c} {3..1} {1..9..4} {a,{b,c}}d \"{q,r}\" {}")).out).toBe("a1 a2 b1 b2 x1y x2y x3y 05 06 07 a b c 3 2 1 1 5 9 ad bd cd {q,r} {}\n");
    expect((await run("mkdir -p br/{s,t}/{u,v} && ls -d br/*/* && rm -r br")).out).toBe("br/s/u\nbr/s/v\nbr/t/u\nbr/t/v\n");
    const large = await run("printf '%s' {1..100001}");
    expect(large.code).not.toBe(0);
    expect(large.err).toContain("brace expansion exceeds 100000 words");
  });

  test("unavailable shell options report failure", async () => {
    expect(await run("shopt -s globstar; echo $?; shopt -q globstar; echo $?; shopt -u globstar")).toMatchObject({ code: 0, out: "1\n1\n" });
    expect((await run("shopt -s extglob")).err).toContain("unavailable in this shell");
  });

  test("globbing options affect matches and unmatched patterns", async () => {
    expect(await run('mkdir -p globcheck; touch globcheck/.hidden globcheck/visible; shopt -s dotglob; printf "%s\\n" globcheck/*; rm -r globcheck; shopt -s nullglob; set -- *.no-match-here; echo $#')).toMatchObject({ out: "globcheck/.hidden\nglobcheck/visible\n0\n", err: "" });
    const result = await run("shopt -s nullglob failglob; echo *.no-match-here");
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("no match:");
  });

  test("builtins agents reach for", async () => {
    expect((await run("declare -i n=5; n+=3; declare -l lo=ABC; echo $n $lo; declare -p lo; printf -v pv '%03d' 7; echo $pv; printf '%q\\n' \"a b'c\"")).out).toBe("8 abc\ndeclare -l lo=\"abc\"\n007\na\\ b\\'c\n");
    expect((await run("f(){ local -a v=(p q); echo ${v[1]} ${FUNCNAME[0]}; }; f; shopt -s nullglob; for g in *.none; do echo bad; done; set -o pipefail; false | true; echo $? ${PIPESTATUS[@]}")).out).toBe("q f\n1 1 0\n");
    expect(await run("echo $0 $BASH_VERSINFO; nonexistent-command")).toMatchObject({ out: "bash 5\n", err: "bash: line 1: nonexistent-command: command not found\n" });
    expect((await run("command -v ls cat; t=$SECONDS; echo ${t//[0-9]/}; nproc; mktemp -d | grep -c ^/tmp/")).out).toBe("ls\ncat\n\n1\n1\n");
  });

  test("endless writers into a short reader stop with SIGPIPE status", async () => {
    const r = await run('yes | head -2; echo "${PIPESTATUS[@]}"; while :; do echo y; done | head -1');
    expect(r.out).toBe("y\ny\n141 0\ny\n");
  });

  test("timeout enforces its limit, nohup runs the command", async () => {
    expect(await run("timeout 0.3 sleep 5; echo $?; timeout 0.3 sh -c 'while :; do :; done'; echo $?")).toMatchObject({ out: "124\n124\n" });
    expect(await run("timeout 5 touch to.txt; nohup touch nh.txt; ls to.txt nh.txt; rm to.txt nh.txt")).toMatchObject({ code: 0, out: "nh.txt\nto.txt\n" });
    expect(await run("timeout 0.1 sh -c 'sleep 1; touch late.txt'; echo $?; test ! -e late.txt && echo clean; timeout 1 sh -c 'timeout 5 sleep 3'; echo $?; echo recovered")).toMatchObject({ code: 0, out: "124\nclean\n124\nrecovered\n", err: "" });
  });

  test("time, fd 3, xargs -n1 and relative dates", async () => {
    expect(await run("time true")).toMatchObject({ code: 0, out: "" });
    expect((await run("time true")).err).toMatch(/^\nreal\t0m0\.\d{3}s\n$/);
    expect((await run("exec 3>fd3.txt; echo via3 >&3; exec 3>&-; cat fd3.txt; rm fd3.txt")).out).toBe("via3\n");
    expect((await run("printf 'a\\nb\\n' | xargs -n1 echo; printf 'c\\n' | xargs -P4 -I{} echo x{}")).out).toBe("a\nb\nxc\n");
    const today = (await run("date +%s")).out.trim();
    const dayAgo = (await run("date -d '1 day ago' +%s")).out.trim();
    expect(Number(today) - Number(dayAgo)).toBeGreaterThanOrEqual(86399);
    expect((await run("touch -d yesterday y.txt && [ y.txt -ot keep.txt ] && echo older; rm y.txt")).out).toBe("older\n");
  });

  test("temporary files and directories are unique and private", async () => {
    expect(await run('a=$(mktemp); b=$(mktemp); test "$a" != "$b" && echo unique; stat -c %a "$a"; d=$(mktemp -d); stat -c %a "$d"; f=$(mktemp -p "$d" --suffix=.txt item.XXXXXX); test -f "$f" && echo file; rm "$a" "$b"; rm -r "$d"')).toMatchObject({ code: 0, out: "unique\n600\n700\nfile\n", err: "" });
    expect(await run('p=$(mktemp -u local.XXXXXX); test ! -e "$p" && echo dry; mktemp -q bad; echo $?; mktemp -q -p /missing x.XXXX; echo $?')).toMatchObject({ code: 0, out: "dry\n1\n1\n", err: "" });
  });

  test("resource limits never return uninitialized values or pretend to enforce quotas", async () => {
    expect(await run("ulimit -n")).toMatchObject({ code: 0, out: "unlimited\n", err: "" });
    expect((await run("ulimit -n 512")).code).not.toBe(0);
  });

  test("tables, pagers and unavailable interactive commands", async () => {
    expect(await run("printf 'name count\\na 2\\nlong 3\\n' | column -t")).toMatchObject({ code: 0, out: "name  count\na     2\nlong  3\n", err: "" });
    expect(await run("printf 'é:1\\nabc:2\\n' | column -t -s : -o ' | '")).toMatchObject({ code: 0, out: "é   | 1\nabc | 2\n", err: "" });
    expect(await run("printf 'a\\nb\\nc\\nd\\n' | column -c 6")).toMatchObject({ code: 0, out: "a  c\nb  d\n", err: "" });
    expect(await run("printf 'read me\\n' | less -FRX; more a/one.txt")).toMatchObject({ code: 0, out: "read me\n1\n", err: "" });
    expect((await run("nano keep.txt")).err).toContain("interactive editors are unavailable");
    expect((await run("pgrep bash")).code).toBe(2);
    expect((await run("pkill bash")).err).toContain("no process table");
  });
});

describe("touch, devices and git plumbing", () => {
  test("touch creates, updates and sets times, alone and from children", async () => {
    const t = new Sandbox({ "old.txt": "x\n" });
    try {
      let r = await t.run(": > empty.txt && touch empty.txt old.txt new.txt && ls");
      expect(r.err).toBe("");
      expect(r.out).toBe("empty.txt\nnew.txt\nold.txt\n");
      r = await t.run("touch -t 202001021230 old.txt && touch -r old.txt new.txt && ls -l --full-time new.txt");
      expect(r.out).toContain("2020-01-02 12:30:00");
      r = await t.run("touch -c missing; ls missing 2>&1; touch no/dir/f; echo $?");
      expect(r.out).toContain("No such file");
      expect(r.out.trim().endsWith("1")).toBe(true);
      r = await t.run("echo a b | xargs touch && sh -c 'touch c' && ls a b c");
      expect(r.code).toBe(0);
    } finally { t.close(); }
  });

  test("/dev/urandom and /dev/zero read", async () => {
    const r = await sb.run("head -c 32 /dev/urandom | wc -c; head -c 4 /dev/zero | od -An -tx1");
    expect(r.out.split("\n")[0].trim()).toBe("32");
    expect(r.out).toContain("00 00 00 00");
  });

  test("reflog, symbolic-ref and count-objects answer", async () => {
    const t = new Sandbox({ "f.txt": "1\n" });
    try {
      const g = "git -c user.name=a -c user.email=a@b";
      let r = await t.run(`git init -q && git add -A && ${g} commit -qm one && echo 2 >> f.txt && ${g} commit -qam two && git reflog`);
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/^[0-9a-f]{7} HEAD@\{0\}: commit: two\n[0-9a-f]{7} HEAD@\{1\}: commit \(initial\): one\n$/);
      r = await t.run("git symbolic-ref HEAD; git symbolic-ref --short HEAD; git count-objects -v");
      expect(r.out).toContain("refs/heads/main\nmain\ncount: ");
      expect(r.out).toContain("in-pack: ");
      r = await t.run("git switch -q --detach HEAD && git symbolic-ref -q HEAD; echo $?");
      expect(r.out.trim()).toBe("1");
    } finally { t.close(); }
  });
});
