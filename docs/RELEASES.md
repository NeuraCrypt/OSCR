# Releases, packages and environments in the registry (night phase 07)

A release is the version of a paper's code that goes with a version of the paper: its tag names one
commit, the one the tracing map's lines are at; its notes say what changed; its files carry what the
results need; its environment says how the code runs again. The repository pages of the GitHub side
let a researcher read, compare and make releases **inside the registry**, beside the paper and its
tracing map:

- **Releases, tags and release files stay GitHub's objects** (D00-6): read in the reader's browser on
  the reader's own quota (D00-5), written by GitHub as the person, one authorization at a time, the
  token used once and revoked (D00-4).
- **The registry's own is its research layer over them**: a release **tied to a version of a paper**
  (a preprint, the submitted or accepted manuscript, the version of record, a correction), the
  **tracing map versioned with it**, **Software Heritage's archive** at the person's request (D00-15),
  and the **Zenodo deposit of its validated map** at its author's request, a DOI on the map (its
  links and metadata), never on the code, on Zenodo's sandbox while the registry is built (CLAUDE.md).
- **Environments** are read as text and **never executed**; **packages** are never hosted: the ones
  the manifests declare are confirmed by a person who may push, and stay at their public registry.

GitHub is OSCR's competitor: a release is read, compared and made in the registry; a reader is sent
to GitHub only for what the registry cannot do, through an "at the source" link after a sentence that
says why (the files' bytes, the source archives, the feeds, a file over 25 MiB). The decisions:
[DECISIONS.md](DECISIONS.md) D07-1 to D07-20; the phase's plan: [PLATFORM_PLAN.md](PLATFORM_PLAN.md)
§15.6 "Phase 07"; the GitHub side's contract: [FORGE.md](FORGE.md); what it builds on:
[CODE_NAVIGATION.md](CODE_NAVIGATION.md), [PULL_REQUESTS.md](PULL_REQUESTS.md), [ISSUES.md](ISSUES.md),
[CONTRIBUTIONS.md](CONTRIBUTIONS.md) (the validation of a map and its Zenodo deposit).

**In one paragraph.** Every page is the repository's static shell, `/r/*` (no file per release;
signed out, no Worker request). The reader's browser reads GitHub's releases, tags and files from
GitHub's anonymous API and shows them as view trees (email addresses masked, someone's text never
markup). Each write, a release made, edited, published or deleted, the drafts read, a tag made or
deleted, a file attached or deleted, a release tied to a paper's version, Software Heritage or Zenodo
asked, a package confirmed, is one authorized action of phase 01's flow (`act-releases.ts`,
`act-packages.ts`): the Worker acts once as the person, checks GitHub's answer, writes its rows (the
action row; a tie, the Mac's jobs, a package: 1 row each). A file up to 25 MiB goes through the Worker
on a route of its own, streamed, never parsed. The Mac versions the tracing map with the release,
asks Software Heritage, and deposits the validated map on Zenodo (`oscr/forgejobs.py`); its static
layer carries the ties, the maps' digests and the confirmed packages for signed-out readers
(`oscr/forgelayer.py`).

## The addresses (GitHub's own shapes, D07-11)

After `/r/<owner>/<name>/`, one static shell (`public/_redirects`: `/r/* /r/ 200`):

| address | view |
|---|---|
| `releases/` (`?q=`) | the list: drafts first (the person's, kept in the tab), then the versions, the highest first, then the tags that are no version; the search on submit |
| `releases/tag/<tag>` | a release: its notes, its files, the source archives, the comparison, its environment, the paper's version and its map, Software Heritage and Zenodo, edit and delete |
| `releases/latest` | GitHub's latest release, the same page, with GitHub's rule said |
| `releases/new` (`?tag=&target=&title=&body=&prerelease=1&doi=&paper_version=`) | the form; GitHub's parameters and the registry's two, each checked, the text masked |
| `releases/edit/<tag>` | the same form for a release (its tag and commit only for a draft) |
| `releases/changelog` | every published release's notes, the highest version first, one Markdown text to copy into a CHANGELOG.md |
| `releases/download/<tag>/<file>`, `releases/latest/download/<file>` | a file of a release: GitHub's, linked, with its SHA-256 (the registry never downloads an asset) |
| `tags/` | the tags, the highest version first: the commit, the release each carries (or a link to draft one), GitHub's archives; create and delete |
| `environment/<ref>` | the environment files at a branch, a tag or a commit (the default branch without one), and the packages they declare |

The repository's bar gains **Releases** (the releases and the tags under it); its sidebar links the
releases, the tags, the latest, and the environment. The paper's page lists **the versions of its
code**: the releases tied to a version of it, with the map versioned with each (`Later.astro`,
`paper-research.ts`, from the nightly layer).

## The list, a release, the form

- **The list** (D07-10): GitHub's list (100 a page, 1 request) and its latest (1); ordered by semantic
  version (semver 2.0's precedence; "v1" and "1.2" read loosely, a bare number or a date is no
  version), each with its states in words, **Latest**, **Pre-release**, **Draft**, **Immutable**
  (`.ok`, `.warning`), never a pill, its tag at its commit, when and by whom, its files, the paper's
  version it goes with, and the first words of its notes. The filter runs on submit (never as you
  type) with GitHub's qualifiers `draft:`, `prerelease:`, `tag:` (a version's prefix: `tag:v1` is
  every v1.x.y), `created:`, `published:`, `latest:`, `immutable:`, `is:`, and the registry's `paper:`,
  `doi:`, `version:` (the paper's version).
- **Drafts** (D07-7) are seen only by the people who may push. The page never reads them anonymously:
  "Show my drafts" is one authorization (`release_drafts`), GitHub shows them to the person, and the
  callback page keeps them in the tab (`src/lib/release-stash.ts`, sessionStorage, masked), with a
  draft just saved; the list shows them "as GitHub showed them to you", and forgets them with the tab.
- **A release's page**: its notes rendered by the registry's Markdown renderer; its files with their
  size, **their SHA-256 as GitHub computed it**, GitHub's download count and date, and "Check a file":
  the reader picks a file, its SHA-256 is computed in the browser (WebCrypto), the file never leaves
  the computer; the source archives (GitHub's, with why their checksum may change) and "What the
  archives leave out" (`.gitattributes`' `export-ignore`, read at the tag; `export-subst` named, git's
  formatting, nothing runs); "Compare with" another release (phase 02's comparison between the two
  tags) and "What changed since" the previous one; the Environment panel (below); the sidebar's table
  of contents of the releases.
- **The form**: the tag, with the next versions suggested from the highest version tagged and what was
  merged since (a pull request labelled breaking: a major version, under 1.0.0 a minor one; a feature:
  a minor one; else a patch; each with its reason); the target, a branch or a commit id, shown as
  **the exact commit the release will name** (an existing tag fixes it: its own commit); the previous
  tag (GitHub's rule: the highest version below); the title; the notes, with **"Write the notes from
  what was merged"** (below) and a preview; "Also let GitHub add its own generated notes"; pre-release;
  latest (yes, no, GitHub's choice); **For the paper**: the paper (the repository's papers, or a DOI),
  the version it goes with, its label, the map the paper's page shows (its digest, versioned with the
  release when it is published), Software Heritage and Zenodo when it is published. "Save the draft"
  first (drafts first: attach the files, then publish), or "Publish the release". A commit of the
  research `.github/release.yml` is offered through the editor.

### Notes written in the browser (D07-9)

As GitHub writes its generated notes: the pull requests merged between the previous tag and the target
(GitHub's comparison, 1 request, and its closed pull requests, 1: a pull request is in the range when
its merge commit is one of the range's commits), each with its author and the co-authors its merge
commit names by their GitHub no-reply address; grouped by `.github/release.yml` (`changelog.exclude`
labels and authors, `categories[*]` with their `labels` and `exclude`, the catch-all `"*"`, the rest
under "Other Changes"), read raw at the default branch; then the registry's section **"For the
paper"**: the tracing-map links on the files the range changed ("to look at again": the paragraph ↔
the lines), and the research issues fixed in the code at one of the range's commits; and the full
changelog's comparison, the registry's own. GitHub's own generator stays an option (`generateNotes`).

## The research extension (D07-2 to D07-6)

- **A release tied to a version of a paper** (`release_papers`, one row per release and paper): the
  paper by its DOI, the version (`preprint`, `submitted`, `accepted`, `published`, `correction`), its
  label, the commit the tag named, the digest of the map the person saw. The repository must be known
  as the paper's code (attached to it in the registry, or the Mac's `paper_repo` fact). The tie is
  **linked** when the person is a verified author of the paper or a maintainer of the code, **proposed**
  otherwise (D01-22's rule). A person who may push, or a verified author of the paper, ties and
  unties. At creation (`release_create`'s `paper`) or later (`release_research`).
- **Citations keep meaning the same code** (D07-3): a release names the commit the page showed (an
  existing tag must name it); a published release keeps its tag and its commit; a release a paper's
  version is tied to stays published and is not deleted (untie first); a tag a published release or a
  tie uses is not deleted. GitHub's own **immutable releases** (locked tag and files, text editable, a
  deleted one's tag never reused) are respected and said in words.
- **The tracing map versioned with the release** (D07-4): when a tied release is published, the Mac's
  `release` job freezes the paper's map (`zenodo.map_of`: links and metadata, never the paper's text
  nor the code) for (the repository, the tag, the paper), with the release's commit and the commit the
  map's lines are at, in its state (`forge_map_version`), and answers its digest into the tie; the
  static layer shows it: digest, pairs, commits.
- **Software Heritage** (D07-6): on the request of a person who may push, an `archive` job whose `ref`
  is the tag (D00-15; Save Code Now takes the repository's tags with it).
- **Zenodo** (D07-5): on the request of a **verified author of the paper with an ORCID iD** (checked by
  the Worker, and again by the Mac), a `deposit` job: the map's digest must still be the one the author
  saw; then Phase 6's own `zenodo.validate` and `zenodo.deposit_map`, with the release: the tag as the
  record's version, **IsSupplementTo** the paper's DOI, **References** the release's code at its commit;
  a new version of the map's record when it has one (the same concept DOI). **The sandbox** unless the
  owner sets `OSCR_ZENODO_INSTANCE=zenodo`; a validation made with ORCID's sandbox is a test, which only
  Zenodo's sandbox takes and no public output shows (the static layer shows a real Zenodo's DOI only).
  The code is never deposited: an author who wants a DOI for the code itself turns on Zenodo's own
  GitHub integration, their own act outside the registry.

## Files (D07-8)

- Up to **25 MiB through the Worker**: the release page reads the file, computes its SHA-256 in the
  browser, and confirms `{release, name, label, size, sha256, contentType}`; the file waits in the tab's
  IndexedDB (`forge-files`, ten minutes, taken once) while GitHub authorizes; the callback page posts it
  to **`POST /api/forge/asset`**: the completion in headers (`X-Forge-Code`, `X-Forge-State`,
  `X-Forge-Payload` in base64url), the file as the body, its `Content-Length` required and held (more
  or fewer bytes and the upload fails). The Worker streams it to GitHub's upload host **without parsing,
  buffering or hashing it** (its 10 ms of CPU; `FixedLengthStream` in workerd), then compares GitHub's
  own SHA-256 with the page's: a different file is removed again, as the person.
- **Larger files** go on GitHub's own release page (up to 2 GiB), or to Zenodo or Hugging Face with a
  DOI for data (D00-9): the page says so, with the link. The registry never downloads an asset: every
  download link is GitHub's.
- Deleting a file is one authorization, its name typed (`asset_delete`); an immutable release's files
  are GitHub's to keep.

## Environments (D07-13, D07-14)

The release page's **Environment** panel, and the view `environment/<ref>`, read the tree at the
commit (1 request) and each environment file raw (not counted; 12 files at most, 512 KiB each):
`requirements*.txt`, `environment.yml`, `renv.lock`, `Project.toml` and `Manifest.toml`, a `Dockerfile`,
`.devcontainer/devcontainer.json`, `pyproject.toml`, `setup.cfg`, R's `DESCRIPTION`, the lock files
(`Pipfile.lock`, `poetry.lock`, `uv.lock`, `conda-lock.yml`, `package-lock.json`…), Binder's
`runtime.txt` and `apt.txt`, at the root, in `binder/`, `.binder/` and `.devcontainer/`. Each is parsed
**as data** (`src/lib/environments.ts`): **nothing of the repository is built, installed or run**, in
the browser, the Worker or the Mac; the scripts (`setup.py`, `install.R`, `postBuild`, `start`) are named
and never read as code. What each says, in words, in its tone: how many packages are pinned to an exact
version, which have none, what comes from a repository or an address, a lock file that pins all, the
Python or R or Julia version, a container's base image pinned by its **digest** or only by a tag, a
file added from an address at build, a script piped to a shell, what a development container runs on
the machine that opens it.

**Where it can run again**: plain links, each saying **who runs it**: **Binder** (mybinder.org, a free
public service with its own rules and limits, when the repository has a file Binder reads) and
**GitHub Codespaces** (GitHub, under the visitor's own account and its quota, in the development
container the repository describes), at the release's tag. The registry runs nothing.

## Packages (D07-15)

OSCR hosts no package (GitHub Packages as a service is excluded: storage, bandwidth, and files the
registry cannot vet). The manifests' declared packages, `pyproject.toml` and `setup.cfg` (PyPI),
`DESCRIPTION` (CRAN), `Project.toml` (Julia's General registry), a public `package.json` (npm), a conda
recipe (conda-forge), are listed "declared by the repository", with their registry's page and an
install line pinned to the declared version (`pip install eeg-tools==1.2.0`,
`remotes::install_version(…)`, `conda install -c conda-forge …=…`, `Pkg.add(name = …, version = …)`,
`npm install …@…`). A person who may push **confirms or declines** each one (`package_confirm`, one
authorization, GitHub asked whether they may push): the registry keeps the word (`repo_packages`), and
the Mac publishes the confirmed ones in the static layer. The package stays at its registry.

## The actions (FORGE.md "Action kinds")

| kind | payload | GitHub, as the person | rows |
|---|---|---|---|
| `release_create` | `{tag, target (the commit's full id), name?, body?, draft?, prerelease?, latest?: "true" \| "false" \| "legacy", generateNotes?, paper?: {doi, version, label?}, map?, archive?, deposit?}` | the release (a draft makes no tag; a published one makes it at `target`) | 1 + the tie + a job each (`release` when published and tied, `archive`, `deposit`): ≤ 5 |
| `release_edit` | `{id, tag?, target? (a draft's only), name?, body?, draft?, prerelease?, latest?}` | the release; `draft: false` publishes | 1 + a `release` job per tie when it publishes |
| `release_delete` | `{id, confirm: its tag}` | the release (its tag stays) | 1 |
| `release_drafts` | `{}` | reads the releases, answers the drafts (masked) | 1 |
| `release_research` | `{tag, paper?: {doi, version, label?} \| untie?: doi, map?, archive?, deposit?: doi}` | asks whether the person may push; nothing written on GitHub | 1 + the tie (or its removal) + the jobs asked |
| `tag_create` | `{name, target, message?}` | a tag at a commit (annotated with a message) | 1 |
| `tag_delete` | `{name, confirm}` | the tag (not one a published release or a tie uses) | 1 |
| `asset_upload` | `{release, name, label?, size, sha256, contentType}` + the file (`POST /api/forge/asset`) | the file, streamed; removed again if GitHub's SHA-256 differs | 1 |
| `asset_delete` | `{release, id, confirm: its name}` | the file | 1 |
| `package_confirm` | `{registry, name, version?, source?, confirm}` | asks whether the person may push | 2 (the package, the action) |

None needs the repository to be one the registry follows: GitHub decides who may. `FORGE_OPEN` gates
every kind (the owner only until phase 16), the file route included. Migrations
`migrations/d1-forge/0006_releases.sql` (`release_papers`; `jobs` with `release`, `deposit`, `paper_id`,
`proof`; `actions` rebuilt) and `0007_packages.sql` (`repo_packages`; `actions` rebuilt).

## What it costs (PLATFORM_PLAN §15.4: ~150 requests, ~100 rows written, ~2,000 read a day)

Phase 08 adds the events of the in-site inbox ([SOCIAL.md](SOCIAL.md)): a release published writes its
event (1 row), a release tied to a paper's version its event under the paper (1 row): `release_create`
tied and published is 7 rows.

| step | Worker | D1 | GitHub (the reader's anonymous quota, 60 an hour) |
|---|---|---|---|
| the list | 0 signed out; 1 signed in (the shell's layer) | the layer's reads | the releases (1), the latest (1) |
| a release | 0 (1 signed in) | 0 | the releases (1), the latest (1), the tag's commit (1); the tree (1) and the environment files raw (not counted); `.gitattributes` and the tree on demand |
| the form | 0 (1 signed in) | 0 | tags, branches, releases, latest (4); the notes on demand: the comparison and the closed pull requests (2), `release.yml` raw |
| an action | 4 (the CSRF read and start, then the CSRF read and act or the file route) | 1–5 rows | the person's own quota |
| the Mac, a day |, | ~100 rows (answers, digests) from the facts push's budget | none (the map is the Mac's own; Zenodo's sandbox and Software Heritage on request only) |

## Security (the phase's self-review)

- **No token stored**: the person's token lives in `act.ts`'s `runAction` for one action, the file
  route included, and is revoked; the tab keeps the drafts' masked texts and, for ten minutes, the file
  the person chose, never a token.
- **CSRF and Origin**: `start`, `act` and `POST /api/forge/asset` need the session, its CSRF token and
  the site's Origin (tested: a forged token, another Origin, no session: refused before any exchange).
- **`FORGE_OPEN`** on every new kind (tested at start for another account's release and file).
- **Texts as view trees**: notes rendered by the registry's renderer after masking; names, labels,
  versions and environment readings as text nodes; no `innerHTML` in the phase's code.
- **No email address shown**: masked in notes, names, labels, drafts, environment files, the Mac's
  messages (no at sign in `jobs.message`), the tie's label (no at sign), the Zenodo record (public
  names only).
- **No open redirect**: the callback's links are `/r/` paths; the drafts' stash takes a repository from
  a `/r/<owner>/<name>/` path only; the Binder, Codespaces, registry and download links are fixed hosts
  built from checked names; a file's link is always GitHub's, never an answer's own address.
- **Never executed**: environment files and scripts are parsed or named, never run; the Mac reads no
  environment file; nothing of a repository is built.
- **Zenodo**: the sandbox by default; a deposit needs the author's role and ORCID iD twice; a sandbox DOI
  never in a public output; the end-to-end run's Mac is pointed at a local mock with an explicit
  `--instance sandbox`, whatever the settings say.

## Where the code is

| part | where |
|---|---|
| the actions | `website/worker/forge/service/act-releases.ts`, `act-packages.ts`, `paper-versions.ts`; `store.ts` (`release_papers`, `recentJobsOf`, jobs' `paper_id`, `proof`) |
| the file route | `website/worker/forge/service/asset.ts`, `act.ts` (`runAction`), `index.ts` |
| the signed-in layer | `website/worker/forge/service/read.ts` (`releaseTies`, `answered`, `packages`) |
| the database | `migrations/d1-forge/0006_releases.sql`, `0007_packages.sql` |
| GitBackend | `ReleaseAsset.digest` (`github/map.ts`, the double, the fake, the contract); the double's immutable releases |
| the pure parts | `src/lib/semver.ts`, `releases.ts`, `release-view.ts`, `release-stash.ts`, `environments.ts` |
| the pages | `src/scripts/repo-releases.ts`, `repo-release-assets.ts`, `repo-environment.ts`, `forge-client.ts` (the file store, `completeUpload`), `forge-authorized.ts`; `paper-research.ts` and `Later.astro` (the paper's versions of its code); `science.css` |
| the Mac | `oscr/forgejobs.py` (`release`, `deposit`, `archive` with a tag; `forge_map_version`; `--instance`), `oscr/zenodo.py` (a release's record), `oscr/forgelayer.py` (`releases`, `packages`, the papers' `map`) |
| tests | `tests/forge-service/releases.test.ts`, `assets.test.ts`, `packages.test.ts`; `tests/forge-pages/semver.test.ts`, `releases.test.ts`, `release-view.test.ts`, `environments.test.ts`; `tests/test_forgejobs.py`, `test_forgelayer.py`, `test_forge_schema.py`; the end-to-end run's phase 07 checks |
| screenshots | `docs/night-screenshots/phase-07/` |

## Deferred

- **Attestations** (GitHub's Sigstore bundles, `gh release verify`): GitHub's page for now; the
  registry's "Check a file" compares a local file's SHA-256 with GitHub's.
- **The Mac reading the manifests at each synced commit** and the registries' own metadata (versions,
  publication dates, a version withdrawn): the reader's browser proposes the packages now, a person
  confirms; the Mac publishes what was confirmed.
- **Deployments** as GitHub records them (no GitBackend method yet); a release's discussion and
  reactions (phases 06, 08); following releases (phase 08's inbox); `oscr release upload` and
  `verify-asset` (phase 14); per-asset download counts of the registry's own (GitHub's are shown).
- **A paper's release in an issue's Development section** (phase 05's page): the research issue says
  "fixed in the code" at its commit; the release that shipped it, later.
- Feeds (GitHub's own `releases.atom`, linked with the reason); the release form's `discussion`
  category (phase 06).
