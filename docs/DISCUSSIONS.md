# Discussions, the wiki and projects (night phase 06)

OSCR's own conversation, knowledge and planning surfaces, built on the research-issue model (D00-6:
GitHub's own objects stay on GitHub, OSCR's own objects live in OSCR). Code: the discussion core and
routes (`website/worker/forge/service/discussions-core.ts`, `discussions.ts`), the project core and
routes (`projects-core.ts`, `projects.ts`), the wiki action (`act-wiki.ts`); the schema
(`migrations/d1-forge/0014_discussions.sql`, `0015_projects.sql`, `0016_wiki.sql`). Decisions: D06-1
to D06-6 in `docs/DECISIONS.md`.

Every write is behind `FORGE_OPEN` (the owner only until phase 16, D01-1). These are OSCR's **first
public, user-written free text**: the phase-16 protections apply, and what is not yet reconciled is
named below and in D06-6.

## Discussions

A discussion belongs to a **space**, and there is a space per paper, per repository and per
organization (D00-6):

- `paper:doi:10.…` the paper's space, keyed by its DOI, even when the code is hosted elsewhere (the
  Discussion section reserved since phase 04); its **verified authors** hold the maintain role;
- `repo:<forge>:<id>` a repository the registry knows; its **maintainers** (and its registry manager)
  hold the maintain role;
- `org:<handle>` an organization (phase 09); its **owners and moderators** hold the maintain role.

A space holds up to **25 categories**, each with a format: `open` (a plain thread), `announcement`
(only a maintainer opens one), `qa` (questions, with answers and the answered state) and `poll`. A
space is created with its default categories (`DEFAULT_CATEGORIES`) when its first discussion opens;
every space has a `general`, a `q-a`, a `polls` and an `announcements` category.

A discussion carries a title, a body, a category, labels (10 at most), a state (open, or closed with
a reason: resolved, outdated, duplicate, off-topic, spam), upvotes, a lock, a pin, and a timeline of
events. A `qa` discussion may have one comment **marked as the answer**. A `poll` discussion carries
its options and their counts. Comments are numbered within the discussion (`discussion_comments`,
`WITHOUT ROWID`, the key holds the discussion); the comment length limit is **65,536 characters**
(D16's limit, here too). A comment may be a reply to another, upvoted, edited (by its author),
deleted (by its author or a maintainer), or hidden (by a maintainer).

**Votes** (`discussion_votes`) count each reader's upvote or poll choice once: the row stops a second
vote, and the count on the discussion or comment row is the truth the pages read. A vote can be taken
back, and a poll choice changed.

### The routes (`discussions.ts`)

```
GET  /api/forge/discussions?id=N                 one discussion, its comments, the reader's votes
GET  /api/forge/discussions?space=paper:10.…      a space: its categories and its discussions
POST /api/forge/discussions/open                  a new discussion (3 rows; 4 when the space is new)
POST /api/forge/discussions/comment               a comment (3 rows); its edit, deletion, hiding (2)
POST /api/forge/discussions/vote                  an upvote, a poll vote, or either taken back (3)
POST /api/forge/discussions/edit                  title, body, category, answered, labels, lock,
                                                  pin, close, reopen, transfer (2)
```

Anyone signed in opens a discussion (an announcement only a maintainer), comments (a locked
discussion takes comments from maintainers only), and votes. The author edits its title, body and
category, closes and reopens it. The space's maintainers do that too, and mark the answer, label,
lock, pin, transfer, hide and delete. A hidden discussion or comment is withheld from everyone but
its author and the registry's owner, who read it with the notice.

## The wiki (versioned by git)

GitHub offers no API for its own wikis, so OSCR's wiki is **Markdown pages on a `wiki` branch** of
the repository (D00-6), edited through the phase-03 one-authorized-commit model: the person's own
token, used once, never stored; OSCR never writes to GitHub itself.

```
wiki_edit  {base, createFrom?, message, description?,
            pages: [{slug, content} | {slug, delete:true}], sidebar?, footer?}
```

The first page makes the `wiki` branch (`createFrom` a commit of the repository); later pages commit
onto it (`base` the wiki head the page read, so a branch that moved fails). Pages are `<slug>.md`, the
sidebar `_Sidebar.md`, the footer `_Footer.md` (GitHub's convention). The commit is GitHub's, signed,
with the person its author (D00-14); the registry records only its action row (1 row). History, a
page at a revision, compare and revert are reads of GitHub in the reader's browser (0 Worker
requests, the §15.6 budget). The content is committed verbatim (a commit to the person's own
repository is their own text); the **masking happens when the registry displays a page**, as it does
for any file.

## Projects

A project is OSCR's own planning board, owned by a person (`user:<id>`) or an organization
(`org:<handle>`). Its **items** are GitHub's issues and pull requests, free-text drafts, and OSCR's
own research objects: **papers**, **tracing maps** and **reproduction reports**. Its **fields** are
built-in (`Title`, `Status`), custom (text, number, date, a single choice, an iteration) and
**research** (`paper`, `map_state`, `repro_outcome`). It has table, board and roadmap views.

A field's value lives in the item row as JSON (`project_items.field_values`): a change of one field
is **one row**, not one row per cell. Caps: **5,000 items** and **50 fields** per project.

### The routes (`projects.ts`)

```
GET  /api/forge/projects?id=N          one project: its fields, its items, its views (grouped)
GET  /api/forge/projects?owner=…        an owner's projects (its own, or org:<handle>)
POST /api/forge/projects/create         a new project with its built-in fields and views
POST /api/forge/projects/edit           the title, description, state or views
POST /api/forge/projects/field          a field created, changed or deleted
POST /api/forge/projects/item           an item added, changed, archived or removed
```

Only an owner (the author, an organization's owners and moderators, the registry's owner) manages a
project. A built-in field is never deleted.

## Caps (gate.ts, caps.ts)

The registry's own writes are logged in `actions` like the research writes, so the per-account caps
and the day's 5,000 rows count them. Phase 06's caps: `discussions` (20 a day, with `actions`),
`votes` (200 a day, its own), `projects` (10 a day, with `actions`), `project_edits` (300 a day, its
own, for items and fields). Discussion comments and edits count toward the 100 authorized actions,
like research comments and edits.

## Public free text: the phase-16 reconciliation (D06-6)

Discussions, projects and the wiki are OSCR's first public, user-written free text. The protections
in force now, all self-contained and already generic:

- **Turnstile** on the write forms (a new discussion, a new comment, a new project, a draft item);
- the **per-account caps** and the day's row budget;
- **blocks and interaction limits** of a repository space (`mayInteract`);
- **email masking** (`maskEmails`, the shared fixture) and control-character stripping on every text;
- the **65,536-character** comment limit;
- **triager hide, redact and delete** through the objects' own `hidden`/`state` columns.

What must be extended **when phase 06 merges** (deferred, named here and in D06-6): the central
owner-moderation queue and public reporting (`REPORT_KINDS`/`HIDDEN_KINDS`, the `moderation` and
`content_reports` table CHECKs, `hidden.ts`, the Mac's `oscr/moderation.py` static drop,
`src/lib/moderation.ts`, the shared moderation fixture) must cover the kinds `discussion` and
`discussion_comment`; and the nightly static export, search, feed and webhook of discussions must
drop hidden content. CLAUDE.md's "no free text of a reader is public" statement (the moderation
section) and `/policies/moderation/` must be updated then. No language-model moderator is added (no
free model fits the free plan reliably); rules, Turnstile, hiding and caps carry the load.

## Deferred (D06-5)

The reader-facing Astro pages and client scripts for discussions, projects and the wiki (the service,
schema, actions and caps are delivered and tested); custom category management beyond the default set;
an issue converted to a discussion and back; a discussion for a release; search qualifiers; the
public-API routes for discussions and projects; iterations/roadmap/insights charts, templates, status
updates and view export for projects; the Mac-side nightly static shards and moderation drop. See
D06-5 and D06-6.
