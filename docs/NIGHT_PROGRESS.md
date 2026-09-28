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
| 01 Git hosting | night/phase-01-git-hosting | next: branch created from night/phase-00-research |

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

## Next step

Phase 01, Git hosting, on branch `night/phase-01-git-hosting` (created from
`night/phase-00-research`):
- follow `docs/PLATFORM_PLAN.md` §15.6, "Phase 01 — Git hosting and the mirror mode": 223
  features to build (98 Reproduce, 125 Adapt; 257 rows with the excluded ones in
  `docs/GITHUB_PARITY.md`);
- the forge service: wire `GitBackend` into the Worker (`POST /api/forge/start`, `/act`,
  `/webhook`, `GET /api/forge/repo`; the `FORGE` binding and the App's secrets in `env.ts`), the
  static callback page `/forge/authorized/` and the shell `/r/*`;
- the `oscr_forge` migration, the Mac's new job kinds, and the questions for the App's secrets
  and the new database in `tools/setup_cloudflare.sh`.
The owner's actions are in `docs/NIGHT_REPORT.md` §2; until the App exists, everything runs
against the fake GitHub and the in-memory double.
