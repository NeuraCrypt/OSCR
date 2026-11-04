# The badge

How a paper's (or a repository's) badge is drawn, addressed, linked and added, and why it is built this
way. The guide for authors is the site's `/help/badge/`; the generator is `/badge/`.

## What exists

| Piece | Where | What it does |
|---|---|---|
| The drawing | `website/src/lib/badge.ts` | Pure functions: what the badge says (`badgeMessage`), the SVG (`renderBadge`: `flat`, `large`, `mark`, `card`; themes `blue`, `light`), shields.io's endpoint JSON (`endpointJson`), the addresses (`badgeUrls`), the snippets (`snippet`: Markdown, HTML, reStructuredText, AsciiDoc, Org, LaTeX), DOI and repository keys, `hasBadge`. Shared by the Worker, the build and the browser. |
| The logo | `website/src/lib/badge-logo.ts`, made by `tools/make_badge_logo.py` | The owner's wordmark at 40 px high, white and blue, as PNG data URIs: an image shown through `<img>` loads nothing outside itself, so the logo travels inside the SVG (as shields.io does). The same script writes `website/public/badge.png` (the mark on its blue, 186 × 88). Standard library only. |
| The badges drawn on demand | `website/worker/badge.ts`, routed by `worker/index.ts` | `GET /badge/doi/<doi>.svg|.json`, `GET /badge/repo/<host>/<path>.svg|.json`, and the same without a suffix: the badge's link, a 302. Reads only static files through `ASSETS` (free): `/lookup/NN.json`, `/data/papers/NN.json`, `/data/repos/NN.json`, `/badge/site.json`. No D1, no secret, no cookie. |
| The static badges | `src/pages/badge.svg.ts`, `public/badge.png` | Never drawn on demand: the fallback when the Worker's quota is spent, and for what reads no SVG (LaTeX, Word, email). |
| The generator | `src/pages/badge/index.astro`, `src/scripts/badge.ts` | One static page: a DOI or a repository in, the preview, every snippet with a Copy button, the four addresses, and for each repository of the paper whether its README carries the badge (read from GitHub's, GitLab.com's or Hugging Face's public API by the reader's browser) with a link to the forge's own editor. Also the chooser a repository's badge links to when it is the code of several papers (`?repo=`). |
| The paper's page | `src/components/paper/Contribute.astro` | The author's or maintainer's three snippets now use the paper's own badge, and link to the generator. |
| The account | `src/pages/account.astro` `#badges`, `src/scripts/account.ts` | Each paper the person is a verified author of, and each repository they maintain, linked to its badge: the in-site notification. |
| The submission | `src/scripts/submit.ts` | `?doi=` and `?code=` fill the form (an unknown paper's badge links there), kept through a sign-in in `sessionStorage`. |
| The command line | `cli/src/oscr_cli/badge.py`, `cli/src/oscr_cli/commands/badge.py` | `oscr badge [DOI] [--repo-badge] [--format …] [--style …] [--show …] [--write] [--remove]`: the snippet, or the README written between `<!-- oscr-badge:start -->` and `<!-- oscr-badge:end -->` (or the markup's own comment), under the title and after a front matter, replaced next time. |
| The guide | `src/pages/help/badge.astro` | The complete tutorial, platform by platform; called out at the top of `/help/`. |

`/badge/site.json` carries `SITE_NAME`: the Worker never names the platform itself.

## What a badge says

| State | Message | Tone | Link |
|---|---|---|---|
| a page, code found or verified | paper ↔ code | masthead `#1f3b4d` | the paper's page |
| an author validated the map (a map DOI) | paper ↔ code · validated | green `#2b6b3f` | the paper's page |
| on request, data only | code on request, data only | masthead | the paper's page |
| a repository, one paper | as its paper | | that paper's page |
| a repository, several papers | code of N papers | masthead | `/badge/?repo=…` (the list) |
| read, no page | read, no code found | grey | `/lookup/?doi=…` |
| a scientific tool's repository (`/badge/tools.json`) | scientific tool | masthead | the tool's page, `/scientific-tools/<slug>/` |
| unknown | not registered | grey | `/submit/?doi=…` or `?code=…`, filled in |

`?show=` replaces the message with another fact (`doi`, `map`, `code`, `scripts`, `language`, `license`,
`journal`), falling back to the state when the fact is unknown; `?text=` with the reader's own words
(40 characters, no email address, no em dash). `?missing=hide` answers an empty image for an unknown
key (GitLab group badges). The link's `?to=` is `paper`, `reader`, `map`, `cite`, `code`, `doi` or `api`.

## How the big ones do it (2026-11-03)

- **shields.io**: SVG, 20 px, two parts, Verdana 11 px with measured widths and `textLength`, an
  accessible name, logos embedded as data URIs; the **endpoint badge** (`schemaVersion: 1`, `label`,
  `message`, `color`, `labelColor`, `isError`, `namedLogo`, `logoSvg`, `logoColor`, `style`,
  `cacheSeconds`) lets any service publish facts that shields draws.
  <https://shields.io/badges/endpoint-badge>
- **GitHub's camo proxy** rewrites every README image and keys its cache on the image's address;
  GitHub's guidance is to send `Cache-Control` (`no-cache` to update at once) and a supported
  `Content-Type`; a stale image can be purged with `curl -X PURGE <camo url>`.
  <https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-anonymized-urls>
- **Hugging Face** badges are static SVGs (light and dark, four sizes) in a dataset repository, wrapped
  in a Markdown link; a model card is the repository's README, YAML front matter first.
  <https://huggingface.co/datasets/huggingface/badges>
- **GitLab** has project and **group badges** whose link and image take placeholders
  (`%{project_path}`, `%{project_id}`, `%{default_branch}`, `%{commit_sha}`): one group badge reaches
  every project. <https://docs.gitlab.com/ee/user/project/badges.html>
- **Zenodo**, **JOSS** and **Software Heritage** draw one badge per identifier (a DOI, a SWHID, an
  origin) on demand, linked to the record: the model the paper's badge follows.

What the OSCR badge takes from them: the shields geometry and accessible name; the endpoint JSON for
whoever wants shields' styles; an hour of cache (the records change once a night) with
`stale-while-revalidate`, an ETag and 304s; a logo inside the image; a badge per identifier that links
to the record; GitLab's placeholders. What it adds: the link is the registry's own redirect, so a badge
written today follows the paper's page wherever it moves, and a badge of an unknown paper turns into an
invitation to submit it, then into the real badge the night the record is published.

## Cost (zero, within the free plan)

Every badge view that reaches the Worker counts against the free plan's 100,000 requests a day. They
are held down by:

- `Cache-Control: public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400`: the camo proxy,
  the browsers and Cloudflare's Cache API (on the custom domain) each ask at most once an hour per
  address; an ETag turns a revalidation into a 304.
- Only static reads (free); no D1, so the search's quota is untouched.
- The generator page asks the Worker for its preview image only; the README checks go to the forges
  from the reader's browser.

A thousand READMEs each seen all day cost on the order of 24,000 requests at worst (one an hour from
one proxy each): within the quota beside the pages. Past it, the badges drawn on demand stop until
00:00 UTC; the static `/badge.svg` and `/badge.png` never do. Should the badges ever crowd out the
pages, raising `BADGE_MAX_AGE` to a day is the first lever.

## Adding the badge to every repository: what was studied

| Way | Verdict |
|---|---|
| OSCR opens pull requests on the authors' repositories | **Refused.** It needs write permission on others' repositories (CLAUDE.md: "No write permission is ever asked of GitHub"), and unsolicited automated pull requests are what GitHub's Acceptable Use Policies call spam; same for Hugging Face. |
| Issues or emails to the authors | **Refused**: no mass message to the authors (CLAUDE.md), notifications stay in the site. |
| The author's own one-click pull request (their token, used once) | Not built (CONTRIBUTIONS.md): the `public_repo` scope opens every public repository of the author. The forge editor link does the same with no permission. |
| **The account page** lists each paper and repository with its badge | **Built**: the in-site notification. |
| **The generator** finds each README, says which lack the badge, opens the forge's editor (GitHub: a missing README is created already filled, `new/<branch>?filename=README.md&value=…`) | **Built**: one click per repository, the author's own gesture. |
| **GitLab group badges** with `%{project_path}` and `?missing=hide` | **Built**: one setting badges every project of a group, now and later. |
| **`oscr badge --write`** in a clone | **Built**: scriptable over all of a lab's clones (`for d in */; do (cd "$d" && oscr badge --write); done`), idempotent. |
| The forge's GitHub App (night phase 01, behind `FORGE_OPEN`) suggesting the badge in its check run on repositories its owners installed it on | **Built** (2026-11-04, `pr-checks.ts` `badgeReminder`): on a repository linked to a paper whose README lacks the badge, the check run's summary ends with one sentence and the badge page's address. One more read, nothing written. |
| **The "Add the badge" box** on every paper's page (static, and rendered on demand by the Worker) and every scientific tool's page | **Built** (2026-11-04, `components/BadgeBox.astro`, `render.ts` `badgeSection`, `badge.ts` `badgeBox`): every reader sees it, signed in or not; the Markdown, reStructuredText and HTML snippets carry their marks, so every later tool replaces them in place. |
| **A GitHub Action** in the researcher's own workflow | **Built** (2026-11-04, `github-action/oscr-badge/`): it runs `oscr badge --write` from this repository's `cli/` and commits the README with the workflow's own token when it changed; the researcher opts in by adding the workflow file (`/help/badge/#action`). The registry writes nothing. |
| **The registry's editor with the badge in place** (`/r/<owner>/<name>/edit/<branch>/<README>?badge=doi:…`) | **Built**, behind `FORGE_OPEN` (2026-11-04, `repo-edit.ts`, `badge.ts` `insertBadge`, `badgeSubject`): the address names only the subject, the page builds the snippet and puts it under the title; the person commits it as themselves, one authorization (D00-4). |
| The App opening the badge pull request by itself when installed | **Not built**: D00-4 (the installation token never writes) and CLAUDE.md (no write permission asked of GitHub). The owner's decision to change. |
| An arXiv "Code" tab through arXivLabs | **Proposal drafted** (`docs/ARXIVLABS_PROPOSAL.md`): the owner sends it; arXiv decides. |

## The sites where papers are read (built 2026-11-04)

A link from each paper the registry has a page for to that page, on the sites where the paper itself
is read, for every paper at once (`oscr/linkfeeds.py`, `oscr linkfeeds [--upload]`, the nightly's
`linkfeeds` step, `OSCR_LINKFEEDS=0` turns it off). No author's repository is touched.

| Site | File | Matched by | Shown |
|---|---|---|---|
| Europe PMC External Links (LabsLink, schema 1.2) | `data/linkfeeds/labslink/profile.xml`, `links-NNN.xml.gz` (50,000 links each) | PMID, else PMCID, else DOI | the article's "External Links" tab |
| PubMed LinkOut | `data/linkfeeds/linkout/resources-NNN.xml` | PMID | "LinkOut - more resources" |

Until the owner registers, the provider ids are 0 (`OSCR_LABSLINK_PROVIDER`, `OSCR_LINKOUT_PROVIDER`).
Once each service gives its FTP account, `OSCR_LABSLINK_FTP=host/folder` and `OSCR_LABSLINK_FTP_USER`
(the same with `LINKOUT`; `…_FTP_PLAIN=1` when the service has no TLS), the password in the keychain
(`org.oscr.labslink`, `org.oscr.linkout`): from then on the night sends the files. The profile's contact
address (`OSCR_LABSLINK_EMAIL`) goes to Europe PMC only. The letters to send: `docs/BADGE_OUTREACH.md`.

## Safety

- The SVG is served with `Content-Security-Policy: default-src 'none'; img-src data:; style-src
  'unsafe-inline'; sandbox`, `nosniff`, `Cross-Origin-Resource-Policy: cross-origin`, CORS `*`. Every
  text in it is escaped; it holds no script and no external reference.
- The reader's own `text=` is cleaned (control characters, dashes, email addresses), 40 characters.
- The badge keeps nothing about who sees it; there is no view counter.
- The generator's page policy adds only the forges' public APIs to `connect-src`.

## Tests

- `website/tests/badge.test.ts`: the messages, the options, the drawing (escaping, accessible name, no
  external reference, no rounded corner, sizes), the endpoint schema, the keys, the addresses and
  snippets (the same vectors as the CLI's), `hasBadge`, and the Worker's routes, headers, 304, HEAD,
  OPTIONS, 405, redirects and static-only reads.
- `cli/tests/test_badge.py`: the addresses, the insertion under the title for every markup (after a
  Hugging Face card's YAML), idempotence, replacement, removal, `oscr badge` end to end.
- `npm run check` lists `/badge/`, `/badge/site.json`, `/badge.svg`, `/badge.png` among the fixed files.
