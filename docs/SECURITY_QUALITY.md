# Security and quality (night phase 11)

The registry's security layer over the repositories it knows: a dependency graph, vulnerability and
malware alerts, a secrets scan, code scanning, private vulnerability reporting, an SBOM and licence
compatibility. It follows two rules without exception (D00-11):

- **Nothing of a user's code ever runs.** The Mac reads files as text; it never executes a manifest,
  never resolves dependencies, never installs anything, never runs an analyser. The Worker runs no
  analyser either; it shows what the researcher's own CI reported.
- **The analysis runs away from the site.** The Mac computes the facts and pushes them to the GitHub
  side's D1 database (`oscr_forge`); the Worker reads them (0 Worker requests for the analysis). A
  signed-in reader's Security tab is about 500 Worker requests a day (PLATFORM_PLAN.md §15.6).

Every write this phase adds is behind `FORGE_OPEN` (the owner only until the GitHub side opens, D01-1).
No email address is ever asked for, shown or stored; the texts are masked. The registry never opens a
pull request and never writes to GitHub (AUP): it shows Dependabot, it is not it.

## The six elements

### 1. The dependency graph (E1)

`oscr/depgraph.py` parses, as text, the environment files the inventory lists: Python (requirements,
pyproject, Pipfile, conda `environment.yml`, setup.cfg), R (`DESCRIPTION`, `renv.lock`), Julia
(`Project.toml`, `Manifest.toml`), JavaScript (`package.json` and the lock files: npm, yarn, pnpm),
and GitHub Actions workflows (`uses:`). Each dependency keeps its ecosystem, its exact version when a
lock file pins it, the declared range, its scope (runtime, build, optional, dev, actions), whether it
is direct (named in a manifest) or only pulled in by a lock file, whether it is pinned, and the files
it appears in (the view's "show paths"). Source precedence: a lock file's version wins over a range; a
manifest marks a dependency direct. Two snapshots: the default branch's head, and each commit a
paper's tracing map pins (`traced_paths`).

Facts: `repo_deps` (`migrations/d1-forge/0012_security.sql`), one row per dependency per snapshot,
pushed by `oscr security scan`. The Worker read is `GET /api/forge/security`; the Security tab's
Dependencies view has search, filters and "show paths" (`src/lib/security-view.ts`,
`src/scripts/repo-security.ts`).

### 2. Vulnerability and malware alerts from OSV (E2)

`oscr/osv.py` queries OSV (osv.dev), a free public database, without a key, with its batch endpoint
(one request for many packages). Only public package names, ecosystems and versions leave. It reads
the severity from the CVSS vector, flags a malicious-package advisory (OpenSSF's `MAL-` ids), marks a
withdrawn advisory and a development-scope dependency, and auto-triages by rule (a withdrawn advisory
is dismissed as a false positive). The ecosystems covered: PyPI, npm, CRAN, GitHub Actions (conda and
Julia are not covered by OSV and are skipped, never guessed).

Facts: `security_alerts` (kind `osv`). The human decision (dismiss, reopen, assign, label) is in
`alert_triage`, written by the Worker (`POST /api/forge/security/triage`, gated by `FORGE_OPEN`, a
manager of the repository), kept apart so a re-push of a finding never clobbers it. Dependabot pull
requests are GitHub's and the researcher's to switch on; the registry shows them and opens none.

During the night build the client never calls the real OSV: it is given a local fake, as the fake
GitHub stands in for GitHub. The real calls happen only when the owner runs `oscr security scan` with
the network.

### 3. The secrets scan after the push (E3)

GitHub's push protection refuses a push with a secret on public repositories; pushes do not pass
through the registry, so it cannot refuse one. After the push, `oscr/secretscan.py` scans the files
the Mac already stored (never re-fetched, nothing run) and **reports, never blocks**: structured token
shapes (the same kinds as the web editor's warning, a shared fixture keeps them in step:
`tests/fixtures/secret_patterns.json`), paired generic assignments marked as guesses, the owner's
custom patterns with a test string and a dry run, path exclusions, and remediation guidance. A leaked
value is never kept: only its kind, path, line and a short hidden hint. A leaked token reaches its
provider through GitHub's own partner programme, not through the registry.

Facts: `security_alerts` (kind `secret`). Shown in the Security tab; dismissible like an OSV alert.

### 4. Code scanning: SARIF (E4)

The researcher's CI runs its own analyser and uploads the result as SARIF 2.1.0 through the token API
(`POST /api/forge/v1/security/sarif`, the scope `security:write`, gated by `FORGE_OPEN`). `worker/forge/
service/sarif.ts` parses it (the rule, the level or `security-severity`, the file and line, the
data-flow code-flows, each text masked) and stores one `security_alerts` row per result (kind `sarif`,
source `ci`). The upload replaces the repository's earlier results. The registry runs no analyser: it
shows what the CI reported.

### 5. Policies and private vulnerability reporting (E5)

A reporter tells a repository's maintainers of a vulnerability in private: `POST /api/forge/advisory/
open` opens an advisory (`advisories`), a private thread (`advisory_posts`) lets the maintainers and
the reporter discuss, and the maintainers add collaborators and credits, draft the advisory, publish
it or withdraw it (`/api/forge/advisory/post`, `/edit`). A CVE through a numbering authority stays the
maintainers' own step; coordinated-disclosure guidance and the advisory databases (OSV, GitHub's) are
shown. An advisory is **private by construction**: never in a public output, the static layer, the
search, a feed or a webhook (the Mac never reads these tables); a read is refused to anyone but the
reporter, a named collaborator and a manager of the repository, until it is published.

### 6. SBOM and licence compatibility (E6)

`oscr/sbom.py` builds an SPDX 2.3 document (JSON and tag-value) from the dependency graph, one package
per dependency with a purl and the pinned version; a licence not stated is `NOASSERTION`, never
invented. It knows a compatibility table for the common open licences (permissive, weak and strong
copyleft, Creative Commons, public domain) and applies a licence policy (allow and deny lists), and
says a clash in words, never as a blocking error. `oscr security sbom` writes the SPDX files; `oscr
security scan` records each repository's licence and its dependencies' compatibility summary
(`repo_licences`). The Security tab's "Download SBOM" button builds the SPDX in the reader's browser
from the dependency graph (`src/lib/sbom.ts`): nothing of the code is sent. Dependency licences are
not fetched from the package registries (no network in the facts push); they are counted as unknown,
never guessed.

## The command line

```
oscr security scan   [--local | --remote]   # the dependency graph, OSV alerts, the secrets scan, the licences
oscr security status [--local | --remote]   # what the database holds
oscr security sbom   [--repo owner/name] [--sbom-out DIR] [--sbom-format json|tag-value]
```

`OSV_API_URL` points the OSV client at a fake for a development run; `OSCR_SECRETS_CONFIG` names the
JSON of the owner's secret-scan exclusions and custom patterns.

## The D1 tables (`migrations/d1-forge/0012_security.sql`)

| table | key | written by | what |
|---|---|---|---|
| `repo_deps` | (forge, repo_id, snapshot, ecosystem, name) | the Mac | the dependency graph |
| `security_alerts` | (forge, repo_id, kind, ref) | the Mac (osv, secret), the Worker (sarif) | the findings |
| `alert_triage` | (forge, repo_id, kind, ref) | the Worker | the human decision on an alert |
| `repo_licences` | (forge, repo_id) | the Mac | the licence and the compatibility summary |
| `advisories` | (forge, repo_id, ref) | the Worker | a private vulnerability report (private) |
| `advisory_posts` | (forge, repo_id, ref, n) | the Worker | the private thread |

All `WITHOUT ROWID`, no secondary index (every read is a key or a key range), no email, token, secret
or code column. The `actions` table's kinds gain `security_alert`, `sarif`, `advisory_open`,
`advisory_post`, `advisory_edit` (types.ts `SECURITY_KINDS`), with the caps `triage`, `scanning`,
`advisory` (caps.ts).

## Budget (PLATFORM_PLAN.md §15.6)

The analysis on the Mac: 0 Worker requests, OSV's free batch API, about 500 alert rows a day from the
facts push. A signed-in Security tab: about 500 Worker requests a day. A private report: 1 to 3 rows.
No paid tier is needed.
