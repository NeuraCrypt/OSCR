# Decisions of the night run

Each decision taken without the owner, with its reasons. The order of criteria (`docs/NIGHT_RUN.md` §1):
1. zero cost;
2. compliance with the services' terms;
3. security;
4. simplicity;
5. consistency with `CLAUDE.md`.

## Phase 00: how OSCR stores and serves Git repositories (2026-09-28/29)

The Git storage choice follows the order of criteria that `docs/NIGHT_RUN.md` §2.2 sets for it:
1. certain compliance with the services' terms: an option whose permission is not explicit is out;
2. zero cost: no payment card, no trial;
3. full compatibility with the standard `git` client;
4. reliability;
5. simplicity;
6. reversibility.

**How it was decided.**
- Seven reports were written tonight: Hugging Face, a GitHub organization, a Forgejo VM, a Git
  server on Cloudflare, the other hosted forges, repositories in the researcher's own account,
  and Cloudflare's free capacity.
- Three skeptics then checked each option against the services' own pages, read on 2026-09-28:
  one on the terms, one on the cost, one on the feasibility.
- The working notes stay in `data/night/storage/`, which is not committed. The facts that decide
  are copied into the entries below, with their sources.
- The full specification of the `GitBackend` interface, for the implementer, is
  `data/night/gitbackend-design.md` (also not committed). Its substance goes into the code's
  file headers.

### D00-1. OSCR cannot host Git repositories itself: no option is both certainly compliant and free

**Decision.** OSCR does not store Git repositories itself. With tonight's services and the owner's
rules, no storage owned by OSCR is both certainly allowed and free.

**Options compared.**

| option | 1. terms | 2. zero cost | 3. git | verdict |
|---|---|---|---|---|
| Hugging Face: repositories of an OSCR organization | **Unclear.** The Terms scope the Hub to machine learning. The Content Policy lists "irrelevant data" and proxies that bypass restrictions as abuse. Service accounts and token exchange are Enterprise-only. Sources: huggingface.co/terms-of-service, /content-policy, /docs/hub/enterprise-service-accounts | Holds for a pilot only: 100 GB private, public "best-effort" | **Fails.** A pre-receive hook refuses binary files and files over 10 MiB outside LFS/Xet. Imports must therefore rewrite history, which changes the commit ids tracing maps point to | out |
| A GitHub organization owned by OSCR, run by a GitHub App | **Unclear.** AUP §6 requires GitHub's express written permission to exploit "access to the Service". ToS §H reserves API access that would amount to resale for a separate, subscription-based arrangement. GitHub's own docs advise integrations not to centralize users' data (*Repository limits*) | Free, but tight for the whole platform: 10 GiB of LFS storage and 10 GiB of LFS download a month for the whole organization, and 500 content-creating requests an hour | complete | out as storage. The GitHub App is kept for the mirror mode (D00-2) |
| Forgejo on a free cloud VM | **Unclear.** Oracle's Cloud Services Agreement grants use for internal business operations only (§1.1). It forbids service-bureau use and making the Services available to third parties (§3.4(c)) | **Fails.** Oracle Always Free and Google's e2-micro both require a payment card. Azure and AWS offer no permanent free VM | excellent | out |
| A Git server on Cloudflare (Workers, Durable Objects, D1) | **Not fully confirmed.** Hosting content is explicitly allowed. But serving large files through the CDN is tied to *paid* services, and a proxy in front of storage hosted elsewhere is not explicitly allowed | **Fails.** A push must be indexed (inflate, resolve deltas, SHA-1). Measured tonight: 3–14 ms of CPU for a 0.3 MB pack and 24–91 ms for 1.7–3.5 MB, against a 10 ms budget. Card-free storage is at most ~8.5 GB against ~100 GB planned; R2 needs a card. The working implementations (git-on-cloudflare, Cloudflare Artifacts) run on paid plans only | not on the free plan | out |
| Other hosted forges: GitLab.com, Bitbucket, Codeberg, SourceHut, Gitea.com, Azure DevOps, CodeCommit and others | **Prohibited or unclear.** GitLab (§5.1, §8.1) and Atlassian (§2.1, §2.2) forbid serving third parties from one customer's account. Codeberg requires free licences, refuses mostly AI-written projects and refuses general-purpose hosting. The others grant no such permission | Mostly free, with tight quotas | good | out |

**Reasons.** Terms come first, and no option where OSCR holds the repositories has an explicit
permission. Cloudflare is the only one whose terms clearly allow hosting, and it fails zero cost
and git compatibility on the free plan.

**What would change it.** Each of these is the owner's decision, and none is both free and
certain:
- **A paid Cloudflare plan.** Workers Paid ($5 a month) plus R2 (about $1.35 a month more at
  100 GB). On a paid plan Cloudflare's terms allow serving large files, and the open-source
  git-on-cloudflare (MIT) becomes usable, as a `cloudflare` backend (D00-13).
- **Cloudflare Artifacts** once generally available: about $54.50 a month at 100 GB, Workers Paid
  included.
- **An institution's Forgejo or GitLab**, free and with no card, under an agreement the owner
  signs that allows hosting researchers' repositories: a `forgejo` or `gitlab` backend.
- **GitHub's written permission** under AUP §6 for an OSCR organization. This is an outside
  contact only the owner can make, and it is not recommended: the LFS and write ceilings would
  remain.

### D00-2. The choice: repositories in the researcher's own GitHub account, driven by OSCR's GitHub App with their consent, plus the mirror mode

**Decision.**
- **Hosting through OSCR.** A researcher gets a repository in their own GitHub account.
  - OSCR's GitHub App creates it with their authorization (`POST /user/repos`, or
    `POST /repos/{template}/generate` from a template), one repository per explicit request.
  - GitHub automatically gives the App access to the repository it created.
- **The mirror mode** uses the same machinery on an existing repository:
  - with the App installed on it, OSCR receives its webhooks and can write back with the
    researcher's authorization;
  - for a public repository without the App, OSCR only reads; the Mac polls it.
- **OSCR's own layer** sits on top: links to papers and DOIs, tracing maps pinned to commits,
  reviews, the scientific issue types, reproduction reports, and releases tied to paper
  versions.
- **The App is a new registration**, separate from the sign-in OAuth App, which stays as it is
  (no scope).

**Options compared.** D00-1's five options and this one. Only this one passes the first criterion:
- GitHub's documentation tells integrations to "store user-generated data in their own GitHub
  accounts rather than centralizing it in your account" (docs.github.com, *Repository limits*,
  "Integrations and GitHub Apps");
- a GitHub App acts on a user's behalf once authorized (*Authorizing GitHub Apps*);
- a user access token may create repositories under the "Repository creation" permission
  (*Permissions required for GitHub Apps*).

The terms skeptic confirmed exactly this core and nothing more:
- repositories in the researcher's own account;
- the App acting with the researcher's authorization;
- one repository per explicit request, through the documented endpoints;
- no bot accounts, no bulk activity, no git proxy;
- read-only mirroring of public repositories. ToS §D says the terms do not restrict lawful
  access to public repositories.

**Left out of the original proposal**, because no clause explicitly allows them:
- the Worker reading GitHub with the App's token on behalf of anonymous visitors (D00-5);
- running reproductions on GitHub Actions beyond the repository's own tests (D00-11);
- the clone alias on OSCR's domain as a default (D00-3).

**Reasons.**
- **Terms**: the first criterion is met.
- **Cost**: zero for OSCR. Registering an App is free, and every quota is the researcher's own.
  A free account without a payment method is blocked at its quota, never billed.
- **Git**: fully compatible, since GitHub is the server.
- **Reliability**: GitHub's for git, though GitHub Free has no availability commitment.
- **Simplicity**: the simplest option. There is no server, no storage and no proxy to run.
- **Reversibility**: the best option. OSCR holds no repository, and its layer is keyed by forge
  ids.

**What it costs OSCR.**
- Its own access control: GitHub decides who may push.
- Its own git tokens and clone URLs (D00-3).
- Refusing a push that contains a secret (D00-11).
- Researchers without a GitHub account. They create one themselves; the catalogue, the maps and
  the reviews never needed hosting.

**What would change it.**
- GitHub changing its terms or APIs. Precedent: the Source Imports API was retired in 2024.
- An OSCR-hosted option unlocked by the owner (D00-1).
- GitLab.com or Codeberg approved for researchers' own repositories (D00-16).

### D00-3. Git over HTTPS goes to github.com with GitHub's scoped tokens; OSCR runs no git proxy

**Decision.**
- **Clones and pushes go straight to GitHub.** Clone, fetch, pull and push use
  `https://github.com/<owner>/<name>.git` (or SSH) with the researcher's own GitHub credentials.
  No git byte passes through OSCR.
- **The scoped personal tokens are GitHub's.** The App's user access token is limited to:
  - the App's permissions;
  - the user's own rights;
  - the repositories where the App is installed.

  It expires after 8 hours.
- **The `oscr` command-line tool** (phase 14) gets such a token through GitHub's device flow:
  - it needs only the App's public client id, so the token never reaches OSCR;
  - it keeps the token in the researcher's own keychain;
  - it serves as git's credential helper for `github.com` only, never for OSCR's own host.
- **OSCR's own tokens** (phases 09 and 14) will reach OSCR's API and layer only, never git.
- **A clone alias on OSCR's domain** is designed but **off**. It would answer `…/info/refs` with a
  `302` to github.com; git follows that by default (`http.followRedirects=initial`), and no data
  would pass through OSCR. Why it stays off:
  - no clause addresses it;
  - the feasibility skeptic confirmed anonymous clones and same-host pushes through a redirect,
    but an authenticated push to github.com through one is untested.
  - Switched on, it could be a single static `_redirects` rule (0 Worker requests).

**Options compared.**
- **A Worker proxy** that checks an OSCR token and forwards git traffic. It is excluded on three
  counts:
  - GitHub's terms: AUP §6 ("access to the Service"), and ToS §H (tokens shared to exceed rate
    limits);
  - Cloudflare's terms: a proxy in front of content hosted elsewhere is not explicitly allowed,
    and serving large files through the CDN is tied to paid services;
  - the Worker's own limits: a 100 MB request body, and no SSH.
- **Installation tokens handed to users.** GitHub advises acting for a user with that user's own
  token.
- **Direct github.com URLs**, which are chosen.

**Reasons.** Terms and security: no shared credential and no pooled traffic. Simplicity: git
speaks to GitHub as usual.

**What would change it.**
- An OSCR-hosted backend (D00-1), where the Worker could check OSCR's tokens in front of it.
- The owner switching the alias on after a test clone and push with credentials.

### D00-4. Writes as the person: one authorization per action, no stored user token; the App's installation acts only for itself

**Decision.**
- **Every write on GitHub is made as the person**: create, commit, branch, merge, pull request,
  review, issue, release. It uses a GitHub App user access token obtained for that one action:
  1. The page records what the person confirmed (the action, and the SHA-256 of its payload) in
     a short signed cookie. The cookie lasts 10 minutes, uses the HMAC purpose "forge", is bound
     to the session and holds the PKCE verifier. Nothing is written to D1.
  2. The browser goes to GitHub and comes back to a static page, which posts the code and the
     payload.
  3. The Worker exchanges the code and checks that the GitHub account is the one linked to the
     signed-in OSCR account. It performs the action and checks that GitHub's answer matches it.
     Then it revokes the token.
- **The user token is never stored.** CLAUDE.md: a provider's token is used during the callback
  only. The refresh token is dropped.
- **The App's installation token serves only the App's own acts**: posting OSCR's check run on a
  pull request, and reading an installed repository after its webhook.
  - It is minted from the App's private key.
  - It is kept in the Worker's memory for its hour, never in D1, KV or a cookie.
  - `GitBackend` refuses any other write made with an installation token.
- **The App's secrets** (ID, client id and secret, private key, webhook secret) are Cloudflare
  secrets, created by the owner.

**Options compared.**
- **Keeping the user token encrypted in the session cookie for its 8 hours**: fewer round trips,
  but it stores a credential.
- **Writing with the installation token**: the changes would be attributed to the App, not the
  person. OSCR would also have to re-implement GitHub's permission checks, and GitHub's best
  practices say to act for a user with a user token.
- **One authorization per action**, which is chosen.

**Reasons.**
- It is consistent with CLAUDE.md's rule on provider tokens.
- It follows GitHub's best practice.
- Every change is attributed to the person who made it.
- No credential is kept at rest.
- It costs 2 Worker requests and 1 D1 row (the action log) per action.

**What would change it.**
- The owner accepting session-held user tokens.
- GitHub asking for consent on every authorization, which is to be tested once the App is
  registered. That would make the session-held token worth its risk.

### D00-5. Reading: each reader uses their own GitHub quota, straight from the browser; OSCR never serves reads with the App's token

**Decision.**
- **Repository pages are static shells.** One `_redirects` rule serves `/r/*`, with no file per
  repository, so a signed-out view costs 0 Worker requests.
- **The browser reads public repositories directly from GitHub**:
  - `api.github.com` allows cross-origin reads, at 60 requests an hour per reader's IP address;
  - `raw.githubusercontent.com` does not count in those 60. Since May 2025 it falls under
    GitHub's unpublished limits for anonymous traffic (github.blog changelog, 2025-05-08).
- **When a reader's anonymous quota is spent**, the page says so and links to the same view on
  GitHub.
- **Blame and code search** both require authentication on GitHub. For readers they are links to
  GitHub's own pages, and the command-line tool has local `git`. Search inside a repository still
  works in part:
  - file names are matched from the tree;
  - for small repositories, the text of raw files is searched in the browser.
- **OSCR's own layer** (links to papers, maps) is a small static index rebuilt nightly. A
  signed-in page asks the Worker once (1 request).

**Options compared.**
- **The Worker reading GitHub with the App's installation token** for anonymous visitors and for
  blame, as the original proposal did. The terms skeptic found no clause allowing a read proxy
  that pools one token's quota for third parties (AUP §6, ToS §H), so it is dropped.
- **Direct reads on each reader's own quota**, which are chosen.

**Reasons.** Terms: each reader spends their own quota. Cost: zero Worker requests for signed-out
reading.

**What would change it.**
- The owner accepting session-held user tokens (D00-4). A signed-in reader's blame and code
  search could then run on their own quota.
- The Mac could publish blame for the traced files at their pinned commits, as OSCR's own
  derived data. This is not decided.

### D00-6. Which objects live where: GitHub's own objects stay on GitHub, OSCR's own objects in OSCR

**Decision.**
- **On GitHub**, shown as GitHub serves them and written as the person:
  - pull requests (branches, merges, checks);
  - ordinary issues. They share their numbers with pull requests, and a closing keyword such as
    "fixes #12" works only there;
  - releases and tags.
- **In OSCR**, in D1 `oscr_forge` and on the Mac:
  - papers, DOIs, tracing maps and their reviews;
  - the scientific issue types: code error, code–paper mismatch, reproduction failure, tied to
    reproduction reports;
  - discussions and projects, per paper;
  - the link between a release and a version of the paper.
  - An OSCR issue can be copied to GitHub as an ordinary issue with a label, when its author
    asks, one at a time.
- **The wiki is versioned by git.** Its pages are Markdown files on a `wiki` branch of the
  repository, edited through commits. GitHub offers no API for its own wikis.
- **OSCR never acts on GitHub on its own initiative.** It never stars, follows, or opens issues or
  pull requests (AUP §4; no mass contact).

**Options compared.**
- **Copying everything into OSCR**: two sources of truth for the same object.
- **Making everything OSCR-native**: GitHub's semantics would be lost (closing keywords, merge
  state, checks).
- **A split by nature of the object**, which is chosen.

**Reasons.**
- Each object has one source of truth.
- GitHub's semantics stay intact.
- OSCR's scientific objects do not depend on GitHub.

**What would change it.** An OSCR-hosted backend (D00-1), where pull requests and issues could
become OSCR's own.

### D00-7. Commits and merges are made by GitHub, as the person, or on the researcher's machine

**Decision.**
- **A web edit is one commit per authorization**, made by GitHub's `createCommitOnBranch`
  (GraphQL):
  - it is one request, whatever the number of files;
  - `expectedHeadOid` is required, so a branch that has moved fails. The page then offers a new
    branch with a pull request;
  - GitHub signs the commit, and the person is its author.
- **Special cases use the Git data API**: moves without re-sending content, executable bits, and
  commits with two parents or none. The steps are blobs, a tree, a commit, then a ref update that
  refuses a non-fast-forward.
- **Branch merges** (`POST …/merges`) **and pull-request merges** (`PUT …/pulls/{n}/merge`, with
  the head the reader approved) are made by GitHub.
- **A merge conflict is resolved in the browser.** The three versions come from GitHub, and the
  conflicting hunks are computed on the reader's own CPU. The result is committed with two
  parents.
- **Nothing is built in the Worker or on the Mac.** No Git object is stored on Cloudflare (C5).
- **Payloads through the Worker are capped at 1 MiB to start.** The Worker must parse and rebuild
  them within 10 ms of CPU. The cap is to be measured in V8 and raised. Larger uploads use
  GitHub's own upload page, or `git push`.

**Options compared.**
- **Building commits in the Worker**: no Git objects are allowed on Cloudflare, and the CPU budget
  is 10 ms.
- **Building commits on the Mac**: it must never hold user tokens, and third parties' pushed
  content stays off it.
- **GitHub's Contents API, one file per request**: N requests, and not atomic.
- **`createCommitOnBranch`**, chosen, with the Git data API for the special cases.

**Reasons.**
- Atomic: the compare-and-swap on the branch head.
- Cheap: one content-creating request.
- Attributed and signed.
- Zero CPU on OSCR's side.

**What would change it.**
- CPU measurements, for the cap.
- An OSCR-hosted backend, where that forge would make commits and merges.

### D00-8. Imports run on the researcher's machine, or through GitHub's importer

**Decision.**
- **From GitHub, GitLab or any git host**, the `oscr` command-line tool runs
  `git clone --mirror` and `git push --mirror` on the researcher's machine. This keeps every
  commit id, so tracing maps pinned to the source stay valid. Alternatives:
  - GitHub's own importer page, which does not move LFS objects;
  - for a GitHub repository, simply linking it (mirror mode) or forking it.
- **From Zenodo**, the tool downloads the record's archive and makes one commit that cites the
  record's DOI. An archive has no history.
- **Never in the Worker, never on the Mac.**

**Options compared.**
- **GitHub's Source Imports API**: retired in 2024.
- **The Worker**: no `git`, 10 ms of CPU, a 100 MB body.
- **The Mac**: it must never hold user tokens, and third parties' pushed content stays off it.
- **GitHub's web importer**: offered, but it does not move LFS objects.
- **The researcher's machine**, which is chosen.

**Reasons.** Terms and security; commit ids are preserved.

**What would change it.** A backend with a server-side import, such as Forgejo's
`/repos/migrate`. `GitBackend` has a capability for it.

### D00-9. Large files and size limits

**Decision.**
- **Data goes elsewhere, in this order**:
  1. release assets: under 2 GiB each, with no limit on total size or bandwidth;
  2. a Zenodo record, made by the researcher;
  3. a Hugging Face dataset in the researcher's own account.
- **Git LFS is for small binaries only.** GitHub Free gives each owner 10 GiB of LFS storage and
  10 GiB of LFS download a month. Past that, LFS is blocked for that account until the next
  month, or billed if the researcher has a payment method on file; OSCR warns about both.
- **OSCR shows the limits** at creation and in the editor:
  - a file is blocked above 100 MiB, with a warning above 50 MiB;
  - GitHub's own web upload accepts 25 MiB;
  - a push is at most 2 GB;
  - a repository is ideally under 1 GB.
- **Through OSCR's Worker**: web commits up to 1 MiB (D00-7), and release assets up to 25 MiB,
  streamed without parsing. Beyond that, GitHub's own pages or the command-line tool.
- **OSCR never downloads LFS objects or release assets itself.** The bandwidth is the
  researcher's.

**Options compared.**
- **LFS by default**: one popular dataset would disable LFS for its owner for the rest of the
  month.
- **R2**: needs a payment card (C1).
- **Release assets, Zenodo, Hugging Face**, which are chosen.

**Reasons.** Zero cost for OSCR and for researchers without a payment method. Large data gets
persistent identifiers.

**What would change it.**
- Measured CPU, for the Worker's caps.
- GitHub changing its LFS or release limits.

### D00-10. Deleting a repository: a 30-day grace period in OSCR; the deletion on GitHub is the researcher's own act

**Decision.**
- **The request.** The person types the repository's name and sees how many tracing maps point to
  it, validated or not. In one authorized action, OSCR then archives the repository on GitHub and
  hides it in OSCR.
- **For 30 days**, one action restores it (unarchived).
- **When the delay ends**, the Mac's job runner shows the person an in-site reminder.
  - The deletion on GitHub is made only through the person's own fresh authorization, never by
    OSCR's App token or a timer.
  - If they never confirm, the repository stays archived in their account and hidden in OSCR.
  - GitHub's own safety net remains: a deleted repository can be restored for 90 days, unless it
    belonged to a fork network that is not empty.
- **Tracing maps** that point to a deleted repository say so. They show the Software Heritage
  copy when there is one (D00-15), and the licensed script copies.

**Options compared.**
- **Immediate deletion**: only GitHub's own 90-day restore, from its web interface.
- **Deletion by OSCR's App token after a timer**: it would act without the person, which is
  outside the confirmed core (D00-2).
- **OSCR's grace period, with the person's own final act**, which is chosen.

**Reasons.** The repository is the researcher's own. Nothing is lost by mistake. Maps are warned
before anything happens.

**What would change it.** An OSCR-hosted backend, where the grace period would be OSCR's alone.

### D00-11. Continuous integration: only the repository's own tests, on the researcher's GitHub Actions; OSCR's checks never run code

**Decision.**
- **What GitHub Actions may run**: a repository's own tests and builds, in the researcher's
  repository, on standard runners. Larger runners are always billed.
  - OSCR's templates may include an optional test workflow.
  - GitHub's Additional Product Terms allow Actions to develop and test the repository's
    software, and nothing more is explicitly allowed. So OSCR never launches a paper's analyses
    "to reproduce it" on Actions, and never uses Actions as general compute.
- **OSCR's own checks run no code.** They check that a licence is present, the environment file,
  the DOI link, `CITATION.cff` and the coherence of the tracing map.
  - On a pull request, "tracing-map links touched" is posted by the App as a GitHub check run.
  - OSCR reads the researcher's CI results through the Checks API.
- **A secret pushed to GitHub cannot be refused by OSCR**, because pushes do not pass through it.
  GitHub's push protection covers public repositories. OSCR adds a scan that reports and never
  blocks (phase 11).
- **User code never runs on the Mac or on Cloudflare.**

**Options compared.**
- **Actions for reproductions**: no explicit permission.
- **OSCR running code**: forbidden.
- **Non-executing checks, plus the repository's own tests**, which are chosen.

**Reasons.** Terms; the rule that no user code runs on the Mac or on Cloudflare.

**What would change it.**
- An explicit permission for reproduction runs. None was found.
- An OSCR-hosted backend with a pre-receive step, which could refuse a secret.

### D00-12. Cloudflare's part: metadata, authorization and webhooks only, within the free plan

**Decision.**
- **A new D1 database, `oscr_forge`** (binding `FORGE`, created by the owner), holds OSCR's layer:
  - the repositories OSCR knows, by forge id, public only;
  - their links to papers;
  - installations;
  - the traced paths the Mac pushes;
  - the action log;
  - the Mac's jobs.

  It holds no Git object, no token and no email address.
- **Budgets**:
  - Worker requests: of the 100,000 a day, a planning share of 40,000 for the GitHub side (C2).
  - D1 writes: the forge service is capped in code at 5,000 a day, inside the Worker's
    10,000-row share. Moving 20,000 of the search push's 80,000 rows to the GitHub side, after
    the push's first full load, is proposed but awaits the owner (C3).
  - D1 reads: planned at 1,000,000 a day.
  - Estimate for a day at 3,000 repositories: ~7,000 Worker requests and ~2,300 rows written.
- **Not used**:
  - R2: its checkout asks for a payment card, and overage is billed (C1).
  - KV (C6).
  - Durable Objects: GitHub updates refs atomically, so no locking is needed. C4 becomes moot.
  - Queues and Cron Triggers: the Mac does the scheduling.
- **No static file per repository** (C5). The catalogue already uses 80% of the 20,000 files.
- **The Cloudflare report's "thin streaming proxy" role (CF-G3) is withdrawn** (D00-3).
- **When the daily request quota is spent**, `/api/*` answers 429, and every page stays up,
  repository shells included.

**Options compared.** R2, KV, Durable Objects, Queues and Cron Triggers, against D1 for metadata
only.

**Reasons.** Zero cost, simplicity.

**What would change it.**
- Measured traffic (the Cloudflare dashboard needs the owner's login).
- C3.
- An OSCR-hosted Cloudflare backend on a paid plan.

### D00-13. `GitBackend`: one forge-neutral interface, GitHub first, an in-memory test double, a read-only Python counterpart

**Decision.**
- **The interface**, in TypeScript under `website/worker/forge/`. It is grouped into:
  - repositories;
  - git: refs, trees, files, commits, compare, blame, search, and making commits and merges;
  - pull requests and reviews;
  - issues;
  - releases;
  - checks;
  - webhooks;
  - the App's authorization;
  - links to the forge's own pages.

  Around it:
  - typed errors: one class, twelve codes;
  - the forge's limits;
  - capabilities per kind of credential: anonymous, user, installation.

  It covers phases 01 to 07. Its read side runs in the browser as well as in the Worker.
- **A GitHub adapter**, which reaches the network only through an injected `fetch` and adds no
  dependency (no Octokit): REST, GraphQL where REST falls short, and WebCrypto for the App's JWT.
- **An in-memory test double** that implements everything, with git's real object ids, and a
  contract suite that every backend must pass.
- **`oscr/forge.py` on the Mac**, read-only: a repository by id, heads through conditional
  requests, whether a commit exists, and files. The Mac never writes to a forge.
- **Room for other backends.** The `forge` field keeps `gitlab`, `forgejo` and `cloudflare`
  possible. Forgejo's and GitLab's APIs cover the same operations almost one to one.

**Options compared.**
- **Calling GitHub directly everywhere**: changing forge would mean a rewrite.
- **A Git library**: isomorphic-git is a client, not a server.
- **A neutral interface**, which is chosen.

**Reasons.**
- The mission asks for storage that can change without rewriting the rest (`NIGHT_RUN.md` §2.2).
- OSCR's layer is keyed by `(forge, repository id, commit)`, so a move changes only the backend.

**What would change it.** Nothing is expected to. A new forge adds an adapter that passes the
contract suite.

### D00-14. Scope and privacy: public repositories only at first; no email address, ever

**Decision.**
- **Public repositories only.** Private ones would need a server-side token on every read. Their
  names are never stored, even when an installation lists them.
- **The App's permissions.**
  - No account permission, and in particular not "Email addresses" (CLAUDE.md).
  - Repository permissions: Metadata (read); Repository creation, Administration, Contents, Pull
    requests, Issues and Checks (all write). Workflows is not requested.
  - "Administration" is the first to drop if researchers find it too broad. They would then
    rename, archive and delete on GitHub themselves.
- **Email addresses.** GitHub's answers carry commit authors' addresses.
  - `GitBackend`'s types have no field for one, and the adapters never copy them.
  - Every page masks addresses in commit messages, bodies and code, with the same rule as
    `catalog.mask_emails`.
- **Names shown on GitHub**, such as the check run's, come from `SITE_NAME`.

**Options compared.**
- **Private repositories now**: they need a token on every read, and on GitHub Free they lack
  protected branches and code owners.
- **Public first**, which is chosen.

**Reasons.** CLAUDE.md's rules on email addresses and on no stored tokens; simplicity.

**What would change it.** The owner accepting server-side tokens for private repositories, in a
later phase.

### D00-15. Commits that tracing maps point to: Software Heritage on request

**Decision.**
- **The risk.** A researcher can rewrite history or delete a repository.
- **Today** OSCR only *queries* Software Heritage (`oscr/repos.py`, read-only).
- **From phase 01**, OSCR asks Software Heritage to archive ("Save Code Now") when a person asks
  for it: the author who validates a map, or the author of a release (phase 07), just like a
  Zenodo deposit. The request is a job for the Mac.
- **It is not a default.** `oscr/repos.py` already treats a request to a third-party service as
  an option, never a default.
- **Until a commit is archived**, a pinned commit that disappears is shown as "no longer at the
  source", with the licensed script copies where they exist.

**Options compared.**
- **Archiving every pinned commit by default**: requests to a third-party service at scale,
  without anyone's action.
- **Archiving on request**, which is chosen.
- **Archiving nothing**: maps would break silently.

**Reasons.** It is consistent with the existing rule; the author decides, as for Zenodo.

**What would change it.** The owner allowing OSCR to request archiving by default for the commits
of validated maps.

### D00-16. GitLab.com and Codeberg for researchers' own repositories: deferred

**Decision.** Not tonight.
- **GitLab.com**: its Subscription Agreement (§8.1) fits a researcher's own use of their account.
  But no clause says in so many words that a third-party service may create and drive projects in
  a user's namespace, and §5.1(iii) is broad.
- **Codeberg** would fit only repository by repository, and only when all of these hold:
  - in the researcher's own account;
  - under a free licence;
  - for a project not mostly written by generative AI;
  - without automatic pull mirrors;
  - under 750 MiB.
- Both stay out until their terms are read clause by clause.

**Options compared.**
- **Approving them tonight**: the first criterion is not met.
- **Deferring**, which is chosen.

**Reasons.** Certain compliance comes first.

**What would change it.** That reading, done and positive. Then a `gitlab` or `forgejo` adapter
(D00-13).

### Where the reports' own decisions went

| report | its decisions | here |
|---|---|---|
| Hugging Face | reject as storage and as a mirror | D00-1 |
| GitHub organization and App | reject as storage; keep the App for the mirror mode | D00-1, D00-2 |
| Forgejo VM | F1–F4 reject; F5 keep the interface neutral | D00-1, D00-13 |
| Cloudflare Git server | CF-G1, CF-G2 reject; CF-G3 amended (no proxy role); CF-G4 room for a paid backend | D00-1, D00-3, D00-12, D00-13 |
| Other forges | O1, O2 reject; O3 neutral interface; O4 Software Heritage | D00-1, D00-13, D00-15 |
| User-owned | U1 → D00-2; U2 → D00-3; U3 → D00-4; U4 → D00-6; U5 → D00-9; U6 → D00-16; U7, U8 → D00-14 | as listed |
| Cloudflare capacity | C1–C6 (C3 proposed, not applied) | D00-12 |

## Phase 01: Git hosting and the mirror mode (2026-09-29)

Taken while laying the foundation of phase 01 (the schema, the forge service's skeleton, the
setup script), by the same criteria. D01-1 to D01-10 are the phase plan's decisions
(`data/night/phase-01/plan.json`, not committed); D01-11 onwards were taken while building. The
contract they shape: [FORGE.md](FORGE.md).

### D01-1. FORGE_OPEN: the write routes answer only to the owner until phase 16

**Decision.**
- `FORGE_OPEN` unset (the default) closes `POST /api/forge/start` and `POST /api/forge/act` to every
  account but the owner's: the GitHub account whose public numeric id is `FORGE_OWNER_GITHUB_ID`.
  Everyone else gets 403 `forge_closed`, in words. `FORGE_OWNER_GITHUB_ID` unset: closed to all.
- Checked at start (the GitHub identity linked to the signed-in account) and again at act (the
  account GitHub says authorized the action).
- Webhooks and the signed-in reads are not gated.
- `FORGE_OPEN=true` opens them; the setup script never sets it.

**Reasons.** Security: the mission makes phase 16's content rules indispensable before any public
opening (`PLATFORM_PLAN.md` §15.5, plan decision 3), and merging an earlier branch then opens
nothing. The switch costs one comparison per request.

**What would change it.** Phase 16 merged, and the owner's word.

### D01-2. The App's slug and the owner's GitHub id are secrets; the private key comes from its file

**Decision.** `tools/setup_cloudflare.sh` stores `GITHUB_APP_SLUG` and `FORGE_OWNER_GITHUB_ID` as
Cloudflare secrets, like the App's id, client id, client secret and webhook secret, not as
`[vars]` of `wrangler.toml`. `GITHUB_APP_PRIVATE_KEY` is read from the path of GitHub's `.pem`
file (PKCS#1, as it is) and piped to `wrangler secret put`: it is never pasted or shown. Every
pasted value is hidden, the public ones included (one rule for all).

**Reasons.** A deployment replaces the `[vars]` of the Worker with those of `wrangler.toml`;
secrets survive it. A multi-line key pasted into a terminal is error-prone and would show.

**What would change it.** The owner preferring the slug in `wrangler.toml` (it is public).

### D01-3. One more read route: GET /api/forge/mine

**Decision.** Besides the four routes of the plan, `GET /api/forge/mine` answers "Your
repositories" in one request, by a key range.

**Reasons.** The dashboard would otherwise need one request per repository.

### D01-4. A table of webhook deliveries

**Decision.** `deliveries` keeps one row per delivery handled (its id, when, the rows it wrote):
a redelivery writes nothing, and with `actions.rows` it counts the global 5,000 rows a day without
a counter row. A webhook then costs 1–2 rows, the delivery's own included.

**Reasons.** Idempotency, and the cap, within the budget of §15.6.

### D01-5. The URL scheme

**Decision.** `/new/`, `/new/link/`, `/new/import/`, `/repositories/`,
`/r/<owner>/<name>/[settings/|branches/]`, `/forge/authorized/`, `/hosting/…`. Phase 02 may add
views under `/r/` and keeps these. One static shell serves every `/r/*` path.

**Reasons.** GitHub's own shape (owner, name), readable, and no file per repository (C5).

### D01-6. The catalogue's GitHub repositories enter OSCR's layer through the static shards

**Decision.** The repositories the catalogue already links (318 of 463 are on GitHub) appear in
the Mac's static layer with the mode `catalogue` (read only), at 0 D1 rows. Linking one in D1
stays the person's own action.

**Reasons.** The mirror mode brings in the catalogue's code at no cost; nobody's consent is
assumed. It follows plan decision 4 (OSCR-native objects as nightly static shards for signed-out
readers).

### D01-7. One write path: paper links and Software Heritage requests are authorized actions too

**Decision.** Adding or removing a repository's papers (`papers`) and asking Software Heritage to
archive it (`software_heritage`) go through the same start/act flow, with a permission check as the
person on GitHub.

**Reasons.** One write path to secure, audit and cap.

### D01-8. The end of a grace period hides; the deletion stays the researcher's

**Decision.** The Mac's `delete_due` job hides a repository whose 30 days ended without a restore.
The deletion on GitHub is only `delete_final`, the researcher's own fresh authorization (D00-10).

### D01-9. The research-compendium template is a build-time variable

**Decision.** `COMPENDIUM_TEMPLATE` ("owner/name") at build time; without it, the option is not
shown.

**Reasons.** The owner has not made the template yet (optional, ARCHITECTURE.md "The owner's
steps").

### D01-10. science.css gets all of phase 01's rules from the foundation

**Decision.** The foundation adds every rule the pages of phase 01 need (`.repo-head`,
`p.status-line`, `.setup`, `pre.commands` and `button.copy`, `fieldset.choices` and `.explain`,
`.limits`, `section.danger`, `table.branches`, `dl.settings`, `.panel`, `.confirm`, and the phone
layout of the masthead's links and the tables), so that no two elements edit it.

### D01-11. The daily counts are key ranges: the keys of actions and deliveries start with the UTC day

**Decision.**
- `actions` is keyed (day, user_id, at, nonce), `deliveries` (day, delivery), `day` being
  `at / 86400` (a CHECK keeps them equal). No index on either.
- An account's last 24 hours are two key ranges, (yesterday, user) and (today, user); today's rows
  of every account and every webhook one range of each table.
- A redelivery is found by four key probes, (day, delivery) for today and the three days before:
  GitHub lets a delivery be redelivered for 3 days.

**Options compared.**
- **The design's sketch**, `actions` keyed (user_id, at, nonce) and `deliveries` by the delivery
  id: an account's day is a range, but "today's rows" of everyone has no key order at all, and the
  global cap would read both tables whole.
- **A second order through an index** (or a rowid table with an index): +1 row written for every
  action or every delivery, over the budgets of W1, the link and H1.
- **A counter row per day**: +1 row written per write; ruled out ("no counter row").
- **The day first**, which is chosen: 1 row per action and per delivery, every count a key range.

**Reasons.** Zero extra writes; every read by key.

**What would change it.** Measured reads (D01-12).

### D01-12. The global cap is asked once per action, at act; webhooks are not asked

**Decision.** `globalCap` sums the `rows` of today's action and delivery rows (at most 5,000 of
each: every row counts itself at least) once per authorized action, at act, just before anything
is written. A webhook writes at most 2 rows and does not ask; its rows count in the total the next
action sees. Over the cap: 503 `quota` until 00:00 UTC.

**Reasons.** Reading today's rows costs about as many rows read as rows were logged today (~750 on
average at the design's plausible day, ~375,000 reads a day for 500 actions: within the GitHub
side's 1,000,000 reads, well within D1's 5,000,000); asking at every webhook would double it for
rows GitHub sends anyway (a refused delivery is redone by the Mac's polling, not saved).

**What would change it.** Measured reads over the share: then one counter row per day (1 more
row written per action, the owner's call against "no counter row"), or the check sampled.

### D01-13. "Your repositories" lists the reader's own GitHub account

**Decision.** `/api/forge/mine` reads the repositories OSCR knows under the reader's GitHub login
(the login of the GitHub identity linked to their account), by the prefix (forge, owner_login) of
`repos_path`, paged by name, filtered by mode and template. An organization's repositories are
listed by the same query under the organization's login.

**Options compared.** Listing by `linked_by` needs a second index on `repos` (+1 row per creation
and link, over their budgets) or a scan.

**Reasons.** The only index serves both the path lookups and the lists; it is GitHub's own notion
of "your repositories".

### D01-14. `oscr_forge` admits the test double's forge

**Decision.** The CHECKs on `forge` accept `github` and `memory` (the test double's), as
`oscr/forge.py` `FORGES` does. The Worker's production backend is GitHub's (`service/backend.ts`),
so no production row can say `memory`; `store.ts` refuses any other forge.

**Reasons.** The service's tests run on the real migration with MemoryBackend.

### D01-15. An action's rows are statements with their cost

**Decision.** A spec's `perform` returns its D1 rows as `Write`s, `{stmt, rows}`, `rows` being what
D1 bills (the row and its index entries): act writes them in one batch with the action row, whose
`rows` is their sum plus one. The tests' fake D1 bills the same way and records any scan.

**Reasons.** The caps and the budgets are counted exactly, without asking D1 after the fact.

### D01-16. The Mac answers a forge job in its own row

**Decision.** `jobs` gains `done_at`, `outcome` and `message` (plain text, no at sign). A
repository's page reads the jobs still pending from the table's last 50 rows (a bounded tail of
the rowid).

**Reasons.** `oscr_community`'s jobs answer into the request's row; a forge job has none, and the
dashboard says what is pending.

### D01-17. `repos` keeps the template flag; `installations` are keyed by forge and id

**Decision.** `repos.template` (0 or 1), kept by creations and the `template` action, lets the
dashboard filter templates without a request to GitHub. `installations` is keyed (forge, id), like
every other table.

### D01-18. The token template link, and OSCR's own tokens later

**Decision.** The Code button and the tokens guide link to GitHub's pre-filled fine-grained token
page (`src/lib/forge.ts` `tokenTemplateUrl`: the owner as resource owner, Contents write, 30 days, a
name from the repository). GitHub's page has no parameter for the one repository: its description
tells the person to pick it. OSCR's own tokens, for its API only and never for git, come with
phase 10 (plan decision 8).

### D01-19. The parts not built yet answer 501

**Decision.** The foundation creates every file the elements fill: the routes answer 501
`not_built`, the action arrays are empty, the pages are placeholders that say so, the Mac's
commands exit with "not built yet". Nothing half-built pretends to work.

### D01-20. After installing the App, the action is authorized again the ordinary way

**Decision.** When a page asks to install the App first (the mirror mode), GitHub's installation
page comes back to `/forge/authorized/` with `installation_id` and `setup_action`, and sometimes a
code of its own. That code was not asked with a PKCE challenge, so the page never posts it: it
declares the same action again (`forge-client.ts` `resumeAction`, the declaration kept with the
payload in the tab), and the tab goes through GitHub's ordinary authorization page with PKCE. The
person who just installed the App is sent back at once.

**Why.** Security and simplicity: one kind of code reaches act, always bound to a PKCE verifier,
and nothing depends on how GitHub treats a verifier for a code asked without a challenge. Cost:
one more redirection, on the installation path only.

### D01-21. The creation form offers an open licence by default

**Decision.** `/new/` pre-selects the MIT licence and says why a licence matters (reuse, the
registry's copies of the scripts, archiving); "None" is one click away and says what it means. An
address that asks for an empty repository (`readme=0`, the import page's link) gets no licence
either, since an import needs an empty repository.

**Why.** CLAUDE.md: only verified licences leave the Mac, and GitHub writes the LICENSE file that
verifies it. The person still chooses, and the confirmation sentence names the licence.

### D01-22. A paper's status at creation and linking comes from the roles only

**Decision.** `papers.ts` `paperStatuses`: `linked` when the person holds `verified_author` for
the paper or `maintainer` for the repository in `oscr_community.roles` (one read by the roles'
key), `proposed` otherwise. Owning a brand-new repository is not a maintainer role by itself. The
Mac checks the same roles again before it adds anything to a paper's record.

**Why.** One rule on both sides, and Phase 6's rule for editing a record's links. Security: no one
attaches a paper to code as "linked" by creating a repository.

### D01-23. A first branch GitHub could not rename is said, and the repository recorded

**Decision.** When `create` asks for a first branch named otherwise than GitHub's and the rename
fails, the repository is recorded as GitHub made it, and the answer says so in words
(`result.notes`), with the Branches page to rename it later.

**Why.** The repository exists on GitHub: recording nothing would leave it invisible to the
registry for a detail the person can change in one step.

### D01-24. A webhook writes at most 2 rows; its delivery row only when it fits

**Decision.** A delivery's changes are conditional statements that write nothing when already made
(a push's head only when newer: `head_at`; the other changes only when a value differs:
`store.ts` `updateRepo` guard `differs`; a push's job only when the same push asked for none among
the recent jobs). A change of one row is written with the delivery row (the log, and the day's
global count); a change of two rows (a rename moves the path's index entry, a privatized repository
loses its name, a push to a repository with tracing maps also asks the Mac for a `push` job) is
written without it, being idempotent by itself. An installation removed writes one row per
repository it covered, plus one. A delivery needs an installation the registry knows that covers
the repository's account; anything else is acknowledged and dropped.

**Why.** The budget of §15.6 (≤ 2 rows a delivery) with D1's billing of index entries, and
idempotency for GitHub's redeliveries. The rows written without a delivery row are rare events and
stay outside the day's global count, inside the margin between 5,000 and the Worker's 10,000.

### D01-25. A spec reaches the person's installations, never their token

**Decision.** `ActionContext.installations` (`list`, `repositories`) is bound to the action's
token inside `act.ts`: the link action finds the installation of the App that covers a repository
through it, and the token itself stays in `act.ts`'s scope.

**Why.** Security: the rule "the token is never stored, logged or answered" is kept by
construction, with no spec able to leak it.

### D01-26. Linking a repository already linked is refused; one hidden or gone is linked again

**Decision.** `link` answers 409 `already_linked` for a repository the registry follows (active,
archived, or waiting for its deletion): its papers change with the `papers` action. A repository
hidden, deleted or gone is linked again on its own row, brought up to date.

**Why.** One row per repository id, and no silent change of who linked it.

### D01-27. Settings act on the repository GitHub names by its id; the final deletion after a request only

**Decision.** Every settings, branch and deletion action first asks GitHub for the repository by
its durable id (GitHub follows renames and transfers), acts on the path GitHub gives, and `check`
compares the id. `delete_final` is accepted once a deletion was asked: during the grace period, or
after it, when the Mac's `delete_due` job has hidden the repository; it is the only caller of
`repos.delete` in the service (a test greps for it), and the Mac never deletes on a forge. The
Software Heritage request needs a person who may push to the repository (anyone else can ask
Software Heritage directly); it writes one job and nothing on GitHub.

**Why.** D00-10 and D00-15: no deletion without the person's fresh authorization, no archive
request the registry makes on its own; the id, not a stale path, decides which repository changes.

### D01-28. The pages declare every action with the Worker's own rules and sentence

**Decision.** `/new/`, `/new/link/` and the repository's Settings and Branches pages import the
action specs' `validate` and `describe` (worker/forge/service/act-*.ts, through `actions.ts`): a
payload the Worker would refuse is said on the page before anything is sent, and the sentence a
person confirms is exactly the one the Worker repeats after GitHub. The actions are offered to a
signed-in reader whose layer roles are owner, maintainer or the person who linked it; GitHub
decides at the action whether their account may (a reader with write only is refused there, in
words).

**Why.** One source of truth for what an action means; no confirmation sentence that differs from
what is done. The cost: about 14 KB more script on those pages.

### D01-29. The end-to-end run bypasses the CSP of the /r/ pages in its test browser only

**Decision.** The `/r/` shell's Content-Security-Policy lets the page reach GitHub's API and raw
files only. The local run serves the fake GitHub on 127.0.0.1, so its headless Chrome bypasses the
CSP for those pages (DevTools' `Page.setBypassCSP`); the site's headers are unchanged, and no
development address is ever in them.

**Why.** Security: the production policy stays as strict as it is; the test browser, not the
site, makes the exception.

## Phase 02: code navigation (2026-09-29)

Taken while building the registry's own code viewer (`docs/CODE_NAVIGATION.md`), under the owner's
directive of 2026-09-29: GitHub is OSCR's competitor; everything is shown inside OSCR, and a reader
is sent to GitHub only as a last resort.

### D02-1. GitHub's own address shapes, in the one /r/ shell

**Decision.** The code views take GitHub's shapes after `/r/<owner>/<name>/`: `tree/<ref>/<path>`,
`blob/<ref>/<path>`, `commits/<ref>/<path>`, `commit/<sha>`, `compare/<base>...<head>` (and two
dots), `find/<ref>`, `search/?q=`, and `docs/<ref>/<page>` for the documentation. The longest branch
or tag that prefixes the segments is the ref, as on GitHub. The one static shell serves them all
(`/r/* /r/ 200`): no file per repository, no Worker request.

**Why.** A GitHub address becomes the registry's by changing its start; links in READMEs, papers and
maps translate one to one. Zero cost: the file budget does not grow with the repositories.

### D02-2. The registry's own viewer; GitHub only as a last resort, said

**Decision.** Files, directories, history, diffs, comparisons, Markdown, notebooks and tables are
shown by the registry's own code, styled by `science.css`. highlight.js's class-based output is read
into view trees by a strict parser (no HTML string reaches the page). The reader is sent to GitHub
only when they ask for something the registry cannot show (blame, a file too large, a licence that
forbids showing, GitHub's limit reached, the code search of a large repository), through a discreet
"At the source" link after a sentence that says why (`code-nav.ts` `atSource`). The README, the
files and the latest commit of phase 01's home now stay in the registry.

**Why.** The owner's directive. A reader who leaves for GitHub does not come back.

### D02-3. Read in the reader's browser, on the reader's quota; the tab keeps what never changes

**Decision.** The views read GitHub's anonymous API from the reader's browser (60 requests an hour)
and the files from `raw.githubusercontent.com` (not counted); the tab keeps the immutable answers
(trees and commits by id) in `sessionStorage` (`gitcache.ts`). Every extra of phase 02 (READMEs,
images, `.gitattributes`, the citation, the search's files, a tracing map's version) is a raw read.

**Why.** D00-5: signed out, the Worker is asked nothing. The raw reads keep the quota for the
requests only the API answers.

### D02-4. Display limits

**Decision.** Text files are read up to 1 MiB; images, notebooks and PDFs up to 10 MiB; highlighting
up to 512 KiB, 20,000 lines and lines of 5,000 characters (plain text beyond); Markdown rendered up
to 500 KiB (GitHub's cut), each said in words, with "At the source" for a file too large.

**Why.** The reader's browser stays responsive; GitHub's own limits are the readers' expectations.

### D02-5. Blame stays GitHub's page

**Decision.** Blame needs a GitHub sign-in (GraphQL): the line menu and the key `b` open GitHub's
blame at the commit, after the sentence that says so. Local blame is the command line's (phase 14).

**Why.** D00-5 (no user token kept); the anonymous API has no blame.

### D02-6. No image from another site loads without the reader's click

**Decision.** An image on another site is a link naming its host; the page never loads it and there
is no image proxy. The repository's own images (relative paths, and its own raw addresses) are read
as bytes and shown from object URLs (`img-src blob:`); a notebook's outputs as `data:` images.

**Why.** Privacy (a third party learns nothing of the reader) and cost (a proxy would spend the
Worker's requests and be an open relay). The CSP stays strict.

### D02-7. The licence gate: files are shown under an open licence only

**Decision.** A repository's files are shown when GitHub detects an open licence (the list of
`code-nav.ts` `licenceShows`); without one, or one GitHub cannot identify, they are listed, not
shown, with "At the source" and a sentence that asks the authors to add a licence. The README is a
file: not rendered then (the home keeps phase 01's 480-character excerpt, D02-19).

**Why.** CLAUDE.md: a file whose licence does not allow redistribution is never published; showing
is publishing.

### D02-8. Diagrams, maps and 3D models are shown as source, in words

**Decision.** Mermaid blocks and files, GeoJSON and TopoJSON, and STL models are shown as their
source (or said in words: features by geometry, triangles), with a sentence and "At the source".

**Why.** Mermaid's SVG needs inline styles the pages' CSP forbids; a map needs a tile service
outside the registry; a 3D viewer is a large dependency. Deferred, not refused.

### D02-9. One Markdown renderer and TeX to MathML, written here

**Decision.** `markdown.ts` (GFM with GitHub's tag filter) and `mathml.ts` (TeX into MathML Core)
are the registry's own code, with no dependency, producing view trees. The inventory named Temml;
MathML is written directly instead: no library, no stylesheet, no font, and an unknown command is
shown as its source, never guessed.

**Why.** science.css only; nothing from a repository can become markup; the page scripts stay small
(a few kilobytes, not a Markdown library plus a sanitizer). Pathological texts are bounded (tests).

### D02-10. Tracing maps reach the code view as 64 static shards, with no paper text

**Decision.** `/forge/traced/00.json` … `63.json` are built from the catalogue's alignments at build
time, keyed like the layer's shards: per repository, each paper's map at its pinned commit, the
pairs' paths, lines, section headings, paragraph numbers and symbols. The paragraphs themselves are
read in the Code ↔ Paper reader. At another commit, a map's lines are found again by their content
(the map's version, a raw read), else by the map's symbol; a range that changed says so.

**Why.** Zero cost (static files, a fixed number); the paper's text keeps its licence rules; a map
stays useful as the code moves.

### D02-11. Trace points from permalinks: one reading, on both sides

**Decision.** `src/lib/traced.ts` `parsePermalink` and `oscr/forge.py` `parse_permalink` read
GitHub's and the registry's permalinks (a file at a commit id, its lines) the same way, held to
`tests/fixtures/permalinks.json`; an address at a branch is no trace point. Addresses URL parsers
read differently (spaces, backslashes, dot segments, escaped slashes) are refused on both sides.

**Why.** A map pinned to a moving branch would silently drift; the Mac and the site must agree.

### D02-12. Notebooks are rendered, never run

**Decision.** A notebook is rendered from its JSON: Markdown cells, highlighted code, outputs in
their richest safe form (images as `data:`, SVG as an image, Markdown and LaTeX rendered, text).
HTML, JavaScript and widget outputs never run: their text form is shown, or a sentence.

**Why.** CLAUDE.md: never execute users' code. GitHub does the same (its notebooks are static).

### D02-13. A PDF opens in the browser's own viewer

**Decision.** A PDF (checked by its signature) is opened in a new tab from an object URL typed
`application/pdf`, or downloaded; no `<iframe>`, `<object>` or `<embed>`.

**Why.** The CSP keeps `object-src 'none'` and no frame; a blob typed as a PDF never becomes a page
of this site.

### D02-14. The Docs view: GitHub Pages adapted

**Decision.** `docs/<ref>/<page>` renders the Markdown of `docs/` (or of the root) as pages, their
list beside them, with the one renderer and science.css; links between pages stay in the view. No
author HTML, CSS or JavaScript runs; a Pages site built by Jekyll or a workflow keeps its own
address, linked from the home's sidebar.

**Why.** A repository's documentation read inside the registry, safely; the build of Pages is
GitHub's.

### D02-15. Languages are computed from the tree, Linguist's way

**Decision.** The About panel's languages come from the recursive tree the page already read: bytes
per language, data and prose aside, vendored, generated and documentation paths aside (Linguist's
common defaults), `.gitattributes` obeyed.

**Why.** GitHub's languages endpoint would cost one more request of the reader's 60; the tree is
already there.

### D02-16. The finder and the search run in the reader's browser

**Decision.** The finder matches the tree's paths as the reader types (a local list). The search
reads a small repository's text (300 files, 4 MB, files ≤ 384 KB) only when the form is sent; beyond
that, GitHub's code search at the source, with the sentence (it needs a GitHub sign-in).

**Why.** Zero cost and no index to keep; the catalogue's rule (a search runs on submit) kept.

### D02-17. Email addresses are masked in attributes read as text too

**Decision.** `h()` masks `title`, `alt`, `aria-label`, `placeholder` and `value` like text nodes.

**Why.** CLAUDE.md: no email address is displayed. A repository's Markdown link titles and a
notebook's output descriptions reach attributes (found by the security review).

### D02-18. The owner's default community files are read raw

**Decision.** For the community files a repository lacks (code of conduct, contributing, security,
support), the home tries the root of `<owner>/.github` at `HEAD`, as raw reads (4 at most), and says
"<owner>'s default".

**Why.** GitHub's community profile endpoint would cost a request of the reader's quota; a raw 404 is
free.

### D02-19. The README is rendered from the tree; phase 01's excerpt stays the fallback

**Decision.** The home and every directory render their README from the commit's tree (GitHub's
precedence on the home: `.github/`, the root, `docs/`). Phase 01's excerpt (from the API's README)
stays on the home until the whole README replaces it, and stays alone when the files cannot be read
or shown (a rate limit, D02-7).

**Why.** The reader never sees less than phase 01 gave; the tree's README costs no request.
