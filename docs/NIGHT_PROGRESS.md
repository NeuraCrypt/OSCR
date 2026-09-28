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
| 02 Code navigation | night/phase-02-code-navigation | next: branch created from night/phase-01-git-hosting |

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

## Next step

Phase 02, code navigation, on branch `night/phase-02-code-navigation` (created from
`night/phase-01-git-hosting`): follow `docs/PLATFORM_PLAN.md` §15.6 "Phase 02"; the code view is
built inside the `/r/` shell (`website/src/scripts/repo-shell.ts`, `src/lib/repo-view.ts`), which
keeps phase 01's URL scheme (D01-5). The owner's actions are in `docs/NIGHT_REPORT.md` §2; until
the App exists, everything runs against the fake GitHub and the in-memory double.
