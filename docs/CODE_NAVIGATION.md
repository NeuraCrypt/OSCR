# Code navigation: the registry's own code viewer (night phase 02)

The repository pages of the GitHub side show a repository's code, history, documents and tracing
maps **inside the registry**, in its own professional viewer and in `science.css`. GitHub is
OSCR's competitor: a reader is sent there only as a last resort, when they ask for something the
registry cannot show, through a discreet "At the source" link after a sentence that says why (the
owner's directive of 2026-09-29, D02-2). The decisions: [DECISIONS.md](DECISIONS.md) D02-1 to
D02-19; the phase's plan: [PLATFORM_PLAN.md](PLATFORM_PLAN.md) §15.6 "Phase 02"; the GitHub side's
contract: [FORGE.md](FORGE.md).

**In one paragraph.** Every view is served by the one static shell `/r/*` (no file per repository,
no Worker request for a signed-out reader). The reader's browser reads GitHub's anonymous API on
the reader's own quota (60 requests an hour) and the files from `raw.githubusercontent.com` (not
counted); the tab keeps GitHub's immutable answers (trees and commits by id) in `sessionStorage`.
What a repository holds never becomes markup or script: every view is a view tree of allowed
elements and attributes (`src/lib/repo-view.ts` `h`), turned into DOM nodes by
`src/scripts/dom.ts`; highlight.js's class-based output is read by a strict parser; Markdown,
notebooks and TeX are rendered by the registry's own code; email addresses are masked in every
text and every attribute read as text.

## The addresses (D02-1)

GitHub's own shapes, after `/r/<owner>/<name>/`, so that a GitHub address becomes the registry's
by changing its start:

| address | view | script |
|---|---|---|
| `/r/<o>/<n>/` | the home: the files, the README, the About panel (languages, community files, "Cite this repository"), the papers | `repo-shell.ts`, `repo-code.ts`, `repo-markdown.ts`, `repo-about.ts` |
| `tree/<ref>/<path>` | a directory: the file tree, the files with their size, the latest change, the README | `repo-code.ts` |
| `blob/<ref>/<path>` | a file: its lines (`#L10`, `#L10-L20`), rendered files (Markdown, notebooks, tables, SVG), images, PDFs; `?plain=1` the source of a rendered file, `?raw=1` the raw text | `repo-code.ts`, `repo-markdown.ts`, `repo-rich.ts`, `repo-traced.ts` |
| `commits/<ref>/<path>` | the history of a branch or a file, by day; `?author=`, `?since=`, `?until=`, `?page=` | `repo-history.ts` |
| `commit/<sha>` | one commit: message, people, signature, checks, the branches and tags at it, its diffs (`?diff=split`, `?w=1`), the tracing-map links it changed | `repo-history.ts`, `repo-traced.ts` |
| `compare/<base>...<head>` | GitHub's comparison (three dots), `<base>..<head>` the two trees (two dots); branches, tags, commits, a fork's `owner:branch`, `main~3`, `v1.0^` | `repo-history.ts` |
| `docs/<ref>/<page>` | the repository's documentation as pages (docs/, or the root's Markdown): GitHub Pages adapted, no author HTML or JavaScript | `repo-docs.ts` |
| `find/<ref>` | the file finder (key `t`) | `repo-find.ts` |
| `search/?q=…&ref=…` | the text search of a small repository | `repo-find.ts` |

The longest branch or tag that prefixes the segments is the ref, as on GitHub. Keys, never while
typing: `t` the finder, `w` the branch and tag switcher, `y` the permalink (the address at the
commit id), `l` jump to a line, `b` blame at the source.

## What each view costs the reader's quota

| view | GitHub API requests (at most; the tab's cache usually makes a second visit 0 to 1) | raw reads (not counted) |
|---|---|---|
| a directory, a file | the branches (1; the tags only when the ref is not a branch), the commit's tree (1, recursive), the latest change (1) | the file, `.editorconfig`, `.gitattributes`, `.gitmodules` |
| the home | the repository, its latest commit, its README (phase 01's 3), the branches and the tree | the README, its images, `.gitattributes`, `CITATION.cff` or `codemeta.json`, the owner's `.github` defaults (4 at most) |
| a history | the branches (1), one page of 30 commits (1) | — |
| a commit | the commit and its first 100 files (1), whether the default branch holds it (1), its checks (2) | expanded context, image diffs, the tracing maps' versions |
| a comparison | each side resolved (0 to 1), the comparison (1), or the two trees (2) | the two-dot files |
| docs, find, search | the branches and the tree | the pages, `.gitattributes`, the searched files |

The tracing maps' shard is a file of this site (`/forge/traced/NN.json`): no Worker request, no
GitHub quota. A spent quota says so, in words, with the time left, and links to the same view at
the source (`code-nav.ts` `degradedView`).

## The viewer (E1)

- **Highlighting**: highlight.js 11 (BSD-3-Clause), one module per language loaded when needed,
  its class-based output read into view trees by a strict parser (`src/lib/highlight.ts`
  `parseHljs`); the colours are `.hljs-*` rules of `science.css`. Linguist's language names, from
  `.gitattributes`' `linguist-language`, modelines, file names, extensions and shebangs.
  EditorConfig's tab width.
- **Lines**: `ol.lines.code`, one `li` per line with its id (`L12`), the numbers in a gutter of
  their own (`::before`: not copied, not found by the browser's search), each line's exact
  indentation (no wrapping; the block scrolls sideways). A click on a number selects the line,
  shift-click a range; the line menu copies the permalink or the lines, and says what a tracing map
  links to them.
- **Hidden and bidirectional Unicode** is shown as its code point, never applied, with a sentence.
- **The file tree** (`nav.file-tree`) beside every file and directory; above them on a phone.
- **Files**: Raw (in the viewer), Download (the bytes read), Copy; images from object URLs
  (`img-src blob:`); LFS pointers said as such (the object is never fetched: it would spend the
  owner's bandwidth); submodules and symbolic links resolved when they stay in the repository.
- **Limits** (D02-4): text files up to 1 MiB, images, notebooks and PDFs up to 10 MiB; highlighted
  up to 512 KiB, 20,000 lines and lines of 5,000 characters, plain beyond; Markdown rendered up to
  500 KiB (GitHub's cut), said in words.
- **The licence gate** (D02-7): a repository's files are shown under an open licence; without one,
  or one GitHub cannot identify, they are listed, not shown, and the home keeps phase 01's short
  README excerpt.

## History, diffs, comparisons (E3)

`src/lib/history.ts` (pure) and `src/scripts/repo-history.ts`: the commit list by day with its
filters; a commit's page; patches parsed with their line numbers; unified and split rows;
whitespace hidden as `git diff -w`; the context expanded from the raw files (20 more lines, or the
whole file); image diffs side by side, swiped or in onion skin (eleven steps, `science.css`); the
changed files as a tree with a path filter; a `.diff` built here from the patches (a `.patch`
would carry the authors' email addresses). Blame is GitHub's page (it needs a GitHub sign-in):
the line menu and the key `b` open it at the source, with the sentence (D02-5).

## One renderer: Markdown with math (E2)

`src/lib/markdown.ts`, written here, no dependency (D02-9): GitHub Flavored Markdown into view
trees. Headings with their anchors (`user-content-` ids, as GitHub) and the outline; CommonMark's
emphasis rules (with the openers' bottom: no quadratic time); code spans; fenced code highlighted;
quotes and alerts (`[!NOTE]` … `[!CAUTION]`, said in words); lists and task lists; tables with
their alignment; footnotes; `<details>`; reference links; bare addresses (GFM's rule for trailing
punctuation and parentheses); scholarly identifiers (DOI, arXiv, PMID, PMCID, RRID, SWHID, ORCID iD
with its check digit) and full commit ids as links; emoji shortcodes; entities.

- **GitHub's tag filter**: what runs or embeds (`script`, `style`, `iframe`, `object`, `form`, `svg`,
  `math`, `video`…) is dropped with its content; the authors' `style`, `class` and handlers never
  reach the page; `align` becomes a class; ids carry `user-content-`.
- **Links**: relative paths to the viewer at the page's ref; GitHub's addresses of a repository
  stay in the viewer; `javascript:`, `data:` and `mailto:` keep their text only.
- **Images**: relative ones and the same repository's raw addresses are read at the commit as
  bytes; an image on another site is a link naming its host, never loaded by the page (D02-6); a
  dark-only image is dropped (no dark theme).
- **Math** (`src/lib/mathml.ts`): TeX into MathML Core, drawn by the browser itself: no library,
  font or stylesheet. `$…$`, `` $`…`$ ``, `$$…$$`, ```` ```math ````; fractions, roots, scripts and
  limits, Greek, operators, fences, fonts, accents, matrices, cases, aligned; `\newcommand` and
  `\def` kept for the document, expansion bounded; an unknown command shown as its source; the
  source kept as an annotation.
- **Diagrams and maps** (D02-8): Mermaid, GeoJSON, TopoJSON and STL blocks are shown as source, with
  a sentence and "At the source".
- **READMEs**: under a directory's files and on the home (GitHub's precedence: `.github/`, the root,
  `docs/`); the Markdown one first.

## Tracing maps in the code view (E4: the research core)

- **The shards** (D02-10): `/forge/traced/00.json` … `63.json`, built at build time from the
  catalogue's alignments (`src/pages/forge/traced/[shard].json.ts`), keyed like the layer's
  (`layerShard`): per repository, each paper's map at its pinned commit, its pairs' paths, lines,
  section headings, paragraph numbers and symbols. No paper text: the paragraphs are read in the
  Code ↔ Paper reader, under its licence rules. `npm run check` holds the 64 files and what a pair
  may carry.
- **In a file**: the lines a map links in the reader's colours (`.pair-N`), a note of the
  paragraphs they carry out, each range selecting its lines and each paragraph opening the paper
  beside the code (`/paper/<slug>/code/#pair-N`). At another commit than the map's, the lines are
  found again: the map's version (a raw read) is looked for in the version shown; when the map's
  commit is gone, by the map's symbol; a range that changed says so.
- **"Explain these lines"** (no model): the line menu names the paragraphs the map links to the
  selection. **"Ask about a commit"**: a commit's page lists the map links whose lines it changed,
  kept, or could not find in its parent.
- **Trace points** (D02-11): permalinks read the same way by the website
  (`src/lib/traced.ts` `parsePermalink`) and the Mac (`oscr/forge.py` `parse_permalink`), both held
  to `tests/fixtures/permalinks.json`.

## Rich files (E5)

- **Notebooks** (`src/lib/notebook.ts`, D02-12): rendered from their JSON (nbformat 4, and 3's
  worksheets), never run. Markdown cells through the one renderer (math, attachments); code
  highlighted in the kernel's language; outputs in their richest safe form: images as `data:`
  addresses, SVG as an image, Markdown and LaTeX rendered, text, streams, errors without terminal
  codes. HTML, JavaScript and widgets never run: their text form, or a sentence.
- **Tables** (`src/lib/table.ts`): CSV and TSV (RFC 4180), the header, rows numbered, numbers
  aligned, a filter, a ragged row or an unclosed quote said, the first 1,000 rows.
- **SVG** files drawn as images (an `<img>` runs no script); **PDFs** opened in the browser's own
  PDF viewer from an object URL typed `application/pdf`, or downloaded (D02-13).
- **In words** (`src/lib/rich.ts`): GeoJSON and TopoJSON (their features by geometry), STL models
  (their triangles), Mermaid files, other markups (reStructuredText, AsciiDoc, Org…) shown as
  source with a sentence.
- **The Docs view** (`src/lib/docs.ts`, D02-14): the Markdown of `docs/` (or the root) as pages, their
  list beside them, links between pages kept in the view (`.md`, Jekyll's `.html`, a directory).

## About, citation, community files (E6)

- **Languages** in words, computed from the tree the page already read (D02-15): bytes per language,
  data and prose aside, vendored, generated and documentation paths aside (Linguist's common
  defaults), `.gitattributes` obeyed (`src/lib/attributes.ts`: `linguist-language`, `-vendored`,
  `-generated`, `-documentation`, `-detectable`, `binary`).
- **Community health files** by GitHub's precedence (`.github/`, the root, `docs/`; the licence at
  the root), the owner's `.github` repository as the default (D02-18), each linked in the viewer.
- **"Cite this repository"** (`src/lib/citation.ts`): `CITATION.cff` (a YAML subset read here) or
  `codemeta.json`, the preferred citation first, as APA 7 and BibTeX with Copy buttons; an
  author's email address is never read.

## Search in a repository and the keyboard (E7)

`src/lib/finder.ts`, `src/scripts/repo-find.ts` (D02-16):
- **The finder** (`t`): the tree's files matched as the reader types, GitHub's way (the letters in
  order, better at a name's start, in the file's name, in a run), the matched letters marked;
  arrows, Enter, Esc; vendored and generated files left out unless `.gitattributes` brings them
  back.
- **The search**: the text of a small repository read in the reader's browser when the form is sent
  (never as one types): 300 files and 4 MB at most, files over GitHub's 384 KB not searched; words
  or a phrase, `path:`, `language:`, match case; the first lines of each file, the words marked,
  each line a link to it. Beyond: GitHub's code search, which needs a GitHub sign-in, at the
  source, with the sentence.

## Where it meets the `code-first` branch

The parallel branch `code-first` rebuilds the live site's paper reader (`/paper/<slug>/code/`) on
the same model. Phase 02 keeps its code in its own files; they meet at:
- the `.hljs-*` rules of `science.css` (E1) and highlight.js's class-based output;
- `ol.lines.code` (the gutter, `li#L<n>`, `.highlight`) and `nav.file-tree`;
- the pairs' colours `.pair-1` … `.pair-6`: `src/lib/traced.ts` `pairClass` repeats
  `src/lib/lines.ts` `pairClass` (lines.ts imports without an extension, which Node's tests cannot
  load), and the reader's anchor `#pair-N`, which the tracing-map notes link to;
- `src/lib/markdown.ts` and `mathml.ts` could render the reader's paragraphs too.

## Deferred

Sticky lines and folding; the symbols pane, jump to definition and find references; find in file;
the 3D STL viewer; GeoJSON maps (a tile service); Mermaid drawings (inline styles the CSP forbids);
reStructuredText rendered on the Mac; the social preview; a release's DOI in the citation; "the
branches that contain a commit" (no REST endpoint); identical copies from the script store's
digests; rendered prose and notebook diffs; `linguist-generated` collapsed in diffs.
