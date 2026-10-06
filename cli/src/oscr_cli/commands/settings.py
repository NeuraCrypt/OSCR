"""``oscr config``, ``oscr alias``, ``oscr completion``, ``oscr help``: the tool's own settings."""
from __future__ import annotations

import argparse
from typing import Any

from .. import manual
from ..config import SETTINGS
from ..errors import UsageError
from ..parsing import command, group

NAME = "config"
GROUP = "settings"


# ── oscr config ──


def _config_get(ctx: Any, args: argparse.Namespace) -> int:
    ctx.io.print(ctx.config.get(args.key))
    return 0


def _config_set(ctx: Any, args: argparse.Namespace) -> int:
    ctx.config.set(args.key, args.value)
    if args.key == "credential_store" and args.value == "file":
        ctx.io.warn("Credentials will be written to a plain file (mode 0600) instead of your system's keychain. Anyone who can read your files can use them. `oscr config set credential_store keychain` goes back.")
    return 0


def _config_unset(ctx: Any, args: argparse.Namespace) -> int:
    if args.key not in SETTINGS:
        raise UsageError(f"There is no setting “{args.key}”.")
    ctx.config.unset(args.key)
    return 0


def _config_list(ctx: Any, args: argparse.Namespace) -> int:
    rows = [(k, ctx.config.get(k), words) for k, (_, words) in SETTINGS.items()]
    if ctx.io.out_tty:
        ctx.io.table(rows, headers=("setting", "value", "what it does"))
    else:
        for k, v, _ in rows:
            ctx.io.print(f"{k}={v}")
    return 0


# ── oscr alias ──


def _alias_set(ctx: Any, args: argparse.Namespace) -> int:
    from ..main import build_parser

    parser = build_parser(ctx.config.site_name)
    builtins = set(parser._subparsers._group_actions[0].choices)  # type: ignore[union-attr]
    if args.name in builtins:
        raise UsageError(f"“{args.name}” is one of the tool's commands: an alias cannot hide it.")
    if not args.name.replace("-", "").replace("_", "").isalnum():
        raise UsageError("An alias's name is letters, digits, - and _.")
    if args.expansion.lstrip().startswith("!"):
        raise UsageError("Aliases that run a shell are not offered (the tool runs no command of yours): write the tool's own command.")
    first = args.expansion.split()[0] if args.expansion.split() else ""
    if first not in builtins:
        raise UsageError(f"An alias expands to one of the tool's commands; “{first}” is not one.")
    ctx.config.set_alias(args.name, args.expansion)
    ctx.io.say(f"Alias {args.name} → oscr {args.expansion}")
    return 0


def _alias_list(ctx: Any, args: argparse.Namespace) -> int:
    aliases = ctx.config.aliases()
    if not aliases:
        ctx.io.say("No alias yet: `oscr alias set co 'pr checkout'` makes one.")
        return 0
    ctx.io.table(sorted(aliases.items()), headers=("alias", "expands to") if ctx.io.out_tty else None)
    return 0


def _alias_delete(ctx: Any, args: argparse.Namespace) -> int:
    if not ctx.config.delete_alias(args.name):
        raise UsageError(f"There is no alias “{args.name}”.")
    return 0


# ── oscr completion ──


def _walk(parser: argparse.ArgumentParser, path: tuple[str, ...] = ()) -> dict[tuple[str, ...], tuple[list[str], list[str]]]:
    """Every command path → (its sub-commands, its flags)."""
    subs: list[str] = []
    flags: list[str] = []
    out: dict[tuple[str, ...], tuple[list[str], list[str]]] = {}
    for a in parser._actions:
        if isinstance(a, argparse._SubParsersAction):
            for name, p in a.choices.items():
                if name not in subs:
                    subs.append(name)
                out.update(_walk(p, (*path, name)))
        else:
            flags.extend(o for o in a.option_strings if o.startswith("--"))
    out[path] = (subs, flags)
    return out


def completion_script(shell: str, parser: argparse.ArgumentParser) -> str:
    tree = _walk(parser)
    if shell == "bash":
        cases = []
        for path, (subs, flags) in sorted(tree.items()):
            key = " ".join(path)
            cases.append(f'    "{key}") words="{" ".join(subs + flags)}" ;;')
        return (
            "# oscr completion for bash: add `eval \"$(oscr completion bash)\"` to ~/.bashrc\n"
            "_oscr() {\n"
            "  local cur path i w words\n"
            '  cur="${COMP_WORDS[COMP_CWORD]}"\n'
            '  path=""\n'
            "  for ((i = 1; i < COMP_CWORD; i++)); do\n"
            '    w="${COMP_WORDS[i]}"\n'
            '    [[ "$w" == -* ]] && continue\n'
            '    path="${path:+$path }$w"\n'
            "  done\n"
            '  case "$path" in\n' + "\n".join(cases) + '\n    *) words="" ;;\n  esac\n'
            '  COMPREPLY=($(compgen -W "$words" -- "$cur"))\n'
            "}\n"
            "complete -F _oscr oscr\n"
        )
    if shell == "zsh":
        cases = []
        for path, (subs, flags) in sorted(tree.items()):
            cases.append(f'    "{" ".join(path)}") words=({" ".join(subs + flags)}) ;;')
        return (
            "#compdef oscr\n"
            "# oscr completion for zsh: `oscr completion zsh > \"${fpath[1]}/_oscr\"`, then start a new shell\n"
            "_oscr() {\n"
            "  local -a words\n"
            "  local p=\"\" w\n"
            "  for w in ${words[2,CURRENT-1]}; do [[ $w == -* ]] || p=\"${p:+$p }$w\"; done\n"
            '  case "$p" in\n' + "\n".join(cases) + "\n    *) words=() ;;\n  esac\n"
            "  compadd -- $words\n"
            "}\n"
            'compdef _oscr oscr 2>/dev/null || _oscr "$@"\n'
        )
    if shell == "fish":
        lines = ["# oscr completion for fish: `oscr completion fish > ~/.config/fish/completions/oscr.fish`"]
        for path, (subs, flags) in sorted(tree.items()):
            cond = "__fish_use_subcommand" if not path else f"__fish_seen_subcommand_from {path[-1]}"
            for s in subs:
                lines.append(f"complete -c oscr -f -n '{cond}' -a {s}")
            for f in flags:
                lines.append(f"complete -c oscr -f -n '{cond}' -l {f[2:]}")
        return "\n".join(lines) + "\n"
    raise UsageError("The shells: bash, zsh, fish.")


def _completion(ctx: Any, args: argparse.Namespace) -> int:
    from ..main import build_parser

    ctx.io.write(completion_script(args.shell, build_parser(ctx.config.site_name)))
    return 0


# ── oscr help ──


def _help(ctx: Any, args: argparse.Namespace) -> int:
    from ..main import build_parser

    parser = build_parser(ctx.config.site_name)
    words = list(args.topic or [])
    if not words:
        parser.print_help()
        ctx.io.print("\nhelp topics: " + ", ".join(sorted(manual.TOPICS)))
        return 0
    text = manual.topic(words[0]) if len(words) == 1 else None
    if text:
        ctx.io.write(text)
        return 0
    target: argparse.ArgumentParser = parser
    for w in words:
        sub = next((a for a in target._actions if isinstance(a, argparse._SubParsersAction)), None)
        if sub is None or w not in sub.choices:
            raise UsageError(f"No command or topic “{' '.join(words)}”. The topics: {', '.join(sorted(manual.TOPICS))}.")
        target = sub.choices[w]
    target.print_help()
    return 0


def register(sub: Any) -> None:
    _, cs = group(sub, "config", help="read and change the tool's settings", examples_=["oscr config list", "oscr config set color never", "oscr config set git_protocol ssh"])
    p = command(cs, "get", help="print a setting's value", handler=_config_get)
    p.add_argument("key")
    p = command(cs, "set", help="change a setting", handler=_config_set, examples_=["oscr config set host localhost:8791"])
    p.add_argument("key")
    p.add_argument("value")
    p = command(cs, "unset", help="a setting back to its default", handler=_config_unset)
    p.add_argument("key")
    command(cs, "list", help="every setting, its value and what it does", handler=_config_list)

    _, al = group(sub, "alias", help="short names for commands you use often", examples_=["oscr alias set co 'pr checkout'", "oscr co 12", "oscr alias set mine 'issue list --assignee @me'"])
    p = command(al, "set", help="make an alias ($1, $2… take the next arguments)", handler=_alias_set)
    p.add_argument("name")
    p.add_argument("expansion")
    command(al, "list", help="the aliases", handler=_alias_list)
    p = command(al, "delete", help="remove an alias", handler=_alias_delete)
    p.add_argument("name")

    p = command(sub, "completion", help="the shell completion script (bash, zsh, fish)", handler=_completion,
                examples_=['eval "$(oscr completion bash)"', 'oscr completion zsh > "${fpath[1]}/_oscr"', "oscr completion fish > ~/.config/fish/completions/oscr.fish"])
    p.add_argument("shell", choices=("bash", "zsh", "fish"))

    p = command(sub, "help", help="the manual: a command's page, or a topic", handler=_help,
                examples_=["oscr help formatting", "oscr help exit-codes", "oscr help repo clone"])
    p.add_argument("topic", nargs="*")
