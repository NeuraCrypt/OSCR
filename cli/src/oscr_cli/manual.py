"""The manual: ``oscr help <topic>`` (every command also has ``--help`` with its examples). The long form
with every command is docs/CLI.md."""
from __future__ import annotations

from . import site


def overview(site_name: str = site.SITE_NAME) -> str:
    return f"""Work with {site_name} and your research code's GitHub repository from the terminal.

{site_name}'s own commands come first: link your repository to its paper, trace its lines to the
paper's Methods, check it as the registry checks it, and cite it. The GitHub commands talk to GitHub
directly with your own GitHub token; the registry is asked for its view first.

  registry   paper, trace, check, cite
  github     repo, pr, issue, release, search, api, browse, run, workflow
  account    auth
  settings   config, alias, completion, mcp, help"""


def root_epilog() -> str:
    return """examples:
  oscr auth login                  sign in: GitHub (device flow) and the registry (approved on the site)
  oscr check                       the registry's checks on this clone (files read, never run)
  oscr cite --format bibtex        a citation from CITATION.cff
  oscr paper link 10.1234/abcd     attach this repository to its paper
  oscr repo view --web             the repository's page on the registry
  oscr help formatting             --json, --jq and --template

Two commands are named oscr: this one, for researchers, and the registry's own harvester on its Mac
(docs/CLI.md, "Two commands named oscr"). Help topics: oscr help <topic>."""


TOPICS: dict[str, tuple[str, str]] = {
    "environment": (
        "the environment variables the tool reads",
        """OSCR_HOST            the registry's host (else the setting `host`)
OSCR_SITE_NAME       the platform's name to show
OSCR_TOKEN           a registry token to use instead of the signed-in account's (a CI job)
OSCR_GITHUB_TOKEN    a GitHub token to use instead of the signed-in account's
GH_TOKEN             the same, as GitHub's own command line reads it (GITHUB_TOKEN is not read:
                     on the registry's Mac it is the harvester's)
OSCR_REPO            the repository, as owner/name (else -R, the default, the git remotes)
OSCR_CONFIG_DIR      where the settings live (else $XDG_CONFIG_HOME/oscr-cli or ~/.config/oscr-cli)
OSCR_GITHUB_WEB      GitHub's web address;  OSCR_GITHUB_API  GitHub's API address
OSCR_GITHUB_CLIENT_ID  the GitHub App's public client id for the device flow
OSCR_BROWSER         the command that opens a page (`none`: print the address)
OSCR_EDITOR, VISUAL, EDITOR   the editor for bodies
OSCR_PAGER, PAGER    the pager
OSCR_DEBUG=1         say each request (never a token), as --debug
OSCR_SPINNER_DISABLED=1   no animation while waiting
OSCR_PROMPT=disabled      never ask a question
OSCR_FORCE_TTY=1     write as to a terminal even in a pipe
NO_COLOR             no colour;  CLICOLOR_FORCE=1  colours even in a pipe""",
    ),
    "exit-codes": (
        "what the exit code says",
        """0    done
1    an error (the network, the registry, GitHub, a file), said on standard error
2    a usage error: an unknown command, flag or argument, or a value missing when the tool
     cannot ask (not a terminal, or OSCR_PROMPT=disabled)
3    a check found a failure (oscr check, oscr trace check): the report says which
4    sign-in needed: no credential for this host, or it was refused (expired, revoked)
130  interrupted (Ctrl-C)""",
    ),
    "formatting": (
        "--json, --jq, --template; terminals and pipes",
        """In a terminal, lists are aligned columns cut to its width, with colours. In a pipe or a file, each
item is one line of tab-separated fields, nothing cut, no colour: what cut, awk and sort read.

--json FIELDS    the fields named (comma-separated) as JSON; --json alone lists a command's fields
--jq EXPR        filter that JSON with a subset of jq: paths (.a.b, .[0], .[], .[2:5], ?),
                 | , // == != < <= > >= and or + - * / %, literals, [...], {a, b: .c},
                 length keys values has select map first last not type tostring tonumber
                 ascii_downcase ascii_upcase join split sort sort_by unique reverse add min max
                 any all empty test startswith endswith contains ltrimstr rtrimstr
                 to_entries from_entries limit. Strings print raw; the rest as JSON.
                 Variables, reduce, assignment and formats: pipe --json into jq itself.
--template TMPL  render that JSON with a subset of Go's templates: {{.field}}, {{range}},
                 {{if}}/{{else}}, {{with}}, pipelines, and json len join pluck truncate upper
                 lower printf timeago color autocolor tablerow tablerender eq ne lt gt not
                 and or index.

Every text from the network is cleaned before it is shown: escape sequences and the controls
that reorder text become visible and inert (^[, <U+202E>), email addresses become
[email hidden]. JSON escapes controls itself.

examples:
  oscr issue list --json number,title --jq '.[] | select(.title | test("EEG")) | .number'
  oscr release list --json tag,published --template '{{range .}}{{.tag}}  {{timeago .published}}{{"\\n"}}{{end}}'""",
    ),
    "repository": (
        "which repository a command is about",
        """In this order:
  1. -R [HOST/]OWNER/NAME on the command;
  2. OSCR_REPO in the environment;
  3. the default set in this clone by `oscr repo set-default OWNER/NAME` (git config oscr.default-repo);
  4. the clone's remotes that point to GitHub: upstream, github, origin, then the others.""",
    ),
    "auth": (
        "the two credentials, where they are kept, the git credential helper",
        """`oscr auth login` gets two credentials, each approved in your browser:
  - a GitHub token, through GitHub's own device flow, for git and GitHub's API. The tool asks
    GitHub directly with the registry's GitHub App's public client id: the token never reaches
    the registry. It expires after 8 hours; `oscr auth refresh` renews it.
  - a registry token, through the registry's own device flow: you open its page, sign in with
    ORCID, GitHub or Google, type the code your terminal shows, see what it may do, and approve.
Both are kept only in your system's keychain (macOS: the login keychain, service `oscr-cli`;
Linux: the Secret Service, through secret-tool). A plain file (mode 0600) is used only when you
ask for it (`--insecure-storage`, or `oscr config set credential_store file`), with a warning.
Several accounts may be signed in; `oscr auth switch` chooses the active one.
`oscr auth setup-git` makes the tool git's credential helper for GitHub's host only: it never
gives a credential to any other host, the registry's included.""",
    ),
    "safety": (
        "what the tool never does",
        """- It never runs your repository's code or anything cloned: `oscr check` and `oscr trace` read
  files as text; git runs with its hooks off (core.hooksPath set to the null device).
- It never prints a token: not with --debug, not in an error; tokens are never passed to another
  program on its command line.
- It never asks for, shows or keeps an email address; your git commit address is your own
  configuration, never read or changed.
- It cleans every text from the network before showing it (oscr help formatting).""",
    ),
    "mcp": (
        "the tool as an MCP server for an assistant",
        """`oscr mcp serve` speaks JSON-RPC 2.0 over standard input and output (the Model Context Protocol)
and offers the tool's read commands as tools: the registry's view of a repository, its checks on
a local clone, a citation, the tracing maps, issues, pull requests and releases. It writes nothing.
Configure your assistant to start `oscr mcp serve` (docs/CLI.md "MCP").""",
    ),
}


def topic(name: str) -> str | None:
    t = TOPICS.get(name)
    return f"{name}: {t[0]}\n\n{t[1]}\n" if t else None
