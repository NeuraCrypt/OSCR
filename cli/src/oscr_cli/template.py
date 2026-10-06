"""``--template``: a subset of Go's text/template, as ``gh`` offers it (``oscr help formatting``; D14-5).

What it reads:

- text, and actions between ``{{`` and ``}}`` (``{{-`` and ``-}}`` trim the spaces beside them);
- ``{{.}}``, ``{{.field}}``, ``{{.a.b}}``, literals (``"text"``, `` `raw` ``, numbers, ``true``,
  ``false``, ``nil``), calls ``{{func arg …}}``, pipelines ``{{.x | func arg}}`` (the value becomes
  the last argument), ``( … )``;
- ``{{range …}} … {{else}} … {{end}}`` (the dot is each item), ``{{if …}} … {{else if …}} … {{else}}
  … {{end}}``, ``{{with …}} … {{end}}``, ``{{/* a comment */}}``;
- the functions ``json``, ``len``, ``join SEP LIST``, ``pluck FIELD LIST``, ``truncate N TEXT``,
  ``upper``, ``lower``, ``printf FORMAT ARGS…`` (``%s``, ``%d``, ``%v``, ``%q``, widths),
  ``timeago TIME``, ``color STYLE TEXT`` and ``autocolor STYLE TEXT`` (colours only in a terminal),
  ``tablerow A B …`` and ``tablerender`` (aligned columns), ``eq``, ``ne``, ``lt``, ``gt``, ``not``,
  ``and``, ``or``, ``index X KEY``.

Variables (``$x :=``), ``define``/``template``/``block`` and the other functions are deferred
(D14-13): pipe ``--json`` into another tool for them.
"""
from __future__ import annotations

import json
import re
from typing import Any

from .errors import UsageError


class TemplateError(UsageError):
    pass


_ACTION = re.compile(r"\{\{(-\s)?(.*?)(\s-)?\}\}", re.S)
_ARG = re.compile(
    r"""\s*(?:
      (?P<str>"(?:[^"\\]|\\.)*")
    | (?P<raw>`[^`]*`)
    | (?P<num>-?\d+(?:\.\d+)?)
    | (?P<field>(?:\.[A-Za-z_][A-Za-z0-9_]*)+|\.)
    | (?P<ident>[A-Za-z_][A-Za-z0-9_]*)
    | (?P<op>[|()])
    )""",
    re.VERBOSE,
)


def _lex_args(src: str) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    i = 0
    while i < len(src):
        if not src[i:].strip():
            break
        m = _ARG.match(src, i)
        if not m or m.end() == i:
            raise TemplateError(f"--template: cannot read “{src[i:i + 12]}”.")
        kind = m.lastgroup or ""
        out.append((kind, m.group(kind)))
        i = m.end()
    return out


def _parse_pipeline(toks: list[tuple[str, str]], i: int = 0, inner: bool = False) -> tuple[list[list[Any]], int]:
    """A pipeline: commands separated by |, each a list of arguments (a sub-pipeline is ("pipe", …))."""
    cmds: list[list[Any]] = [[]]
    while i < len(toks):
        kind, value = toks[i]
        if kind == "op" and value == "|":
            cmds.append([])
            i += 1
        elif kind == "op" and value == "(":
            sub, i = _parse_pipeline(toks, i + 1, inner=True)
            cmds[-1].append(("pipe", sub))
        elif kind == "op" and value == ")":
            if not inner:
                raise TemplateError("--template: a “)” without its “(”.")
            return cmds, i + 1
        else:
            cmds[-1].append((kind, value))
            i += 1
    if inner:
        raise TemplateError("--template: a “(” without its “)”.")
    if any(not c for c in cmds):
        raise TemplateError("--template: an empty command.")
    return cmds, i


def _parse(src: str) -> list[Any]:
    """The template as a tree: text, ("out", pipeline), ("range"|"if"|"with", branches, else)."""
    pieces: list[Any] = []
    pos = 0
    for m in _ACTION.finditer(src):
        text = src[pos:m.start()]
        if m.group(1):
            text = text.rstrip()
        pieces.append(("text", text))
        pieces.append(("action", m.group(2).strip()))
        pos = m.end()
        if m.group(3):
            rest = src[pos:]
            pos += len(rest) - len(rest.lstrip())
    pieces.append(("text", src[pos:]))
    if any(kind == "text" and "{{" in value for kind, value in pieces):
        raise TemplateError("--template: an action opened with {{ is not closed with }}.")

    root: list[Any] = []
    stack: list[tuple[str, list[Any], Any]] = []  # (kind, node, current body)
    body = root
    for kind, value in pieces:
        if kind == "text":
            if value:
                body.append(("text", value))
            continue
        if value.startswith("/*"):
            continue
        word = value.split(None, 1)[0] if value else ""
        rest = value[len(word):].strip()
        if word in ("range", "if", "with"):
            node: list[Any] = [word, [(_parse_pipeline(_lex_args(rest))[0], [])], None]
            body.append(node)
            stack.append((word, node, body))
            body = node[1][0][1]
        elif word == "else":
            if not stack:
                raise TemplateError("--template: {{else}} outside a block.")
            _, node, _ = stack[-1]
            if rest.startswith("if ") and node[0] == "if":
                node[1].append((_parse_pipeline(_lex_args(rest[3:]))[0], []))
                body = node[1][-1][1]
            else:
                node[2] = []
                body = node[2]
        elif word == "end":
            if not stack:
                raise TemplateError("--template: {{end}} without a block.")
            _, _, body = stack.pop()
        else:
            body.append(("out", _parse_pipeline(_lex_args(value))[0]))
    if stack:
        raise TemplateError(f"--template: {{{{{stack[-1][0]}}}}} has no {{{{end}}}}.")
    return root


def _field(dot: Any, path: str) -> Any:
    if path == ".":
        return dot
    v = dot
    for part in path.strip(".").split("."):
        if isinstance(v, dict):
            v = v.get(part)
        else:
            return None
    return v


def _text(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (dict, list)):
        return json.dumps(v, ensure_ascii=False)
    return str(v)


def _truth(v: Any) -> bool:
    return bool(v) and v != 0


def _printf(fmt: str, *args: Any) -> str:
    out = []
    it = iter(args)
    for m in re.finditer(r"%(-?\d*)([sdvq%])|[^%]+|%", fmt):
        if m.group(0) == "%%":
            out.append("%")
        elif m.group(2):
            width, verb = m.group(1), m.group(2)
            v = next(it, None)
            s = json.dumps(_text(v)) if verb == "q" else (str(int(v)) if verb == "d" and isinstance(v, (int, float)) else _text(v))
            if width:
                w = int(width)
                s = s.ljust(-w) if w < 0 else s.rjust(w)
            out.append(s)
        else:
            out.append(m.group(0))
    return "".join(out)


class Renderer:
    def __init__(self, color: bool):
        self.color = color
        self.rows: list[list[str]] = []

    COLORS = {"red": "31", "green": "32", "yellow": "33", "blue": "34", "magenta": "35", "cyan": "36", "bold": "1", "dim": "2", "underline": "4"}

    def call(self, name: str, args: list[Any]) -> Any:
        def need(n: int) -> None:
            if len(args) != n:
                raise TemplateError(f"--template: {name} takes {n} argument{'s' if n != 1 else ''}.")

        if name == "json":
            need(1)
            return json.dumps(args[0], ensure_ascii=False)
        if name == "len":
            need(1)
            return len(args[0]) if isinstance(args[0], (list, dict, str)) else 0
        if name == "join":
            need(2)
            return str(args[0]).join(_text(x) for x in (args[1] or []))
        if name == "pluck":
            need(2)
            return [x.get(args[0]) if isinstance(x, dict) else None for x in (args[1] or [])]
        if name == "truncate":
            need(2)
            n, s = int(args[0]), _text(args[1])
            return s if len(s) <= n else s[: max(0, n - 1)] + "…"
        if name in ("upper", "lower"):
            need(1)
            return _text(args[0]).upper() if name == "upper" else _text(args[0]).lower()
        if name == "printf":
            if not args:
                raise TemplateError("--template: printf needs a format.")
            return _printf(str(args[0]), *args[1:])
        if name == "timeago":
            need(1)
            from .output import ago

            return ago(args[0])
        if name in ("color", "autocolor"):
            need(2)
            code = ";".join(self.COLORS.get(c, "") for c in str(args[0]).split("+") if self.COLORS.get(c))
            s = _text(args[1])
            return f"\033[{code}m{s}\033[0m" if self.color and code else s
        if name == "tablerow":
            self.rows.append([_text(a).replace("\n", " ") for a in args])
            return ""
        if name == "tablerender":
            need(0)
            if not self.rows:
                return ""
            n = max(len(r) for r in self.rows)
            widths = [max(len(r[i]) if i < len(r) else 0 for r in self.rows) for i in range(n)]
            lines = ["  ".join((r[i] if i < len(r) else "").ljust(widths[i]) for i in range(n)).rstrip() for r in self.rows]
            self.rows = []
            return "\n".join(lines) + "\n"
        if name in ("eq", "ne", "lt", "gt"):
            need(2)
            a, b = args
            return {"eq": a == b, "ne": a != b, "lt": a is not None and b is not None and a < b, "gt": a is not None and b is not None and a > b}[name]
        if name == "not":
            need(1)
            return not _truth(args[0])
        if name == "and":
            return all(_truth(a) for a in args)
        if name == "or":
            return next((a for a in args if _truth(a)), args[-1] if args else None)
        if name == "index":
            need(2)
            x, k = args
            if isinstance(x, dict):
                return x.get(k)
            if isinstance(x, list) and isinstance(k, int) and -len(x) <= k < len(x):
                return x[k]
            return None
        raise TemplateError(f"--template: this subset has no function “{name}” (oscr help formatting).")

    def arg(self, a: Any, dot: Any) -> Any:
        kind, value = a
        if kind == "field":
            return _field(dot, value)
        if kind == "str":
            return json.loads(value)
        if kind == "raw":
            return value[1:-1]
        if kind == "num":
            return float(value) if "." in value else int(value)
        if kind == "pipe":
            return self.pipeline(value, dot)
        if kind == "ident":
            if value in ("true", "false"):
                return value == "true"
            if value == "nil":
                return None
            return self.call(value, [])
        raise TemplateError("--template: cannot read an argument.")

    def pipeline(self, cmds: list[list[Any]], dot: Any) -> Any:
        value: Any = None
        for n, cmd in enumerate(cmds):
            head = cmd[0]
            if head[0] == "ident" and head[1] not in ("true", "false", "nil"):
                args = [self.arg(a, dot) for a in cmd[1:]]
                if n > 0:
                    args.append(value)
                value = self.call(head[1], args)
            else:
                if len(cmd) > 1 or n > 0:
                    raise TemplateError("--template: only a function takes arguments.")
                value = self.arg(head, dot)
        return value

    def render(self, nodes: list[Any], dot: Any) -> str:
        out: list[str] = []
        for node in nodes:
            if node[0] == "text":
                out.append(node[1])
            elif node[0] == "out":
                out.append(_text(self.pipeline(node[1], dot)))
            else:
                kind, branches, other = node
                if kind == "range":
                    cond, body = branches[0]
                    items = self.pipeline(cond, dot)
                    seq = list(items.values()) if isinstance(items, dict) else (items or [])
                    if seq:
                        for item in seq:
                            out.append(self.render(body, item))
                    elif other is not None:
                        out.append(self.render(other, dot))
                elif kind == "with":
                    cond, body = branches[0]
                    v = self.pipeline(cond, dot)
                    if _truth(v):
                        out.append(self.render(body, v))
                    elif other is not None:
                        out.append(self.render(other, dot))
                else:
                    for cond, body in branches:
                        if _truth(self.pipeline(cond, dot)):
                            out.append(self.render(body, dot))
                            break
                    else:
                        if other is not None:
                            out.append(self.render(other, dot))
        return "".join(out)


def render(src: str, data: Any, *, color: bool = False) -> str:
    return Renderer(color).render(_parse(src), data)
