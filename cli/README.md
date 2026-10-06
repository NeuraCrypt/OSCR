# oscr, research code and its paper, from the terminal

`oscr` is the command line of the **Open Scientific Code Registry** (OSCR, <https://openscicode.org>),
for researchers. It links your repository to its paper, checks it the way the registry checks it,
traces its lines to the paper's Methods, cites it, and works with its GitHub repository, the
registry's view first.

- The package on PyPI is **`openscicode`**; the command you type is **`oscr`**.
- It needs Python 3.10 or later and git. It uses the **standard library only**: nothing else is
  installed.
- Free and open (Apache-2.0). It talks to GitHub with your own GitHub token (the registry never sees
  it) and to the registry with the registry's token; it never asks for, shows or keeps an email
  address, and it never runs your code.

## Install

```sh
pipx install openscicode        # recommended (an environment of its own)
# or
pip install openscicode
oscr --version
```

`uv tool install openscicode` works too. From a copy of the registry's repository instead of PyPI:
`pipx install ./cli`.

## Sign in

```sh
oscr auth login
```

Two credentials, each approved in your browser:

- **GitHub**, through GitHub's own device flow: the tool asks GitHub directly with the registry's
  GitHub App's public client id. Your GitHub token goes from GitHub to your keychain and **never
  reaches the registry**. It lives 8 hours; `oscr auth refresh` renews it.
- **The registry**, through its own device flow: open the page the terminal prints, sign in with
  ORCID, GitHub or Google, **type the code your terminal shows**, read what the token may do, approve.

Both are kept **only in your system's keychain** (macOS keychain; Linux Secret Service through
`secret-tool`). `oscr auth status` says who is signed in; `oscr auth logout` signs out (the
registry's token is revoked). `oscr auth setup-git` lets git use your GitHub token, for GitHub's host
only.

## The registry's own commands

```sh
oscr check                        # licence, environment, the paper's DOI, CITATION.cff, tracing maps, sizes, README
oscr check --base main            # a branch's change, as the registry checks a pull request
oscr cite                         # APA and BibTeX from CITATION.cff (or codemeta.json)
oscr cite --release v1.2.0 --swhid
oscr paper link 10.1234/abcd      # attach this repository to its paper (confirmed on the site, authorized on GitHub)
oscr paper list                   # the papers the registry links to this repository
oscr trace list                   # the maps between this code and its papers
oscr trace check --commit HEAD    # are the maps' lines still here? same, moved, changed, gone
oscr trace propose 10.1234/abcd analysis/filter.py:10-24=3 --section "Methods"
```

`oscr check` and `oscr trace` read your files as text. **They never run your code**, and git runs with
its hooks off.

## Your repository on GitHub

```sh
oscr repo create my-analysis --license mit --paper 10.1234/abcd
oscr repo clone lab/eeg-analysis
oscr repo view                    # the registry's view, then GitHub's
oscr repo sync                    # fast-forward this clone (or a fork from its parent)
oscr pr create --title "Fix the band-pass filter" --body "As in Methods §2.3"
oscr issue create --research mismatch --paper 10.1234/abcd --title "..." --path a.py --lines 10-24 --paragraph 3
oscr release create v1.0.0 --generate-notes
oscr run list                     # your own CI (GitHub Actions), summarized
oscr browse analysis/filter.py:10 # the registry's page of those lines
oscr search "band power"
oscr api /user
```

GitHub's side talks to GitHub directly with your own token; the registry's side talks to its
`/api/forge/v1`. Each command shows the registry's page of what it made or read first, GitHub's
address only when the registry cannot show the thing.

## For scripts and assistants

- In a pipe, lists are tab-separated lines; `--json FIELDS`, `--jq EXPR` and `--template TMPL` shape
  the output.
- Exit codes: 0 done, 1 error, 2 usage, 3 a check failed, 4 sign-in needed, 130 interrupted.
- `oscr mcp serve` offers the read commands to an assistant (the Model Context Protocol, over stdio).
- Every text from the network is cleaned before it is shown (escape sequences made inert), and no
  email address is ever asked for, shown or kept.

`oscr help` and `oscr <command> --help` say the rest.

## The full guide

The complete guide, with every command group and real examples, is on the site:
**<https://openscicode.org/help/cli/>**. The public read API it builds on is at
<https://openscicode.org/help/api/>. The source is at <https://github.com/NeuraCrypt/OSCR>.

## A note on the two `oscr` commands

The registry's own Mac runs a second, unrelated `oscr`: the harvester's admin tool. This researchers'
tool installs into an environment of its own and never touches the harvester's; each refuses the
other's commands with a line that names the right one. You never meet the harvester unless you run the
registry yourself.

## Licence

Apache-2.0.
