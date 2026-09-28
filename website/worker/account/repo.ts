// A repository as a person types it into the claim form, turned into the key the registry gives
// it (oscr/links.py): "https://github.com/Owner/Name/tree/main" → "github.com/owner/name". Only
// the forges whose addresses name an owner: the ones `repo_owner` holds (oscr/community.py).

/** Forges whose repositories are <host>/<owner>/<name>. */
const TWO_PART = new Set(["github.com", "bitbucket.org", "codeberg.org", "gin.g-node.org", "gitee.com", "framagit.org"]);
const SEGMENT = /^(?!\.+$)[A-Za-z0-9._-]{1,100}$/;

function isGitlab(host: string): boolean {
  return host === "gitlab.com" || host.startsWith("gitlab.") || (host.includes(".gitlab.") && !host.endsWith(".gitlab.io"));
}

const stripGit = (name: string) => name.replace(/\.git$/i, "");

/** The registry's key of the repository in `text`, or "" when it names none. "owner/name" alone
 *  means GitHub. */
export function repoKey(text: string): string {
  let t = (text ?? "").trim();
  if (!t || t.length > 300 || /\s/.test(t)) return "";
  if (/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(t)) t = `github.com/${t}`;
  t = t.replace(/^git\+/i, "").replace(/^git@([^:/]+):/i, "$1/");
  t = t.replace(/^(?:https?|git|ssh):\/\//i, "").replace(/^[^@/]+@/, "").replace(/^www\./i, "");
  t = t.split(/[?#]/)[0];
  const parts = t.split("/").filter(Boolean);
  if (parts.length < 3) return "";
  const host = parts[0].toLowerCase().replace(/:\d+$/, "");
  if (TWO_PART.has(host)) {
    const owner = parts[1];
    const name = stripGit(parts[2]);
    if (!SEGMENT.test(owner) || !SEGMENT.test(name)) return "";
    return `${host}/${owner}/${name}`.toLowerCase();
  }
  if (isGitlab(host)) {
    // GitLab groups nest; a page inside the project starts with "/-/".
    const cut = parts.indexOf("-");
    const path = (cut >= 0 ? parts.slice(1, cut) : parts.slice(1)).map((s, i, all) => (i === all.length - 1 ? stripGit(s) : s));
    if (path.length < 2 || !path.every((s) => SEGMENT.test(s))) return "";
    return `${host}/${path.join("/")}`.toLowerCase();
  }
  return "";
}

/** The web address of a repository key ("https://github.com/owner/name"). */
export function repoUrl(key: string): string {
  return `https://${key}`;
}
