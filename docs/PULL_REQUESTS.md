# Forks and pull requests in the registry (night phase 04)

The repository pages of the GitHub side let a researcher fork a repository, open a pull request,
read and review it line by line, apply suggested changes, resolve its conflicts and merge it —
**inside the registry**, in the viewer of phase 02 and the machinery of phase 03. GitHub keeps the
pull requests (they are GitHub's objects, D00-6) and makes every fork, review, commit and merge, as
the person, one authorization at a time (D00-4, D00-7). GitHub is OSCR's competitor: a reader is
sent there only for what the registry cannot show (a CI log), through a discreet link after a
sentence that says why (D02-2). The decisions: [DECISIONS.md](DECISIONS.md) D04-1 to D04-19; the
phase's plan: [PLATFORM_PLAN.md](PLATFORM_PLAN.md) §15.6 "Phase 04"; the GitHub side's contract:
[FORGE.md](FORGE.md); the viewer and the editor it builds on: [CODE_NAVIGATION.md](CODE_NAVIGATION.md),
[WEB_EDITING.md](WEB_EDITING.md).

**In one paragraph.** Every page is the one static shell `/r/*` (no file per pull request; signed
out, no Worker request). The reader's browser reads the pull request, its files, reviews, comments
and checks from GitHub's anonymous API, on the reader's own quota, and shows them as view trees
(someone's text never becomes markup; email addresses are masked). Each write — open, edit, close,
review, comment, resolve, merge, update, revert, fork, sync — is one authorized action of phase 01's
flow (`POST /api/forge/start`, GitHub, `POST /api/forge/act`): the Worker acts once as the person,
checks GitHub's answer, writes one D1 row (the action's), and revokes the token. A suggestion
applied and a conflict resolved are phase 03's `commit` (a merge commit with two parents for a
resolution).

## The addresses (GitHub's own shapes, D04-2)

| address | view | script |
|---|---|---|
| `pulls/?q=…` | the list, with GitHub's qualifiers; close or reopen the chosen ones | `repo-pulls.ts` |
| `compare/<base>...<head>?expand=1`, `pull/new/<branch>` | the creation form under the comparison | `repo-pulls.ts` |
| `pull/<n>` | the conversation, the merge box, the sidebar | `repo-pull.ts` |
| `pull/<n>/commits`, `pull/<n>/checks` | its commits; its checks, read from GitHub | `repo-pull.ts` |
| `pull/<n>/files` (`/changes`) | Files changed: diffs, comments, suggestions, the review | `repo-pull-files.ts` |
| `pull/<n>/conflicts` | the conflicts, resolved in the browser | `repo-conflicts.ts` |
| `fork/`, `forks/` | the fork form, the fork list | `repo-forks.ts` |

The home of a repository gains "Fork this repository · Its forks · Pull requests" and, for a fork,
its standing against its upstream (behind, ahead) with **Sync fork** and **Contribute** (a pull
request into the upstream). The tab "Pull requests" is between Code and Branches.

## The list (D04-3, D04-14)

- **The filter** takes GitHub's qualifiers (`is:open|closed|merged|draft`, `author:`, `assignee:`,
  `label:`, `no:`, `head:`, `base:`, `draft:`, `review-requested:`, `created:`, `updated:`,
  `merged:`, `closed:`, `sort:`), free words, `-` to negate, `AND`, `OR` and parentheses
  (`src/lib/pulls.ts` `parsePullQuery`). `@me` is the reader's GitHub login (asked of the Worker
  only then).
- **What GitHub is asked**: its list endpoint (100 pull requests, 1 request) with the state, base
  and sort, the rest filtered in the browser; GitHub's search (10 a minute) only when the query
  needs what only it knows (`review:`, `reviewed-by:`, `involves:`, comments).
- **Bulk**: close or reopen the chosen ones, up to 25, in ONE authorization (the sentence names
  them; one GitHub request each).

## Opening a pull request

Under a three-dot comparison of two branches (a fork's `owner:branch` as the head), "Create a pull
request" opens the form (at once with `?expand=1`, GitHub's address; `pull/new/<branch>` compares
with the default branch):

- **the title** from the branch, or from its only commit (GitHub's rule);
- **the description**: the default branch's template (`.github/pull_request_template.md`, the root,
  `docs/`; several in `PULL_REQUEST_TEMPLATE/`, chosen by `?template=`), else **the research
  template** when the repository is linked to a paper (what changes; whether it alters results
  reported in the paper; the paper; how it was checked; the issues it fixes), with a preview in the
  registry's own renderer;
- **prefill by address**: GitHub's `title`, `body`, `template`, `labels`, `assignees`, and the
  registry's `reviewers`, `draft` (each checked; a prefilled text is masked for addresses);
- **draft**, and for a fork **Allow edits by maintainers** (on by default: it lets the base's
  maintainers apply suggestions and resolve conflicts on the fork's branch);
- **reviewers**, with suggestions from CODEOWNERS (D04-11);
- the **closing keywords** said as they are typed ("Merging it closes #3"), with GitHub's rule:
  only a merge into the default branch closes;
- **the change in numbers** (files, lines per language, notebooks, data, licence, environment,
  citation files, workflows — computed, never a model's words) and **the tracing-map links it
  touches** (D04-12).

Phase 03's commit on a new branch links this form from its callback ("Open a pull request into
main").

## The pull request's page (D04-4, D04-10)

- **The header**: the title and number, its state in a word (Open, Draft, Merged, Closed), who
  wants to merge what into what, and the merge status at the top of every tab.
- **The conversation**: the description and the timeline — comments, reviews with their decision
  in words ("approved these changes", "requested changes"), the conversations each review started
  (a review comment and its replies, outdated said), rendered by the registry's Markdown renderer.
  Role labels in words: the pull request's **author**, a **verified author of the paper** (the
  registry's roles), a **code owner**. The comment form has a preview; a conversation can be
  answered, resolved or unresolved (D04-9).
- **The merge box**: the reviews and the checks in words; the mergeable state (clean, conflicts,
  behind, blocked, draft, still being checked); the three methods with GitHub's default messages
  (a merge commit names the pull request and its branch; a squash takes the title with its number
  and lists the commits); "delete the branch after merging"; **auto-merge** on or off; **Update
  branch**; **Resolve the conflicts** (here); Ready for review and Convert to draft; Close and
  Reopen; after a merge, **Revert** (a new pull request) and **Delete** or **Restore** the branch.
  A merge carries the head the page showed: if a commit arrives meanwhile, GitHub merges nothing
  (409, "read what changed, then merge again").
- **The sidebar**: the reviewers and their latest decision, "Ask for a review" and "Remove", the
  **suggested reviewers** — code owners of the changed files and the **paper's verified authors**
  (D04-10) — labels (and "alters results reported in the paper" when that label is set), the
  issues it closes (its text and its commits' messages), the papers, the change in numbers and the
  tracing-map links it touches.
- **Commits** and **Checks** tabs: the commits in phase 02's list; each check run and commit status
  in words, a CI's own log reachable "at the source" (the registry keeps no CI log and runs no code,
  D00-11).

## Files changed: the review (D04-7, D04-8)

- Phase 02's diffs (`repo-history.ts` `mountFiles`, through hooks): unified or split, whitespace
  hidden, the tree of files and its filter, highlighting; the **commit selector** (`?commit=`).
- **Viewed**, per file, kept in the browser (a file changed since is unviewed again), and the
  review's progress ("2 of 5 files viewed").
- **Comments on lines**: click a line's number (the new side; the old side for a deleted line),
  shift-click another in the same hunk for several lines. GitHub takes comments on the lines its
  diff shows (the registry's extra context is said to be outside). "Suggest a change" starts a
  ```` ```suggestion ```` block from the head's lines (not offered for lines holding an email
  address, D04-16).
- **A comment goes at once** (one authorization: a review of one comment) **or into the pending
  review**, kept in this browser (`localStorage`) until **Finish your review**: a summary and
  Comment, Approve or Request changes, submitted as ONE review on the commit the comments were
  written on. The callback page drops the pending review once GitHub took it, and only then. The
  author cannot approve their own pull request (said before GitHub is asked).
- **Suggestions**: shown as the change they make; **Apply this suggestion**, or **Add to the batch**
  then commit them all: ONE commit on the pull request's branch ("Apply suggestions from code
  review"), each suggester a co-author (their GitHub no-reply address, D03-9), not the person who
  applies. On a fork's pull request, GitHub takes it when the pull request allows edits by
  maintainers (D04-6).
- **The research layer**: above the diffs, the tracing-map links the pull request changes; above
  each file, its own links — the paper, the Methods paragraph (opening the Code ↔ Paper reader), the
  lines, and whether the change touches them (D04-12).

## Conflicts, resolved in the browser (D04-5)

`pull/<n>/conflicts` reads the merge base and both sides' changes (2 comparisons) and each
conflicting file's three versions (raw reads), computes the conflicts on the reader's CPU
(`src/lib/conflicts.ts` over `worker/forge/diff.ts` `diff3`) and shows each: the pull request's
lines, the base's lines, and what they were before both. Each conflict takes a choice — one side,
both in either order, or the reader's own lines — or the whole file is edited with git's markers.
Then ONE commit on the pull request's branch, **with two parents** (the pull request's head, the
base's head), made by GitHub as the person: phase 03's `commit` with `mergeParent`. The commit
starts from the pull request's tree, so it also writes the files only the base changed. What the
browser does not resolve is said, with the command line: a file deleted or renamed on one side and
changed on the other, a binary changed on both, more than 100 files or the Worker's 1 MiB.

## Forks (D04-15)

- **Fork**: into the reader's account or an organization of theirs, a name, the default branch only
  (GitHub's default) or all branches. The sentence says what a fork is: public, in the network,
  kept when the original is deleted or made private. GitHub keeps one fork per account: forking
  again finds it.
- **The fork list**: the repository's public forks, newest first (1 request).
- **Sync fork**: GitHub's merge-upstream — a fast-forward, or a merge commit when both moved; a
  conflict leaves the branch as it was, said.
- Leaving a fork network is GitHub Support's to do; the registry says so where it matters.

## The actions (FORGE.md "Action kinds")

| kind | payload | GitHub, as the person |
|---|---|---|
| `fork` | `{owner?, name?, defaultBranchOnly?}` | `POST …/forks` |
| `fork_sync` | `{branch}` | `POST …/merge-upstream` |
| `pull_open` | `{base, head, title, body?, draft?, maintainerCanModify?, reviewers?}` (the target's branch is the base) | `POST …/pulls`, then the reviewers |
| `pull_edit` | `{number \| numbers, title?, body?, base?, state?, draft?, reviewers?: {add, remove}, autoMerge?, headBranch?: "delete" \| "restore"}` | `PATCH …/pulls/{n}`, GraphQL drafts and auto-merge, reviewers, the head branch |
| `pull_review` | `{number, commit, event, body?, comments?: [{path, line, side?, startLine?, startSide?, body}]}` | `POST …/pulls/{n}/reviews` |
| `pull_comment` | `{number, body, replyTo?}` | `POST …/issues/{n}/comments`, or a reply |
| `pull_thread` | `{number, comment, resolved}` | GraphQL: the thread found by the comment, resolved or not |
| `pull_merge` | `{number, method, head, title?, message?, deleteBranch?}` (the target's head is `head`) | `PUT …/pulls/{n}/merge` with `sha` |
| `pull_update` | `{number, head}` | `PUT …/pulls/{n}/update-branch` |
| `pull_revert` | `{number}` | GraphQL `revertPullRequest` |
| `commit` (phase 03) + `mergeParent` | a resolution: `{branch, base, mergeParent, message, changes}` | the Git data API, two parents |

Each writes the action row only (1 row), `migrations/d1-forge/0003_pulls.sql` adding the kinds.
None needs the repository to be one the registry follows: GitHub decides who may. `FORGE_OPEN`
unset: only the owner may act (the end-to-end run checks another account's fork and comment
refused).

## What it costs (PLATFORM_PLAN §15.4: ~600 requests, ~300 rows written a day)

| step | Worker | D1 | GitHub (the reader's anonymous quota, 60 an hour) |
|---|---|---|---|
| the list | 0 (1 when `@me`) | 0 | 1 (the search: 1 of 10 a minute) |
| a pull request's conversation | 0 signed out; the shell's layer signed in | reads | the pull request, comments, reviews, review comments, commits, checks (2): 7; its files and merge base when the repository has maps (+2) |
| Files changed | 0 | 0 | the pull request, its commits, its files (1–3), its review comments, the merge base: 5–7; raw reads not counted |
| the conflicts | 0 | 0 | the pull request, 2 comparisons; raw reads |
| an action | 4 (the CSRF read, start; after GitHub, the CSRF read and act) | 1 row | the person's own quota |

## Where the code is

| part | where |
|---|---|
| the actions | `website/worker/forge/service/act-pulls.ts`, `act-forks.ts`, `act-commit.ts` (`mergeParent`), `migrations/d1-forge/0003_pulls.sql` |
| GitBackend | `repos.forks`, `repos.syncFork` (`github/repos.ts`, the double, the fake, the contract) |
| the verified authors | `service/read.ts` (`reviewers`), `migrations/d1-community/0004_roles_by_paper.sql` |
| the pure parts | `src/lib/pulls.ts`, `codeowners.ts`, `pull-view.ts`, `pull-page.ts`, `conflicts.ts` |
| the pages | `src/scripts/repo-pulls.ts`, `repo-pull.ts`, `repo-pull-files.ts`, `repo-conflicts.ts`, `repo-forks.ts`, `pull-common.ts` |
| tests | `tests/forge-service/pulls.test.ts`, `forks.test.ts`; `tests/forge-pages/pulls.test.ts`, `codeowners.test.ts`, `pull-view.test.ts`, `pull-page.test.ts`, `conflicts.test.ts`; the contract (`forks`, `syncFork`); the end-to-end run's phase 04 checks |
| screenshots | `docs/night-screenshots/phase-04/` |

## Deferred

The tracing-map guard as a GitHub check run (the App's installation token on `pull_request`
webhooks); the pull requests dashboard with its inbox and saved views (phase 08's inbox); stacked
pull requests' "merge the stack"; setting the "Alters reported results" label (phase 05's labels;
the page shows it when set); re-anchoring a map after a merge (the Mac); the merge queue; archiving
a pull request; reactions; the "Compare & pull request" banner; comments on a whole file and on a
commit; "Update with rebase"; rich notebook diffs; code owners on the file view; dismissing a review;
required reviewers and team reviews (phase 09); labels, assignees and milestones edited from the page
(phase 05); contributor role labels from GitHub's author association.
