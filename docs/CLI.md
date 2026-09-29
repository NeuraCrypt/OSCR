# The `oscr` command line (night phase 14)

`oscr` is the registry's command line for **researchers**: it links a repository to its paper, checks it
as the registry checks it, traces its lines to the paper's Methods, cites it, and works with its GitHub
repository — the registry's view first. It is a distribution of its own (`cli/`, the import package
`oscr_cli`), apart from the harvester that runs the registry on its Mac (below, "Two commands named
oscr"). Decisions: [DECISIONS.md](DECISIONS.md) D14-1 to D14-16. The API it calls: [API.md](API.md).

- Python 3.10 or later, git, **the standard library only**: nothing else is installed.
- Every command has `--help` with examples; `oscr help <topic>` is the manual's topics
  (`formatting`, `exit-codes`, `environment`, `repository`, `auth`, `safety`, `mcp`).

## Install

```sh
pipx install oscr-cli            # or: uv tool install oscr-cli   (the name on PyPI is provisional)
oscr --version
```

From a copy of the registry's repository: `pipx install ./cli` (or `uv tool install ./cli`): an
environment of its own, never the repository's `.venv`.

### Two commands named oscr

The registry's own Mac has another `oscr`: the harvester's admin command line (the root's `oscr`
package), which its launchd jobs run as `.venv/bin/python -m oscr …` (D14-1).

- The researchers' tool never installs into the harvester's `.venv`, and never uses the import
  package `oscr`. In the repository, it runs as `PYTHONPATH=cli/src .venv/bin/python -m oscr_cli …`.
- Each tells the other's commands apart: the researchers' `oscr nightly` (or `watch`, `forge`, `d1`,
  `jobs`, `zenodo`…) says it is the harvester's and how it runs; the harvester's `oscr auth` (or `repo`,
  `pr`, `issue`, `paper`, `trace`, `cite`, `check`…) is refused as before (argparse, exit 2) with a line
  naming the researchers' tool.
- Their settings and credentials are apart too: `~/.config/oscr-cli/` and the keychain service
  `oscr-cli`, never the harvester's `~/.config/oscr/settings` or `org.oscr.*` entries.

## Sign in

```sh
oscr auth login                  # GitHub, then the registry: both approved in your browser
oscr auth login --github         # only GitHub
oscr auth login --oscr --scopes repos:read,research:write --days 90
```

Two credentials:

1. **GitHub**, through **GitHub's own device flow**. The tool asks `github.com/login/device/code` with
   the registry's GitHub App's **public client id** (from the setting `github_client_id`,
   `OSCR_GITHUB_CLIENT_ID`, or the registry's `GET /api/v1/cli`); you enter the code on GitHub's page;
   the token goes from GitHub to your keychain and **never reaches the registry** (D00-3). It lives 8
   hours; its refresh token 6 months: `oscr auth refresh --github`, or any command when it expired,
   renews it with the public client id; if GitHub asks for more, the device flow runs again.
2. **The registry**, through **its own device-code flow** (D14-2). The terminal prints the address of
   the registry's approval page (`/device/?r=…`) and a code of 8 letters. On the page, signed in with
   ORCID, GitHub or Google, you **type that code**, read what the token may do and for how long, and
   approve or refuse. The terminal polls every 5 seconds, for 15 minutes at most, and keeps the token.
   By default it may `repos:read` and `research:read`, for 90 days; `--scopes` and `--days` ask for
   others (the scopes: [API.md](API.md#scopes)).

**Both are kept only in your system's keychain**:

- macOS: the login keychain, through `security` (the secret is handed on standard input, never on a
  command line); service `oscr-cli`, account `github:<host>:<login>` or `oscr:<host>:<login>`;
- Linux: the Secret Service (GNOME Keyring, KWallet) through `secret-tool`;
- a plain file (`credentials.json`, mode 0600) only when you ask (`--insecure-storage`, or
  `oscr config set credential_store file`), with a warning each time.

`~/.config/oscr-cli/hosts.json` keeps the accounts' public handles, scopes and expiries: never a token,
never an email address.

| command | what it does |
|---|---|
| `oscr auth status [--offline] [--json …]` | who is signed in, where each credential is kept, whether it still works |
| `oscr auth token --github\|--oscr` | print the active token, for a script's environment |
| `oscr auth switch [--user LOGIN]` | another signed-in account becomes the active one |
| `oscr auth refresh [--github\|--oscr]` | GitHub's token renewed; the registry's approved again (the old one revoked) |
| `oscr auth logout [--github\|--oscr] [--user]` | the registry's token revokes itself (`POST /api/v1/token/revoke`), both leave the keychain; GitHub's stays valid at GitHub until it expires (8 hours at most) unless you revoke the App's authorization there |
| `oscr auth setup-git` | the tool becomes git's credential helper **for GitHub's host only**; `oscr auth git-credential` answers nothing for any other host, the registry's included |
| `oscr auth login --with-token < file` | a token pasted on standard input instead (a CI job's) |

In CI: `OSCR_TOKEN` (the registry's) and `OSCR_GITHUB_TOKEN` or `GH_TOKEN` (GitHub's) win over the
keychain. `GITHUB_TOKEN` is not read (on the registry's Mac it is the harvester's).

## The registry's own commands

### `oscr check`

```sh
oscr check                       # the registry's checks at HEAD
oscr check --base main           # the change from main, as the registry checks a pull request
oscr check --rev v1.0 --json conclusion,findings
oscr check --offline             # ask the registry nothing (no papers, no maps)
```

The same seven checks as the registry's check run on pull requests (D10-8): a licence (recognised from
its text), an environment file, the paper's DOI (linked in the registry, or named), `CITATION.cff`, the
tracing maps' files, files over 50 MiB, a README that says how to run the code. The rules are the
Worker's `checks-core.ts`, ported to Python line for line and held to one file of cases both answer
(`tests/fixtures/checks-cases.json`, D14-6). They read files **as text**, from git's object store, and
**never run anything**. The papers come from the registry's live layer when you are signed in, else
from last night's static layer; the maps from its static shards. Exit code 3 when a check fails.

### `oscr cite`

```sh
oscr cite                        # APA and BibTeX, from CITATION.cff (or codemeta.json)
oscr cite --format bibtex >> refs.bib
oscr cite --software             # the software itself, not the paper CITATION.cff prefers
oscr cite --release v1.2.0       # that version, with the DOI its release notes name (a Zenodo badge)
oscr cite --doi 10.5281/zenodo.123 --software
oscr cite --swhid                # the commit's Software Heritage identifiers (swh:1:rev:…, swh:1:dir:…)
```

The citation is the site's own ("Cite this repository", `citation.ts`, ported). A SWHID resolves once
Software Heritage has archived the commit (the repository's page asks it, on request).

### `oscr trace`

```sh
oscr trace list                  # the registry's tracing maps of this repository
oscr trace check                 # their lines at HEAD: same, moved, changed (found by the symbol), gone
oscr trace check --commit v2.0 --paper 10.1234/abcd
oscr trace propose 10.1234/abcd analysis/filter.py:10-24=3 plot.py#L4-L6=5 --section "Methods › Filtering" --write
oscr trace check --file .oscr/maps/10.1234_abcd.json
```

A map links paragraphs of a paper's Methods to lines of its code at a pinned commit. `check` finds each
link's lines again at another commit the way the site's code view does (the same lines, the nearest
copy; else the map's symbol). `propose` makes a map from lines you select — `PATH:START-END`,
`PATH#LSTART-LEND` or a permalink, `=N` for the paper's paragraph — at one commit, with each link's
GitHub and registry permalinks; it warns when the commit is on no remote branch. The registry does not
receive proposed maps from the command line yet (D14-8): keep the file with your code, or cite its links
in a research issue.

### `oscr paper`

```sh
oscr paper link 10.1234/abcd     # attach this repository to its paper
oscr paper list                  # the papers the registry links to it
```

`paper link` goes through **the site's own write path** (D01-7, D14-7): it opens the registry's page
pre-filled — `/new/link/?repo=…&paper=…` for a repository the registry does not know yet, its settings'
Papers otherwise — where you confirm and GitHub authorizes that one action as you. `--no-browser`
prints the address.

## Your repository on GitHub

GitHub's side of every command talks to **GitHub directly, with your own GitHub token** (the registry
never sees it); the registry's side talks to its `/api/v1` with the registry's token. Each command gives
**the registry's page** of what it made or read (`/r/<owner>/<name>/…`); GitHub's address only when the
registry cannot show the thing, with a line saying why (a file's blame, a CI run's logs, `--github`).

| command | what it does |
|---|---|
| `oscr repo create NAME [--license mit] [--gitignore Python] [--add-readme] [--paper DOI] [--clone]` | a **public** repository on GitHub, as you (private ones are refused: D00-14); with `--paper`, the registry's page to link it opens next |
| `oscr repo clone OWNER/NAME [DIR]` | git clone, straight from GitHub, hooks off; a fork gets its `upstream` remote |
| `oscr repo view [OWNER/NAME] [--web]` | the registry's view (linked or not, papers, maps), then GitHub's facts |
| `oscr repo list [OWNER]` | your public repositories, and whether the registry links each |
| `oscr repo sync [OWNER/NAME]` | fast-forward this clone's branch; or a fork on GitHub from its parent |
| `oscr repo set-default OWNER/NAME` | the repository this clone's commands go to |
| `oscr pr create --title … [--body … \| --body-file F \| --editor] [--push] [--draft]` | a pull request from this branch; the registry's checks run on the change first, here |
| `oscr pr list / view N / checkout N` | read them; check one out (hooks off) |
| `oscr issue create --title … [--label L] [--assignee @me]` | a GitHub issue |
| `oscr issue create --research code_error\|mismatch\|reproduction --paper DOI …` | a **research issue** of the registry (a mismatch names `--path`, `--lines`, `--paragraph`; a reproduction `--observed`…); needs `research:write` |
| `oscr issue list / view N / close N [--reason not_planned]` | read and close |
| `oscr release create TAG [--generate-notes] [--draft]`, `list`, `view TAG` | releases; tie a release to the paper's version on its registry page |
| `oscr search QUERY [--type papers\|repositories\|issues\|people\|topics]` | the registry's search; `--github repositories\|issues\|code` for GitHub's |
| `oscr api PATH [-X POST] [-f k=v] [-F k=typed] [--input F] [--jq …]` | the registry's API (`/api/v1`); `--github` for GitHub's |
| `oscr browse [PATH[:LINE] \| NUMBER \| COMMIT] [--commit] [--checks] [--blame] [--github] [-n]` | open the registry's page; GitHub's blame and pages only when asked |
| `oscr run list / view ID`, `oscr workflow list` | your own CI (GitHub Actions): summaries, the commit's Checks page on the registry, GitHub's logs named as GitHub's |

`@me` stands for your GitHub login where a login is asked.

## Output, scripts and safety

- **Terminals and pipes**: in a terminal, aligned columns cut to its width, colours; in a pipe, one
  tab-separated line per item, nothing cut, no colour.
- **`--json FIELDS`** prints the fields named (alone, it lists them); **`--jq EXPR`** filters with a
  subset of jq (paths, `|`, `,`, `//`, comparisons, `select`, `map`, `length`, `keys`, `sort_by`,
  `test`…; variables and `reduce` are jq's own: pipe `--json` into jq); **`--template TMPL`** renders
  with a subset of Go's templates (`{{range}}`, `{{if}}`, `json`, `join`, `truncate`, `timeago`,
  `tablerow`…). `oscr help formatting` lists them.
- **Colours**: `NO_COLOR`, `--color never`, `oscr config set color never`; `CLICOLOR_FORCE=1` in a pipe;
  `oscr config set accessible_colors true`: bold and underline, never red against green, a word always.
  No animation: `OSCR_SPINNER_DISABLED=1` or `oscr config set spinner false`.
- **Escape sequences neutralised**: every text from the network (titles, bodies, branch names, file
  contents) is cleaned before it is shown — control characters in caret notation (`^[`), the C1 controls
  and the Unicode controls that reorder text made visible (`<U+202E>`); JSON escapes them itself.
  Email addresses become `[email hidden]`, as on the site.
- **Exit codes**: 0 done, 1 an error, 2 a usage error, 3 a check failed, 4 sign-in needed, 130
  interrupted.
- **`--debug`** (or `OSCR_DEBUG=1`) says each request and its status, **never a token** (the
  `Authorization` header is never printed; every credential shape is redacted; no body is printed).
- **Never run**: `oscr check` and `oscr trace` read files as text; git always runs with
  `core.hooksPath` set to the null device; nothing cloned is ever executed. The only programs the tool
  starts are git, the keychain's own (`security`, `secret-tool`), and your own browser and editor from
  your settings.
- **No email**: none is asked for, shown or kept. Your commits' address is your own git configuration,
  never read or changed.
- Questions are asked only in a terminal (`OSCR_PROMPT=disabled` turns them off); elsewhere the flags are
  needed, and their absence is a usage error.

### Settings, aliases, completion

```sh
oscr config list                  # every setting, its value and what it does
oscr config set host example.org  # another deployment of the registry
oscr config set git_protocol ssh
oscr alias set co 'pr checkout $1'   # oscr co 12 (aliases never run a shell)
eval "$(oscr completion bash)"       # also zsh and fish
```

The platform's name and the default host live in one place (`cli/src/oscr_cli/site.py`, D14-5); a
deployment of its own is `host` and `site_name` in the settings.

## MCP

`oscr mcp serve` speaks JSON-RPC 2.0 over standard input and output (the Model Context Protocol) and
offers the **read** commands as tools: `repo_view`, `paper_list`, `check`, `cite`, `trace_list`,
`trace_check`, `issue_list`, `issue_view`, `pr_list`, `pr_view`, `release_list`, `run_list`, `search`.
Each runs the command a person would, with your settings and credentials, and answers its JSON. None
writes, opens a browser or asks a question (D14-11).

```json
{"mcpServers": {"oscr": {"command": "oscr", "args": ["mcp", "serve"]}}}
```

## For the registry's developers

- Code: `cli/src/oscr_cli/` (`main.py` the entry, `commands/` the tree, `output.py`, `sanitize.py`,
  `jq.py`, `template.py`, `http.py`, `keyring.py`, `accounts.py`, `ghauth.py`, `oscrauth.py`,
  `checks.py`, `citation.py`, `trace.py`, `github.py`, `oscr_api.py`, `mcp.py`); tests `cli/tests/`.
- Tests (no network: fakes of GitHub and the registry on 127.0.0.1, a fake keychain, a throwaway
  keychain file, a stand-in `secret-tool`):

  ```sh
  cd cli && ../.venv/bin/python -m pytest -q && ../.venv/bin/ruff check src tests
  ```
- The Worker's side: `website/worker/forge/service/device-core.ts`, `device.ts`, the page `/device/`
  (`src/pages/device.astro`, `src/lib/device.ts`, `src/scripts/device.ts`), the migration
  `migrations/d1-forge/0011_device.sql`.
- **Local end-to-end run**: `tests/forge-service/e2e.sh` ends with `e2e-cli.ts` (stage 8): the command
  line against the fake GitHub and `wrangler dev`, the harness approving as Ada; `TRANSCRIPTS=<folder>`
  keeps its terminal transcripts (`docs/night-screenshots/phase-14/*.txt`).
- **Publishing** (the owner's step, an outside contact): choose the name on PyPI (in
  `cli/pyproject.toml`), then `cd cli && uv build` (hatchling; offline from the local cache works:
  `uv build --offline`) and `uv publish` with a PyPI token of the owner's (never in the repository).
