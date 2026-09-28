// The forge's own pages, built without any request: what OSCR's pages link to (a tracing map's
// permalink is `blob` at a commit id, with its lines), and the fallbacks of `unsupported` and of
// an anonymous reader's `rate_limited` (blame, code search, the importer, the upload page).
//
// GitHub's shapes:
// - blob permalink: https://github.com/{o}/{r}/blob/{sha}/{path}#L{start}-L{end}
// - blame: …/blame/{rev}/{path}; tree: …/tree/{rev}/{path}; commit: …/commit/{sha}
// - compare: …/compare/{base}...{head}
// - search: https://github.com/search?q=repo%3A{o}%2F{r}+{query}&type=code
// - upload: …/upload/{branch}/{dir}; new release: …/releases/new?tag={tag}
// - importer: https://github.com/new/import
// - install: https://github.com/apps/{slug}/installations/new?state=…
// - clone: https://github.com/{o}/{r}.git; archive: …/archive/{rev}.zip or .tar.gz
// Every segment is escaped with encodeURIComponent, and "/" is kept between path components.
// `parse` reads the revision of a tree or blob address as one segment: a branch whose name holds a
// "/" reads as a shorter name and a longer path (GitHub's own addresses are ambiguous there).
// Tracing maps link at commit ids, which never hold one.
//
// The test double builds the same shapes under its own address (tests/forge/memory.ts).

import type { ForgeLinks } from "../gitbackend.ts";
import { SEGMENT } from "../paths.ts";
import type { ForgeName, RepoRef, Rev } from "../types.ts";

/** Each "/"-separated component escaped, the "/" kept. */
export function escapePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** The first path segments of github.com that are not accounts. */
const RESERVED = new Set([
  "about", "apps", "collections", "contact", "customer-stories", "enterprise", "events", "explore", "features",
  "issues", "login", "logout", "marketplace", "new", "notifications", "orgs", "organizations", "pricing", "pulls",
  "search", "security", "settings", "site", "sponsors", "topics", "trending", "users",
]);

export function forgeLinks(o: { forge: ForgeName; web: string; appSlug?: string | null }): ForgeLinks {
  const web = o.web.replace(/\/+$/, "");
  const host = new URL(web).host.toLowerCase();
  const base = (r: RepoRef) => `${web}/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}`;
  const at = (r: RepoRef, kind: string, rev: Rev, path?: string) =>
    `${base(r)}/${kind}/${escapePath(rev)}${path ? `/${escapePath(path)}` : ""}`;
  return {
    repo: base,
    tree: (r, rev, path) => at(r, "tree", rev, path),
    blob: (r, rev, path, lines) => {
      const url = at(r, "blob", rev, path);
      if (!lines) return url;
      return lines.end !== undefined && lines.end !== lines.start ? `${url}#L${lines.start}-L${lines.end}` : `${url}#L${lines.start}`;
    },
    blame: (r, rev, path) => at(r, "blame", rev, path),
    commit: (r, sha) => `${base(r)}/commit/${encodeURIComponent(sha)}`,
    compare: (r, b, h) => `${base(r)}/compare/${escapePath(b)}...${escapePath(h)}`,
    search: (r, query) => `${web}/search?${new URLSearchParams({ q: `repo:${r.owner}/${r.name} ${query}`, type: "code" })}`,
    upload: (r, branch, dir) => at(r, "upload", branch, dir),
    newRelease: (r, tag) => `${base(r)}/releases/new${tag ? `?${new URLSearchParams({ tag })}` : ""}`,
    importer: () => `${web}/new/import`,
    install: (state) => {
      const url = `${web}/apps/${encodeURIComponent(o.appSlug ?? "")}/installations/new`;
      return state ? `${url}?${new URLSearchParams({ state })}` : url;
    },
    clone: (r) => `${base(r)}.git`,
    archive: (r, rev, format) => `${base(r)}/archive/${escapePath(rev)}.${format}`,
    parse(url) {
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        return null;
      }
      if (u.host.toLowerCase() !== host || (u.protocol !== "https:" && u.protocol !== "http:")) return null;
      let parts: string[];
      try {
        parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      } catch {
        return null;
      }
      if (parts.length < 2 || RESERVED.has(parts[0].toLowerCase())) return null;
      const owner = parts[0];
      const name = parts[1].replace(/\.git$/i, "");
      if (!SEGMENT.test(owner) || !SEGMENT.test(name)) return null;
      const repo: RepoRef = { forge: o.forge, owner, name };
      const m = /^#L(\d+)(?:-L(\d+))?$/.exec(u.hash);
      const lines = m ? { start: Number(m[1]), end: Number(m[2] ?? m[1]) } : null;
      const kind = parts[2];
      if (parts.length >= 4 && (kind === "tree" || kind === "blob" || kind === "blame" || kind === "commit")) {
        const rev = parts[3];
        const path = kind === "commit" ? null : parts.slice(4).join("/") || null;
        return { repo, rev, path, lines: kind === "blob" || kind === "blame" ? lines : null };
      }
      return parts.length === 2 ? { repo, rev: null, path: null, lines: null } : null;
    },
  };
}
