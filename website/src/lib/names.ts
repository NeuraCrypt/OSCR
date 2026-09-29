// Names and addresses shared by the build, the browser's scripts and the Worker: nothing here
// reads a file.

/** Only web addresses become links: anything else in the data (a `javascript:` URL,
 *  say) is dropped, and the pages fall back to another link or to none. */
export const webUrl = (u: string | null | undefined) => (u && /^https?:\/\//i.test(u) ? u : "");

const FORGE = /^(?:github\.com|gitlab\.com|codeberg\.org|bitbucket\.org)\/(.+)$/;

/** A repository as one reads it at a glance: "owner/repo", "Zenodo 123", "OSF abcde". */
export function shortName(d: { repo: string; url: string }): string {
  const m = d.repo.match(FORGE);
  if (m) {
    // The normalized name is in lower case; the URL keeps the authors' spelling.
    const u = d.url.match(/^https?:\/\/(?:www\.)?[^/]+\/([^?#]+?)(?:\.git)?\/?$/);
    return u && u[1].toLowerCase() === m[1] ? u[1] : m[1];
  }
  const z = d.repo.match(/^(zenodo|osf|figshare):(.+)$/);
  if (z) return `${{ zenodo: "Zenodo", osf: "OSF", figshare: "figshare" }[z[1]]} ${z[2]}`;
  return d.repo;
}
