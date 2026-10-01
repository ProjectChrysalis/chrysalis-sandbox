const decoder = new TextDecoder();

function patternRegex(pattern) {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      if (++i >= pattern.length) return null;
      source += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (ch === "*") {
      const stars = /^\*+/.exec(pattern.slice(i))[0];
      const next = pattern[i + stars.length];
      if (stars.length > 1 && (i === 0 || pattern[i - 1] === "/") && (next === "/" || next === undefined)) {
        while (pattern[i + 1] === "*") i++;
        if (pattern[i + 1] === "/") {
          source += "(?:[^/]+/)*";
          i++;
        } else source += ".*";
      } else source += "[^/]*";
    } else if (ch === "?") source += "[^/]";
    else if (ch === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end < 0) source += "\\[";
      else {
        source += `(?!/)[${pattern.slice(i + 1, end).replace(/^!/, "^")}]`;
        i = end;
      }
    } else source += ch.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  try {
    return new RegExp(`^${source}$`);
  } catch {
    return null;
  }
}

function rulesFrom(store, abs, source, base) {
  const bytes = store.readFile(abs);
  if (!bytes) return [];
  const rules = [];
  for (const [i, raw] of decoder.decode(bytes).split(/\r?\n/).entries()) {
    // An escaped trailing space belongs to the pattern.
    let pattern = raw;
    while (pattern.endsWith(" ")) {
      let backslashes = 0;
      for (let j = pattern.length - 2; j >= 0 && pattern[j] === "\\"; j--) backslashes++;
      if (backslashes % 2) break;
      pattern = pattern.slice(0, -1);
    }
    if (!pattern || pattern.startsWith("#")) continue;
    const negate = pattern.startsWith("!");
    let glob = negate ? pattern.slice(1) : pattern;
    const dirOnly = glob.endsWith("/");
    if (dirOnly) glob = glob.slice(0, -1);
    const anchored = glob.includes("/");
    glob = glob.replace(/^\//, "");
    const re = patternRegex(glob);
    if (re) rules.push({ source, line: i + 1, pattern, base, negate, dirOnly, anchored, re });
  }
  return rules;
}

/** Last matching rule, including a negation. An excluded directory prevents
 *  its children being re-included by a deeper file or a later child rule. */
export function ignoreMatch(store, repo, path, excludesFile, excludeSource = excludesFile) {
  const rules = excludesFile ? rulesFrom(store, excludesFile, excludeSource, "") : [];
  rules.push(...rulesFrom(store, `${repo.gitDir}/info/exclude`, ".git/info/exclude", ""));
  const parts = path.replace(/\/$/, "").split("/");
  let base = "";
  for (let i = 0; i < parts.length; i++) {
    const source = base ? `${base}/.gitignore` : ".gitignore";
    rules.push(...rulesFrom(store, `${repo.root}/${source}`, source, base));
    const current = parts.slice(0, i + 1).join("/");
    const directory = i < parts.length - 1 || store.isDir(`${repo.root}/${current}`) || path.endsWith("/");
    let match = null;
    for (const rule of rules) {
      if (rule.dirOnly && !directory) continue;
      const relative = rule.base ? current.slice(rule.base.length + 1) : current;
      const target = rule.anchored ? relative : parts[i];
      if (rule.re.test(target)) match = rule;
    }
    if (i === parts.length - 1 || (match && !match.negate)) return match;
    base = current;
  }
  return null;
}
