// The environment a release carries, read as text and never executed (night phase 07, E6;
// docs/RELEASES.md; D00-11, D07-*): pure functions, no DOM, tested in Node
// (tests/forge-pages/environments.test.ts). The release page's Environment panel and the view
// environment/<ref> (src/scripts/repo-environment.ts) build on it.
//
// What it reads: the files that say how the code runs again — pip's requirements, conda's
// environment.yml, renv.lock, Julia's Project.toml and Manifest.toml, a Dockerfile, a development
// container, pyproject.toml, setup.cfg, R's DESCRIPTION, the lock files (Pipfile.lock, poetry.lock,
// conda-lock, uv.lock, package-lock.json), Binder's runtime.txt and apt.txt. Each is parsed as data;
// the scripts (setup.py, install.R, postBuild, start) are named and never read as code: nothing of
// the repository is built, installed or run, here or anywhere in the registry.
//
// What it says, in words: how many packages are pinned to an exact version, whether a lock file pins
// them all, whether a container's base image is pinned by its digest (a tag can move, a digest cannot),
// what fetches from the network at build, what runs on the machine that opens a development container.
// Then where it can run under the visitor's own account and quota (Binder, a free public service;
// GitHub Codespaces), each link saying who runs it; and the packages the manifests declare, with their
// registry and an install line pinned to the version.
//
// Like every browser script, it never names the platform.

import { maskEmails } from "../../worker/forge/mask.ts";
import { isPackageName, REGISTRIES, REGISTRY_WORDS, type Registry } from "../../worker/forge/service/act-packages.ts";
import { parseYaml } from "./citation.ts";

export type EnvKind =
  | "pip" | "conda" | "renv" | "julia-project" | "julia-manifest" | "docker" | "devcontainer" | "pyproject" | "setupcfg"
  | "r-description" | "lock" | "runtime" | "apt" | "script" | "npm" | "conda-recipe";

export interface EnvFile {
  path: string;
  kind: EnvKind;
}

/** What each kind is, for people. */
export const KIND_WORDS: Readonly<Record<EnvKind, string>> = {
  pip: "pip's requirements",
  conda: "a conda environment",
  renv: "R's renv lock file",
  "julia-project": "a Julia project",
  "julia-manifest": "Julia's manifest (every version pinned)",
  docker: "a container image's recipe (Dockerfile)",
  devcontainer: "a development container",
  pyproject: "a Python project (pyproject.toml)",
  setupcfg: "a Python project (setup.cfg)",
  "r-description": "an R package (DESCRIPTION)",
  lock: "a lock file (every version pinned)",
  runtime: "Binder's runtime (runtime.txt)",
  apt: "system packages (apt.txt)",
  script: "a script",
  npm: "a Node.js package (package.json)",
  "conda-recipe": "a conda recipe (meta.yaml)",
};

/** The folders Binder and the development containers read, besides the root. */
const DIRS = ["", "binder/", ".binder/", ".devcontainer/"];

/** The environment files among a tree's paths, in a stable order. */
export function environmentFiles(paths: readonly string[]): EnvFile[] {
  const out: EnvFile[] = [];
  const add = (path: string, kind: EnvKind) => {
    if (!out.some((f) => f.path === path)) out.push({ path, kind });
  };
  for (const path of paths) {
    const slash = path.lastIndexOf("/");
    const dir = slash < 0 ? "" : path.slice(0, slash + 1);
    const name = path.slice(slash + 1);
    if (!DIRS.includes(dir) && !(dir.startsWith(".devcontainer/") && name === "devcontainer.json") && !(dir === "recipe/" || dir === "conda.recipe/")) continue;
    if (/^requirements([-_.][\w-]+)?\.txt$/i.test(name) || name === "requirements.in") add(path, "pip");
    else if (/^environment\.ya?ml$/i.test(name)) add(path, "conda");
    else if (name === "renv.lock") add(path, "renv");
    else if (name === "Project.toml" || name === "JuliaProject.toml") add(path, "julia-project");
    else if (name === "Manifest.toml" || name === "JuliaManifest.toml") add(path, "julia-manifest");
    else if (/^(Dockerfile|Containerfile)(\.[\w-]+)?$/.test(name)) add(path, "docker");
    else if (name === "devcontainer.json" || name === ".devcontainer.json") add(path, "devcontainer");
    else if (name === "pyproject.toml") add(path, "pyproject");
    else if (name === "setup.cfg") add(path, "setupcfg");
    else if (name === "DESCRIPTION" && dir === "") add(path, "r-description");
    else if (/^(Pipfile\.lock|poetry\.lock|uv\.lock|conda-lock\.ya?ml|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|pdm\.lock)$/.test(name)) add(path, "lock");
    else if (name === "runtime.txt") add(path, "runtime");
    else if (name === "apt.txt") add(path, "apt");
    else if (/^(setup\.py|install\.R|postBuild|start|Makefile)$/.test(name)) add(path, "script");
    else if (name === "package.json" && dir === "") add(path, "npm");
    else if (name === "meta.yaml") add(path, "conda-recipe");
  }
  const order: EnvKind[] = ["conda", "pip", "lock", "renv", "r-description", "julia-project", "julia-manifest", "pyproject", "setupcfg", "npm", "conda-recipe", "docker", "devcontainer", "runtime", "apt", "script"];
  return out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || (a.path < b.path ? -1 : 1));
}

// ─── the readings ────────────────────────────────────────────────────────────

export interface Check {
  words: string;
  tone: "ok" | "warning" | "";
}

export interface Requirement {
  name: string;
  /** "exact", "range", "none", or "source" (installed from a repository or an address). */
  pin: "exact" | "range" | "none" | "source";
  spec: string;
}

export interface EnvReport {
  file: EnvFile;
  /** What the file says, in words. */
  summary: string;
  checks: Check[];
  requirements: Requirement[];
}

const pinWord = (n: number, of: number, what = "package", whats = `${what}s`) => `${n} of the ${of} ${of === 1 ? what : whats}`;

/** Checks on a list of requirements: exact pins, ranges, none. */
function pinChecks(reqs: readonly Requirement[]): Check[] {
  if (!reqs.length) return [];
  const exact = reqs.filter((r) => r.pin === "exact").length;
  const none = reqs.filter((r) => r.pin === "none");
  const source = reqs.filter((r) => r.pin === "source");
  const out: Check[] = [];
  if (exact === reqs.length) out.push({ words: `Every package is pinned to an exact version (${reqs.length}).`, tone: "ok" });
  else out.push({ words: `${pinWord(exact, reqs.length)} pinned to an exact version; the others may resolve to newer versions than the paper's.`, tone: "warning" });
  if (none.length) out.push({ words: `No version at all for ${none.slice(0, 8).map((r) => r.name).join(", ")}${none.length > 8 ? "…" : ""}.`, tone: "warning" });
  if (source.length) out.push({ words: `Installed from a repository or an address, not a published version: ${source.slice(0, 5).map((r) => r.name || r.spec).join(", ")}.`, tone: "warning" });
  return out;
}

/** One line of pip's requirements, or null (a comment, an option). */
export function pipRequirement(line: string): Requirement | null {
  const l = line.replace(/\s+#.*$/, "").trim();
  if (!l || l.startsWith("#")) return null;
  if (/^(-r|--requirement|-c|--constraint|--index-url|--extra-index-url|-i|--find-links|-f|--no-binary|--only-binary|--pre|--trusted-host)\b/.test(l)) return null;
  if (/^(-e|--editable)\s+/.test(l) || /^(git\+|hg\+|svn\+|bzr\+|https?:\/\/|file:)/.test(l) || / @ /.test(l)) {
    const name = /#egg=([\w.-]+)/.exec(l)?.[1] ?? /^([\w.-]+)\s*@/.exec(l)?.[1] ?? "";
    return { name, pin: "source", spec: l.slice(0, 200) };
  }
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$/.exec(l.split(";")[0].replace(/\s*--hash=\S+/g, "").trim());
  if (!m) return null;
  const spec = m[3].trim();
  const pin = /^===?\s*[\w.!+-]+$/.test(spec) && !spec.includes("*") ? "exact" : spec ? "range" : "none";
  return { name: m[1], pin, spec };
}

export function readRequirements(text: string): { reqs: Requirement[]; hashes: boolean; includes: string[] } {
  const reqs: Requirement[] = [];
  const includes: string[] = [];
  let hashes = false;
  // Continuation lines ("\") joined first, as pip does.
  for (const raw of text.replace(/\\\r?\n/g, " ").split(/\r?\n/).slice(0, 5_000)) {
    if (/--hash=/.test(raw)) hashes = true;
    const inc = /^\s*(-r|--requirement|-c|--constraint)\s+(\S+)/.exec(raw);
    if (inc) includes.push(inc[2]);
    const r = pipRequirement(raw);
    if (r) reqs.push(r);
  }
  return { reqs, hashes, includes };
}

/** A conda dependency ("numpy=1.26.4", "scipy>=1.11", "python=3.11"). */
function condaRequirement(s: string): Requirement {
  const m = /^([A-Za-z0-9_.-]+(?:::[A-Za-z0-9_.-]+)?)\s*(.*)$/.exec(s.trim());
  const name = (m?.[1] ?? s).replace(/^.*::/, "");
  const spec = (m?.[2] ?? "").trim();
  // conda: "=1.26.4" or "==1.26.4" (and a build string after a second "=") is one version.
  const pin = /^={1,2}\s*\d[\w.+!]*(=[\w.*]+)?$/.test(spec) && !/\*$/.test(spec.split("=").filter(Boolean)[0] ?? "") ? "exact" : spec ? "range" : "none";
  return { name, pin, spec };
}

/** A small TOML reader: [tables], key = "string" | number | true | [array of strings] (possibly on
 *  several lines). What manifests need; anything else is skipped. */
export function parseToml(text: string): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = { "": {} };
  let table = "";
  const lines = text.replace(/\r\n?/g, "\n").split("\n").slice(0, 5_000);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/^\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const t = /^\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
    if (t) {
      table = t[1].replace(/"/g, "");
      out[table] ??= {};
      continue;
    }
    const kv = /^("[^"]+"|'[^']+'|[A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].replace(/^["']|["']$/g, "");
    let value = kv[2].trim();
    if (value.startsWith("[") && !balanced(value)) {
      while (i + 1 < lines.length && !balanced(value)) value += ` ${lines[++i].trim()}`;
    }
    out[table][key] = tomlValue(value);
  }
  return out;
}

function balanced(v: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (const ch of v.replace(/#[^"'\]]*$/, "")) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[") depth++;
    else if (ch === "]") depth--;
  }
  return depth <= 0;
}

function tomlValue(v: string): unknown {
  const s = v.replace(/\s+#[^"']*$/, "").trim();
  if (/^"""/.test(s) || /^'''/.test(s)) return s.slice(3).replace(/("""|''')$/, "");
  if (/^".*"$/.test(s)) return s.slice(1, -1).replace(/\\"/g, '"');
  if (/^'.*'$/.test(s)) return s.slice(1, -1);
  if (s === "true" || s === "false") return s === "true";
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith("[")) return [...s.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
  if (s.startsWith("{")) return s;
  return s;
}

/** An R DESCRIPTION (Debian control format): fields, continuation lines joined. */
export function parseDcf(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let key = "";
  for (const line of text.replace(/\r\n?/g, "\n").split("\n").slice(0, 2_000)) {
    const m = /^([A-Za-z][\w.@/-]*):\s*(.*)$/.exec(line);
    if (m) {
      key = m[1];
      out[key] = m[2].trim();
    } else if (key && /^\s+/.test(line)) out[key] = `${out[key]} ${line.trim()}`.trim();
  }
  return out;
}

/** R's "pkg (>= 1.0), other" as requirements. */
function rRequirements(field: string | undefined): Requirement[] {
  if (!field) return [];
  return field
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const m = /^([A-Za-z][\w.]*)\s*(?:\(([^)]*)\))?/.exec(x);
      const spec = (m?.[2] ?? "").trim();
      return { name: m?.[1] ?? x, pin: /^==\s*\S+$/.test(spec) ? "exact" : spec ? "range" : "none", spec } as Requirement;
    })
    .filter((r) => r.name !== "R");
}

/** JSON with comments and trailing commas (a devcontainer.json), or null. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let quote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === '"') quote = false;
      continue;
    }
    if (ch === '"') {
      quote = true;
      out += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += ch;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return null;
  }
}

/** A container image's reference: pinned by its digest, by a tag, or not at all. */
export function imagePin(ref: string): { image: string; pin: "digest" | "tag" | "latest" } {
  const image = ref.trim();
  if (/@sha256:[0-9a-f]{64}$/.test(image)) return { image, pin: "digest" };
  const last = image.split("/").pop() ?? image;
  const tag = last.includes(":") ? last.slice(last.indexOf(":") + 1) : "";
  return { image, pin: !tag || tag === "latest" ? "latest" : "tag" };
}

const imageCheck = (image: string, where: string): Check => {
  const p = imagePin(image);
  if (p.pin === "digest") return { words: `${where} is pinned by its digest: the same image, always.`, tone: "ok" };
  if (p.pin === "tag") return { words: `${where} (${image}) is named by a tag, which can move: its digest (…@sha256:…) would name the same image always.`, tone: "warning" };
  return { words: `${where} (${image}) has no version (“latest” is whatever it is on the day it is pulled).`, tone: "warning" };
};

/** What a file says, read as text: never executed. */
export function readEnvironment(file: EnvFile, textIn: string): EnvReport {
  const text = maskEmails(textIn.slice(0, 512 * 1024));
  const report: EnvReport = { file, summary: KIND_WORDS[file.kind], checks: [], requirements: [] };
  switch (file.kind) {
    case "pip": {
      const r = readRequirements(text);
      report.requirements = r.reqs;
      report.summary = `pip's requirements: ${r.reqs.length} ${r.reqs.length === 1 ? "package" : "packages"}`;
      report.checks = pinChecks(r.reqs);
      if (r.hashes) report.checks.push({ words: "Hashes are given: pip installs exactly these files.", tone: "ok" });
      if (r.includes.length) report.checks.push({ words: `It includes ${r.includes.join(", ")}: read that file too.`, tone: "" });
      break;
    }
    case "conda": {
      let doc: unknown = null;
      try {
        doc = parseYaml(text);
      } catch {
        doc = null;
      }
      const o = doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>) : {};
      const deps = Array.isArray(o.dependencies) ? o.dependencies : [];
      const conda = deps.filter((d): d is string => typeof d === "string").map(condaRequirement);
      const pipList = deps.find((d) => d && typeof d === "object" && Array.isArray((d as Record<string, unknown>).pip)) as { pip: unknown[] } | undefined;
      const pip = (pipList?.pip ?? []).filter((d): d is string => typeof d === "string").map(pipRequirement).filter((r): r is Requirement => r !== null);
      const all = [...conda.filter((r) => r.name !== "pip"), ...pip];
      report.requirements = all;
      const channels = Array.isArray(o.channels) ? o.channels.filter((c): c is string => typeof c === "string") : [];
      const python = conda.find((r) => r.name === "python");
      report.summary = `a conda environment${typeof o.name === "string" ? ` (${o.name})` : ""}: ${conda.length} conda ${conda.length === 1 ? "package" : "packages"}${pip.length ? ` and ${pip.length} from pip` : ""}${channels.length ? `, from ${channels.join(", ")}` : ""}`;
      report.checks = pinChecks(all);
      if (python) report.checks.unshift({ words: python.spec ? `Python ${python.spec.replace(/^=+/, "")}.` : "Python, of no given version.", tone: python.spec ? "" : "warning" });
      if (channels.includes("defaults") || !channels.length) report.checks.push({ words: "Anaconda's default channel is used: its terms of service apply to some organizations; conda-forge's do not.", tone: "" });
      break;
    }
    case "renv": {
      let lock: Record<string, unknown> | null = null;
      try {
        lock = JSON.parse(text) as Record<string, unknown>;
      } catch {
        lock = null;
      }
      const pkgs = lock && typeof lock.Packages === "object" && lock.Packages ? Object.values(lock.Packages as Record<string, Record<string, unknown>>) : [];
      const r = (lock?.R as Record<string, unknown> | undefined)?.Version;
      report.requirements = pkgs.map((p) => ({ name: String(p.Package ?? ""), pin: "exact", spec: String(p.Version ?? "") }));
      report.summary = `R's renv lock file: R ${typeof r === "string" ? r : "of no given version"}, ${pkgs.length} packages`;
      report.checks = lock ? [{ words: "A lock file: every package's version is pinned.", tone: "ok" }] : [{ words: "The lock file could not be read as JSON.", tone: "warning" }];
      break;
    }
    case "julia-project": {
      const t = parseToml(text);
      const deps = Object.keys(t.deps ?? {});
      const compat = t.compat ?? {};
      report.requirements = deps.map((name) => ({ name, pin: typeof compat[name] === "string" && /^=/.test(String(compat[name])) ? "exact" : compat[name] ? "range" : "none", spec: String(compat[name] ?? "") }));
      report.summary = `a Julia project${typeof t[""].name === "string" ? ` (${t[""].name})` : ""}: ${deps.length} ${deps.length === 1 ? "dependency" : "dependencies"}`;
      const bounded = deps.filter((d) => compat[d]).length;
      report.checks = deps.length ? [{ words: `Compatibility bounds for ${pinWord(bounded, deps.length, "dependency", "dependencies")}; a Manifest.toml pins them exactly.`, tone: bounded === deps.length ? "" : "warning" }] : [];
      if (typeof compat.julia === "string") report.checks.unshift({ words: `Julia ${compat.julia}.`, tone: "" });
      break;
    }
    case "julia-manifest":
    case "lock":
      report.summary = KIND_WORDS[file.kind];
      report.checks = [{ words: `${file.path.split("/").pop()}: every version is pinned.`, tone: "ok" }];
      break;
    case "docker": {
      const lines = text.replace(/\\\r?\n/g, " ").split(/\r?\n/);
      const froms = lines.map((l) => /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/i.exec(l)?.[1]).filter((x): x is string => !!x && x.toLowerCase() !== "scratch");
      const stages = new Set(lines.map((l) => /^\s*FROM\s+\S+\s+AS\s+(\S+)/i.exec(l)?.[1]?.toLowerCase()).filter(Boolean));
      const bases = froms.filter((f) => !stages.has(f.toLowerCase()));
      const runs = lines.filter((l) => /^\s*RUN\s/i.test(l)).length;
      report.summary = `a Dockerfile: ${bases.length ? `built from ${bases.join(", ")}` : "no base image found"}, ${runs} RUN ${runs === 1 ? "step" : "steps"}`;
      report.checks = bases.map((b, i) => imageCheck(b, bases.length > 1 ? `The base image ${i + 1}` : "The base image"));
      if (lines.some((l) => /^\s*ADD\s+https?:\/\//i.test(l))) report.checks.push({ words: "It adds a file from an address at build: what is there may change.", tone: "warning" });
      if (lines.some((l) => /(curl|wget)[^|]*\|\s*(ba|z)?sh\b/.test(l))) report.checks.push({ words: "It runs a script fetched from the network at build: read it first; it is not pinned.", tone: "warning" });
      const pipIn = lines.filter((l) => /\bpip3?\s+install\b/.test(l) && !/-r\s+\S+|requirements/.test(l)).length;
      if (pipIn) report.checks.push({ words: `${pipIn} pip ${pipIn === 1 ? "install names" : "installs name"} packages in the Dockerfile itself: check their versions there.`, tone: "" });
      break;
    }
    case "devcontainer": {
      const j = parseJsonc(text);
      const o = j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
      if (!o) {
        report.checks = [{ words: "It could not be read as JSON.", tone: "warning" }];
        break;
      }
      const build = o.build && typeof o.build === "object" ? (o.build as Record<string, unknown>) : null;
      report.summary = `a development container${typeof o.name === "string" ? ` (${o.name})` : ""}: ${typeof o.image === "string" ? `the image ${o.image}` : build?.dockerfile ? `built from ${String(build.dockerfile)}` : typeof o.dockerComposeFile !== "undefined" ? "Docker Compose" : "no image said"}`;
      if (typeof o.image === "string") report.checks.push(imageCheck(o.image, "Its image"));
      const features = o.features && typeof o.features === "object" ? Object.keys(o.features as object) : [];
      if (features.length) report.checks.push({ words: `${features.length} ${features.length === 1 ? "feature adds" : "features add"} tools at build: ${features.slice(0, 4).join(", ")}${features.length > 4 ? "…" : ""}.`, tone: "" });
      const hooks = ["initializeCommand", "onCreateCommand", "updateContentCommand", "postCreateCommand", "postStartCommand", "postAttachCommand"].filter((k) => o[k] !== undefined);
      if (hooks.length) report.checks.push({ words: `It runs commands on the machine that opens it (${hooks.join(", ")}): read them first.`, tone: "warning" });
      break;
    }
    case "pyproject": {
      const t = parseToml(text);
      const p = t.project ?? {};
      const deps = Array.isArray(p.dependencies) ? (p.dependencies as unknown[]).filter((d): d is string => typeof d === "string") : [];
      report.requirements = deps.map(pipRequirement).filter((r): r is Requirement => r !== null);
      const poetry = t["tool.poetry.dependencies"] ?? {};
      for (const [name, spec] of Object.entries(poetry)) if (name !== "python") report.requirements.push({ name, pin: typeof spec === "string" && /^\d/.test(spec) ? "exact" : spec ? "range" : "none", spec: String(spec) });
      report.summary = `a Python project${typeof p.name === "string" ? ` (${p.name}${typeof p.version === "string" ? ` ${p.version}` : ""})` : ""}: ${report.requirements.length} ${report.requirements.length === 1 ? "dependency" : "dependencies"}${typeof p["requires-python"] === "string" ? `, Python ${p["requires-python"]}` : ""}`;
      report.checks = report.requirements.length ? [{ words: "A package's dependencies are ranges by design: a lock file, or the release's own requirements, pins what the paper ran.", tone: "" }] : [];
      break;
    }
    case "setupcfg": {
      const meta = /\[metadata\]([\s\S]*?)(\n\[|$)/.exec(text)?.[1] ?? "";
      const name = /^\s*name\s*=\s*(.+)$/m.exec(meta)?.[1]?.trim();
      const req = /install_requires\s*=\s*\n((?:[ \t]+.+\n?)*)/.exec(text)?.[1] ?? "";
      report.requirements = req.split("\n").map(pipRequirement).filter((r): r is Requirement => r !== null);
      report.summary = `a Python project (setup.cfg${name ? `: ${name}` : ""}): ${report.requirements.length} dependencies`;
      break;
    }
    case "r-description": {
      const d = parseDcf(text);
      report.requirements = [...rRequirements(d.Imports), ...rRequirements(d.Depends)];
      report.summary = `an R package${d.Package ? ` (${d.Package}${d.Version ? ` ${d.Version}` : ""})` : ""}: ${report.requirements.length} ${report.requirements.length === 1 ? "dependency" : "dependencies"}`;
      const r = /\bR\s*\(([^)]*)\)/.exec(d.Depends ?? "")?.[1];
      if (r) report.checks.push({ words: `R ${r}.`, tone: "" });
      report.checks.push({ words: "A package's dependencies are ranges by design: renv.lock pins what the paper ran.", tone: "" });
      break;
    }
    case "runtime":
      report.summary = `Binder's runtime: ${text.trim().split(/\s+/)[0] ?? ""}`;
      break;
    case "apt": {
      const pkgs = text.split(/\r?\n/).map((l) => l.replace(/#.*$/, "").trim()).filter(Boolean);
      report.summary = `system packages (apt.txt): ${pkgs.slice(0, 8).join(", ")}${pkgs.length > 8 ? "…" : ""}`;
      report.checks = pkgs.length ? [{ words: "System packages come in whatever version the image's distribution has on the day it is built.", tone: "warning" }] : [];
      break;
    }
    case "script":
      report.summary = `a script (${file.path.split("/").pop()}): read as text only, never run; what it installs is code, not a list`;
      report.checks = [{ words: "The registry does not read a script's dependencies: they would be what the script does when run.", tone: "" }];
      break;
    case "npm": {
      let j: Record<string, unknown> | null = null;
      try {
        j = JSON.parse(text) as Record<string, unknown>;
      } catch {
        j = null;
      }
      const deps = j && typeof j.dependencies === "object" && j.dependencies ? Object.entries(j.dependencies as Record<string, string>) : [];
      report.requirements = deps.map(([name, spec]) => ({ name, pin: /^\d+\.\d+\.\d+$/.test(spec) ? "exact" : "range", spec }));
      report.summary = `a Node.js package${typeof j?.name === "string" ? ` (${j.name})` : ""}: ${deps.length} dependencies`;
      break;
    }
    case "conda-recipe":
      report.summary = "a conda recipe (meta.yaml): how the package is built for conda";
      break;
  }
  return report;
}

// ─── where it runs: the visitor's own account and quota ──────────────────────

export interface Elsewhere {
  service: string;
  url: string;
  /** Who runs it, in words. */
  who: string;
}

const BINDER_KINDS: readonly EnvKind[] = ["conda", "pip", "lock", "renv", "r-description", "julia-project", "docker", "runtime", "apt", "script", "pyproject"];

/** Binder and GitHub Codespaces at a ref: plain links, each saying who runs it. Binder only when the
 *  repository has a file it reads; Codespaces for every GitHub repository. */
export function openElsewhere(repo: { owner: string; name: string }, ref: string, files: readonly EnvFile[]): Elsewhere[] {
  const enc = (s: string) => s.split("/").map(encodeURIComponent).join("/");
  const out: Elsewhere[] = [];
  if (files.some((f) => BINDER_KINDS.includes(f.kind))) {
    out.push({
      service: "Binder",
      url: `https://mybinder.org/v2/gh/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/${encodeURIComponent(ref)}`,
      who: "mybinder.org builds the environment from these files and runs it: a free public service, with its own rules and limits, for public repositories. The registry runs nothing.",
    });
  }
  out.push({
    service: "GitHub Codespaces",
    url: `https://codespaces.new/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/tree/${enc(ref)}`,
    who: `GitHub runs it, under your own GitHub account and its quota${files.some((f) => f.kind === "devcontainer") ? ", in the development container the repository describes" : ""}. The registry runs nothing.`,
  });
  return out;
}

// ─── the packages a repository declares ──────────────────────────────────────

export { isPackageName, REGISTRIES, REGISTRY_WORDS, type Registry };

export interface DeclaredPackage {
  registry: Registry;
  name: string;
  version: string | null;
  /** The manifest that declares it. */
  source: string;
}


/** The packages the manifests declare (their name and version, as the files say): proposed, never
 *  recorded without a person who may push (act-packages.ts). */
export function packagesOf(files: readonly { path: string; kind: EnvKind; text: string }[]): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  const add = (registry: Registry, name: unknown, version: unknown, source: string) => {
    if (!isPackageName(registry, name)) return;
    if (out.some((p) => p.registry === registry && p.name.toLowerCase() === name.toLowerCase())) return;
    out.push({ registry, name, version: typeof version === "string" && /^[\w.+!-]{1,40}$/.test(version) ? version : null, source });
  };
  for (const f of files) {
    if (f.kind === "pyproject") {
      const t = parseToml(f.text);
      add("pypi", t.project?.name ?? t["tool.poetry"]?.name, t.project?.version ?? t["tool.poetry"]?.version, f.path);
    } else if (f.kind === "setupcfg") {
      const meta = /\[metadata\]([\s\S]*?)(\n\[|$)/.exec(f.text)?.[1] ?? "";
      add("pypi", /^\s*name\s*=\s*(.+)$/m.exec(meta)?.[1]?.trim(), /^\s*version\s*=\s*(.+)$/m.exec(meta)?.[1]?.trim(), f.path);
    } else if (f.kind === "r-description") {
      const d = parseDcf(f.text);
      add("cran", d.Package, d.Version, f.path);
    } else if (f.kind === "julia-project") {
      const t = parseToml(f.text);
      add("julia", t[""].name, t[""].version, f.path);
    } else if (f.kind === "npm") {
      try {
        const j = JSON.parse(f.text) as Record<string, unknown>;
        if (j.private !== true) add("npm", j.name, j.version, f.path);
      } catch {
        // not JSON: nothing declared
      }
    } else if (f.kind === "conda-recipe") {
      const name = /^\s*name:\s*["']?([\w.-]+)/m.exec(f.text)?.[1];
      const version = /^\s*version:\s*["']?([\w.+!-]+)/m.exec(f.text)?.[1];
      add("conda-forge", name?.toLowerCase(), version, f.path);
    }
  }
  return out;
}

/** The package's page at its registry. */
export function registryUrl(p: Pick<DeclaredPackage, "registry" | "name">): string {
  const n = encodeURIComponent(p.name).replace(/%40/g, "@").replace(/%2F/g, "/");
  switch (p.registry) {
    case "pypi":
      return `https://pypi.org/project/${n}/`;
    case "cran":
      return `https://cran.r-project.org/package=${n}`;
    case "conda-forge":
      return `https://anaconda.org/conda-forge/${n}`;
    case "julia":
      return `https://juliahub.com/ui/Packages/General/${n}`;
    case "npm":
      return `https://www.npmjs.com/package/${n}`;
  }
}

/** The line that installs this version (the version the release declares). */
export function installLine(p: Pick<DeclaredPackage, "registry" | "name" | "version">): string {
  const v = p.version;
  switch (p.registry) {
    case "pypi":
      return v ? `pip install ${p.name}==${v}` : `pip install ${p.name}`;
    case "cran":
      return v ? `remotes::install_version("${p.name}", version = "${v}")` : `install.packages("${p.name}")`;
    case "conda-forge":
      return v ? `conda install -c conda-forge ${p.name}=${v}` : `conda install -c conda-forge ${p.name}`;
    case "julia":
      return v ? `using Pkg; Pkg.add(name = "${p.name}", version = "${v}")` : `using Pkg; Pkg.add("${p.name}")`;
    case "npm":
      return v ? `npm install ${p.name}@${v}` : `npm install ${p.name}`;
  }
}
