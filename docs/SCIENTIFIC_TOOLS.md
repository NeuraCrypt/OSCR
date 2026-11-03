# Scientific tools

A section of the site for research software shown from its repository: `/scientific-tools/` (the
list) and `/scientific-tools/<slug>/` (one tool: what it is, its repository, its licence, and a code
viewer over every text file at a pinned commit). Added **by hand**, never harvested. Not `/tools/`,
which stays the papers' entities (the libraries found in the authors' code).

## Independent of the papers by construction

| What | Scientific tools | Papers |
|---|---|---|
| Data | `website/src/scitools/<slug>.json`, committed | the Mac's export, copied by `scripts/data.mjs` |
| Written by | `npm run scitool:add` (by hand) | the harvester, the nightly |
| Read by | `src/lib/scitools-data.ts` at build time only | `src/lib/catalog.ts` and the rest |
| D1, Hugging Face, Worker | none | search, community, datasets |
| Code text | never copied: fetched by the reader's browser from GitHub at the pinned commit | OSCR's own lots |

`scripts/data.mjs` never reads or writes `src/scitools/` (a test holds it), and the section's pages
import nothing of the catalogue. The nightly build simply rebuilds these pages from the committed
manifests: no network at build time, so they cannot make a nightly fail. A malformed manifest is
caught by `npm test` (`tests/scitools.test.ts`) before it is committed.

## Add a tool

1. On a machine with `git` and Node 22+ (the Mac's checkout, or any clone of the repository):

   ```sh
   cd website
   npm run scitool:add -- https://github.com/<owner>/<name>
   ```

   Options: `--ref <branch|tag>` (default: the default branch), `--slug <slug>` (default: from the
   name), `--name <name>`, `--description <text>` (default: GitHub's description, else the README's
   first paragraph), `--homepage <https://...>`.
2. It clones the repository shallowly **without a checkout** (hooks at the null device; nothing of it
   runs), reads every blob from git's object store, and writes `src/scitools/<slug>.json`: the commit,
   the licence its licence file names (SPDX, or "not recognised"), and each text file's path, size,
   SHA-256, lines and language. Binary files, files over 1 MB and Git LFS pointers are counted, not
   listed. A private repository is refused.
3. `npm test`, then commit the manifest on a branch and merge. The next build (the nightly's, or
   `npm run deploy`) shows the tool.

**Re-pin** (show a newer commit): run the same command again. The tool keeps its slug, its date of
addition and its description (unless `--description` is given). **Remove**: delete its manifest and
commit.

## How the code is shown

The page holds the file list, never the text. When a file is chosen, the reader's browser fetches it
from `https://raw.githubusercontent.com/<owner>/<name>/<commit>/<path>`, checks its SHA-256 against the
manifest's, masks email addresses, then shows it with the reader's highlighter
(`src/scripts/scitool.ts`, using `src/lib/source.ts` `fetchVerified`, the papers' own fallback check).
A file that differs, is over 1 MB or cannot be reached is said in words, with its link on GitHub. The
page's Content-Security-Policy allows `raw.githubusercontent.com` and nothing else outside the site
(`public/_headers`, `/scientific-tools/:slug/`). The address keeps the file (`?file=<path>`).

Since no copy of the code leaves, the licence gates nothing here: it is shown, not enforced.

## Limits

- `SCITOOLS_MAX` = 100 tools (one static page each, so the site's file budget moves by at most 101
  files), `SCITOOL_FILES_MAX` = 5,000 files per tool (`src/lib/scitools.ts`).
- GitHub only, for now (the manifest's `repository.host` is `github`).
- The section is linked from Browse; the masthead, the footer and the command palette are unchanged on
  purpose (changing them changes every page of the site, all re-sent at the next deploy).
