# Harvesting throughput and free hosting

*2026-09-26. The throughput comes from measurements made here [measured]. The offers were
checked on 2026-09-25 and 26 on the official pages by three independent searches
[verified]; [unverified] marks what could not be. Offers change fast: Oracle halved its
free tier in June 2026 without notice.*

> **Since this study**, the Mac runs the harvester continuously and publishes every night
> (see [GETTING_STARTED.md](GETTING_STARTED.md)), the website is on Cloudflare Workers (static assets; Pages until 2026-09-26), and the
> GitHub Actions workflow (`.github/workflows/harvest.yml`) is dormant: it only runs by hand.

---

## 1. Throughput

### What a pass does, measured

Measured on 300 "neuro" papers from August 2026, with the whole chain: text, judgement,
DataCite, verification of the repositories, fetching of the scripts [measured].

| Measure | Value |
|---|---|
| time per paper | **2.4 s** (720 s for 300) |
| throughput of a single pass | **~1,500 papers per hour**, ~5,000 script files per hour |
| papers with the authors' code | 31 of 300 (10%); 71 repositories verified; 1,004 files fetched |
| machine | ~5% of one core, 280 MB of memory at most (zips), no GPU |
| what limits it | politeness towards the APIs (Europe PMC and DataCite for every paper), not the machine |

With the GitHub "DOI in the README" search (with a token, 30 requests per minute), the cost
rises to ~4.5 s per paper. It found nothing more than the text on 177 open-access papers: it
stays on for the daily pass and off for the backfill.

### What there is to process

Europe PMC, open-access papers with full text [measured]:

| Scope | Whole backlog | 2025 |
|---|---|---|
| neuro (broad) | **614,336** | 73,225 (~200 a day) |
| electrophysiology (EEG, MEG, iEEG…) | **45,738** | 6,313 (~17 a day) |

### What that gives

| Where | Daily flow (neuro) | Backfill of the neuro backlog | Electrophysiology backlog |
|---|---|---|---|
| **GitHub Actions**, 1 pass a day + 1.5 h of backfill (the default setting) | ~8 min | ~2,250 papers a day, **~9 months** | **~20 days** |
| GitHub Actions, 4.5 h of backfill a day (`BACKFILL_HOURS=4.5`) | same | ~6,750 a day, **~3 months** | ~7 days |
| **The Mac, as a background task**, day and night | a few minutes | ~36,000 a day, **~17 days** | **~1.5 days** |
| A GitHub runner installed on the Mac (GitHub schedules, the Mac runs) | same as the Mac | same as the Mac, jobs of 5 days at most | same |

These projections use the rate of a pass at normal priority. At background priority, the
setting the Mac uses by default, the watch measured **~715 papers per hour** later on
2026-09-26 (358 to 436 papers per 30-minute slice) [measured]: about half the figures of the
Mac rows above.

### What really bounds the throughput: the API quotas

[verified]. On GitHub's shared machines, a "per IP address" quota is shared with other
users, so it is unpredictable.

| API | Limit | What the harvester does |
|---|---|---|
| Europe PMC | none stated; EBI's terms block any use that hinders others | 1.3 requests per second (below the ~3 per second considered polite) |
| DataCite | 3,000 requests per 5 min and per IP | 2 per second |
| Crossref | public: 5 per second and 1 concurrent; "polite" (declared contact): 10 per second | only without full text |
| Zenodo | guest: 60 per minute and **2,000 per hour** | spaced at 2,000 per hour |
| **Software Heritage** | **120 per hour anonymous**: this is the bottleneck | quota exhausted → set aside until the reset; the archive state stays "unknown" |
| **OSF** | ~100 per hour anonymous | quota exhausted → the repository is verified again at the next pass |
| GitHub API | 60 per hour anonymous, 1,000 per hour with the Actions token | used only with a token |
| git clones from github.com | tightened for anonymous users since 2025-05-08 | authenticated with the Actions token when there is one |
| the PMC bucket on AWS | none published | attached files; a lead for full texts in bulk |

To go beyond ~1,500 papers per hour, three things would be needed:
- read the full texts from the PMC bucket rather than calling Europe PMC;
- Software Heritage and OSF tokens;
- parallelism, API by API.

The research then estimates ~5,000 to 10,000 papers per hour. But on GitHub, the terms of
use forbid a "disproportionate burden": the big backfill belongs on the Mac or on a
self-hosted runner.

---

## 2. Where to run it for free

Verdicts: **yes**, suitable · **caveats**, possible with reservations · **no**, unsuitable.

### The options that work

| Offer | What is free | Reservations | Verdict |
|---|---|---|---|
| **GitHub Actions** (public repository) | unlimited minutes, 6 h jobs, 20 at once, cron every 5 min at the most, `git` and internet unrestricted, no card | a scheduled task is disabled after 60 days without activity; delays at the top of the hour; terms of use: usage tied to the project, no disproportionate burden (a grey zone for scraping) | yes |
| **A self-hosted runner on the Mac** | GitHub schedules and publishes, the Mac runs: jobs up to 5 days, the Mac's IP, no GitHub minute used | the Mac must be on; installing the runner is a permanent configuration | yes |
| **The Mac alone** (`tools/install_mac.sh`) | unlimited: a continuous watch, ~5% of one core, 40 to 45 MB, no GPU; the nightly publication to Hugging Face | the website must be published elsewhere (Pages) | yes, installed |
| **Modal** (Starter) | **$30 of compute offered every month** (~1,900 h at ¼ core), 5 crons, persistent volumes; researchers: up to $10,000 | card [unverified]; the SQLite database must be copied from the network volume | yes |
| **Google Cloud e2-micro** | a free VM with no end date, 30 GB of disk, cron | **credit card required**; US regions; **1 GB outbound per month**, so the website is published elsewhere | yes |
| **Oracle Cloud Always Free** | Ampere VM, **2 OCPU / 12 GB** (halved on 2026-06-15), 200 GB of disk, **10 TB outbound per month** | **reclaims idle VMs** (CPU, network and memory under 20% over 7 days): exactly our profile; "out of capacity"; a card is reportedly required | caveats |
| **Serv00** | 3 GB, 512 MB, **cron + SSH + Python**, no card | FreeBSD; a login required every 90 days; terms of use [unverified] | caveats |
| **Kaggle** (scheduled CPU notebooks) | one run a day at most, 12 h per session, no card | internet after phone verification; improvised persistence; terms outside data science [unverified] | caveats |
| Northflank (sandbox) | 2 free cron jobs | size, disk, card [unverified] | caveats |
| Azure Container Apps (jobs) | 180,000 vCPU-seconds per month | a card, or Azure for Students ($100 without a card) | caveats |
| alwaysdata (free) | 1 GB, 256 MB, ¼ CPU | cron and SSH [unverified]; 1 GB fills fast | caveats |
| GitLab CI | 400 min per month, 3 h jobs | ~13 min a day: the electrophysiology flow only | caveats |

### The dead ends, and why

- **Hugging Face Spaces**: creating a Docker or Gradio Space now requires PRO; for free, only
  static Spaces remain.
- **Render**: no free cron, an ephemeral disk.
- **Railway**: $1 a month after the trial.
- **Koyeb**: bought by Mistral on 2026-02-17, card required.
- **Fly.io**: no free tier any more, card required.
- **Choreo, Zeabur**: no hosted free tier any more.
- **Leapcell**: 15 min per run, no disk.
- **Databricks Free**: outbound internet on an allow-list.
- **PythonAnywhere**: no free scheduled task since 2026-01-15, internet on an allow-list.
- **AWS**: a 6-month free plan, then the account is closed.
- **EUserv**: IPv6 only, renewal fees.
- **Glitch**: closed on 2025-07-08.
- **Cirrus CI**: closed on 2026-06-01.
- **Azure Pipelines**: public projects withdrawn.
- **Bitbucket**: 50 min per month.
- **Vercel, Netlify, Cloudflare Workers, Apps Script, Pipedream**: no `git`, runs too short or
  too little CPU.

### Academic leads in France

- **IFB Biosphère**: a free cloud for life-science laboratories; it takes an account and an
  active group.
- **France Grilles FG-Cloud**: a free IaaS cloud for a laboratory, through the virtual
  organization of France Grilles.
- **Modal's research program**: credits on application.

All of them go through a laboratory.

---

## 3. Where to publish the site and the data

| Role | Choice | The limit that bites first |
|---|---|---|
| the site (catalogue + script lots) | **GitHub Pages** | 1 GB of site, 100 GB per month (soft) |
| the site, beyond 1 GB | **Cloudflare Pages** | 20,000 files, 25 MiB per file |
| the browsable data | **a Hugging Face dataset** (viewer + SQL console) | "best-effort" public storage, 10,000 files per folder, a few thousand commits |
| the durable archive, with a DOI | **Zenodo** (a monthly snapshot, 50 GB per record) + **Software Heritage** (the code) | — |

> **Superseded by the project rules** ([CLAUDE.md](../CLAUDE.md)): Zenodo DOIs are reserved
> for tracing maps validated by an author, so the catalogue is not deposited on Zenodo; the
> code stays archived at the source and by Software Heritage.

To dismiss for the site:
- **Netlify**: 15 credits per deployment, i.e. ~20 deployments a month;
- **Azure Static Web Apps**: 250 MB;
- **Firebase**: 10 GB per month, then the site is cut off;
- **Surge**: no CORS on the free plan;
- **Neocities**: 1 GB;
- **Amplify**: 6 months.

---

## 4. The recommended combination

1. **GitHub**: a public repository, the daily pass on Actions, the site on Pages, the
   database in the Release.
2. **The backlog**, backfilled once and for all:
   - either on the Mac (~17 days for all of neuro, ~1.5 days for electrophysiology);
   - or by a GitHub runner installed on the Mac;
   - or in slices of 1.5 to 4.5 h a day on Actions.
3. **Hugging Face** to show the data, **Zenodo** every month for the archive (superseded:
   see the note in section 3).
4. **As a fallback**: Modal (monthly credits) or Google Cloud e2-micro, if the Mac must no
   longer be used.

Main sources:
- GitHub: [limits](https://docs.github.com/en/actions/reference/limits), [terms of use](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features), [anonymous clones](https://github.blog/changelog/2025-05-08-updated-rate-limits-for-unauthenticated-requests/);
- clouds: [Oracle](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm), [Google Cloud](https://docs.cloud.google.com/free/docs/free-cloud-features), [Modal](https://modal.com/pricing), [Serv00](https://www.serv00.com/);
- Hugging Face: [Spaces](https://huggingface.co/docs/hub/spaces-overview), [storage](https://huggingface.co/docs/hub/storage-limits);
- APIs: [Crossref](https://www.crossref.org/documentation/retrieve-metadata/rest-api/access-and-authentication/), [DataCite](https://support.datacite.org/docs/is-there-a-rate-limit-for-making-requests-against-the-datacite-apis), [Zenodo](https://developers.zenodo.org/), [PMC bucket](https://pmc.ncbi.nlm.nih.gov/tools/pmcaws/);
- sites: [Cloudflare Pages](https://developers.cloudflare.com/pages/platform/limits/), [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits).
