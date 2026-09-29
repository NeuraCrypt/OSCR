# Issues in the registry (night phase 05)

The repository pages of the GitHub side let a researcher open, read, triage and close issues —
**inside the registry**, beside the paper and its tracing map. There are two kinds (D00-6):

- **GitHub's ordinary issues** stay GitHub's objects: read in the reader's browser on the reader's
  own quota, written by GitHub as the person, one authorization at a time (D00-4). Their numbers are
  shared with pull requests, and "Fixes #12" keeps GitHub's meaning.
- **Research issues** are the registry's own objects, in D1 `oscr_forge`: a **code error**, a
  **code–paper mismatch** (one tracing-map link: the paper's paragraph, the file's lines at a
  commit) and a **reproduction failure** (its reproduction report: the outcome, the environment, the
  commit, the data, the command, what the paper reports and what came out). They belong to a paper
  (its DOI) and its code — a GitHub repository the registry knows as that paper's code, or the code
  hosted elsewhere (Zenodo, OSF, Software Heritage…). They are named `research#12`, and a pull
  request that says "Fixes research#12" closes one when the registry merges it.

GitHub is OSCR's competitor: an issue is read, written, triaged and closed in the registry; a reader
is sent to GitHub only for what the registry cannot do, through a discreet "at the source" link after
a sentence that says why (D02-2). The decisions: [DECISIONS.md](DECISIONS.md) D05-1 to D05-19; the
phase's plan: [PLATFORM_PLAN.md](PLATFORM_PLAN.md) §15.6 "Phase 05"; the GitHub side's contract:
[FORGE.md](FORGE.md); what it builds on: [CODE_NAVIGATION.md](CODE_NAVIGATION.md),
[WEB_EDITING.md](WEB_EDITING.md), [PULL_REQUESTS.md](PULL_REQUESTS.md).

**In one paragraph.** Every page is a static shell — the repository's `/r/*`, and one new shell
`/research/*` for the research issues (no file per issue; signed out, no Worker request). The
reader's browser reads GitHub's issues from GitHub's anonymous API and shows them as view trees
(someone's text never becomes markup; email addresses are masked). Each write on GitHub — open,
edit, close with a reason, comment, react, label, assign, milestone, type, lock, pin, transfer, a
sub-issue or a dependency, a branch, the labels and milestones — is one authorized action of phase
01's flow: the Worker acts once as the person, checks GitHub's answer, writes one D1 row (the
action's) and revokes the token. A research issue is written by the registry's own routes (one
Worker request, 2 or 3 rows), under `FORGE_OPEN` like everything else; signed-out readers read it
from nightly static shards, "as of last night".

## The addresses (GitHub's own shapes, D05-3)

| address | view | script |
|---|---|---|
| `/r/<o>/<n>/issues/?q=…` | the list: GitHub's issues and the research ones together, the filter, bulk actions | `repo-issues.ts` |
| `/r/<o>/<n>/issues/new/choose` | the chooser: the research forms, the repository's templates and forms, contact links | `repo-issues.ts` |
| `/r/<o>/<n>/issues/new?template=…` | the form: blank, a Markdown template, an issue form, or a research form (`research:mismatch`, `research:reproduction`, `research:code_error`) | `repo-issues.ts` |
| `/r/<o>/<n>/issues/<n>` | an issue: the conversation, the actions, the sidebar (a pull request's number goes to its page) | `repo-issue.ts` |
| `/r/<o>/<n>/labels`, `milestones`, `milestone/<n>` | labels; milestones and one milestone's issues | `repo-issues.ts` |
| `/research/<n>` | a research issue | `research.ts` |
| `/research/new?type=…&doi=…&code=…` | a research form for code hosted elsewhere (a GitHub repository's goes to its `/r/` form) | `research.ts` |
| `/research/?paper=<doi>` | a paper's research issues (signed in) | `research.ts` |

The repository's bar gains **Issues** between Code and Pull requests.

## The list (D05-4)

- **The filter** takes GitHub's issue qualifiers — `is:open|closed|locked|unlocked|pinned`,
  `reason:`, `author:`, `assignee:` (and `*`), `label:` (a comma is OR), `milestone:` (a title or a
  number, `none`), `type:`, `no:` and `has:` (label, assignee, milestone, type, sub-issues),
  `created:`, `updated:`, `closed:` (dates and ranges), `comments:`, `reactions:`,
  `interactions:` (counts and ranges), `sort:` (created, updated, comments, reactions and one
  reaction, interactions, best-match; `-asc`/`-desc`), `mentions:`, `commenter:`, `involves:`,
  `linked:`, `in:` — free words, `-`, `AND`, `OR`, parentheses; and the research ones: `is:research`
  (`-is:research`), `type:mismatch|reproduction|code-error`, `doi:`/`paper:`, `map-link:` (a
  paragraph, a file, or `14:src/filter.py`), `path:`, `resolution:`, `outcome:`
  (`src/lib/issues.ts` `parseIssueQuery`, `matchIssue`). `@me` is the reader's GitHub login.
- **What GitHub is asked**: its list endpoint (100 issues, 1 request) with the state, the labels,
  one milestone, assignee and creator, the sort; GitHub's search (10 a minute) only for what only it
  knows (`commenter:`, `involves:`, `mentions:`, `linked:`, `in:`), its query stripped of the
  registry's own qualifiers. The research issues: signed in, live (1 Worker request); signed out,
  the nightly layer shard, said "as of last night". Pinned open issues come first.
- **Bulk**: close as completed or not planned, reopen, add or remove a label, set a milestone, on up
  to 25 chosen issues (15 when labels change: each is read first) — ONE authorization.

## Opening an issue (D05-5, D05-6, D05-7)

- **The chooser** lists the registry's three research forms first (when the repository is attached to
  a paper: research issues belong to one), then the repository's templates and issue forms (the
  default branch's `.github/ISSUE_TEMPLATE/`, in GitHub's order; the legacy single template), blank
  issues (unless `config.yml` turns them off), the contact links (named by their host), and the
  contributing, security, support and code-of-conduct files as "helpful resources". A form GitHub
  would refuse is said, with its problems.
- **Issue forms** are read as GitHub reads them (`src/lib/issue-forms.ts`: markdown, input, textarea,
  dropdown with multiple and default, checkboxes with required options; upload said, not taken:
  attachments wait for phase 16's checks); required fields and ticked boxes checked before sending;
  the answers written as GitHub writes them ("### Label", "_No response_", "- [X]", a code block for
  a `render` field); prefilled by field id, and the research fields by `field.<name>=`.
- **The form** takes GitHub's prefill parameters (`title`, `body`, `labels`, `assignees`,
  `milestone`, `template`, `type`) and the registry's (`doi`, `repo`, `commit`, `path`, `lines`,
  `paragraph`, `section`, `parent`), each checked; a preview in the registry's renderer with the task
  progress; labels (the most used first), assignees and milestone (GitHub keeps them for people who
  triage, and the answer says what it dropped); "Create more".
- **Similar issues** while writing: by shared words over the repository's recent issues and the
  research ones, the same file or paragraph weighing more — lexical, in the browser, no model
  (D05-9).
- **Suggestions set by rule** (automated-decision transparency, D05-10): a label or a research type
  the text suggests ("it names versions or packages"), each marked "set by rule" with its reason,
  never applied without the person, who adds or declines each; a research type opens that form with
  the title carried.
- **From the code and the paper**: a file's selected lines offer "Reference in a new issue" (their
  permalink in its text) and, on a repository attached to a paper, "Report a code–paper mismatch on
  these lines" or "a code error" (the research form, prefilled with the file, the lines and the
  commit). The Code ↔ Paper reader offers "Report a mismatch" on each match (the paragraph, the
  lines, the commit the map read). The paper's page offers the three forms.

## An issue's page (D05-8)

- **The header**: the title and number, the state in words with its reason ("Closed as not
  planned"), the type, who opened it, the comments, the task progress, the lock.
- **The conversation**: the description and the comments rendered by the registry's renderer, "#12"
  and "research#3" linked, role labels in words (the author, a verified author of the paper);
  GitHub's events in words ("added the label “data”", "mentioned this in #9", linked when it is this
  repository); reactions as their characters and names.
- **Acting** (one authorization each, GitHub deciding what the account may): comment (a preview;
  the built-in and the reader's saved replies, kept in this browser; "#" and "@" completion; the
  "+1" nudge, which offers a reaction instead); quote a comment; reference it in a new issue; react
  or take one's reaction back; edit the title and the description, or one's comment; delete one's
  comment; tick the task list (one edit of the text); close as completed, not planned or a duplicate
  of #n (GitHub's "Duplicate of #n" comment with it); reopen; labels, assignees, milestone, type
  (GitHub's issue types belong to organizations); a sub-issue added or removed, "Create a sub-issue";
  blocked by #n or not; lock with a reason or unlock; pin or unpin; transfer to another repository
  of the same account; create the branch GitHub names for the issue ("12-the-title"); duplicate the
  issue (a prefilled form). A text holding an email address is edited at the source, said (D05-15).
- **The sidebar**: assignees, labels with their colour marks, type, the milestone and its progress,
  relationships (sub-issues and their progress, what blocks it, "Blocked" in words), development
  (the issue's branch, the mentions; "a pull request that says Fixes #n closes it"), participants.

## Research issues (D05-1, D05-2, D05-11 to D05-14)

- **Opening one**: the research forms ask what each type needs — a mismatch the paragraph, the
  file and the lines (the commit when known), and what the paper says and what the code does; a
  reproduction failure the outcome, the figure, the commit, the environment, the data, the command,
  what the paper reports and what came out; a code error the error and what it changes. The Worker
  checks that the repository is known as that paper's code (linked in the registry, or the Mac's
  `paper_repo` fact), or that code hosted elsewhere is a place the registry recognizes.
- **Its page** (`/research/<n>`): the conversation and its events in words, the report as a
  definition list, the paper (its paragraph and section) and the code (its lines at the commit, in
  the registry's viewer), the resolution, the labels, the copy on GitHub.
- **Who may do what** (D05-12): anyone signed in opens and comments (a locked conversation takes its
  triagers only); the author edits, closes and reopens; the **triagers** — the paper's verified
  authors, the code's maintainers (the registry's roles), the person who manages the repository in
  the registry (who linked or created it, or its owner), a moderator — also label, lock, pin (three
  "known issues" per paper) and hide comments.
- **Closing** takes GitHub's reasons and a **research resolution** that fits the type: fixed in the
  code, the paper was corrected, not a mismatch, the failure could not be reproduced, the data is now
  available — with what settles it (a commit, the correction's DOI); a duplicate names the other
  research issue.
- **A pull request closes one** (D05-13): its conversation's Development section says "Merging it
  in the registry closes the research issue research#12: fixed in the code"; the merge sends the
  numbers, and the Worker closes each one the pull request's own text names with a closing keyword,
  about this repository, when the merge goes into the default branch — "fixed in the code", at the
  merge commit (1 row each).
- **Copied to GitHub** (D05-14): its author may copy it, once, as an ordinary issue of its repository
  (the type's label, the paper's DOI, the permalink of the lines, "research#12"); the research issue
  names the copy. The registry never posts on GitHub on its own.
- **The paper's page**: Discussion lists its code errors and mismatches, Reproductions its
  reproduction failures, pinned ones first as "known issues"; signed out from the layer shards of
  its GitHub repositories, signed in live.

## The actions (FORGE.md "Action kinds")

| kind | payload | GitHub, as the person |
|---|---|---|
| `issue_open` | `{title, body?, labels?, assignees?, milestone?, type?, parent?}` | `POST …/issues`, then the sub-issue |
| `issue_edit` | `{number \| numbers (≤ 25; ≤ 15 with labels or assignees), title?, body?, state?, reason?, duplicateOf?, labels?: {add, remove}, assignees?: {add, remove}, milestone?, type?}` | `PATCH …/issues/{n}` (labels and assignees merged with what GitHub has), "Duplicate of #n" |
| `issue_comment` | `{number, body}` \| `{number, comment, body}` \| `{number, comment, delete: true}` | the comment, its edit, its deletion |
| `issue_react` | `{number, comment?, reaction, remove?}` | a reaction, or one's own taken back |
| `issue_lock` | `{number, locked, reason?}` | lock, unlock |
| `issue_pin` | `{number, pinned}` | GraphQL pin, unpin (three at most) |
| `issue_transfer` | `{number, to}` (a repository of the same account) | GraphQL transfer |
| `issue_relation` | `{number, sub?: {add \| remove}, blockedBy?: {add \| remove}}` | sub-issues, dependencies |
| `issue_branch` | `{number, name ("<n>-…"), from}` | a branch at the base's head |
| `issue_labels` | `{create?, update?, delete?}` (≤ 25 changes) | the repository's labels |
| `issue_milestone` | `{title, description?, dueOn?}` \| `{number, …}` \| `{number, delete}` | the repository's milestones |
| `research_copy` | `{id}` | an ordinary issue with the type's label; the research issue names it |
| `pull_merge` (+ `closes`) | `…, closes?: [research numbers] (≤ 5)` | the merge; then the research issues its text says it fixes are closed in D1 |

Each writes the action row only (1 row; `research_copy` and a merge that closes research issues 1 more
per research row). `migrations/d1-forge/0004_issues.sql` and `0005_research.sql` add the kinds.
None needs the repository to be one the registry follows: GitHub decides who may.

## The registry's own routes (research issues)

| route | body | rows written |
|---|---|---|
| `GET /api/forge/research?id=<n>` | — | 0 (the issue, its comments, what the reader may do) |
| `GET /api/forge/research?paper=<doi>[&paper=…][&repo=<forge>:<id>]` | — | 0 (≤ 10 papers, 100 each) |
| `POST /api/forge/research/open` | `{paper, repo: {forge, id, path} \| code, type, title, body?, commit?, path?, lines?: {start, end}, paragraph?, section?, report?, labels?}` | 3: the row, its index entry, the action row |
| `POST /api/forge/research/comment` | `{id, body}` \| `{id, n, body}` \| `{id, n, delete: true}` \| `{id, n, hide}` | 3 for a comment (the comment, the issue's count, the action row); 2 otherwise |
| `POST /api/forge/research/edit` | `{id, title?, body?, state?, reason?, resolution?, ref?, duplicateOf?, labels?: {add, remove}, locked?, lockReason?, pinned?}` | 2: the issue, the action row |

Signed in; a POST needs the session's CSRF token and the site's Origin; `FORGE_OPEN` (the owner only
until phase 16); 100 writes and 20 research issues per account a day, and the day's 5,000 rows,
counted from the action rows (`research_open`, `research_comment`, `research_edit`). Every text is
masked for email addresses before it is stored.

## What it costs (PLATFORM_PLAN §15.4: ~350 requests, ~550 rows written, ~20,000 read a day)

Phase 08 adds the events of the in-site inbox ([SOCIAL.md](SOCIAL.md)): a research issue opened writes
5 rows (its event and the author's follow of the thread), a comment 4 (5 for a first comment on the
thread), a close or reopen 3; a GitHub issue opened through the registry 3 (its event, the thread
followed), a comment 2.

| step | Worker | D1 | GitHub (the reader's anonymous quota, 60 an hour) |
|---|---|---|---|
| the list | 0 signed out; 1 signed in (the research issues) | ≤ ~1,000 read (10 papers × 100) | the list (1), labels (1), milestones (1, when needed); the search (1 of 10 a minute) |
| an issue | 0 | 0 | the issue, comments, timeline, what blocks it, the branch: 5; sub-issues, labels, milestones when it has them |
| the chooser, a form | 0 (1 signed in) | reads | the tree (cached for the tab), the templates raw (not counted), a page of issues for similar ones (1) |
| an action on GitHub | 4 | 1 row | the person's own quota |
| a research issue, a comment, a change | 2 (the CSRF read, the write) | 3, 3, 2 rows | none |
| a research issue signed out | 0 (a static shard) | 0 | none |

## Where the code is

| part | where |
|---|---|
| the actions | `website/worker/forge/service/act-issues.ts`, `act-research.ts`, `act-pulls.ts` (`closes`); `migrations/d1-forge/0004_issues.sql` |
| research issues | `website/worker/forge/service/research-core.ts` (the pure core), `research.ts` (the routes); `migrations/d1-forge/0005_research.sql` |
| GitBackend | `Issue.type`, `NewIssue.type`, `IssuePatch.type` (`github/issues.ts`, `map.ts`, the double, the fake, the contract) |
| the pure parts | `src/lib/issues.ts`, `issue-forms.ts`, `issue-view.ts`, `issue-page.ts` |
| the pages | `src/scripts/repo-issues.ts`, `repo-issue.ts`, `issue-links.ts`, `research.ts`, `paper-research.ts`; `src/pages/research/index.astro`; `src/components/paper/Later.astro`; the reader's `code.astro` |
| the Mac | `oscr/forgelayer.py` (`research`, the layer's `research`, `/forge/research/NN.json`) |
| tests | `tests/forge-service/issues.test.ts`, `research.test.ts`; `tests/forge-pages/issues.test.ts`, `issue-forms.test.ts`, `issue-view.test.ts`, `issue-page.test.ts`; `tests/test_forgelayer.py`; the contract (types); the end-to-end run's phase 05 checks |
| screenshots | `docs/night-screenshots/phase-05/` |

## Deferred

Attachments (phase 16's checks: the Mac inspects, Hugging Face stores); similar issues by the Mac's
local model (the nightly list; the lexical ones only now); saved views, the issues dashboard and
subscriptions (phase 08's inbox and notifications); issue fields and custom types (phase 09); projects
(phase 06); hiding a GitHub comment and pinned comments (GraphQL, no GitBackend method yet); the edit
history with its revisions' texts; reactions on research issues; deleting an issue; archiving
labels (no API); a research issue's map link marked "disputed" in the traced shards (the Mac's next
step); the parent of a sub-issue in its sidebar (REST does not say); the "Tracked by" of tasks.
