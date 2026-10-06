# Editing in the browser: the registry's own editor (night phase 03)

The repository pages of the GitHub side let a researcher edit, create, rename, move, delete and
upload files **inside the registry**, in an editor that looks like its viewer, and commit the change
as themselves, in one step: GitHub makes the commit, as the person, from what the page confirmed.
GitHub is OSCR's competitor: a reader is sent there only when the registry cannot do what they ask
(a file over the Worker's 1 MiB, LFS), through a discreet "At the source" link after a sentence that
says why (D02-2). The decisions: [DECISIONS.md](DECISIONS.md) D03-1 to D03-19; the phase's plan:
[PLATFORM_PLAN.md](PLATFORM_PLAN.md) §15.6 "Phase 03"; the GitHub side's contract:
[FORGE.md](FORGE.md); the viewer it builds on: [CODE_NAVIGATION.md](CODE_NAVIGATION.md).

**In one paragraph.** Every editing view is the one static shell `/r/*` (no file per repository, no
Worker request while a person edits). The file is read in the reader's browser like the viewer
reads it; the change is kept in the reader's own browser as it is typed. "Commit changes…" opens a
dialog; its one sentence is the Worker's own (D01-28). Then the ordinary authorized action of phase
01 (D00-4): `POST /api/forge/start` declares the repository, the branch and the head the page read;
the person approves on GitHub; `POST /api/forge/act` makes ONE commit as the person -
`createCommitOnBranch` with `expectedHeadOid`, so a branch that moved meanwhile is refused (409,
offer new_branch), checks GitHub's answer, writes one D1 row, and revokes the token.

## The addresses (GitHub's own shapes, D03-2)

| address | view | script |
|---|---|---|
| `edit/<branch>/<path>` | a file in the editor (the key `e` and "Edit" in the file view open it; `#L12` puts the caret on line 12) | `repo-edit.ts`, `code-editor.ts` |
| `new/<branch>/<dir>` | a new file in a folder; `?filename=` and `?value=` prefill it, as GitHub's (a prefilled text is said: read it before committing) | `repo-edit.ts` |
| `upload/<branch>/<dir>` | files uploaded into a folder | `repo-upload.ts` |
| `delete/<branch>/<path>` | a file, or a folder and its files, deleted | `repo-upload.ts` |

The views act on a branch; at a tag or a commit, they say so and link the same view on the default
branch. The viewer links them: "Edit" and "Delete" in a file's header, "Add a file", "Upload files"
and "Delete this folder" in a directory's, "Missing: Add a licence · Add CITATION.cff…" in the home's
community files, and a note in a file's view when a draft of it is kept in the browser.

## The editor (D03-3, D03-4)

- **The viewer's own lines under a transparent textarea.** The visible layer is `ol.lines.code`:
  highlight.js's class-based output, the gutter of numbers, each line's exact indentation, tabs at
  the file's width. The textarea above it holds the text, drawn transparent with its caret and
  selection; both sit in one grid cell with one font, one line height and one left padding
  (`science.css` `.editor-surface`, `.editor-stack`, `textarea.editor-input`), so the caret sits on
  the letters. No library that injects styles: CodeMirror (the inventory's first choice) writes
  `<style>` elements, which the pages' CSP (`style-src 'self'`) and the science.css-only rule forbid.
- **Typing** redraws only the lines that changed (plain text at once); the file is highlighted again
  when the typing pauses, within the viewer's limits (plain beyond). Email addresses in the visible
  layer are hidden in place (`maskEmailsInPlace`: the same length, so the columns hold); the textarea
  keeps the file's text, which is what the commit writes.
- **Indentation**: `.editorconfig` (indent style and size, tab width), else what the file itself
  uses (tabs, or the most common step of its spaces), else 4 spaces (tabs for a Makefile or Go);
  changeable in the toolbar. Tab and Shift+Tab indent and outdent the selection (after Escape, Tab
  leaves the editor); Enter keeps the line's indentation, one level more after a line that opens a
  block. Line endings (CRLF kept) and a byte-order mark are kept; EditorConfig's
  `insert_final_newline` and `trim_trailing_whitespace` apply on the way out. A file opened and not
  changed is never rewritten.
- **Find and replace** (Ctrl/Cmd+F; match case, whole word, regular expressions; Ctrl/Cmd+G and
  Shift+Ctrl/Cmd+G), **go to line** (Alt+G), **wrapping** (kept in the browser), **undo and redo**
  (the browser's own: every change goes through its `insertText`).
- **The name field** renames and moves, as GitHub's: `a/b.py` makes folders, `../` goes up, `/`
  starts at the root; `.git` and anything above the repository are refused.
- **Edit, Preview, Changes**: the preview is the viewer's own renderers (Markdown with math,
  notebooks, tables); Changes is the diff against the version the change started from.
- **Limits**: files up to 512 KiB of UTF-8 text (their JSON must fit the Worker's 1 MiB); LFS
  pointers, binaries, submodules and symbolic links are changed with git; a file whose licence the
  viewer may not show (D02-7) is not opened either, its authors can add a licence here first.

## Drafts, and a branch that moved (D03-5, D03-6)

- The change is kept in the reader's browser (`localStorage`, every access in try/catch), keyed by
  the repository, the branch and the file (a new file: its folder, or the name the address gives),
  for a month, until committed. The callback page drops it once GitHub made the commit, and only
  then: a refused commit leaves it where it was.
- When the branch moved since the draft started: if this file did not change, the change simply
  applies to the latest version; if it did and the two changes do not overlap, a three-way merge in
  the browser (`diff.ts` `merge3`) brings it onto the latest version on request; otherwise, the
  commit goes on a new branch made at the version edited, and its comparison shows both.
- The Worker refuses a commit whose head moved between the page and GitHub's return (the
  compare-and-swap); the callback page says so and sends the person back to the editor, where the
  draft waits.

## The commit dialog (D03-7 to D03-11)

`src/scripts/commit-dialog.ts`, `src/lib/commit-view.ts`; opened by the editor, the upload page and
the delete page.

- **The message** (GitHub's default as its placeholder: "Update analysis.py", "Create CITATION.cff",
  "Rename a.py to b.py", "Delete docs directory", "Add files via upload") and an extended description.
- **Where the commit goes**: the branch shown, or a new branch (GitHub's `<login>-patch-N`
  suggestion) made at the version the change started from. The pull request itself is phase 04's:
  the Worker's answer names it (`pullRequest: {repo, base, head}`) and the callback page links the
  comparison of the two branches, in the registry's own viewer.
- **Propose changes**: when GitHub says the person may not write to the repository, their own copy
  (a fork, made by GitHub in their account) takes the change on a new branch. The sentence says so
  before anything is done.
- **Co-authors** by their GitHub accounts, read from GitHub's public API in the reader's browser
  (one request each); the Worker writes `Co-authored-by: <login> <<id>+<login>@users.noreply.github.com>`.
  **Sign-off**: `Signed-off-by` with the no-reply address of the account GitHub says authorized the
  action, when the person signs off or the repository requires it (GitHub's
  `web_commit_signoff_required`: the button then reads "Sign off and commit changes"). No address
  the person types ever reaches a commit's trailers (D00-14).
- **The research link**: the tracing-map links the change touches, lines a map links changed, or a
  file a map links moved or deleted, each with its paper, its Methods paragraph and its lines, and
  why a new branch is then recommended (it is chosen by default). A map keeps pointing at its own
  commit, so the paper's links stay valid.
- **The secret warning**: token shapes (GitHub, GitLab, AWS, Google, private keys, Slack, Stripe,
  OpenAI, Anthropic, Hugging Face, npm, PyPI, SendGrid, Twilio, Discord, a password in an address)
  found in what the commit writes, by line, the value hidden; committing anyway needs a tick.
  GitHub's own push protection may still block the commit.
- **The author**: GitHub makes and signs the commit as the person, with the address their GitHub
  settings give to web commits (the no-reply one when they keep theirs private).
- Then the one sentence, "Confirm on GitHub", and `/forge/authorized/`, which says what was done and
  links the file as committed, the commit and the comparison, `/r/` paths of the registry only
  (`forge-client.ts` `viewerLinks`: never another site).

## Uploads and deletions (D03-12, D03-13)

`src/lib/upload.ts`, `src/scripts/repo-upload.ts`.

- **Upload**: files chosen or dropped, a folder keeping its structure; each checked (its name, a
  file where a folder is, a submodule, `.gitattributes`' `filter=lfs` obeyed, unlike GitHub's web
  upload, since GitHub would commit the bytes themselves); a file of the same name is replaced,
  keeping its executable bit; texts go as text, other bytes as base64. One commit of up to 100 files
  and about 950 KiB of payload (≈ 714 KiB of bytes); larger: GitHub's own upload page (25 MB a file)
  or git, at the source, with the reason. Types are not restricted: git holds any bytes, and nothing
  uploaded is ever run or served as a page by the registry; a compiled program or a large binary is
  said in words. The files stay in the page only until committed.
- **Delete**: a file, or a folder and every file under it (at most 100), reviewed first; the history
  keeps them, said in words; the dialog lists the tracing-map links on them.
- **An image into Markdown**: pasted or dropped into a Markdown file, it joins the same commit next
  to the file, and `![Describe the image](name)` is written at the caret with the placeholder
  selected, the description is asked for, never required.

## Templates and writing aids (D03-14 to D03-16)

`src/lib/templates.ts`, `src/scripts/repo-templates.ts`.

- **Licences**: a file named LICENSE (or LICENCE, COPYING, `LICENSE-data`…) offers GitHub's licence
  templates, their texts from GitHub's licences API (in the reader's browser, one request), the year
  and the holder filled; each says what it means for the registry's copies of the scripts.
- **Codes of conduct**: CODE_OF_CONDUCT.md offers the Contributor Covenant and the Citizen Code of
  Conduct (GitHub's API); the contact, an email address in the originals, becomes the
  repository's page in the registry.
- **CITATION.cff from the paper** the repository is linked to (the paper as the preferred citation,
  one author entry per person with an ORCID iD, never an email address), and a **research README**.
  CITATION.cff, `codemeta.json` and `.zenodo.json` are checked as they are written, with the viewer's
  own reader: "CITATION.cff reads as: …" (APA), or what is missing.
- **Markdown**: a toolbar of plain words (Heading, Bold, Italic, Quote, Code, Link, Bullets, Numbers,
  Tasks) and its keys (Ctrl/Cmd+B, I, E, K; Ctrl/Cmd+Shift+7, 8 and .; Ctrl/Cmd+Shift+P the preview);
  a URL pasted over a selection makes a link; cells pasted from a spreadsheet make a table; the slash
  commands `/table 3x2`, `/code python`, `/details`, `/cite 10.…` (Enter at the end of the line).
  Ctrl/Cmd+Enter opens the commit dialog, Ctrl/Cmd+S keeps the draft now.

## What it costs (PLATFORM_PLAN §15.4: ~300 requests and ~150 rows a day)

| step | Worker | D1 | GitHub |
|---|---|---|---|
| opening an editing view, typing, previewing | 0 | 0 | the view's anonymous reads (the branches, the tree; the file and `.editorconfig` raw, not counted) |
| opening the commit dialog | 1 (`GET /api/account/me`: the CSRF token and the GitHub login, reused by the start) | reads | the branches (1); co-authors 1 each; a licence or code-of-conduct template 1 |
| committing | 3 (`start`; after GitHub, the callback page's CSRF read and `act`) | 1 row written (the action) | the person's own: 1 content-creating request (`createCommitOnBranch`), or the Git data API's few for a move or an executable bit; a fork for a proposal |

So a commit costs 4 Worker requests and 1 D1 row (the plan counted 2 requests: start and act; the
two CSRF reads are phase 01's flow, D03-19): ~600 requests and ~150 rows a day at ~150 commits.

## Where the code is

| part | where |
|---|---|
| the commit action | `website/worker/forge/service/act-commit.ts` (kind `commit`), `migrations/d1-forge/0002_commit.sql` |
| the editor | `src/scripts/code-editor.ts` (the surface), `src/scripts/repo-edit.ts` (the views, hooks `nameHelpers` and `editorAids`), `src/lib/editor.ts` (pure) |
| the dialog | `src/scripts/commit-dialog.ts`, `src/lib/commit-view.ts`, `src/lib/secrets.ts` |
| uploads, deletions | `src/scripts/repo-upload.ts`, `src/lib/upload.ts` |
| templates, aids | `src/scripts/repo-templates.ts`, `src/lib/templates.ts` |
| the callback | `src/scripts/forge-client.ts` (`startAction(…, {drafts})`, `viewerLinks`), `forge-authorized.ts` |
| tests | `tests/forge-service/commit.test.ts`, `commit-page.test.ts`; `tests/forge-pages/editor.test.ts`, `secrets.test.ts`, `commit-view.test.ts`, `upload.test.ts`, `templates.test.ts`; the end-to-end run's phase 03 checks (`tests/forge-service/e2e.ts`) |
| screenshots | `docs/night-screenshots/phase-03/` |

## Deferred

Emoji autocomplete; the workflow editor's schema validation (SchemaStore's licence to confirm before
bundling) and `devcontainer.json` help; co-authors chosen among the registry's accounts (GitHub
logins today); OSCR's own commit signing (GitHub signs web commits as the person, D00-7); a
protected branch said before the commit (GitHub refuses it at the commit, in words, and a new branch
is offered); the "Propose" of the community checklist as a pull request (phase 04); commits with two
parents from the browser (phase 04's conflict resolution uses the same action).
