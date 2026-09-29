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

## Phase 03: editing in the browser (2026-09-29)

Taken while building the registry's own editor and commit dialog ([WEB_EDITING.md](WEB_EDITING.md)),
under the owner's directive of 2026-09-29 (GitHub is OSCR's competitor: the editing happens in OSCR)
and D00-4, D00-7 (a commit is made by GitHub, as the person, one authorization per action).

### D03-1. One action kind, `commit`, for every change made from the browser; no repository row needed

**Decision.** Edits, new files, renames, moves, deletions and uploads are one kind of authorized
action, `commit` (`worker/forge/service/act-commit.ts`): its target is the repository, the branch and
the head the page read, bound at start in the flow cookie; its payload repeats the branch and the
head (`branch`, `base`), and a payload prepared for another is refused. It does not need the
repository to be one the registry follows (`needsRepo: false`): GitHub decides who may write. It
writes the action row only (1 row). `migrations/d1-forge/0002_commit.sql` rebuilds `actions` with the
kind (SQLite cannot change a CHECK in place); the schema tests read the effective schema.

**Why.** One write path to secure, cap and audit (D01-7); a researcher fixing a README of a
catalogue repository they may write to should not have to link it first; the row budget of §15.6.

### D03-2. GitHub's own editing addresses, in the one /r/ shell

**Decision.** `edit/<branch>/<path>`, `new/<branch>/<dir>` (with GitHub's `?filename=` and
`?value=`), `upload/<branch>/<dir>` and `delete/<branch>/<path>` after `/r/<owner>/<name>/`. A text
that came with the address is said ("read it before you commit it").

**Why.** D02-1: a GitHub address becomes the registry's by changing its start; no new file.

### D03-3. The registry's own editor: a transparent textarea over the viewer's lines

**Decision.** The editor is the viewer's `ol.lines.code` (highlight.js's classes, the gutter, the
exact indentation, tabs at the file's width) under a transparent textarea in one grid cell, one
font, one line height and one padding (`science.css`). Undo and redo are the browser's own, every
change going through `insertText`. The inventory named CodeMirror 6.

**Why.** CodeMirror writes `<style>` elements: the pages' CSP (`style-src 'self'`) and the
science.css-only rule forbid them. The overlay keeps editing identical to reading, with no
dependency (the owner's directive: the editor matches the professional viewer).

**What would change it.** A need the overlay cannot meet (multiple cursors, code folding): a
CodeMirror build whose styles are moved into science.css, if its style module can be disabled.

### D03-4. Email addresses are hidden in place in the editor's visible layer

**Decision.** The visible layer masks each address character by character (`maskEmailsInPlace`:
same length, so the columns hold); the textarea keeps the file's text, which is what the commit
writes. The Changes and Preview tabs mask as the viewer does.

**Why.** CLAUDE.md (no address shown) without corrupting the file the person commits.

### D03-5. Drafts are kept in the reader's browser, dropped on success only

**Decision.** The change is kept in `localStorage` as it is typed (every access in try/catch), keyed
by the repository, the branch and the file, for a month. The page names its draft to the start
(`startAction(…, {drafts})`); the callback page drops it only when GitHub made the commit. The
settings kept: wrapping.

**Why.** The inventory's "auto-save" adapted to the rule that the Worker keeps nothing of a person's
work; a refused commit (the branch moved, a closed gate) loses nothing.

### D03-6. A branch that moved: refused by the Worker, merged in the browser when it can be

**Decision.** The Worker's `createCommitOnBranch` carries the head the page saw (the
compare-and-swap); a moved branch answers 409 with `offer: "new_branch"`, nothing recorded. The
editor, reopened, says so: this file unchanged, the change applies to the latest version; changed
without overlap, a three-way merge in the browser (`diff.ts` `merge3`) on request; otherwise a new
branch made at the version edited.

**Why.** D00-7; the reader's own CPU, no server-side merge.

### D03-7. A new branch starts at the head the page saw; the pull request is phase 04's

**Decision.** "Create a new branch for this commit and start a pull request" makes the branch at the
head the change started from (`createFrom`), GitHub's `<login>-patch-N` suggested. The Worker's
answer names the pull request to open (`pullRequest: {repo, base, head}`) and links the comparison of
the two branches in the registry's viewer; phase 04 opens it.

**Why.** The plan: 04's suggestions and "new branch with a pull request" commit through 03's
machinery.

### D03-8. Propose changes: a fork, only when GitHub says the person may not write, and said first

**Decision.** When GitHub gives the person no write permission and the page allowed it (`propose`,
ticked by default and said in the sentence the person confirms), GitHub forks the repository into
their account and the commit goes on a new branch there, at the same head. Without it: 403 with
`offer: "propose"`. A fork GitHub is still copying is said ("wait a minute"), the draft kept.

**Why.** GitHub's "Propose changes"; no copy made in someone's account without their confirmation.

### D03-9. The Worker writes the trailers; the author's address is GitHub's

**Decision.** `Co-authored-by` lines carry each co-author's GitHub login and no-reply address
(`<id>+<login>@users.noreply.github.com`), their ids read from GitHub's public API in the reader's
browser and shape-checked by the Worker; `Signed-off-by` carries the no-reply address of the account
GitHub says authorized the action, when the person signs off or the repository requires it
(`RepoInfo.signoffRequired`, GitHub's `web_commit_signoff_required`). No address typed on the page
reaches a trailer. The commit's author and signature are GitHub's (the person's web-commit address);
the inventory's OSCR no-reply address and OSCR's own signing key are not used.

**Why.** D00-7 (GitHub signs web commits as the person) and D00-14 (no email address, ever).

### D03-10. The tracing-map links a change touches are said before the commit

**Decision.** The commit dialog lists each map link whose lines change, or whose file moves or is
deleted — the paper, the Methods paragraph (opening the reader beside the code), the lines — and
chooses a new branch by default then.

**Why.** The plan's research link for phase 03: a paper's code changed knowingly, the map pinned to
its own commit (valid), its authors able to re-anchor it after a merge (phase 04).

### D03-11. Secrets: a warning in the browser, a tick to go on

**Decision.** Token shapes (a short list with prefixes of their own, placeholders ignored) found in
what the commit writes are said by line, the value hidden; committing anyway needs a tick. GitHub's
push protection may still refuse.

**Why.** The inventory's push protection "in web editing and uploads"; phase 11 brings the full
list. Nothing found leaves the browser.

### D03-12. Uploads: through the Worker's 1 MiB and 100 files; larger at the source

**Decision.** An upload is one commit of at most 100 files and about 950 KiB of payload (texts as
text, bytes as base64); a file too large is refused with GitHub's own upload page (25 MB) at the
source. `.gitattributes`' `filter=lfs` is obeyed (refused, since GitHub would store the bytes). Types
are not restricted; a compiled program or a large binary is said in words.

**Why.** D00-7's cap (10 ms of CPU); nothing uploaded is ever run or served as a page by the
registry (text as text nodes, images from object URLs, SVG as an image, HTML as source), so a type
list would protect nothing.

### D03-13. A folder is deleted file by file, reviewed first, at most 100

**Decision.** `delete/<branch>/<folder>` lists every file under it, says the history keeps them, and
commits their deletions in one commit (at most 100: beyond, `git rm -r`).

**Why.** GitHub's "Delete directory", within the commit's cap.

### D03-14. Licence and code-of-conduct templates from GitHub's API, in the reader's browser

**Decision.** The pickers read GitHub's licences and codes-of-conduct API on the reader's quota
(one request when a template is chosen), fill the year and the holder, and replace a code of
conduct's contact (an email address in the originals) with the repository's page in the registry.
Each licence says what it means for the registry's copies.

**Why.** No licence text bundled (their exact texts are GitHub's to keep current); no address shown.

### D03-15. CITATION.cff from the paper; metadata checked with the viewer's own reader

**Decision.** A new CITATION.cff can start from the paper the repository is linked to (the preferred
citation) with ORCID iDs and no address; CITATION.cff, `codemeta.json` and `.zenodo.json` are checked
as they are written with phase 02's reader ("reads as: …" in APA, or what is missing). Workflow and
`devcontainer.json` help is deferred (SchemaStore's licence to confirm).

**Why.** The inventory's adaptation: the research metadata files first.

### D03-16. Markdown aids of the registry's own; emoji autocomplete deferred

**Decision.** A toolbar of plain words and GitHub's keys, a URL pasted over a selection made a link,
spreadsheet cells a table, the slash commands `/table`, `/code`, `/details`, `/cite <DOI>`.

**Why.** GitHub's writing features that matter for research READMEs; emoji need a data table.

### D03-17. What the editor opens

**Decision.** UTF-8 text files up to 512 KiB; LFS pointers, binaries (upload instead), submodules and
symbolic links are changed with git, said. A file the viewer may not show (D02-7) is not opened in
the editor either; a new file can always be created (a licence, first).

**Why.** The Worker's 1 MiB with JSON's escapes; the licence gate: showing is publishing.

### D03-18. The callback page links the registry's viewer only

**Decision.** A commit's answer carries its links (the file as committed, the commit, the
comparison) as `/r/` paths built by the Worker; the page keeps only paths matching the viewer's shape
(`forge-client.ts` `VIEWER_PATH`: no other site, no `//`, no dot segment). "Back" is the editor.

**Why.** No open redirect; the reader stays in the registry.

### D03-19. A commit costs 4 Worker requests and 1 D1 row

**Decision.** The dialog reads the session's CSRF token and GitHub login once (`/api/account/me`) and
hands it to the start; after GitHub, the callback page reads it again, then acts: 4 requests (the
plan counted start and act), 1 row. Editing, previewing and uploading ask the Worker nothing.

**Why.** Phase 01's flow; ~600 requests a day at ~150 commits, inside the GitHub side's 40,000.

## Phase 04: forks and pull requests (2026-09-29)

Taken while building forks and pull requests in the registry ([PULL_REQUESTS.md](PULL_REQUESTS.md)),
under the owner's directive of 2026-09-29 (GitHub is OSCR's competitor: pull requests are read,
reviewed and merged in OSCR) and D00-4, D00-6, D00-7 (every write the person's own, one
authorization each; pull requests are GitHub's objects; GitHub makes commits and merges).

### D04-1. Ten action kinds, each one act made by GitHub as the person; no pull request in D1

**Decision.** `fork`, `fork_sync` (`act-forks.ts`) and `pull_open`, `pull_edit`, `pull_review`,
`pull_comment`, `pull_thread`, `pull_merge`, `pull_update`, `pull_revert` (`act-pulls.ts`), in the
registry of phase 01; `migrations/d1-forge/0003_pulls.sql` rebuilds `actions` with the kinds. Each
writes the action row only (1 row) and none needs the repository to be one the registry follows
(`needsRepo: false`): GitHub decides who may. The target is the repository by GitHub's id (followed
through renames); a pull request's number, title, body or comment never reaches D1 or a log.

**Why.** D00-6: one source of truth; the row budget of §15.6; one write path to secure and cap.

### D04-2. GitHub's pull request addresses, in the one /r/ shell

**Decision.** `pulls/?q=`, `pull/<n>`, `pull/<n>/files` (and GitHub's newer `/changes`), `commits`,
`checks`, `conflicts`, `pull/new/<branch>`, `compare/<base>...<head>?expand=1`, `fork/`, `forks/`,
after `/r/<owner>/<name>/`. No file per pull request.

**Why.** D02-1: a GitHub address becomes the registry's by changing its start; the file budget.

### D04-3. Read on the reader's quota; GitHub's search only for what only it knows

**Decision.** The list asks GitHub's list endpoint (100 a page) and filters in the browser with
GitHub's qualifiers; a query that names reviews, reviewers or comments goes to GitHub's search (10 a
minute). A pull request's page reads its parts anonymously (about 7 requests; the files and the
merge base only when the repository has tracing maps); the tab keeps what never changes.

**Why.** D00-5: signed out, the Worker is asked nothing; the reader's 60 anonymous requests an hour
go to what the page shows.

### D04-4. A merge carries the head the page showed; the methods allowed are GitHub's to refuse

**Decision.** `pull_merge` sends GitHub the head the page showed (`sha`, and the target's
`expectedHead`): a commit that arrived meanwhile makes GitHub refuse (409, offer "reload"), nothing
merged. The three methods are offered with GitHub's default messages; GitHub's anonymous API does
not say which the repository allows, so its refusal is said in words ("the repository does not
allow this method", with the other reasons GitHub gives none of).

**Why.** The reviewer merges what they read (GitHub's own compare-and-swap); no request spent to
learn a setting GitHub enforces anyway.

### D04-5. Conflicts resolved in the browser: ONE commit with two parents on the pull request's branch

**Decision.** The merge base and both sides' changes come from two comparisons, the three texts
from raw reads; `diff3` runs on the reader's CPU; each conflict takes one side, both, or the
reader's lines (or the whole file with git's markers). The resolution is phase 03's `commit` with
`mergeParent`: parents [the pull request's head, the base's head], built by the Git data API from
the pull request's tree, so the files only the base changed are written too (texts as text, bytes
as base64). A resolution that keeps every line of the branch makes no new tree. Deletions or renames
against changes, binaries changed on both sides, and resolutions over 100 files or 1 MiB are said,
with the command line.

**Why.** D00-7 ("the conflicting hunks are computed on the reader's own CPU; the result is committed
with two parents"); nothing is built in the Worker; the commit's caps (D03-12).

### D04-6. A commit without write on the repository is tried, and GitHub decides

**Decision.** Without `propose`, `commit` no longer refuses before GitHub when GitHub says the person
may not write to the repository: it asks, and GitHub's refusal is said (403, offer "propose"). The
case is a maintainer's edit of a fork's pull request branch ("Allow edits by maintainers"), which
GitHub's repository permission does not show. The double models it (`memory-git.ts`
`maintainerEdit`).

**Why.** GitHub's rule is branch-specific and GitHub enforces it; one more request only on a path
that was refused before.

### D04-7. Suggestions: shown as a change, applied as one commit, suggesters credited

**Decision.** A comment's ```` ```suggestion ```` block is shown as the change it makes; "Apply" or
a batch makes ONE commit on the pull request's branch ("Apply suggestion(s) from code review"),
each suggester a co-author by GitHub's no-reply address (D03-9), the person applying excepted.
Outdated suggestions, several blocks in one comment, and the old side are said, not applied.

**Why.** GitHub's "Commit suggestion" and "batch", through the one commit path.

### D04-8. The pending review and "Viewed" are kept in the reader's browser

**Decision.** Line comments can wait in a pending review in `localStorage` (under the editor's draft
prefix, a month), submitted as ONE review (Comment, Approve, Request changes) on the commit they were
written on; the callback page drops it once GitHub took the review, and only then (the drafts
mechanism of D03-5). "Viewed" is kept per file and blob: a file changed since is unviewed again.

**Why.** GitHub's pending review and "Viewed" without any server state: nothing of a person's
unsubmitted work is kept by the registry.

### D04-9. Resolving a conversation: found by the Worker as the person; its state not shown

**Decision.** GitHub keeps whether a conversation is resolved in GraphQL only, which anonymous
readers cannot query. `pull_thread` names the conversation by its first comment's id (which the page
reads anonymously); the Worker finds the thread as the person (at most 5 pages of 100) and resolves
or unresolves it. The page offers both, without showing the state.

**Why.** D00-5 (no token for reads); resolving still works in the registry.

### D04-10. The paper's verified authors are suggested as reviewers, to the people who manage the code

**Decision.** `GET /api/forge/repo` answers `reviewers`: the GitHub logins of the linked papers'
verified authors (the registry's roles, the users' GitHub handle), only to a reader who is the
repository's owner, maintainer, the person who linked it, or a verified author of one of its papers;
anyone else gets none. `migrations/d1-community/0004_roles_by_paper.sql` adds `roles_scope` (the
query 0001 foresaw): read by index, never a scan (10 rows read for the seeded example). GitHub asks
reviews of collaborators only; an author who is not one reviews in the registry by commenting, said.

**Why.** The plan's research layer ("the paper's authors are suggested as reviewers"). A verified
author linked their GitHub account to act on their paper's code; the pairing is shown to the people
who manage that code, never to signed-out readers or in a static file.

**What would change it.** The owner preferring an opt-in per author.

### D04-11. CODEOWNERS read in the browser, as GitHub reads it

**Decision.** `src/lib/codeowners.ts`: GitHub's places in its order (`.github/`, the root, `docs/`)
on the default branch, its patterns (no `!`, no `[ ]`, `docs/*` one level, the last rule wins), the
lines GitHub skips said with why. Its owners are suggested as reviewers and labelled "code owner";
a team or an owner named by an email address is said (never its address), not asked.

**Why.** GitBackend has no CODEOWNERS method (the design's note); a raw read costs no quota.

### D04-12. The tracing-map guard lives in the registry's pages; the GitHub check run is deferred

**Decision.** The creation form, the conversation's sidebar and Files changed list the tracing-map
links a pull request touches — for each file, the paper, the Methods paragraph (opening the reader)
and the lines, and whether they change — computed from the merge base (`repo-traced.ts`
`changeTouches`). The check run the App would post on GitHub is deferred.

**Why.** The owner's directive: the review happens in the registry, where the maps are. The check
run needs the App's installation token on `pull_request` webhooks and would show the registry's
work on GitHub's page; it stays in the plan (phase 10's checks).

### D04-13. The research pull request template

**Decision.** When the default branch has no template of its own and the repository is linked to a
paper, the form starts from the registry's research template (what changes; whether it alters
results reported in the paper; the paper; how it was checked; the issues it fixes); it can always be
chosen. A label "alters reported results" set on GitHub is said on the page; setting it is phase
05's (labels).

**Why.** The inventory's adaptation; the author's own words come first.

### D04-14. Bulk close and reopen: one authorization for up to 25

**Decision.** `pull_edit` with `numbers` (≤ 25) closes or reopens them, one GitHub request each, the
sentence naming each number; a refusal midway is said, the ones before it kept.

**Why.** GitHub's bulk actions, within the Worker's 50 subrequests and one authorization.

### D04-15. Forks: made by GitHub; synced by GitHub; leaving the network is GitHub Support's

**Decision.** `fork` into the person's account or an organization of theirs, the default branch
only by default; the list anonymously (`repos.forks`); `fork_sync` through GitHub's merge-upstream
(`repos.syncFork`, added to GitBackend with the adapter, the double, the fake and the contract), a
conflict leaving the branch as it was. The network's rules (public, kept when the original goes)
are said in the form.

**Why.** GitHub's semantics, the person's own consent (D03-8's rule: no copy made without it).

### D04-16. Texts shown are masked; addresses are never written back from the page

**Decision.** Every text the pages show — titles, bodies, comments, labels, branch names, paths,
GitHub's default merge messages, a template or a title prefilled in a form — is masked for email
addresses (`pull-common.ts` `el`, `h`, `maskEmails`). Lines that hold an address are never offered
for editing (a suggestion's start, a conflict's own lines, the whole file with markers): the page
would write the hidden form back. A side's own lines can still be kept.

**Why.** CLAUDE.md (no address shown), without corrupting a file (D03-4's reasoning).

### D04-17. The callback's links: the creation form's "?expand=1", nothing else after a path

**Decision.** `forge-client.ts` `VIEWER_PATH` accepts `?expand=1` at the end of a `/r/` path, and no
other query: phase 03's commit on a new branch links "Open a pull request into main" to the form.

**Why.** No open redirect (D03-18); the one query the flow needs.

### D04-18. An action costs 4 Worker requests and 1 D1 row

**Decision.** As D03-19: the CSRF read and start, then after GitHub the CSRF read and act; the
action row. At ~150 actions a day: ~600 requests and ~150 rows, inside §15.4's share for phase 04.

### D04-19. The test world: a reviewed pull request from a fork; maintainers' edits and pull refs in the double

**Decision.** The fake GitHub starts with a CODEOWNERS file, an issue, and Bob's pull request from
his fork (a Hann window in `band_power`, the lines the fixture's map links), reviewed by Ada with a
suggestion and answered — what the screenshots show. The double keeps a pull request's head
reachable after its branch is deleted (GitHub's `refs/pull/<n>/head`) and lets a maintainer of the
base commit to a fork's pull request branch that allows it.

**Why.** The pages and the end-to-end run need GitHub's semantics where the contract depends on them.

## Phase 05: issues (2026-09-29)

Taken while building issues in the registry ([ISSUES.md](ISSUES.md)), under the owner's directive of
2026-09-29 (GitHub is OSCR's competitor: issues are read, written, triaged and closed in OSCR) and
D00-4, D00-6 (every write the person's own, one authorization each; ordinary issues are GitHub's
objects, the scientific issue types OSCR's own).

### D05-1. Eleven action kinds for GitHub's issues, each one act as the person; no ordinary issue in D1

**Decision.** `issue_open`, `issue_edit` (edit, close with a reason, reopen, labels and assignees
added or removed, milestone, type; bulk on up to 25), `issue_comment` (a comment, its edit, its
deletion), `issue_react`, `issue_lock`, `issue_pin`, `issue_transfer`, `issue_relation` (sub-issues,
"blocked by"), `issue_branch`, `issue_labels`, `issue_milestone` (`act-issues.ts`), in the registry of
phase 01; `migrations/d1-forge/0004_issues.sql` rebuilds `actions` with the kinds. Each writes the
action row only (1 row), none needs the repository to be one the registry follows: GitHub decides
who may, and what GitHub dropped (labels, assignees, a milestone or a type for someone who does not
triage) is said. No title, body, comment or label reaches D1 or a log.

**Why.** D00-6: one source of truth; the row budget of §15.4; one write path to secure and cap.

### D05-2. Research issues are the registry's own objects: three types, a paper and its code, one numbering

**Decision.** `research_issues` and `research_comments` in `oscr_forge`
(`migrations/d1-forge/0005_research.sql`): a code error, a code–paper mismatch (its tracing-map link:
the paragraph, the file and lines at a commit — required), a reproduction failure (its report). Each
belongs to a paper (a DOI) and to its code: a GitHub repository the registry knows as that paper's
code (`repo_papers`, or the Mac's `paper_repo` fact), or code hosted elsewhere at a place the
registry recognizes (`contributions/links.ts`). One numbering for the registry, written
`research#12` (the rowid): no counter row, no per-repository number to race for, and a form GitHub
does not read as its own reference. A repository without a paper has ordinary issues only.

**Options compared.** Research issues as GitHub issues with a label (GitHub's closing keywords would
work, but the objects, their rules and their text would be GitHub's, and a paper whose code is not
on GitHub could have none); per-repository numbers (a read and a race at every creation, and no
number for code elsewhere).

**Why.** D00-6; the plan's research layer; a research issue outlives a repository's move.

### D05-3. GitHub's issue addresses in the /r/ shell; research issues in one shell of their own

**Decision.** `issues/?q=`, `issues/<n>`, `issues/new[/choose]`, `labels`, `milestones`,
`milestone/<n>` after `/r/<owner>/<name>/` (a pull request's number goes to its page); the research
issues at `/research/<n>`, `/research/new`, `/research/?paper=`, served by ONE static file through
`public/_redirects` (`/research/* /research/ 200`), with a Content-Security-Policy that connects to
this site only. The callback's links accept `/research/<n>` and nothing else under it.

**Why.** D02-1 (GitHub's addresses translate one to one); a research issue about code elsewhere has
no repository page; the file budget (one file, whatever the number of issues).

### D05-4. The list reads GitHub's list endpoint and filters in the browser; its search only for what only it knows

**Decision.** GitHub's list endpoint (100 issues, 1 request) with the state, the labels (AND), one
milestone, assignee and creator, and the sort; the rest of GitHub's issue qualifiers, and the
registry's research ones (`is:research`, `type:mismatch|reproduction|code-error`, `doi:`, `paper:`,
`map-link:`, `path:`, `resolution:`, `outcome:`), filtered in the browser over both kinds; GitHub's
search (10 a minute) only for `commenter:`, `involves:`, `mentions:`, `linked:`, `in:`, its query
stripped of the registry's own qualifiers. Pinned open issues first. Bulk actions on up to 25 in
ONE authorization (15 when labels or assignees change: each issue is read first, two requests each,
within the Worker's 50 subrequests).

**Why.** D00-5 (the reader's quota for what the page shows); the research issues are found where the
code is.

### D05-5. Templates and issue forms read as GitHub reads them; the research forms offered first

**Decision.** The default branch's `.github/ISSUE_TEMPLATE/` (forms and Markdown templates, by file
name), the legacy single template, `config.yml` (blank issues, contact links: https only, named by
their host) — read raw (not counted), parsed with the viewer's YAML reader (`issue-forms.ts`), with
GitHub's validation said for a form it would refuse; the answers written as GitHub writes them. On a
repository attached to a paper, the chooser lists the registry's three research forms first; they
open research issues, not GitHub issues.

**Why.** The repository's own forms come first for the software; the research forms are why a
researcher reports here (§15.5, rank 4).

### D05-6. GitHub's issue types kept; the research types are the registry's

**Decision.** GitBackend gains `Issue.type`, `NewIssue.type`, `IssuePatch.type` (the adapter, the
double, the fake, the contract): GitHub's issue types belong to organizations ("Task", "Bug",
"Feature"), and a personal repository's refusal is said. The research types are never GitHub types:
they are research issues (D05-2), filtered with `type:` beside GitHub's.

**Why.** Most research repositories are personal: the research types cannot depend on an
organization's settings.

### D05-7. Prefill by address: GitHub's parameters and the registry's

**Decision.** `title`, `body`, `labels`, `assignees`, `milestone`, `template`, `type` (GitHub's), and
`doi`, `repo`, `commit`, `path`, `lines`, `paragraph`, `section`, `parent`, and a form's fields by id
(GitHub's) or by `field.<name>=` for the research fields (the registry's: GitHub cannot prefill
fields) — each checked; a prefilled text is masked for email addresses. The code view's line menu, the
Code ↔ Paper reader and the paper's page build these addresses.

**Why.** The reader who sees a mismatch in the reader or the code files it in one click, with the
paragraph, the lines and the commit already said.

### D05-8. An issue's page: every write one authorization, reactions and ticks included

**Decision.** Comments, reactions, the task ticks (one edit of the text), edits, closing with a
reason, labels, assignees, milestone, type, relationships, lock, pin, transfer and a branch are each
one authorized action: 4 Worker requests and 1 row. GitHub's REST does not say whether an issue is
pinned, nor who reacted: the page offers pin and unpin, and "take mine back".

**Why.** D00-4 (no stored token); the cost of consent is a round trip to GitHub per act.

**What would change it.** The owner accepting session-held user tokens (D00-4's alternative).

### D05-9. Similar issues are lexical, in the browser

**Decision.** While a title and a text are written, the page compares their words (no stop words, a
plural's "s" dropped) with the repository's recent issues (1 request) and the research ones: shared
words over all words, the same file or paragraph weighing more; the five closest above a threshold.
No model per query; the Mac's nightly "similar issues" with its local model (the 01:00–07:00 GPU
window) are left for phase 08.

**Why.** Zero cost; CLAUDE.md's model rule (rules first, the model at night only).

### D05-10. Suggestions set by rule, never applied without the person

**Decision.** A research type or a label the text suggests (a comparison of the paper and the code,
a result that did not come out, a traceback, the data, versions and packages, numbers that differ)
is shown marked "set by rule" with its reason in words; the person adds or declines each. Nothing is
applied on its own, whatever the confidence.

**Why.** The plan's automated-decision transparency (plan decision 1, PLATFORM_PLAN §15.7, gives it
to this phase); CLAUDE.md's "rules first".

### D05-11. The reproduction report is carried by the reproduction-failure issue

**Decision.** The platform plan's `reproduction_reports` table (§4) was never built. A reproduction
failure carries its report in its own row (`report`, JSON: the outcome, the environment, the data,
the command, what the paper reports, what came out, the figure), the texts masked: one row, no
second table. Successful reproductions (the Reproductions section's other half) wait for phase 06's
per-paper spaces.

**Why.** The budget (§15.4: a research issue is 3 rows); no report without its conversation.

### D05-12. Who triages a research issue

**Decision.** Anyone signed in opens and comments; the author edits, closes and reopens; the paper's
verified authors, the code's maintainers (the registry's roles), the person who manages the
repository in the registry (who linked or created it, or its owner by GitHub login: one read by the
repository's key) and the moderators also label, lock, pin (three per paper, "known issues") and hide
comments. A locked conversation takes its triagers' comments only.

**Why.** D04-10's "people who manage the code", and the paper's authors, whose paper it is about.

### D05-13. A merge in the registry closes the research issues its text names

**Decision.** The pull request's page says which research issues its title and description name with
a closing keyword ("Fixes research#12"); the merge sends their numbers (`pull_merge` `closes`, 5 at
most), and the Worker reads the pull request as the person and closes each one its text names, about
this repository, when the merge goes into the default branch (GitHub's own rule): "fixed in the
code", at the merge commit, 1 row each. A merge made on GitHub itself closes none (the webhook path is
deferred): the research issue's page keeps "Close: fixed in the code".

**Why.** "A pull request that closes one says so"; nobody closes a research issue the pull request
does not name.

### D05-14. A research issue is copied to GitHub by its author only, once

**Decision.** `research_copy`: one authorized action by the research issue's author, on its
repository (the page declares it, the Worker checks it is that one): an ordinary issue with the type's
label, its text followed by the paper's DOI, the lines' permalink and "research#12"; the research
issue names the copy (2 rows). A second copy is refused.

**Why.** D00-6 ("an OSCR issue can be copied to GitHub as an ordinary issue with a label, one at a
time, when its author asks"); the registry never posts on GitHub on its own.

### D05-15. A text holding an email address is not edited in the registry

**Decision.** Quotes, "Reference in a new issue" and "Duplicate this issue" carry the text masked; the
edit of a title, a description or a comment that holds an address is not offered: the sentence says
why, and links it at the source. Research texts are masked before they are stored, so they are always
editable.

**Why.** D04-16: no address shown, and a masked copy written back would lose it.

### D05-16. The registry's writes of research issues are logged in `actions`, and cost 3, 3 or 2 rows

**Decision.** `research_open`, `research_comment`, `research_edit` (types.ts `RESEARCH_KINDS`, after
`ACTION_KINDS` in the migration's CHECK) write an action row like every authorized action, so that
the per-account caps (100 writes, 20 research issues a day) and the day's 5,000 rows count them. A
new issue writes its row, its index entry (`research_paper`, the only index: a paper's issues, a
repository's through its papers) and the action row; a comment its row (keyed by the issue: no
index), the issue's count and the action row; a change the issue and the action row, its events kept
in the row (the last 100, as GitHub caps an edit history). No job row: the Mac reads the tables at
night.

**Options compared.** A job per write (the plan's sketch: one more row per write, for a Mac that can
read the tables by key anyway); a second index by repository (one more row per issue).

**Why.** §15.4's budget; the caps counted from the rows, with no counter row (D01-11).

### D05-17. Signed-out readers read research issues from nightly static shards

**Decision.** `oscr/forgelayer.py` adds each repository's research issues' summaries to its layer
entry (`research`, the newest 200) and writes 64 shards `/forge/research/NN.json`, NN = the number
mod 64, each issue whole (its text, report, events, comments), in the shapes of the Worker's answers,
never who wrote them by account; an issue about a repository left out of the layer, or about a paper
the Mac holds off-topic or withdrawn, is left out; everything scrubbed. `scripts/data.mjs` copies them
and `npm run check` checks them. Before its migration, `oscr_forge` simply has none.

**Why.** Plan decision 4 (PLATFORM_PLAN §15.7: OSCR-native objects as nightly static shards for
signed-out readers, live for signed-in ones); 0 Worker requests signed out (§15.4); a fixed number of
files.

### D05-18. Labels are words with a colour mark from a fixed palette

**Decision.** A label is its name after a small square of its colour: GitHub's hex colour mapped to
the nearest of 16 named colours, painted by `science.css` through `data-color`, never a `style`
attribute, never a pill. A new label's colour is chosen from the palette; GitHub's ten default labels
and three for research code (data, environment, numerical difference) are added in one
authorization.

**Why.** CLAUDE.md (science.css only; no pills; a status in words).

### D05-19. The test world: issues on the fake GitHub; the end-to-end run's issue checks

**Decision.** The fake GitHub starts with labels, a milestone and issues (Bob's Figure 2 issue,
typed, pinned, with a task list, a reaction, a comment and a sub-issue; one closed as completed, one
as not planned: `fake-github-seed.ts` `seedIssues`). The end-to-end run opens a typed GitHub issue,
labels it, comments, closes it as not planned; opens a research issue, labels it, comments, closes it
with a resolution; closes a second one through a pull request's merge; copies one to GitHub; and
checks another account refused (`FORGE_OPEN`). The screenshots' browser blocks every outside address
(Europe PMC, Hugging Face, doi.org, GitHub).

**Why.** The pages and the run need GitHub's semantics where the contract depends on them; nothing
leaves the machine.

## Phase 07: releases, packages and environments (2026-09-29)

Taken while building releases in the registry ([RELEASES.md](RELEASES.md)), under the owner's directive
of 2026-09-29 (GitHub is OSCR's competitor: releases are read, compared and made in OSCR) and D00-4,
D00-6, D00-9, D00-15 (every write the person's own, one authorization each; releases and tags are
GitHub's objects, the tie of a release to a paper's version the registry's; large data to release
files, Zenodo or Hugging Face; Software Heritage on request), with CLAUDE.md's DOI rules.

### D07-1. Nine action kinds for GitHub's releases, tags and files, each one act as the person; no release in D1

**Decision.** `release_create`, `release_edit`, `release_delete`, `release_drafts`, `release_research`,
`tag_create`, `tag_delete`, `asset_upload`, `asset_delete` (`act-releases.ts`), in the registry of phase
01; `migrations/d1-forge/0006_releases.sql` rebuilds `actions` with them. None needs the repository to
be one the registry follows: GitHub decides who may; its refusals are said in words. No title, note or
file reaches D1 or a log.

**Why.** D00-6: one source of truth; one write path to secure, audit and cap.

### D07-2. The tie of a release to a paper's version is the registry's own

**Decision.** `release_papers` (forge, repo, tag, paper): the version (`preprint`, `submitted`,
`accepted`, `published`, `correction`), its label (no at sign), the commit the tag named, the digest of
the map the person saw, `linked` or `proposed` by D01-22's roles. The repository must be known as the
paper's code (`repo_papers`, or the Mac's `paper_repo` fact). A person who may push, or a verified
author of the paper, ties and unties, at creation or later (`release_research`). 1 row.

**Why.** GitHub has no link between a release and a paper; the plan's research extension of the form.

### D07-3. A cited release keeps its code

**Decision.** A release names the full commit id the page showed (an existing tag must name it: 409
`tag_moved`); a published release keeps its tag and its commit; a release a paper's version is tied to
stays published and is not deleted (untie first); a tag a published release or a tie uses is not
deleted. GitHub's immutable releases (locked tag and files, editable text, a deleted one's tag never
reused) are respected and said ("Immutable", in words).

**Why.** A citation of `v1.0` must always mean the same code; the tracing map's lines are at a commit.

### D07-4. The tracing map versioned with the release is the Mac's job

**Decision.** A tied release, when published, asks the Mac for a `release` job: it freezes the paper's
map (`zenodo.map_of`, links and metadata only) for (repository, tag, paper), with the release's commit
and the commit the map's lines are at (`forge_map_version` in its state), answers the digest into the
tie (1 row), and says when the map changed since the page showed it. The static layer shows it.

**Why.** The map is the Mac's (the harvester's alignment); the Worker records what the person saw.

### D07-5. The Zenodo deposit of a release's map: the author's request, the sandbox, never the code

**Decision.** `deposit` (in `release_create` or `release_research`): a verified author of the paper
with an ORCID iD linked (checked by the Worker, again by the Mac), the map's digest still the one the
author saw, then Phase 6's `zenodo.validate` and `zenodo.deposit_map` with the release: the tag as the
record's version, IsSupplementTo the paper, References the release's code at its commit, a new version
of the map's record when it has one. The sandbox unless `OSCR_ZENODO_INSTANCE=zenodo`; the job carries
the ORCID the author signed in with (`jobs.proof`): from ORCID's sandbox, a test, which only Zenodo's
sandbox takes. The static layer shows a real Zenodo's DOI only. A DOI for the code itself is Zenodo's
own GitHub integration, the author's act outside the registry.

**Why.** CLAUDE.md: a DOI only for a map an author validated; the code is never redeposited; the
sandbox for all development; a test never in a public output.

### D07-6. Software Heritage for a release: a person who may push asks

**Decision.** An `archive` job whose `ref` is the tag, asked by a person who may push (D01-27's rule),
at publication or later; Save Code Now takes the repository's tags with it.

**Why.** D00-15: on a person's request only.

### D07-7. Drafts are read as the person and kept in the tab

**Decision.** The pages never read drafts anonymously (GitHub hides them). "Show my drafts" is one
authorization (`release_drafts`, 1 row); the callback page keeps the answer — masked texts, never a
token — in the tab's sessionStorage by repository (`release-stash.ts`), with a draft just saved; the
list says "as GitHub showed them to you", and forgets them with the tab.

**Why.** D00-4: no stored token; the registry keeps no draft.

**What would change it.** The owner accepting session-held user tokens (D00-4's alternative).

### D07-8. Files through the Worker, up to 25 MiB, on a route of their own

**Decision.** `POST /api/forge/asset` completes `asset_upload` with the file as the body: the completion
in headers, `Content-Length` required (≤ 25 MiB, else 413 before anything is read) and held; the Worker
streams the body to GitHub without parsing, buffering or hashing it, then compares GitHub's own SHA-256
with the one the page computed, and removes a different file again, as the person. The file waits in
the tab's IndexedDB across GitHub's authorization (ten minutes, taken once). `act` never carries a file;
the file route completes that one kind. Larger files: GitHub's own release page, or Zenodo or Hugging
Face, said with the reason. The registry never downloads an asset.

**Options compared.** The file in act's JSON (base64: 33 % more, parsed, 1 MiB); a presigned upload
(GitHub has none); hashing in the Worker (≈ 50 ms of CPU for 25 MiB, over the free plan's 10 ms).

**Why.** D00-9's 25 MiB, the Worker's CPU, and the person's own authorization for the file they chose.

### D07-9. Release notes written in the browser, as GitHub writes them, with the paper's section

**Decision.** From GitHub's comparison and closed pull requests (a pull request in the range by its
merge commit), grouped by `.github/release.yml` as GitHub groups them (exclusions, categories, the
catch-all, "Other Changes"), co-authors credited by their GitHub no-reply address only; then "For the
paper": the tracing-map links on the files the range changed, and the research issues fixed at its
commits; the full changelog's comparison in the registry. GitHub's generator stays an option. A
research `release.yml` is offered through the editor.

**Why.** The reader's quota, no model, and what a paper's reader needs first.

### D07-10. Semantic versions order the releases; GitHub says which is latest

**Decision.** Semver 2.0's precedence (`src/lib/semver.ts`); "v1" and "1.2" read loosely, a bare number
or a date is no version; the list shows drafts, then versions (highest first), then the rest by date;
the next version is suggested from the highest version tagged and what was merged, with its reason.
GitHub's `releases/latest` is the latest; its legacy rule is explained, never recomputed as GitHub's.

### D07-11. GitHub's release addresses, in the one /r/ shell

**Decision.** `releases`, `releases/tag/<tag>`, `releases/new`, `releases/edit/<tag>`, `releases/latest`,
`releases/latest/download/<file>`, `releases/download/<tag>/<file>`, the registry's
`releases/changelog`, `tags`, and `environment/<ref>`; a Releases tab. No file per release.

**Why.** D02-1; the file budget.

### D07-12. What stays at the source, said

**Decision.** The files' bytes (download links are GitHub's), the source archives (GitHub builds them on
request: their checksum may change; what `export-ignore` leaves out is shown), the Atom feeds (a feed
read through the registry would spend its daily requests), the attestations' verification, files over
25 MiB: each behind an "at the source" link after a sentence that says why.

### D07-13. Environments are read as text in the reader's browser, never executed

**Decision.** `src/lib/environments.ts` parses the environment files as data and says in words what
they pin (exact versions, lock files, a base image by digest), what fetches from the network at build,
what a development container runs on the machine that opens it; scripts are named, never read as code.
Nothing is built, installed or run anywhere; the Mac reads no environment file.

**Why.** D00-11 and the mission's rule; zero cost (the reader's quota, raw reads not counted).

### D07-14. "Where it can run again": plain links that say who runs them

**Decision.** Binder (when the repository has a file Binder reads) and GitHub Codespaces, at the
release's tag, each saying who runs it and under whose account and quota.

### D07-15. Packages: none hosted; declared by the manifests, confirmed by a person who may push

**Decision.** The pages propose what the manifests declare (PyPI, CRAN, conda-forge, Julia's General
registry, npm), with the registry's page and an install line at the declared version;
`package_confirm` records a writer's word (`repo_packages`, `migrations/d1-forge/0007_packages.sql`,
2 rows); the Mac publishes the confirmed ones. The plan's Mac-side reading of the manifests at each
synced commit, and the registries' own metadata, are deferred: the browser proposes, at no cost.

### D07-16. The layers: the ties, the maps, the packages

**Decision.** The static layer's entry gains `releases` (the ties, the frozen maps, a real Zenodo's DOI)
and `packages` (confirmed); each listed paper with code its map's `map` digest (as its page shows it:
the form ties a release to the map the person saw). The signed-in layer adds `releaseTies`, `answered`
(the Mac's words for the releases, from the jobs' tail) and `packages` (confirmed and declined). The
paper's page lists the versions of its code from the static layer.

### D07-17. What an action costs

**Decision.** 4 Worker requests (the CSRF read and start, then the CSRF read and act or the file route)
and 1 to 5 rows (`release_create` with a tie and three jobs: 5; `package_confirm`: 2; the others: 1,
plus a job or a tie each). `ACT_ROWS_RESERVED` (6) covers the largest. Within §15.4's ~150 requests and
~100 rows a day.

### D07-18. GitBackend: a file's SHA-256; the double's immutable releases

**Decision.** `ReleaseAsset.digest` (GitHub's `digest`, "sha256:…", as hex; null for an older file) in
the adapter, the double, the fake and the contract; the double models GitHub's release immutability
(a repository setting; published releases lock their tag and files; a deleted one's tag burned).

### D07-19. `oscr forge poll --instance`: the Zenodo of a release's deposit on the command line

**Decision.** The forge poll takes `--instance sandbox|zenodo` (the settings' `OSCR_ZENODO_INSTANCE`, else
the sandbox); the end-to-end run passes `sandbox` with `OSCR_ZENODO_SANDBOX_URL` at a local mock and a
token that is none.

**Why.** No run of the tests may reach a real Zenodo, whatever the Mac's settings say.

### D07-20. The test world: releases on the fake GitHub; the end-to-end run's release checks

**Decision.** The fake GitHub starts with the paper's version on the tag `v1.0` (published, a file:
the source data of Figure 2), the environment files and a `pyproject.toml` committed, a pre-release for
the journal's revision and a draft (`seedReleases`). The end-to-end run links Ada's ORCID iD, publishes
a release with her notes and GitHub's, tied to the accepted manuscript with its map, asking for Software
Heritage and Zenodo; checks tags, drafts and a package; refuses Bob's release and file; then runs the
Mac's forge poll offline against the mock sandbox and checks the map versioned and the deposit made.
The screenshots' browser blocks every outside address.

## Phase 08: social, discovery, notifications and search (2026-09-29)

Built on `night/phase-07-releases`, before phase 16 (the owner's order change of 2026-09-29): every
write stays behind `FORGE_OPEN`, and D08-17 lists what phase 16 must cover. The contract is
[SOCIAL.md](SOCIAL.md).

### D08-1. The social layer is the registry's own, in `oscr_forge`; no new database

**Decision.** Stars, star lists, follows and watch levels, profiles, events and notification states are
rows of D1 `oscr_forge` (`migrations/d1-forge/0008_social.sql`: eight tables, no index), written by
the person, signed in, one write at a time. OSCR never stars, follows or watches anything on GitHub.

**Options compared.** A new D1 database (5 of 10 at most, one more migration path and binding, and the
forge's caps would not see its rows); KV (not used, §15.4); GitHub's own stars and watches through the
person's token (the token is never kept, D00-4, and GitHub's AUP §4 forbids automated starring).

**Why.** The forge service's gate, caps and day's count apply as they are; zero cost; one write path.

### D08-2. Subjects by durable ids; authors by ORCID iD, verified; a label is the person's own

**Decision.** A repository is `repo:<forge>:<numeric id>` (a rename keeps its stars), a paper
`paper:doi:10.…` (lower case, as `oscr_community` names papers), a topic GitHub's topic name. A follow
names a person by their GitHub numeric id, a catalogue author by ORCID iD (its ISO 7064 check digit
verified) before they have an account, an organization by `owner:<forge>:<login>`, a journal, tool,
dataset or category by its catalogue id, a thread by `thread:<subject>#<thread>`. The label a page
sent is shown on the person's own Stars page only; the public pages name subjects from the registry's
own data.

**Why.** A follow by ORCID iD is found again when the author signs in (their identity's key); a label
is someone's text and never becomes the public name of a paper or a repository.

### D08-3. Social writes are logged like actions, with caps of their own

**Decision.** Each write batch carries its action row (kinds `star`, `star_list`, `follow`, `notice`,
`profile`; `actions` gains `subject`, what the write was about). Per account and 24 hours: 300 social
writes and 500 notification changes, counted apart from the 100 authorized actions (a person who stars
and reads keeps the right to act); totals of 3,000 stars, 2,000 follows, 32 lists of 300 entries. The
day's 5,000 rows count them.

**Why.** "Counted from the rows, with no counter row" (D01-11), and the global cap sees every row.

### D08-4. No count row: counts, stargazers and public profiles are the Mac's nightly shards

**Decision.** The Worker never counts stars, watchers or followers. The Mac reads the tables each night
and writes `social/NN.json` (64 shards); a signed-in reader's buttons show last night's counts and
their own live state.

**Options compared.** A counter row per subject (a write per star on a hot row, and a count that
drifts); an index per table for `count(*)` (a row more per write, and reads that grow with the
counts).

**Why.** 2 rows a star instead of 3–4; signed-out pages ask the Worker nothing.

### D08-5. One event row per event, keyed by its subject; the inbox is fanned out on read

**Decision.** `events (subject, at, nonce)`, WITHOUT ROWID, no index: a repository's or a paper's
events are its key's prefix. The inbox reads the subjects its reader follows. A person's activity reads
their action rows (their key), and each action's event by its subject, time and nonce (the action's
own).

**Why.** The plan's decision (§15.6): one row per recipient would multiply the writes by the watchers;
no index keeps an event at 1 row.

### D08-6. The same act seen twice is one event

**Decision.** An authorized action and GitHub's webhook for the same act both name GitHub's object
(`ref`: `comment:<id>`, `issue:<n>:opened`, `pull:<n>:merged`, `release:<tag>`…); each insert is
conditional on no event of the same subject naming it by the same GitHub account within a day, so
whichever lands first is the only one. Actions write their events on every repository the registry
knows, alive; the research routes write theirs under the paper.

**Options compared.** Writing actions' events only where the App is not installed (a repository linked
before the installation still receives webhooks: duplicates); a window by (thread, kind, actor) (two
comments of one person on one thread became one).

### D08-7. GitHub's issues and comments reach the inbox as their title and the logins they name

**Decision.** The codec maps `issues` (opened, closed, reopened) and `issue_comment` (created), and
`pull_request` and `release` gain their title, author and mentions; the webhook writes one event, with
its delivery row (D01-24's 2), for a public repository the registry follows, covered by the
installation. The text itself is never kept; an email address is no mention.

### D08-8. The inbox's scope and reasons

**Decision.** At most 60 subjects (watched repositories at their level, watched papers, organizations'
repositories — 30 each —, followed threads), the most recently followed first; 30 events each, 3 months
back. The reader's own acts are no notification; a repository that left the registry drops its events;
a paper's events never name a repository. Reasons: mentioned, the thread's author (by account or by
GitHub id), took part (a thread followed on taking part), a watched repository (at its level, or its
custom types), a watched paper, an organization. A mention reaches a reader within what they watch.

**Why.** Bounded reads (≤ 1,800 rows an inbox at worst) within the plan's 200,000 a day; a mention
outside what one watches would need a row per mention (deferred).

### D08-9. A notification's state is per thread, and newer activity brings it back

**Decision.** `notice_state (user, thread)`: read and done hold until newer activity; saved stays past
the 3 months with the words it showed; "mark all as read" is one row (`notice_marks.read_before`), an
explicit unread overrides it. Unsubscribe is a `thread:` follow at `ignore`.

### D08-10. Filters and views in the browser: one request a view

**Decision.** The inbox answers every thread (≤ 300); Inbox, Unread, Saved, Done, Read and GitHub's
filters (`repo:`, `org:`, `author:`, `is:`, `reason:`, words) apply in the page (`src/lib/social.ts`);
custom filters (15) are saved in the settings row.

### D08-11. The feed reads the followed people's own action logs

**Decision.** 14 days of each followed person's public acts (not their notification states, profile
edits, lists or followed threads; nothing from a private profile), with their events; authors followed
by ORCID iD are found by their identity once they sign in; the followed subjects' events; the new
catalogue papers of followed authors from `/social/authors/NN.json`. "See less like this" hides a kind
of event (the settings).

### D08-12. People are named by their public handles; ONE shell for every profile

**Decision.** A person's page is `/u/<GitHub login or ORCID iD>/`, one static shell
(`public/_redirects`); the Worker finds a person by their GitHub numeric id (the page asks GitHub for a
login's id, on the reader's quota) or their ORCID iD, never by an account's id, which is never answered.
The picture is an identicon of table cells in one of eight hues by class (no image, no style
attribute); the profile README is the `<login>/<login>` repository's, read raw in the browser and
rendered by the registry's own renderer. A private profile keeps its activity, stars, lists and follows
to its owner. No email address is asked for; a name loses its at signs; links are https without a user
part.

**Why.** The file budget (no file per person); the account's id is the registry's secret; GitHub's
"private profile" semantics.

### D08-13. Milestones in words; the calendar counts what was made in the registry

**Decision.** Milestones are sentences from what the registry knows (papers with code in the registry
through `verified_author` roles, the first map deposited, code linked, Software Heritage asked, a
research issue opened), never badges. The calendar counts authorized actions and research writes (not
stars, follows, notifications or profile edits) over a year read in four key ranges of the person's
own actions (D1 binds 100 values a statement), and marks the person's publications from the catalogue.

### D08-14. Explore is last night's file; topics curated in the code; collections decided by the owner

**Decision.** `/social/explore.json`: the repositories and papers most starred in 7 days, the people
most followed (public profiles only), the curated topics (`oscr/social.py FEATURED_TOPICS`, with
aliases) then the starred ones, and the collections: public star lists their owner proposed and the
registry's owner accepted (`oscr social collections|accept|decline`, 1 row).

### D08-15. The static files: 64 social shards, 64 author shards, one Explore file

**Decision.** `social/NN.json` (keys `repo:`, `paper:`, `topic:`, `person:`, `owner:`; NN the first
byte of the key's SHA-256 mod 64, both sides checked on `tests/fixtures/social-shards.json`),
`social/explore.json`, and `/social/authors/NN.json` built with the site from the catalogue. The build
keeps only well-formed keys in their shard and scrubs addresses; the check refuses an address.

**Why.** The file budget: 129 files whatever the number of people.

### D08-16. One search: the registry's objects in `forge_fts`; GitHub's in the browser; code at the source

**Decision.** `GET /api/search?type=repositories|issues|people|topics` reads ONE FTS5 table,
`forge_fts` in `oscr_search`, pushed incrementally by the Mac from the night's public static files only
(nothing reaches the index that the site does not show); papers stay the default type. GitHub's issues
and commits are searched in the reader's browser for one repository (`repo:owner/name`), shown with
links into the registry's pages; GitHub's code search needs a GitHub sign-in, so the page carries the
query there and says why. A DOI typed alone goes to its paper.

**Options compared.** Searching D1 `oscr_forge` by LIKE (scans); GitHub's search for every repository
the registry knows (five operators a query); the inventory's `oscr_code` (a fifth D1 database and the
push of 1.6–3.0 GB: the owner's decision, deferred).

### D08-17. What phase 16 must cover of this phase

Phase 16 runs after 08. It must bring to these objects:
- **moderation**: profiles (name, bio, status, pronouns, links), star lists' names and descriptions,
  collections (already the owner's decision), and the events' titles shown in inboxes and feeds; a
  hidden account's stars, follows, lists, profile and events hidden retroactively (the shards, Explore,
  the search, other people's inboxes and feeds);
- **blocking**: a blocked person's events out of the blocker's inbox and feed, no follow of the
  blocker, no mention reaching them;
- **reports**: report a profile or a list (Phase 6's `reports`);
- **limits**: the social caps (300 writes, 500 notification changes a day; 3,000 stars; 2,000 follows)
  reviewed with Turnstile on bursts; the mention cap (10 an event); the retention job for events past
  3 months;
- **privacy statement**: the social data held (stars, follows, profiles, notification states,
  events), its retention, a private profile's effect, and what the nightly shards publish;
- **FORGE_OPEN**: this phase's writes open with the rest, not before.

### D08-18. What it costs, measured: above the plan's 1,200 rows a day

**Decision.** Measured rows: 2 a star, follow, list change, profile or notification state; an event 1
(2 from a webhook with its delivery row); a research issue 5 (was 3), a comment 4–5 (was 3), a close 3
(was 2); an authorized action + 1 per event (+ 1 for a thread newly followed). At the plan's volumes
that is ~2,700 rows a day, not 1,200: with the earlier phases the GitHub side reaches its 5,000-row cap,
which answers `quota` instead of overspending; C3 (20,000 from the search push's budget) lifts it.
Reads: ≤ 1,800 an inbox, bounded feeds and calendars; 5 statements a search.

**Why.** Events feed the inbox that phases 04 and 05 wanted; the per-thread follow is what makes
"participating" possible without a row per recipient.

## Phase 10: automation and integrations (2026-09-29)

Built on `night/phase-08-social`, before phase 16 (the owner's order change): every write this phase
adds stays behind `FORGE_OPEN` (the owner only), and D10-14 lists what phase 16 must cover. The
contracts are [API.md](API.md) (the public API and its tokens) and [AUTOMATION.md](AUTOMATION.md)
(checks, statuses, webhooks). The GitHub side was at its 5,000-row cap (D08-18): this phase writes
little.

### D10-1. The registry's own personal tokens: a SHA-256 in D1, scoped, expiring, revocable, made on the site only

**Decision.** A token is `oscr_pat_` and 43 base64url characters (256 random bits), answered once;
`oscr_forge` `api_tokens` keeps its SHA-256 (the key), a public id, a name, its scopes, its expiry
(1–366 days, 30 by default: none lives for ever) and the day of its last use (written at most once a
day). Ten scopes by area (`repos:read`, `research:read|write`, `social:read|write`,
`notifications:read|write`, `hooks:read|write`, `statuses:write`), a write granting its area's read.
20 an account. Made and revoked only on `/settings/tokens/` (cookie, Origin, CSRF): a token never makes
or lists tokens. Making one is behind `FORGE_OPEN` and the `automation` cap (50 changes a day);
revoking deletes the row at once and is never refused by a cap or `FORGE_OPEN`. The prefix is a
technical identifier, like the cookies' `__Host-oscr_*`, so that secret scanners (GitHub's push
protection included) recognise a leaked token; `redact` removes it from every log line.

**Options compared.** GitHub-style tokens hashed with a salt or a slow hash (no gain for 256 random
bits); tokens stored encrypted (a secret at rest); OAuth apps with the registry as the provider (a
consent screen, client registrations, refresh tokens: deferred, D10-13); tokens in `oscr_community`
(the forge's caps and day's rows would not see them).

**Why.** CLAUDE.md: no secret stored; the plan's model (phase 01, D01-18).

### D10-2. The public API is the site's own handlers; the person comes from the token

**Decision.** `/api/v1/*` (`api.ts`) maps its routes to the handlers of the site's routes
(`read.ts`, `research.ts`, `social.ts`, `inbox.ts`, and phase 10's `hooks.ts`, `statuses.ts`), which
read the person through `who.ts`: the principal the router set after the token, its scope and its rate
limit, or else the site's session. One write path: the same payloads, validation, `FORGE_OPEN`, caps
and rows. The authorized actions on GitHub (`start`, `act`, `asset`) are not in the API: they need the
person's own authorization on GitHub, in their browser (D00-4); GitHub's API serves GitHub's objects.

**Options compared.** A separate REST layer with its own handlers (two write paths to secure and
cap); GitHub-shaped paths (`/repos/{owner}/{repo}/…`) for the registry's layer (they would suggest
GitHub's objects are served).

### D10-3. Bearer tokens only; no cookie; CORS for any origin; dated versions; request ids; ETag

**Decision.** The router strips the Cookie header before any route: a browser's session never acts
through the API, so it needs no CSRF token and answers `Access-Control-Allow-Origin: *` without
credentials (a preflight is answered without a token, cached a day). `X-Api-Version: <date>` pins a
version (unknown: 400); errors keep the site's model with `request_id` and `documentation_url`;
`X-Request-Id`, `X-Token-Scopes`, `X-Accepted-Scopes`, `X-Token-Expires`, `X-RateLimit-*` on every
answer; a weak ETag (the SHA-256 of the body) and 304, not counted; `Link: rel="next"` from a list's
`next` cursor. Only the index answers without a token.

### D10-4. Rate limits in the isolate's memory; no row per request

**Decision.** Per token, 60 requests a minute and 1,000 a day, counted in the Worker isolate's memory
(`bearer.ts`); `GET /rate_limit` never counts, a 304 is given back. When the owner binds Cloudflare's
rate-limiting binding as `API_LIMITER`, it is asked too (not in `wrangler.toml`: whether it is free is
the owner's to confirm). The Worker's own daily quota stays the last word (429 on `/api/*`).

**Options compared.** A row per request, or a counter row per token and day (1 row written per call:
8,000 a day against the GitHub side's 5,000, D08-18); the Cache API as a counter (per data centre,
racy); Durable Objects (not in the plan's free budget).

**Why.** Zero cost and no row. The cost: a ceiling per isolate, not an exact global count, said in
API.md.

### D10-5. Outgoing webhooks on a paper or a known repository, for the inbox's events; pinged before they are active

**Decision.** `hooks` (the person's key, and ONE index `hooks_subject` for the deliveries) on
`paper:doi:10.…` (any DOI: a paper's events are public in the registry) or `repo:<forge>:<id>` (a
repository the registry follows, alive), for the events of `events.ts` a subject has (a paper's six,
a repository's eleven) or `*`. 10 an account, 10 a subject. A ping is sent when a hook is made; the
hook is active once a ping is answered 2xx; ten failed deliveries in a row pause it. Pausing and
deleting are never refused by a cap or `FORGE_OPEN`.

**Why.** The ping proves the receiver wants the traffic (a hook cannot be pointed at someone else's
service to flood it); the events are the ones the in-site inbox already shows, so a webhook carries
nothing a signed-in reader could not see.

### D10-6. A webhook's secret is derived from the server key, never stored; GitHub's signature scheme

**Decision.** `secret = "whsec_" + HMAC-SHA-256(SESSION_KEY, "hook\n" + id + "\n" + salt)`, answered
when the hook is made or its secret rotated (a new salt, 1 row). Deliveries carry `X-Hub-Signature-256:
sha256=<hex>` (the HMAC of the raw body), as GitHub's do, so receivers reuse their code; `sent_at` in
the body lets them refuse old deliveries.

**Options compared.** The secret stored in D1 (a secret at rest, readable by anyone who reads the
database); encrypted with a key of the Worker (the same key's reach, plus a column of ciphertext).

**What would change it.** A rotation of `SESSION_KEY` changes every secret: its owners rotate theirs
again (said in AUTOMATION.md).

### D10-7. Deliveries leave from the request that wrote the event; retries within it; no Queues, no Cron

**Decision.** `queueHooks` after the batch of `act.ts`, `research.ts` and `webhook.ts`, in `waitUntil`:
the subject's active hooks (one indexed query: 0 rows when there are none), the event read back by
its key (an event another path wrote first is not delivered twice), one signed POST per hook, 5 s for
an answer, again after 1 s and 4 s on no answer, a 5xx, 408 or 429, never on another 4xx or a 3xx
(`redirect: "manual"`), at most 20 sends a request. One row a delivery in `hook_deliveries`, keyed by
the day first (its status, time, tries, a few fixed words; never the answer's body), counted in the
day's rows by a third key range of `globalRowsToday`; past the cap the delivery is made and not
logged. The address is checked before every delivery against private networks, loopback, link-local
and reserved addresses, IPv6 literals, local names and rebinding domains, and the registry itself;
development's `HOOKS_ALLOW_LOCAL=1` lets localhost through and a test keeps it out of `wrangler.toml`.
A person redelivers an event's delivery from its last 7 days.

**Options compared.** Queues or Cron Triggers for automatic redelivery (not in the free plan's
budget, §15.4); the Mac as a redelivery engine (the Mac never posts to people's services: an outside
contact from the owner's machine and network).

### D10-8. The registry's checks run no code: one pure module for the Worker and the browser

**Decision.** `worker/forge/checks-core.ts`: a licence (recognised from its text), an environment file,
the paper's DOI, `CITATION.cff`, the tracing maps' coherence, file sizes, the README; each finding in
words with its way out; `failure` only when the change breaks traceability (a traced file deleted or
renamed, the licence deleted, `CITATION.cff` made unusable), `neutral` when something is missing. It
reads a tree listing and three files as text; nothing is built, installed, imported or run.

**Why.** D00-11; the inventory's "AI review" items become rules (automatic, never a model).

### D10-9. One check run on every pull request, from the App's delivery, 0 D1 rows

**Decision.** `pull_request` `opened`, `synchronize`, `reopened` and `ready_for_review` on a public
repository the registry follows, covered by the installation that sent them, start `pr-checks.ts` in
`waitUntil`: the installation token (the repository's `read`, then `checks: write`) reads the head,
checks, and posts one completed check run whose details page is the registry's own
`/r/<owner>/<name>/checks/<sha>`. `skip-checks: true` in the head commit's message skips it. The
installation is the repository row's, or else the delivery's (an installation on all of an account's
repositories). The run's name is `<SITE_NAME>: research checks` when the Worker has the variable
`SITE_NAME`, else "Research code checks".

**Why.** D04-12 deferred it here; the result lives on GitHub and in the registry's view, so no row.

### D10-10. The Checks view at any commit, the papers' cited commits first

**Decision.** `checks/<ref>` in the one `/r/` shell and a Checks tab: the registry's checks computed in
the reader's browser, links to the checks at the commits the papers' maps cite, the researcher's own
CI as GitHub reports it (check runs, statuses; the registry's own run named as such), the statuses
posted to the registry (signed in only), the environments the workflow files test, read as text. The
logs stay GitHub's (a download needs a GitHub sign-in): the one link to GitHub, said so. A pull
request's Checks tab links to its head's view.

### D10-11. Commit statuses posted by outside services: the latest of each context, 20 a commit

**Decision.** `statuses` keyed (forge, repo_id, sha, context), upserted: 2 rows a status with its
action row (kind `status`, the `statuses` cap: 300 a day). A repository the registry knows, alive; a
target page https without a user part; texts masked. Read by the API and, signed in, by the Checks
view, with GitHub's combined state.

### D10-12. GitHub Actions posts statuses with its own OIDC token: no secret in the repository

**Decision.** `POST /api/v1/statuses/actions` takes GitHub's OIDC token as the bearer: RS256 against
GitHub's published keys (`account/jwt.ts` gains `verifySignature`, `verifyIdToken` unchanged; an
unknown key refetches the keys at most once a minute, opt-in, for this caller only), the issuer, the
audience (the site's origin), the times, `repository_id` of a public repository the registry follows.
The status is the repository's own ("GitHub Actions: <workflow>"); the action row's account is
`oidc:github:<repository id>`, so the daily cap counts per repository; until phase 16, only
repositories whose owner is the registry's owner (`FORGE_OPEN` on `repository_owner_id`).
`GITHUB_OIDC_ISSUER` points at a mock in development only.

### D10-13. What is deferred

- Third-party apps authorized against the registry's API (OAuth with the registry as the provider),
  the Marketplace, Slack and Teams subscriptions (a webhook to a relay the person runs does it now).
- The command line's OSCR device flow (phase 14 builds on these tokens).
- Automatic redelivery of failed webhook deliveries (no Queues, no Cron: D10-7); organization-wide
  webhooks (phase 09).
- The Mac's own paper events for webhooks: a map proposed, validated or flagged, a retraction, a
  reproduction report outside a research issue (they are not `events` rows yet).
- Re-running the researcher's CI from the registry (a person's authorized action on GitHub), check
  suites, required checks (GitHub's branch protection, the person's own settings), the status badge
  (an image from GitHub: D02-6).
- A `status` event for webhooks and the inbox.

### D10-14. What phase 16 must cover of this phase

- **abuse**: webhook addresses (a ping is a request to an address a person names: Turnstile on
  making hooks, a per-account cap on pings), statuses' contexts and descriptions and target pages
  (moderation, reports), token names; the API's unauthenticated requests (a bad token costs one read:
  a per-IP limit if they grow);
- **retention**: `hook_deliveries` beyond 7 days, deleted webhooks' deliveries, statuses of commits
  no longer in the repository, expired tokens (the Mac's retention job, within its row budget);
- **a hidden or blocked account**: its tokens revoked, its hooks paused, its statuses hidden;
- **privacy statement**: tokens (a fingerprint, a name, scopes, the day of last use), webhooks (the
  address, as given, shown to its owner only: an address that carries a receiver's own token is kept
  as given), deliveries' log, statuses (public, with the poster's handle);
- **FORGE_OPEN**: this phase's writes open with the rest, not before.

### D10-15. What it costs, measured

**Decision.** Rows: a token made or revoked 3; a webhook made 4, pinged 2 (3 when it becomes active),
rotated 2, paused or deleted 2–3; a delivery 1; a status 2; an API read 0 (a token's last use 1 a
day); a check run 0. Requests: a webhook's deliveries and a check run ride inside the request that
caused them (subrequests, ≤ 20 sends and ~10 GitHub calls). At the plan's day (~8,000 API calls, a few
hundred deliveries and statuses) that is well under the plan's 800 rows, inside the GitHub side's
5,000.

### D10-16. The reference and the OpenAPI file are built from the routes

**Decision.** `/developers/` (the reference: authentication and scopes, rate limits, pagination,
errors, versions and breaking changes, every route with its parameters and body, webhooks and their
signatures with receivers' code, statuses with a GitHub Actions workflow, the checks) is rendered at
build time from `API_ROUTES`; `public/developers/openapi.json` is written by `scripts/openapi.ts` from
the same routes, and a test fails when the file differs. The site gains 4 files (3 pages, the OpenAPI
file) and their scripts: none per token, hook or status.

### D10-17. The test world: the fake GitHub installs the App; a throwaway key; a local receiver

**Decision.** The fake GitHub server gains `POST /control/install` (the App installed on an account,
its id answered); the end-to-end run makes a throwaway RSA key for the App (the fake accepts any signed
JWT), runs a local receiver on `RECEIVER_PORT` for the webhooks and sets `HOOKS_ALLOW_LOCAL=1` for the
local Worker only. The sign-in mock serves GitHub Actions' keys (`/actions/.well-known/jwks`) for the
OIDC tests.

## Phase 16: content, abuse and rules (2026-09-29)

Built on `night/phase-10-automation` with `main` merged in first (21 commits: the removal request page,
the static file budget, the code-first reader, OpenAlex, the nightly fixes). This phase is the lock
before the GitHub side opens to the public: reports and moderation, maintainers' tools and blocking,
abuse limits and Turnstile, the rules and privacy pages, copyright and private information, known
malware, and the switch `FORGE_OPEN`, which it makes ready and never sets. The contracts are
[MODERATION.md](MODERATION.md) and [POLICIES.md](POLICIES.md). The GitHub side is at its 5,000-row cap
(D08-18): this phase writes little (about 200 rows a day, §15.4).

### D16-1. `main` merged into the night: its file budget and code-first reader win on structure

**Decision.** `origin/main` (b0fb35a) is merged into `night/phase-16-rules` as its own commit, the
conflicts resolved by keeping both intents:
- the per-entity pages stay deleted (`/author/[orcid].astro`); what phase 08 added to an author's page
  (Follow by ORCID iD, the link to their profile in the registry) moves into the entity renderer
  (`src/lib/render.ts`, mounted by `src/scripts/entity.ts` with a dynamic import on authors' pages
  only);
- the old reader page (`/paper/[slug]/code.astro`) stays deleted; phase 05's "Report a mismatch" on
  each match moves into the reader's legend (`Reader.astro`); every link to `/paper/<slug>/code/`
  (the forge layer's `reader`, the code view's traced notes) now points to `/paper/<slug>/#code` or
  `#pair-N`, since main's check refuses a link to the former address;
- `_redirects`: main's 10 entity rewrites and the night's 3 shells (`/r/*`, `/research/*`, `/u/*`):
  13 dynamic rules of the 100 allowed; `_headers`: main's `/removal/` and the paper page's Europe PMC
  and PubMed Central `connect-src`, and every night route kept;
- `scripts/check.mjs`: main's budget, records and link rules (`leads`), with the night's shells in
  `exists`, the night's fixed pages in `FIXED` (phase 10's `/settings/tokens/`, `/settings/hooks/`,
  `/developers/` added), the night's shard checks (layer, research, social, traced), and the inline
  script rule over the union of both lists;
- `env.ts`, `index.ts`: main's `ASSETS` and `handlePage` (pages past `STATIC_PAPERS`, the 404) with the
  night's forge service and public API;
- **Migrations**: the Mac's are main's 0007 (OpenAlex) and 0008 (withheld); the night added none. The
  community database clashed: main's `0003_removal_requests.sql` and the night's
  `0003_roles_by_paper.sql`; the night's is renumbered **`0004_roles_by_paper.sql`** (an index only,
  never applied remotely). `oscr_forge`'s migrations are the night's alone.

**Why.** The owner's instruction for element 0; main's structure is in production.

### D16-2. The DOI lookup's shards: main's two characters and arrays, read by the import page too

**Decision.** Main's lookup is 256 shards named by 2 hex characters, each entry `[status, day read,
page?]`; the night's import page (`src/lib/import-commands.ts`) read 3-character shards of objects. It
now uses `lib/shards.ts` `lookupShard` (one rule) and reads both entry forms (`lookupFields`); a fourth
item, the paper's code links, is read when an export adds it (none does yet).

### D16-3. The file budget with the GitHub side: `STATIC_PAPERS` 5,700, `FIXED_FILES_MAX` 3,600

**Decision.** The night's files count in `FIXED_FILES_MAX`: the fixed pages (~35), their script bundles
(the fixture builds 179 in `_astro/`, main 61), and the nightly shards (forge layer, research issues,
social layer, social authors, tracing maps: 64 each, and Explore's file: `GITHUB_SIDE_SHARDS`, 321).
Main had sized `FIXED_FILES_MAX` (3,000) to its own worst case (2,304 record shards, 256 lookup, 128
lots, 200 categories, ~100 pages and bundles: ~2,990). Measured: main's fixture 107 files besides
papers, the merge's 377; `npm run check:growth` 2,942 files. On the real catalogue that is ~2,900 today
and ~3,300 at the full stock, past 3,000. So, **the same 15,000 margin, divided again**:
`STATIC_PAPERS` 6,000 → **5,700** (the 300 oldest static papers are rendered by the Worker, one request
a view), `FIXED_FILES_MAX` 3,000 → **3,600** (2 × 5,700 + 3,600 = 15,000). `budget.test.ts` adds the
GitHub side's shards and 200 pages and bundles to the sum it checks. CLAUDE.md says 5,700.

**Why.** Main's rule is that the site stays under 15,000 files whatever the catalogue's size; with the
GitHub side, 6,000 static papers would break it as the catalogue fills its record shards. The margin
and the check are unchanged.

**What would change it.** Fewer bundles (Vite's small chunks merged) or fewer shard families would
give papers back their 300 static pages: the owner's choice.

### D16-4. Reports: anyone, with or without an account, behind Turnstile; the owner alone decides

**Decision.**
- `POST /api/forge/report` takes a report of anything the GitHub side shows (a person, a repository,
  a research issue or comment, a GitHub issue, pull request or release, a star list, a commit status;
  a snippet is refused until phase 13), with a reason from the acceptable-use policy's list and the
  reporter's words (required for "other" and for copyright). Signed in, the session and its CSRF
  token; signed out, the site's Origin; always Turnstile, verified server-side. The target must exist
  (1–2 reads by key). 3 rows. No IP address, no email address: a reporter without an account is ''.
- Caps: 20 reports a day per account; 50 a day for all reports without an account together; one open
  report per account and thing.
- **Who moderates: the owner** (the account whose linked GitHub id is `FORGE_OWNER_GITHUB_ID`).
  Moderators by the community `roles` table ('moderator') come later: every moderation route checks the
  owner only, the safest default before the public opening. The Phase 6 removal requests of catalogue
  records stay the Mac's (`oscr reports`); the queue page says so (reading them in the Worker would scan
  `reports`).
- Reports and appeals are open whatever `FORGE_OPEN` says: the registry's pages are public, so is the
  way to report them.

### D16-5. Hidden means absent from every answer at once, and from the static files at the next nightly

**Decision.** One table, `moderation`, keyed (kind, ref). The Worker drops what it hides from every
answer (hidden.ts): research issues and comments (410 for others; a comment's words withheld; the author
and the owner read them with the notice), a suspended account's issues, comments, profile, activity,
feed and inbox events, statuses, webhook deliveries; a repository's layer (410, but to whoever manages
it and the owner); a hidden profile's words and lists; the search's answers (research issues and
repositories at once, people at the next push). The Mac drops the same from the static files each night
(oscr/moderation.py: layer, research shards, social shards, Explore, hence the search index), so a
signed-out reader sees the change after the next nightly publication, as with main's removal requests.
A hidden repository's layer entry says only why; the paper pages say it in one line
(`forge/moderation.json` → `src/data/moderation.json`).

**Why.** Signed-out pages ask the Worker nothing (the budget): the static files are the night's.

### D16-6. A suspended account: every write refused, its tokens revoked, its hooks paused, retroactively hidden

**Decision.** Hiding a person ("suspend") writes two rows (the account, and its GitHub numeric id so
that its GitHub events from webhooks are hidden too), deletes its personal tokens and pauses its
webhooks in the same batch (D10-14). `who.ts` refuses every write of a suspended account (403
`suspended`, with the address of its page), and so does `start` for authorized actions; an appeal and
a data-rights request stay open to it. Restoring does not bring the tokens back (they are gone for
good) nor resume the hooks (their owner does). A person's profile alone can be hidden (`scope:
"profile"`): its words, not the account.

### D16-7. Appeals and counter-notices wait in the reports' queue; the owner answers once

**Decision.** An appeal (or, for a copyright takedown, a counter-notice with its two statements: good
faith and accuracy) marks the `moderation` row and adds a row to `content_reports` (reason 'appeal' or
'counter_notice'), so that the owner's queue is one partial index. One appeal per decision; the answer
(accepted: restored; rejected) is read on `/account/moderation/`, never sent. 4 rows.

**Why.** The forge database keeps one index at most per table (tests/test_forge_schema.py).

### D16-8. Every text is masked, and a remaining at sign is made harmless

**Decision.** Reports', decisions', appeals' and notes' texts go through `cleanText`: control characters
dropped, email addresses masked ("[email hidden]"), a remaining "@" (a mention) replaced by "＠" (U+FF20),
which the CHECKs (`instr(…, '@') = 0`) accept.

### D16-9. The column is `ref`, not `key`

**Decision.** The migration's moderation table names its lookup column `ref`: the schema test refuses a
column named with "key" (or token, secret…), a rule of every migration of `oscr_forge`.

### D16-10. Blocks: silent, from a profile or a comment, with what they do and do not do said

**Decision.** A block (`POST /api/forge/blocks/write`, 2 rows) names a person by "person:github:<id>" or
"person:orcid:<iD>", or the author of a research issue or comment ("research:3#2": the registry finds the
account; the page never learns its id). It keeps the blocked person from commenting on, reacting to,
or opening issues and pull requests in the repositories the blocker manages in the registry (checked at
`start` for `INTERACTION_KINDS`, and for research issues on those repositories), from commenting on the
blocker's research issues, and from following the blocker; the blocker's inbox and feed drop the blocked
person's events and mentions (hidden.ts, with their GitHub numeric id for webhook events). The refusal
says "You cannot take part", never who blocked. The list (`/settings/blocked/`) keeps a ref, a label, the
date and the blocker's note; 1,000 blocks at most; 100 changes a day. The action row names nothing: a
person's public activity never shows whom they blocked. What a block does not do (hide what was already
written, stop reading public pages, anything on GitHub) is said on the page. Closing a blocked person's
open contributions is deferred (D16-20).

**Who manages a repository**, for blocks and limits: the account that linked or created it in the
registry, and the account whose linked GitHub id owns it (its `owner_id`, by the identities' key). The
registry's owner is never refused.

### D16-11. Interaction limits: a repository's or every repository of an account, the stricter wins

**Decision.** Three levels, GitHub's adapted: existing users (accounts older than 24 hours), contributors
(the papers' verified authors and the code's maintainers by the registry's roles, and the managers),
managers only. Durations: 24 hours, 3 days, 1 week, 1 month, 6 months; a limit ends by itself (`until`).
One row per scope (`repo:<forge>:<id>` or `account:<users.id>`), 2 rows a change; the stricter of a
repository's own and its managers' accounts' limits applies. GitHub's "prior contributors" (anyone who
already committed) is narrowed to the registry's roles: finding a person's past comments on a
repository would need an index the budget does not allow. Organizations' limits come with phase 09.

### D16-12. "Low quality", GitHub's seventh reason to hide a comment

**Decision.** `research_comments` is rebuilt in 0010 with 'low-quality' among a maintainer's reasons to
hide a comment (HIDE_REASONS). The owner's moderation stays the `moderation` table's.

### D16-13. The switch: FORGE_OPEN opens only with the content rules in force

**Decision.** `gate.ts` `forgeOpen(env)` = `FORGE_OPEN === "true"` **and** `rulesReady(env)` (Turnstile's
secret set). Without the secret, `FORGE_OPEN="true"` opens nothing: the write routes stay the owner's
(who is not asked for the check while it is not set up), and reports answer 503. Every other rule is
code and in force whatever the switch says: reports, the queue, blocks, limits, caps, the suspension.
The owner's steps, in order, are in NIGHT_REPORT.md: create the Turnstile widget, run
`tools/setup_cloudflare.sh` (step 9), deploy, check a report and a comment behind the check, then set
`FORGE_OPEN=true` (a Cloudflare variable; never in wrangler.toml, never by the setup script).

### D16-14. Turnstile on every public write form of the site; the API carries its token instead

**Decision.** The site's forms that publish words ask for the widget's token and the Worker verifies it
(`requireHuman`, one `siteverify` a send): a report, an appeal, a research issue, a new research
comment, a profile, a star list's name or description, a personal token, a webhook (its ping reaches
an address a person names), a data-rights request. Not asked: edits and deletions of one's own words,
stars, follows, notification states, blocks and limits (bounded by their caps), and GitHub's
authorized actions (GitHub's own authorization, one action at a time, is the person's). A request of
the public API carries a token made behind the check, and is not asked. The widget's script and frame
come from challenges.cloudflare.com: the CSP of the pages with such a form allows them, nothing else.
The site key is public and goes into the pages at build time (`TURNSTILE_SITE_KEY`, from the Mac's
settings `OSCR_TURNSTILE_SITE_KEY` in the nightly); the secret is a Cloudflare secret. Tests use
Cloudflare's documented test keys only, with a local stand-in of `siteverify`
(`TURNSTILE_VERIFY_URL`, accepted on this machine only).

**Deferred.** Turnstile on bursts of stars and follows (D08-17): the buttons would need the widget on
every page; the social caps (300 writes a day, 3,000 stars, 2,000 follows) bound them meanwhile.

### D16-15. Abuse limits: what exists, what was added

**Decision.** Kept: the per-account caps (100 actions, 10 creations, 20 links, 300 social writes, 3,000
stars, 2,000 follows, 50 token and webhook changes, which include pings), the 65,536 characters of a
comment (GitHub's `BODY_CHARS`, the research tables' CHECK), attachments (1 MiB and 100 files through
the Worker, 25 MiB a release asset, GitHub's own types), mentions (10 an event). Added: reports (20 an
account, 50 a day without one), appeals (5), blocks (100 changes, 1,000 kept), limits (20), data-rights
requests (3 a day, 3 open); a suspended account makes no token; an address sending 20 wrong API tokens
in a minute is refused before any read for the rest of that minute (the address in the isolate's
memory only).

### D16-16. Retention, each night, within a budget

**Decision.** `oscr/retention.py` (`oscr forge retention`, and the nightly under `OSCR_FORGE_PUSH`,
`OSCR_RETENTION_BUDGET` rows, 2,000 by default) deletes, by key and a bounded page at a time: events
past 3 months, notification states past 3 months not saved, webhook deliveries past 7 days and those of
deleted webhooks, tokens expired for 30 days, interaction limits past their end, reports decided more
than a year ago, data-rights requests answered more than 3 years ago. The moderation decisions are kept
(their notices are public). The statuses of commits no longer in their repository need GitHub's
answer: deferred (D16-20).

### D16-17. The rules and privacy pages: static drafts, marked, built from the code where they can be

**Decision.** Seven pages, one file each (the file budget): `/terms/` (the GitHub side under GitHub's
own terms; what people own and license; suspension and appeal), `/acceptable-use/` (the reasons a report
may give, and what happens), `/guidelines/`, `/privacy/` (every personal datum held, the private
collection of authors' contact details included, the cookies, the browser's storage, the processors,
retention, transfers, Do Not Track and Global Privacy Control, children, the researchers' data in the
catalogue, the rights), `/limits/` (its numbers imported from the Worker's constants at build time, the
quota messages from the code: the page cannot disagree with it), `/copyright/` (takedowns, GitHub's
notice for code on GitHub, private information, counter-notices, public notices), `/data-rights/` (the
form). Each opens with a ruled notice: a draft awaiting the owner's review, not in force, not legal
advice. What only the owner can say is left as a bracketed blank ([the owner's name and postal address],
the transfers' safeguards, the liability and the law that applies, the counter-notice delay). The footer
links them. Publishing the policies in a public repository under CC0 (the plan) is the owner's choice:
their texts are the pages' files.

### D16-18. Data rights: asked and answered in the site, open to everyone, within one month

**Decision.** `POST /api/forge/rights` (signed in: the sign-in is the proof of identity; for a paper's
author, the ORCID iD the paper names), behind the human check when it is set up, 3 a day, 3 waiting at
most, open whatever FORGE_OPEN says and to a suspended account; `POST /api/forge/rights/answer` (the
owner) answers or refuses with words the person reads on `/account/moderation/`, never by email. The
owner's queue shows the person's public handles (never the account's id) and the date due (one month).
Self-service export and deletion come with phase 09. 3 rows a request, 2 an answer.
