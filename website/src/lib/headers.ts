// The rules of public/_headers, read the way Workers static assets apply them
// (developers.cloudflare.com/workers/static-assets/headers/; the asset worker's
// attachCustomHeaders): every rule whose pattern matches the path, in the order of the file; for
// each, the headers it removes ("! Name") first, then those it sets, a header an earlier rule set
// is appended to, joined with a comma. Shared by the tests (the Worker's pages must agree) and by
// scripts/check.mjs (each page's inline scripts and styles against its policy). Reads no file.

export type HeaderRule = { pattern: string; set: [string, string][]; unset: string[] };

/** The rules of a _headers file: a pattern at the start of a line, its headers indented below. */
export function parseHeaders(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  for (const raw of text.split("\n")) {
    if (/^\s*(#|$)/.test(raw)) continue;
    if (!/^\s/.test(raw)) {
      rules.push({ pattern: raw.trim(), set: [], unset: [] });
      continue;
    }
    const rule = rules.at(-1);
    if (!rule) continue;
    const line = raw.trim();
    if (line.startsWith("!")) rule.unset.push(line.slice(1).trim());
    else {
      const colon = line.indexOf(":");
      if (colon > 0) rule.set.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
    }
  }
  return rules;
}

/** A pattern as a regular expression: "*" any characters, ":name" one segment's. */
function matcher(pattern: string): RegExp {
  const source = pattern
    .split(/(\*|:[A-Za-z]\w*)/)
    .map((part) => (part === "*" ? ".*" : /^:[A-Za-z]/.test(part) ? "[^/]+" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${source}$`);
}

/** The headers the rules give a path, by lower-case name. */
export function headersFor(rules: readonly HeaderRule[], path: string): Map<string, string> {
  const out = new Map<string, string>();
  const set = new Set<string>();
  for (const rule of rules) {
    if (!matcher(rule.pattern).test(path)) continue;
    for (const name of rule.unset) out.delete(name.toLowerCase());
    for (const [name, value] of rule.set) {
      const key = name.toLowerCase();
      out.set(key, set.has(key) && out.has(key) ? `${out.get(key)}, ${value}` : value);
      set.add(key);
    }
  }
  return out;
}

/** The headers one rule sets, by their names as written: a block of the file, as the Worker must
 *  give them itself to the pages it renders. */
export function ruleHeaders(rules: readonly HeaderRule[], pattern: string): Record<string, string> {
  return Object.fromEntries(rules.find((r) => r.pattern === pattern)?.set ?? []);
}

/** Whether an inline script's or style's SHA-256 (base64) is allowed by a policy's directive
 *  (`script-src`, `style-src`, else `default-src`). */
export function allowsHash(policy: string, directive: "script-src" | "style-src", hash: string): boolean {
  const directives = new Map(
    policy.split(";").map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map((d) => [d[0].toLowerCase(), d.slice(1)] as const),
  );
  const sources = directives.get(directive) ?? directives.get("default-src");
  if (!sources) return true;
  return sources.includes("'unsafe-inline'") && !sources.some((s) => s.startsWith("'sha") || s.startsWith("'nonce"))
    ? true
    : sources.includes(`'sha256-${hash}'`);
}
