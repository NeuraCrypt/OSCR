# Night run: progress journal

The mission is `docs/NIGHT_RUN.md`. This journal is enough to resume: read it, then continue
from "Next step".

## How the night runs

- **Where**: the git worktree `/Volumes/Expansion/Scrapper/.worktrees/night`. Never switch the
  branch of the production checkout `/Volumes/Expansion/Scrapper`: it stays on `main`, and the
  harvester and the 04:17 nightly publication run from it.
- **Branches**: `night/phase-XX-name`, one per phase, each built on the previous one. They are
  pushed to GitHub. Nothing is merged into `main`, and nothing is deployed.
- **Orchestration**: one Workflow per phase, launched by the main Claude session.
- **Scratch outputs**: agents write their intermediate outputs under `data/night/`
  (git-ignored). If a session died mid-phase, look there and at `git status` before redoing
  work.
- **Fallback**: `./nuit.sh`, at the root of this worktree, relaunches headless sessions that
  resume from this journal. Start it only if no main session is orchestrating.
- `science.css` is at `website/src/styles/science.css`.
- **Tests at every commit**:
  - `.venv/bin/python -m pytest -q` and `.venv/bin/ruff check oscr tests tools`;
  - in `website/`: `npm test` under the default Node and under Node 22 (CI), at
    `/private/tmp/claude-501/-Volumes-Expansion-Scrapper/2afc683b-88a8-4f04-89f2-a048bee9e298/scratchpad/tscheck/node_modules/node/bin`;
  - then `CATALOG_DIR=<worktree>/tests/fixtures/public-catalog npm run build` and
    `npm run check -- --every-route`;
  - the strict type check, from `website/`, with the same scratchpad's `tsc`:
    `tsc --noEmit --strict --target es2022 --module nodenext --moduleResolution nodenext
    --allowImportingTsExtensions --lib es2023,dom,dom.iterable --skipLibCheck --typeRoots
    <tscheck>/node_modules/@types --types node worker/*.ts worker/*/*.ts tests/*.ts tests/*/*.ts`.

## Phases

| phase | branch | state |
|---|---|---|
| 00 research and architecture | night/phase-00-research | **done** 2026-09-29, pushed (last code commit 831deaf) |
| 01 Git hosting | night/phase-01-git-hosting | **done** 2026-09-29, pushed (13 commits, the foundation, E1 to E12, the end-to-end run) |
| 02 Code navigation | night/phase-02-code-navigation | **done** 2026-09-29, pushed (9 commits: E1 to E7, the security review, the close) |
| 03 Web editing | night/phase-03-web-editing | **done** 2026-09-29, pushed (6 commits: E1 to E5, the close) |
| 04 Forks and pull requests | night/phase-04-pull-requests | **done** 2026-09-29, pushed (7 commits: E1 to E6, the close) |
| 05 Issues | night/phase-05-issues | next: branch created from night/phase-04-pull-requests |

## Phase 00: what it produced

- `docs/GITHUB_PARITY.md`: the inventory of GitHub's features, 5,153 rows (Reproduce 2,413,
  Adapt 1,576, Exclude 1,164), each with its night phase. Section 3.4 lists 31 feature names
  decided differently in different sections: the phases settle them.
- `docs/DECISIONS.md` D00-1 to D00-16 and the "Git hosting" section of `docs/ARCHITECTURE.md`:
  OSCR does not host Git repositories itself (no option is both certainly compliant and free);
  repositories live in the researcher's own GitHub account, driven by OSCR's GitHub App with
  their consent, one authorization per action, plus the mirror mode; OSCR keeps its own layer
  in a new D1 database `oscr_forge`.
- `docs/PLATFORM_PLAN.md`: the phases of the GitHub side (01 to 16 and the new ones), with
  budgets; its §15.7 holds nine plan decisions to record in `DECISIONS.md` by the phase that
  builds each.
- `GitBackend`: `website/worker/forge/` (interface, errors, limits, masking, git objects, diffs,
  paths; the GitHub adapter in `forge/github/`), `website/tests/forge/` (in-memory double,
  contract suite, fake GitHub; 325 tests), `oscr/forge.py` (the Mac's read-only side) and
  `tests/test_forge.py` (24 tests), `tests/fixtures/emails.json` (masking pairs shared by
  Python and TypeScript).
- Tests at the close: pytest 426 passed; ruff clean; `npm test` 460 passed under Node 26 and
  Node 22; build 31 pages; `check --every-route` ok; strict `tsc` clean.
- Not wired into the Worker yet: nothing in `worker/index.ts` or `worker/env.ts` imports
  `forge/`, and `ForgeEnv` lives in `forge/github/index.ts`.

## Phase 01: what it produced

- The forge service in the Worker (`website/worker/forge/service/`): `POST /api/forge/start` and
  `/act` (one authorized action, the token used once and revoked, never stored), the action kinds
  (create, generate, link, papers, the settings, branches, autolinks, deletion with its 30-day
  grace, Software Heritage), `POST /api/forge/webhook` (≤ 2 rows a delivery), `GET /repo` and
  `/mine`. `FORGE_OPEN` unset: only `FORGE_OWNER_GITHUB_ID` may write.
- D1 `oscr_forge` (`migrations/d1-forge/0001_forge.sql`), bound locally; the owner's setup
  script creates it remotely and stores the App's secrets.
- The pages: `/new/`, `/new/link/`, `/new/import/`, `/repositories/`, `/forge/authorized/`, the
  `/r/` shell (home, settings, branches), the guides under `/hosting/`.
- The Mac: `oscr/forgejobs.py` (the jobs and the mirrors' heads), `oscr/forgelayer.py` (traced
  paths and the static layer shards); `oscr forge poll|mirrors|layer|status`.
- `GitBackend` gains custom autolinks (added, nothing changed).
- The local end-to-end run `website/tests/forge-service/e2e.sh` (every check passes) and the
  screenshots `docs/night-screenshots/phase-01/`.
- Decisions D01-1 to D01-29 in `docs/DECISIONS.md`; the contract in `docs/FORGE.md`.
- Tests at the close: pytest 470 passed; ruff clean; `npm test` 779 passed under Node 26 and
  Node 22; build 45 pages; `check --every-route` ok; strict `tsc` clean (the command now lists
  `$(find worker tests -maxdepth 3 -name "*.ts")`: `tests/*/*/*.ts` matches no file).

## Phase 02: what it produced

- The registry's own code viewer in the `/r/` shell, GitHub only as a last resort (the owner's
  directive, D02-2): directories, files (highlight.js, the line gutter, line and range anchors, the
  line menu, permalinks, the file tree, copy, download), history, commits, unified and split diffs,
  comparisons, image diffs (E1, E3).
- One Markdown renderer with math (TeX to MathML, no library), READMEs on the home and in
  directories (E2); tracing maps in the code view: 64 static shards, the lines a map links, "explain
  these lines", a commit's map links, permalinks read alike by the site and the Mac (E4); notebooks
  never run, CSV and TSV tables, SVG, PDF, maps and models in words, the Docs view (E5); languages,
  community files, "Cite this repository" (E6); the file finder `t` and the search of a small
  repository (E7).
- The security review's fixes (email addresses masked in attributes, a search's ref checked); the
  end-to-end run checks phase 02's addresses and the maps' shard.
- Docs: `docs/CODE_NAVIGATION.md`, `ARCHITECTURE.md` ("Code navigation (phase 02)"), decisions
  D02-1 to D02-19; screenshots `docs/night-screenshots/phase-02/` (31: desktop and phone).
- Tests at the close: pytest 472 passed; ruff clean; `npm test` 924 passed under Node 26 and
  Node 22; build 45 pages, 227 files; `check --every-route` ok (the 64 tracing-map shards held);
  strict `tsc` clean (worker and tests; page scripts with `--module esnext --moduleResolution
  bundler`); the end-to-end run: every check passed.

## Phase 03: what it produced

- One authorized action for every change made from the browser, `commit` (`act-commit.ts`, E1): ONE
  commit made by GitHub as the person (`createCommitOnBranch` with the head the page saw: a branch
  that moved is 409 offer new_branch, nothing recorded; the Git data API for moves and executable
  bits), a new branch at that head with phase 04's pull-request hook in the answer, a fork when
  GitHub says the person may not write (propose changes), trailers written by the Worker
  (co-authors' and the signer's GitHub no-reply addresses; sign-off when the repository requires
  it). 1 D1 row; `migrations/d1-forge/0002_commit.sql` adds the kind.
- The editor's pure core (`src/lib/editor.ts`, `secrets.ts`, E2) and the registry's own editor
  (E3): `edit/`, `new/` in the `/r/` shell, a transparent textarea over the viewer's
  `ol.lines.code` (highlight.js, the gutter, the exact indentation; no library that injects
  styles), EditorConfig, find and replace, go to line, wrapping, undo, rename and move by the name
  field, Edit / Preview / Changes, the draft in localStorage, a branch that moved merged in the
  browser when it can be; the commit dialog with the tracing-map links the change touches and the
  secret warning; "Edit" and the key `e` in the viewer.
- Uploads, deletions (a folder reviewed first) and images added to Markdown (E4); licence and
  code-of-conduct pickers, CITATION.cff from the paper, research metadata checked as written, the
  Markdown toolbar, keys, paste and slash commands, the community checklist's "Add" (E5).
- Docs: `docs/WEB_EDITING.md`, `FORGE.md` (the `commit` kind), `ARCHITECTURE.md` ("Editing in the
  browser (phase 03)"), decisions D03-1 to D03-19; screenshots `docs/night-screenshots/phase-03/`
  (30: desktop and phone, signed in against `wrangler dev` and the fake GitHub, a whole commit from
  the page to the callback's outcome).
- Tests at the close: pytest 472 passed; ruff clean; `npm test` 983 passed under Node 26 and Node
  22; build 45 pages, 227 files (no new file); `check --every-route` ok; strict `tsc` clean (worker
  and tests; page scripts); the end-to-end run: every check passed (an edit committed through the
  fake GitHub, a branch that moved refused, a new branch, a move, another account's commit refused).

## Phase 04: what it produced

- Ten authorized actions (E1): `fork`, `fork_sync` (`act-forks.ts`); `pull_open`, `pull_edit` (edit,
  close or reopen, bulk up to 25, draft or ready, reviewers, auto-merge, the head branch deleted or
  restored), `pull_review` (Comment, Approve, Request changes, line and multi-line comments,
  suggestions; the author may not approve), `pull_comment`, `pull_thread` (found as the person by a
  comment's id), `pull_merge` (at the head the page showed: 409 offer reload; GitHub's refusal: 409
  offer conflicts), `pull_update`, `pull_revert` (`act-pulls.ts`); the commit's `mergeParent` (a
  merge commit with two parents); `migrations/d1-forge/0003_pulls.sql`; GitBackend `repos.forks`
  and `repos.syncFork` (adapter, double, fake, contract). 1 D1 row each.
- The pure library (E2): `src/lib/pulls.ts` (addresses, GitHub's qualifiers with AND/OR/negation,
  closing keywords, the merge box in words, default merge messages, the change summary,
  suggestions, comment anchors, the pending review and "Viewed" in the browser, templates and the
  research template, prefill by address, suggested reviewers) and `codeowners.ts`.
- The pages: the list, the creation form under a comparison and the forks (E3: `repo-pulls.ts`,
  `repo-forks.ts`, the Pull requests tab, a fork's standing with Sync fork); the pull request's page
  (E4: `repo-pull.ts`: the conversation, role labels, the merge box, the sidebar with the reviewers
  suggested from CODEOWNERS and the paper's verified authors, commits, checks; `GET /api/forge/repo`
  `reviewers`, `migrations/d1-community/0003_roles_by_paper.sql`); Files changed (E5:
  `repo-pull-files.ts`: phase 02's diffs through hooks, line comments, the pending review, "Viewed",
  suggestions applied alone or as a batch, the tracing-map links per file); conflicts resolved in
  the browser (E6: `repo-conflicts.ts`, `lib/conflicts.ts`: one merge commit with two parents).
- The close: the end-to-end run's phase 04 checks (open, a line comment with a suggestion, the
  suggestion applied, a merge at a moved head refused, the merge, a conflict refused, another
  account's fork and comment refused); the security review's fixes (every text shown masked, no
  hidden address written back, D04-16); docs `docs/PULL_REQUESTS.md`, `FORGE.md`, `ARCHITECTURE.md`
  ("Forks and pull requests (phase 04)"), decisions D04-1 to D04-19; screenshots
  `docs/night-screenshots/phase-04/` (28: desktop and phone).
- Tests at the close: pytest 472 passed; ruff clean; `npm test` 1,036 passed under Node 26 and
  Node 22; build 45 pages, 227 files (no new file); `check --every-route` ok; strict `tsc` clean
  (worker and tests; page scripts); the end-to-end run: every check passed (77).

## Next step

Phase 05, issues, on branch `night/phase-05-issues` (created from `night/phase-04-pull-requests`):
follow `docs/PLATFORM_PLAN.md` §15.6 "Phase 05". Phase 04's hooks for it: `pull-page.ts`
`timelineOf` and `commentHead` (a conversation's timeline and role labels), `pulls.ts` `issueRefs`
and `closingRefs` (references and closing keywords), the list's query language (`parsePullQuery`,
`planQuery`, `matchPull`: GitHub's qualifiers, to extend for issues), `pull-common.ts`
(`whoIsHere`, `confirmAction`, the masking `el`), the sidebar's "Development" section, and the
labels ("Alters reported results" is shown when set; setting labels is phase 05's). The owner's
actions are in `docs/NIGHT_REPORT.md` §2; until the App exists, everything runs against the fake
GitHub and the in-memory double.
