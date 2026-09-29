// A repository's packages, confirmed or declined by a person who may push (night phase 07, E6;
// docs/RELEASES.md "Packages"; D07-*). OSCR hosts no package: the release and environment pages read
// the manifests in the reader's browser, as text (src/lib/environments.ts `packagesOf`), and propose
// what they declare; the registry records a person's word on each, one authorized action:
//
//   package_confirm  {registry, name, version?, source?, confirm}: "this repository publishes <name> at
//                    <registry>" (confirm: true), or "it does not" (false). GitHub is asked, as the
//                    person, whether they may push to the repository; nothing is written on GitHub.
//                    1 row (repo_packages, its key), with the action row.
//
// The package stays at its registry (PyPI, CRAN, conda-forge, Julia's General registry, npm); the Mac
// publishes the confirmed records in the static layer (oscr/forgelayer.py), with a link to the
// registry and an install line pinned to the version the manifest said.

import { declaredRepo, onDeclaredRepo } from "./act-pulls.ts";
import { ForgeProblem, type ActionContext, type ActionSpec, type AnyActionSpec, type D1Database, type Write } from "./types.ts";

/** The public registries a record may name (src/lib/environments.ts reads the manifests). */
export const REGISTRIES = ["pypi", "cran", "conda-forge", "julia", "npm"] as const;
export type Registry = (typeof REGISTRIES)[number];

export const REGISTRY_WORDS: Readonly<Record<Registry, string>> = {
  pypi: "PyPI",
  cran: "CRAN",
  "conda-forge": "conda-forge",
  julia: "Julia's General registry",
  npm: "npm",
};

const PACKAGE_NAME: Readonly<Record<Registry, RegExp>> = {
  pypi: /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/,
  cran: /^[A-Za-z][A-Za-z0-9.]{1,60}$/,
  "conda-forge": /^[a-z0-9][a-z0-9._-]{0,99}$/,
  julia: /^[A-Za-z][A-Za-z0-9_]{0,99}$/,
  npm: /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]{0,213}$/,
};

/** Whether a package's name is one its registry takes (a record names nothing else). */
export const isPackageName = (registry: Registry, name: unknown): name is string => typeof name === "string" && PACKAGE_NAME[registry].test(name);

export interface PackageParsed {
  registry: Registry;
  name: string;
  version: string;
  source: string;
  confirm: boolean;
}

export interface PackageDone {
  registry: Registry;
  name: string;
  status: "confirmed" | "declined";
  page: string;
  links: { href: string; text: string }[];
  notes: string[];
}

const bad = (message: string) => new ForgeProblem(400, "bad_payload", message);

export function validatePackage(payload: unknown): PackageParsed | ForgeProblem {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return bad("Name the package and its registry.");
  const p = payload as Record<string, unknown>;
  if (!(REGISTRIES as readonly unknown[]).includes(p.registry)) return bad(`The registry is one of ${REGISTRIES.map((r) => REGISTRY_WORDS[r]).join(", ")}.`);
  const registry = p.registry as Registry;
  if (!isPackageName(registry, p.name)) return bad(`This is not a package name ${REGISTRY_WORDS[registry]} takes.`);
  if (typeof p.confirm !== "boolean") return bad("Confirm or decline the package.");
  const version = p.version === undefined || p.version === null ? "" : p.version;
  if (typeof version !== "string" || !/^[\w.+!-]{0,40}$/.test(version)) return bad("The version is the manifest's, 40 characters at most.");
  const source = p.source === undefined || p.source === null ? "" : p.source;
  if (typeof source !== "string" || source.length > 500 || /[\u0000-\u001f]|(^|\/)\.\.(\/|$)/.test(source)) return bad("The manifest's path could not be read.");
  return { registry, name: p.name as string, version, source, confirm: p.confirm };
}

export const describePackage = (p: PackageParsed): string =>
  p.confirm
    ? `Confirm that the repository publishes the package ${p.name}${p.version ? ` (${p.version})` : ""} at ${REGISTRY_WORDS[p.registry]}`
    : `Decline the package ${p.name} at ${REGISTRY_WORDS[p.registry]}: the repository does not publish it`;

/** The word of a person on a package (1 row: the table is its key). */
export function upsertPackage(
  db: D1Database,
  r: { forge: string; repoId: string; registry: Registry; name: string; status: "confirmed" | "declined"; version: string; source: string; userId: string },
  t: number,
): Write {
  return {
    rows: 1,
    stmt: db
      .prepare(
        "INSERT INTO repo_packages (forge, repo_id, registry, name, status, version, source, by_user, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT (forge, repo_id, registry, name) DO UPDATE SET status = excluded.status, version = excluded.version, source = excluded.source, by_user = excluded.by_user, at = excluded.at",
      )
      .bind(r.forge, r.repoId, r.registry, r.name, r.status, r.version, r.source, r.userId, Math.floor(t)),
  };
}

/** A repository's packages, by the key's prefix (no index). */
export const packagesOfRepo = (db: D1Database, forge: string, repoId: string) =>
  db.prepare("SELECT registry, name, status, version, source, at FROM repo_packages WHERE forge = ? AND repo_id = ? ORDER BY registry, name LIMIT 200").bind(forge, repoId);

export const packageConfirmSpec: ActionSpec<PackageParsed, PackageDone> = {
  kind: "package_confirm",
  needsRepo: false,
  checkTarget: onDeclaredRepo,
  validate: validatePackage,
  describe: describePackage,
  async perform(ctx) {
    const p = ctx.parsed;
    const info = await declaredRepo(ctx as ActionContext<unknown>);
    const permission = await ctx.session.repos.permission(info.ref, ctx.github.login);
    if (permission !== "admin" && permission !== "maintain" && permission !== "write") {
      throw new ForgeProblem(403, "not_maintainer", "Only a person who may push to this repository says which packages it publishes: nothing was done.");
    }
    const page = `/r/${info.ref.owner.toLowerCase()}/${info.ref.name.toLowerCase()}/environment/`;
    return {
      result: {
        registry: p.registry,
        name: p.name,
        status: p.confirm ? "confirmed" : "declined",
        page,
        links: [{ href: page, text: "The repository's environment and packages" }],
        notes: p.confirm ? ["The registry lists it with the repository from tonight's publication (signed in, at once)."] : [],
      },
      writes: [upsertPackage(ctx.db, { forge: info.key.forge, repoId: info.key.id, registry: p.registry, name: p.name, status: p.confirm ? "confirmed" : "declined", version: p.version, source: p.source, userId: ctx.user.id }, ctx.t)],
      repo: { forge: info.key.forge, repoId: info.key.id },
    };
  },
  check: (r, p) => r.name === p.name && r.registry === p.registry,
};

export const PACKAGE_ACTIONS: readonly AnyActionSpec[] = [packageConfirmSpec];
