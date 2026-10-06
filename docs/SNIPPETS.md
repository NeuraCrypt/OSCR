# Snippets, the registry's gists (night phase 13)

A snippet is a few lines of code shared on their own: the registry's answer to GitHub's gists. See
`docs/PLATFORM_PLAN.md` §15.6 "Phase 13", `docs/DECISIONS.md` D13-*, and the code in
`website/worker/forge/service/snippets-core.ts`, `snippets.ts` and `act-snippet.ts`.

## Where a snippet lives

- **The files** live in a `snippets` repository in the researcher's **own GitHub account**, one
  **folder per snippet** (D13-1). The repository is created with a README on the first snippet, and
  each snippet (and each revision) is **one commit made by GitHub as the person**, through one
  authorized action (the phase-03 model, `act-commit.ts`): the person's token is used once and never
  stored, OSCR never asks for the Gists permission (D00-14) and never writes to GitHub itself.
  Revisions are the folder's commits; cloning, pushing and raw files are git's and GitHub's.
- **The record** lives in `oscr_forge` (`migrations/d1-forge/0018_snippets.sql`): a numeric id (the
  reference reports already use, `snippet:<id>`), the owner, the git location (the repository and the
  folder) and the revision committed, the visibility, the title and description, a **manifest** of the
  files (path, language, size, lines), an optional **paper passage**, the counts (stars, comments,
  forks) and who wrote it. **No file content and no git text are ever in D1** (the row budget): the
  browser reads the files from GitHub at the pinned revision, and the registry shows each one in its
  own reader (`/r/<owner>/snippets/blob/<revision>/<folder>/<file>`), never copied into the page.

## Public or unlisted (D13-2)

- **Public**: in discover, a person's list, and reachable by its link.
- **Unlisted**: out of discover, search, feeds, the public API and the sitemap, `noindex`; reachable
  by a direct link (and by anyone who can read the GitHub repository, said in words on the form). An
  unlisted snippet may be made **public**, never back.

## The record's native writes (`snippets.ts`)

The files and revisions are authorized commits; the record's own writes are the registry's native
routes, logged in `actions` so the caps count them (one cap, `snippets`, out of the 100 authorized
actions, `caps.ts`). Nothing here is written on GitHub.

- `GET  /api/forge/snippets`: one snippet (`?id=` or `?owner=&folder=`), discover (public, newest
  first), or a person's list (`?owner=`).
- `POST /api/forge/snippets/edit`: title, description, make public, comments on/off, the paper
  passage, and a hide (the owner or a moderator).
- `POST /api/forge/snippets/comment`: a comment (behind the human check), its edit (with a history),
  its deletion or hiding.
- `POST /api/forge/snippets/star`: star or unstar; the stargazers are read with the snippet.

The authorized actions (`act-snippet.ts`, kinds in `types.ts` ACTION_KINDS): `snippet_create`,
`snippet_revise`, `snippet_fork`. A fork copies the folder into the forker's own `snippets`
repository in one commit and records a new snippet (`forked_from`), bumping the source's fork count.

## Research additions (D13-3)

- A snippet is tied to a **paper passage**: a DOI and a Methods paragraph, with lines at the
  revision. It is shown **beside** the maps, **never as a map, never given a DOI** of its own.
- A snippet carries a **citation** (its page shows one, built from the author, the title and the
  pinned revision).

## Public free text (CLAUDE.md, the phase-16 note)

A snippet's description, its comments and the content shown are the registry's public, user-written
free text, protected the same way as discussions (D06-6): Turnstile on the write forms, the
per-account caps, the blocks and interaction limits (`mayInteract`), email **masking** (the shared
`maskEmails`, so `oscr_forge` holds no address), control characters stripped, the 65,536-character
comment limit, and triagers' **hide/delete** through the rows' own `hidden` and `deleted` columns.
The central owner-moderation queue and public reporting, and data-rights **erasure**, must be extended
to `snippet` and `snippet_comment` when phase 16 reconciles (D13-4; `content_reports` already lists
`snippet`).

## Deferred (D13-5)

Embedding with a script tag; a revision diff view, permalink UI and ZIP download (git and GitHub
serve these); subscriptions and notification fan-out for snippets; pins on a person's page;
discussion-style insights; the code-view affordance to make a snippet from selected lines (the API
already accepts a passage and files). Each is additive, never a file per snippet.
