# Hosting, sources and tools for harvesting the authors' code of papers

*2026-09-25. Three independent searches (hosting; sources, checked live; tools and
literature), plus our own measurements. Every figure carries its provenance: **[measured]**
here, **[verified]** on the official page or by a real call on 2026-09-25, **[unverified]**
otherwise.*

---

## On one page

- **Free hosting: yes, for the harvester** (not for the generation pipeline, which needs a
  GPU). The combination that holds without a credit card: **GitHub Actions** (the daily
  pass) + **a GitHub Release** (the SQLite database between two passes) + **GitHub Pages**
  (the public catalogue, and the light database readable by Datasette Lite). Ready file:
  `.github/workflows/harvest.yml`.
- **On the Mac: a continuous watch** (`launchd`, *Background* priority), plus a nightly
  publication to Hugging Face. Measured: 40 to 45 MB of memory, ~5% of one core at full
  work, no GPU. Files: `tools/org.oscr.{harvester,dashboard,nightly}.plist`, installed by
  `tools/install_mac.sh`.
- **The source of papers: Europe PMC** (free, no key, JATS full text). For a massive
  backfill of older papers: **the PMC Open Access bucket on AWS**, readable without an
  account.
- **Finding the code: five routes**, all coded but the last. By measured yield: the paper's
  text (availability section, references); the GitHub "DOI in the README" search; the
  Zenodo, OSF and figshare records; Crossref and DataCite; the neuroscience registries (to
  do).
- **What no longer works, or costs**: Papers with Code has been off since 2025-07-24;
  OpenAlex charges per use (lookups by DOI stay free with the owner's key); Hugging Face no longer gives free compute (Docker Spaces are
  reserved for paid plans); Code Ocean refuses robots.

---

## 1. What we measured

| Measure | Result | Provenance |
|---|---|---|
| open-access EEG/MEG papers from 2025 with the authors' code | **23 to 24 of 99** (~24%) | [measured], the corpus of the viability study |
| the same papers that only say "on request" | 4 of 99 (10 say it, of which 6 still publish a link) | [measured] |
| recent papers (2026-09-15 to 25, electrophysiology) with code | **7 of 18** | [measured], never seen during tuning |
| "neuro" papers from 2016-06-01 and 02 with code | **0 of 60** (and no link to a code host in their XML) | [measured] |
| accuracy of the "authors' code" verdicts, on review | 27 of 28 on the tuning corpus; **10 of 11 on new papers**, the only error (a malformed URL) fixed | [measured], read by hand |
| code repositories verified alive | 40 of 40; 6 already archived by Software Heritage | [measured] |
| cost of a pass over 99 papers | 158 s the first time, 58 s afterwards (cache); 64 MB at most; ~20 s of compute | [measured] `/usr/bin/time -l` |
| Europe PMC's search index under-reports code links | by a factor of **2.4**: the XML must be read | [measured] in the viability study |
| **recall, independent benchmark**: 150 papers from 11 neuroscience journals that a Zenodo software record itself declares it is linked to; 142 pairs where a creator of the software is an author of the paper | see below | [measured], `tools/zenodo_benchmark.py` |
| … the TEXT ALONE finds that exact repository | **73 of 102 papers with readable full text (72%)**; 51% over all papers | [measured], a pass without any metadata |
| … the text alone finds at least one repository of the authors' code | **97 of 110 papers with readable text (88%)** | [measured] |
| … with every route (text, Crossref, DataCite, archives) | 142 of 142, 149 papers of 150. **Partly circular**: DataCite reads the Zenodo relations that made the benchmark | [measured] |

**What the text cannot see** (the 29 exact repositories missed in readable text): 25 times
the paper gives ANOTHER code of its authors, which the harvester finds; 9 times neither that
repository nor any link in the text (a dataset citation without a DOI); once "on GitHub"
without a link. For those, only the metadata answers.

**What the benchmark taught** (each point locked by a test):
- Dryad files the CODE of a dataset in a companion Zenodo software record ("Data from: …",
  relation `isSourceOf`): Dryad is a mixed archive, and its verification looks for that
  companion;
- when DataCite says "data" and the text says "code" for the same archive, both are true:
  the code is kept;
- eLife cites its "generated" datasets with an `element-citation` in the statement, and a
  Dryad DOI sometimes loses its dot there;
- a section title is read at the nearest level ("Software availability" under "Materials
  and methods");
- "sample data" goes with software; it does not turn it into a dataset;
- an attached `.zip` file is not a domain name.

**What reading taught** (ten traps, each locked by a test): an untagged reference ("Schmidt
F. ECG_1f_memory"); software cited with its version ("Iso2Mesh … downloaded from"); "we" and
"used" read too broadly; a "repository" that holds data; PubMed and PMC links; the period
after a URL swallowed; the lone link in parentheses; the PLOS statement in `custom-meta`;
the reference call stuck to the DOI (`zenodo.15795242` + "93"); the DOI of a PsyArXiv
preprint read as an OSF project. Then, at verification: a BIDS dataset of 2,141 files
promoted to "code" for 3 scripts; a ZIP counted as zero scripts; an OSF project filed in
sub-components; a repository announced but empty.

---

## 2. Hosting

### 2.1 The table

Verdicts: **yes**, suitable · **caveats**, possible with reservations · **no**, unsuitable.
Figures [verified] unless stated.

| Offer | Free | What bites for this profile | Verdict |
|---|---|---|---|
| **GitHub Actions, public repository** | free minutes; jobs of 6 h at most; cron every 5 min at the most | cron delayed at the top of the hour; **disabled after 60 days without activity** (a commit of the workflow counts in practice, [unverified] officially); terms: usage tied to the project | yes |
| GitHub Actions, private repository | 2,000 min a month | 1 h a day ≈ 1,800 min: just enough | caveats |
| **GitHub Releases** | files under 2 GiB, unlimited total size and bandwidth | no CORS header: unreadable by the browser | yes, to store the database |
| **GitHub Pages** | 1 GB, 100 GB a month (soft), CORS `*` | forbidden for a commercial service | yes, as a showcase |
| A git repository | a file is blocked beyond 100 MiB | never commit the database there | caveats, JSON records only |
| Actions cache | 10 GB per repository | purged after 7 days without a read: not a backup | caveats |
| Hugging Face Spaces | Static Spaces only | **Gradio and Docker Spaces reserved for paid plans (2026)**: neither git nor cron | no for compute, yes for static |
| **Hugging Face, datasets** | "best-effort" public storage; a viewer and a DuckDB SQL console | not a database to rewrite all the time (super-squash advised) | yes, as a data showcase |
| HF Jobs (scheduled) | paid: $0.01 an hour on CPU, ~$0.30 a month | credits required | caveats, almost free |
| GitLab CI | 400 min a month | ~13 min a day at most | caveats |
| Codeberg (Woodpecker, Forgejo Actions) | on request, run by volunteers, "open alpha" | free licenses only | caveats |
| Cloudflare Workers | 10 ms of CPU per cron | no scan possible; a good TRIGGER for `workflow_dispatch` | caveats |
| Cloudflare D1 / R2 / Pages | 5 GB / 10 GB / 25 MiB per file | D1: 100,000 writes a day | caveats |
| Vercel Hobby | 1 cron a day, ± 59 min | a function without git | no |
| Netlify | scheduled functions of 30 s | too short | no |
| Deno Deploy | Classic closed on 2026-07-20 | — | no |
| Render / Railway / Fly.io / Koyeb | no free cron / a trial / no free tier any more / no free compute any more | — | no |
| Northflank | 2 cron jobs, a verified card [unverified in detail] | "not for production" | caveats |
| Google Cloud | an e2-micro VM, 1 GB of egress a month | card required | caveats |
| AWS | 6 months of credits since 2025-07-15 | the account is closed afterwards unless it switches to paid | caveats |
| Oracle Always Free | 2 OCPU / 12 GB | **reclaims idle VMs**: exactly our profile | no |
| Azure | Container Apps jobs in the free offer | card [unverified] | caveats |
| Modal | $30 a month offered; our estimated cost $0.5 to 1.7 a month | card [unverified] | yes / caveats |
| PythonAnywhere | **no free scheduled task since 2026-01-15**; internet on an allow-list | — | no |
| Streamlit Community Cloud | sleeps after 12 h | no scheduler | no |
| Datasette Lite | reads a database served with CORS (GitHub Pages does) | — | yes |
| Turso / Neon / Supabase / MotherDuck | 5 GB / 0.5 GB / pauses / 10 GB | — | caveats |
| Tailscale Funnel / Cloudflare Quick Tunnel / ngrok | expose the Mac | beta / tests only / 1 GB a month | caveats, useless with Pages |

### 2.2 Three zero-cost architectures

**A. All on GitHub (recommended, no card).**
- The `harvest.yml` workflow fetches the database from the `state` Release, runs
  `oscr run`, sends the database back to the Release, commits `library/` and publishes the
  public export on Pages.
- It breaks if:
  - nothing is committed for 60 days;
  - GitHub delays or skips a pass (the next one catches up; the cursor is idempotent);
  - GitHub judges the usage unrelated to the project (the grey zone of the terms).

**B. The Mac computes, GitHub exposes.**
- The background task runs on the Mac, then a `git push` sends the site to Pages. No server
  and no tunnel on the Mac.
- It breaks if:
  - the external disk is not mounted;
  - the Mac runs short of memory (it already swaps).

**C. Actions + Hugging Face.**
- Like A, but the database and the Parquet or CSV exports go to an HF dataset. The HF
  viewer becomes the public showcase, with shareable SQL queries.
- It breaks if:
  - HF changes its storage policy again;
  - nothing is committed on GitHub any more: uploads to HF do not count as activity.

### 2.3 The Mac, at its lightest

- **The settings**: `ProcessType=Background`, `LowPriorityIO`, `LowPriorityBackgroundIO`,
  `Nice 15`, `StartCalendarInterval` (macOS 26.4.1 recognizes all these keys, [verified]
  `man launchd.plist`).
- **If the Mac sleeps at the scheduled time**, the missed publication runs when it wakes up;
  the watch stops with the Mac and resumes when it wakes up.
- **Two macOS traps, seen on 2026-09-26:**
  - launchd opens no log on the external disk: the task dies before starting, exit code 78;
  - `/bin/zsh` started by launchd cannot read a script stored on that disk: exit code 127.

  On the other hand, Python started by launchd, and what it starts (git), read and write
  there. Hence: the logs in `~/Library/Logs/oscr`, Python started directly, the settings
  read by Python.
- **`taskpolicy -b`** also throttles the network: the pass would be slower. We did not use
  it.
- **Nothing is installed until** `tools/install_mac.sh` **is run** (installed on
  2026-09-26).

---

## 3. Sources of papers

| Source | Access | What it brings | State [verified] |
|---|---|---|---|
| **Europe PMC REST** | no key; ~1.4 requests per second sustained | search by period; the JATS full text of open-access papers and of some preprints | used |
| **PMC Open Access on AWS** | `s3://pmc-oa-opendata`, no account | every paper versioned (`PMC….1/….xml`, `.json`); a daily inventory | **for the massive backfill** (to code) |
| bioRxiv API | `/pubs` works; **`/details` returns an empty body** | a new DOI prefix, `10.64898` (55% of recent preprints) | JATS through the website, with frequent 429s |
| Crossref | no key; 5 requests per second (10 in the "polite pool") | references and relations, even for closed papers | used when there is no full text |
| OpenAlex | **charged per use since 2026**: a free key gives $1 a day; a lookup by DOI costs nothing (measured 2026-09-28) | institutions (ROR), open-access status, topics, citations, references, related works | used since 2026-09-28: one free lookup per paper (`oscr/sources/openalex.py`) |
| Semantic Scholar | a quota shared without a key | no code links | no |
| arXiv + Hugging Face Papers | no account | the `githubRepo` of paper pages, **arXiv only** | used for arXiv DOIs |

## 4. Sources of paper → code links

| Route | Measured or verified yield | Coded? |
|---|---|---|
| **The JATS text**: availability section, resources table, references signed by the authors, supplementary material | most of the 24% | yes |
| **GitHub "DOI in the README"** | eLife.100605 → exactly the authors' 2 repositories. On our 177 papers [measured]: **no authors' code beyond what the text found**; 5 repositories found, all rightly set aside (3 mirrors of OpenNeuro data, 2 reuses by students); 168 requests, 18 min without a token. Useful mostly without full text | yes (by default: with a token) |
| **Zenodo, OSF and figshare records** | resource type (software or dataset), files, license, source GitHub repository | yes |
| Software Heritage | archived or not; "Save Code Now" possible | yes for reading; archiving as an option, to code |
| Crossref (references, relations) | eLife types its software (`"type": "software"`) | yes, without full text |
| DataCite `relatedIdentifiers` | precise when declared, often silent | yes |
| OpenAIRE ScholeXplorer v3 (`/v3/Links?sourcePid=DOI&targetType=Software`) | relations often "cites": a cited tool, not the authors' own code | no, to try |
| Europe PMC Annotations | Zenodo and JOSS DOIs annotated by section; **no GitHub URL** | no |
| **ModelDB** (`modeldb.science/api/v1/models/<id>` → the paper's PMID or DOI → `github.com/ModelDBRepository/<id>`) | 1,931 computational neuroscience models | no, **to code: a reverse index** |
| G-Node GIN (`datacite.yml`: `IsSupplementTo` DOI) | neuroscience repositories with a DOI | no, to code |
| NeuroLibre (21 papers), ReScience C (223, of which 33 in computational neuroscience), CODECHECK (132, little neuroscience) | code linked by construction | no, **recall benchmarks** |
| DANDI, OpenNeuro | data; linked papers, no code | no |
| SciCrunch RRID (`scicrunch.org/resolver/RRID:SCR_….json`) | the repository URL of a cited TOOL | no, useful for the list of third-party tools |
| Code Ocean | **403 to any robot** | caveats, marked "unverifiable" |
| Papers with Code | off since 2025-07-24; a frozen archive on HF | no (machine-learning coverage) |

## 5. Extraction tools, and what the literature says

Published performance **[unverified]** unless stated.

| Tool | What it does | For us |
|---|---|---|
| ODDPub (R) | regular expressions for open data and code; Charité | its dictionaries, to port if needed |
| rtransparent (R, PLOS Biol 2021) | sharing indicators on PMC XML | a benchmark to compare with |
| Softcite / GROBID software-mentions | software mentions: **created / used / shared** | the right classifier if machine learning is ever needed (Java, heavy) |
| SoMeSci, CZI Software Mentions (67 M mentions, CC0) | benchmarks and a list of popular tools | an exclusion list of third-party tools |
| DataSeer / PLOS Open Science Indicators | code and data indicators of PLOS papers | a benchmark for PLOS |
| PyMuPDF (AGPL), pypdf (BSD), pdfplumber (MIT) [verified, 2026 versions] | links in PDFs (annotations) | for papers without XML (to code) |
| GROBID (Apache-2.0) | TEI with `<ref type="url">` | the same, as a Java service |

**Published heuristics to tell the authors' own code from a third-party tool**, all used
here:
- the section and the wording ("our code" against "using X");
- the link in both directions (the README cites the paper);
- the Zenodo record (`isSupplementTo`, type "software");
- the repository's creation date and stars;
- an account named after an author.

## 6. Python libraries

[verified] on PyPI and GitHub on 2026-09-25.

- **Kept here, on purpose**: `httpx` alone for the harvesting (and `huggingface_hub` for the
  nightly publication, added on 2026-09-26). The cache, the politeness, the JATS reading
  (`xml.etree`) and SQLite are written without dependencies, to run anywhere.
- **Useful if the project grows**:
  - `lxml` (fast JATS);
  - `huggingface_hub` 2.0 (`paper_info`, `list_papers`);
  - `githubkit` or `PyGithub`;
  - `python-gitlab`;
  - `oaipmh-scythe` (the active successor of Sickle);
  - `requests-cache` or `hishel`;
  - `tenacity`;
  - `RapidFuzz` (author names against accounts);
  - `idutils` (validates DOIs, SWHIDs, RRIDs);
  - `sqlite-utils`, `datasette`, `duckdb`.
- **Dormant, to avoid**: `pdfx` (archived), `papermage`, `unpywall`, `Sickle`, `backoff`,
  `cffconvert`, `osfclient`.

## 7. What remains to do, by expected yield

1. **Backfill of the past years** from the PMC bucket on AWS, rather than through thousands
   of Europe PMC requests.
2. **A reverse index of ModelDB and GIN**: computational neuroscience code linked to its
   paper by construction.
3. **Widen the recall benchmark.** The Zenodo one is done (§1). NeuroLibre, ReScience C
   (computational neuroscience) and CODECHECK remain, and above all CLOSED papers, where
   only the metadata speaks.
4. **Papers without XML**: links from PDFs (pypdf, pdfplumber), for closed journals whose
   PDF we have.
5. **Software Heritage archiving** ("Save Code Now") of the repositories found, as an
   option. It is an action towards a third-party service, so it must be enabled explicitly.
