"""``--jq``: a subset of jq's language, in the standard library (``oscr help formatting``; D14-5).

What it reads:

- paths: ``.``, ``.a``, ``.a.b``, ``."a b"``, ``.[0]``, ``.[-1]``, ``.[]``, ``.a[]``, ``.["a"]``,
  ``.[2:5]``, and ``?`` after any of them (no error when the value has no such thing);
- ``|`` (pipe), ``,`` (both), ``//`` (the right side when the left gives nothing, null or false);
- ``==``, ``!=``, ``<``, ``<=``, ``>``, ``>=``, ``and``, ``or``, ``+``, ``-``, ``*``, ``/``, ``%``;
- literals (``"text"``, numbers, ``true``, ``false``, ``null``), ``[…]`` (an array of what is inside),
  ``{a, b: .c, "d e": .f, (.k): .v}`` (an object), ``(…)``;
- the functions ``length``, ``keys``, ``values``, ``has(k)``, ``select(f)``, ``map(f)``, ``first``,
  ``last``, ``not``, ``type``, ``tostring``, ``tonumber``, ``ascii_downcase``, ``ascii_upcase``,
  ``join(s)``, ``split(s)``, ``sort``, ``sort_by(f)``, ``unique``, ``reverse``, ``add``, ``min``,
  ``max``, ``any``, ``all``, ``empty``, ``test(re)``, ``startswith(s)``, ``endswith(s)``,
  ``contains(x)``, ``ltrimstr(s)``, ``rtrimstr(s)``, ``to_entries``, ``from_entries``, ``limit(n; f)``.

What it leaves to jq itself (deferred, D14-13): variables (``as $x``), ``reduce``/``foreach``, paths and
assignment (``|=``, ``del``), string interpolation, formats (``@csv``…), user-defined functions. A
person who needs them pipes ``--json`` into jq.

Each result is printed on its own line: a string as it is (cleaned, as every text shown), anything else
as compact JSON, as ``gh`` prints ``--jq``.
"""
from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .errors import UsageError


class JqError(UsageError):
    pass


# ── tokens ──

_TOKEN = re.compile(
    r"""\s*(?:
      (?P<num>\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)
    | (?P<str>"(?:[^"\\]|\\.)*")
    | (?P<field>\.[A-Za-z_][A-Za-z0-9_]*)
    | (?P<ident>[A-Za-z_][A-Za-z0-9_]*)
    | (?P<op>\.\.|//|==|!=|<=|>=|[|,<>+\-*/%()\[\]{}:;?.])
    )""",
    re.VERBOSE,
)


@dataclass
class Tok:
    kind: str
    value: str


def tokens(src: str) -> list[Tok]:
    out: list[Tok] = []
    i = 0
    while i < len(src):
        if src[i:].strip() == "":
            break
        m = _TOKEN.match(src, i)
        if not m or m.end() == i:
            raise JqError(f"--jq: cannot read “{src[i:i + 12]}”.")
        kind = m.lastgroup or ""
        out.append(Tok(kind, m.group(kind)))
        i = m.end()
    out.append(Tok("end", ""))
    return out


# ── the tree ──

Node = tuple  # (kind, …)


class Parser:
    def __init__(self, src: str):
        self.t = tokens(src)
        self.i = 0

    def peek(self, value: str | None = None, kind: str | None = None) -> bool:
        t = self.t[self.i]
        return (value is None or t.value == value) and (kind is None or t.kind == kind)

    def take(self, value: str | None = None) -> Tok:
        t = self.t[self.i]
        if value is not None and t.value != value:
            raise JqError(f"--jq: expected “{value}”, found “{t.value or 'the end'}”.")
        self.i += 1
        return t

    def parse(self) -> Node:
        n = self.pipe()
        if not self.peek(kind="end"):
            raise JqError(f"--jq: unexpected “{self.t[self.i].value}”.")
        return n

    def pipe(self) -> Node:
        left = self.comma()
        if self.peek("|"):
            self.take()
            return ("pipe", left, self.pipe())
        return left

    def comma(self) -> Node:
        left = self.alt()
        while self.peek(","):
            self.take()
            left = ("comma", left, self.alt())
        return left

    def alt(self) -> Node:
        left = self.or_()
        if self.peek("//"):
            self.take()
            return ("alt", left, self.alt())
        return left

    def or_(self) -> Node:
        left = self.and_()
        while self.peek("or", "ident"):
            self.take()
            left = ("or", left, self.and_())
        return left

    def and_(self) -> Node:
        left = self.cmp()
        while self.peek("and", "ident"):
            self.take()
            left = ("and", left, self.cmp())
        return left

    def cmp(self) -> Node:
        left = self.add()
        if self.t[self.i].value in ("==", "!=", "<", "<=", ">", ">="):
            op = self.take().value
            return ("bin", op, left, self.add())
        return left

    def add(self) -> Node:
        left = self.mul()
        while self.t[self.i].value in ("+", "-"):
            op = self.take().value
            left = ("bin", op, left, self.mul())
        return left

    def mul(self) -> Node:
        left = self.postfix()
        while self.t[self.i].value in ("*", "/", "%"):
            op = self.take().value
            left = ("bin", op, left, self.postfix())
        return left

    def postfix(self) -> Node:
        n = self.term()
        while True:
            t = self.t[self.i]
            if t.kind == "field":
                self.take()
                n = ("index", n, ("lit", t.value[1:]), False)
            elif t.value == "." and self.t[self.i + 1].kind == "str":
                self.take()
                n = ("index", n, ("lit", json.loads(self.take().value)), False)
            elif t.value == "[":
                n = self.bracket(n)
            elif t.value == "." and self.t[self.i + 1].value == "[":
                self.take()
                n = self.bracket(n)
            elif t.value == "?":
                self.take()
                n = ("try", n)
            else:
                return n

    def bracket(self, n: Node) -> Node:
        self.take("[")
        if self.peek("]"):
            self.take()
            return ("each", n)
        if self.peek(":"):
            self.take()
            hi = self.pipe()
            self.take("]")
            return ("slice", n, None, hi)
        k = self.pipe()
        if self.peek(":"):
            self.take()
            hi = None if self.peek("]") else self.pipe()
            self.take("]")
            return ("slice", n, k, hi)
        self.take("]")
        return ("index", n, k, False)

    def term(self) -> Node:
        t = self.t[self.i]
        if t.kind == "num":
            self.take()
            return ("lit", float(t.value) if any(c in t.value for c in ".eE") else int(t.value))
        if t.kind == "str":
            self.take()
            return ("lit", json.loads(t.value))
        if t.kind == "field":
            self.take()
            return ("index", ("id",), ("lit", t.value[1:]), False)
        if t.value == "..":
            self.take()
            return ("recurse",)
        if t.value == ".":
            self.take()
            if self.peek(kind="str"):
                return ("index", ("id",), ("lit", json.loads(self.take().value)), False)
            if self.peek("["):
                return self.bracket(("id",))
            return ("id",)
        if t.value == "(":
            self.take()
            n = self.pipe()
            self.take(")")
            return n
        if t.value == "[":
            self.take()
            if self.peek("]"):
                self.take()
                return ("lit", [])
            n = self.pipe()
            self.take("]")
            return ("array", n)
        if t.value == "{":
            return self.obj()
        if t.value == "-":
            self.take()
            return ("bin", "-", ("lit", 0), self.postfix())
        if t.kind == "ident":
            self.take()
            name = t.value
            if name in ("true", "false", "null"):
                return ("lit", {"true": True, "false": False, "null": None}[name])
            args: list[Node] = []
            if self.peek("("):
                self.take()
                args.append(self.pipe())
                while self.peek(";"):
                    self.take()
                    args.append(self.pipe())
                self.take(")")
            return ("call", name, args)
        raise JqError(f"--jq: unexpected “{t.value or 'end'}”.")

    def obj(self) -> Node:
        self.take("{")
        entries: list[tuple[Node, Node]] = []
        while not self.peek("}"):
            t = self.t[self.i]
            if t.kind in ("ident", "str"):
                self.take()
                key = t.value if t.kind == "ident" else json.loads(t.value)
                knode: Node = ("lit", key)
                if self.peek(":"):
                    self.take()
                    vnode: Node = self.alt()
                else:
                    vnode = ("index", ("id",), ("lit", key), False)
            elif t.value == "(":
                self.take()
                knode = self.pipe()
                self.take(")")
                self.take(":")
                vnode = self.alt()
            else:
                raise JqError(f"--jq: an object's key, not “{t.value}”.")
            entries.append((knode, vnode))
            if not self.peek(","):
                break
            self.take(",")
        self.take("}")
        return ("object", entries)


# ── evaluation ──


def _type(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, (int, float)):
        return "number"
    if isinstance(v, str):
        return "string"
    if isinstance(v, list):
        return "array"
    return "object"


def _truthy(v: Any) -> bool:
    return v is not None and v is not False


_ORDER = {"null": 0, "boolean": 1, "number": 2, "string": 3, "array": 4, "object": 5}


def _key(v: Any) -> Any:
    t = _type(v)
    if t == "array":
        return (_ORDER[t], [_key(x) for x in v])
    if t == "object":
        return (_ORDER[t], sorted((k, _key(x)) for k, x in v.items()))
    return (_ORDER[t], v if t != "null" else 0)


def _index(v: Any, k: Any, node: Node) -> Any:
    if v is None:
        return None
    if isinstance(k, str) and isinstance(v, dict):
        return v.get(k)
    if isinstance(k, (int, float)) and not isinstance(k, bool) and isinstance(v, list):
        i = int(k)
        return v[i] if -len(v) <= i < len(v) else None
    raise JqError(f"--jq: cannot index {_type(v)} with {_type(k)}.")


def _binop(op: str, a: Any, b: Any) -> Any:
    if op == "==":
        return a == b and _type(a) == _type(b)
    if op == "!=":
        return not (a == b and _type(a) == _type(b))
    if op in ("<", "<=", ">", ">="):
        ka, kb = _key(a), _key(b)
        return {"<": ka < kb, "<=": ka <= kb, ">": ka > kb, ">=": ka >= kb}[op]
    if op == "+":
        if a is None:
            return b
        if b is None:
            return a
        if isinstance(a, dict) and isinstance(b, dict):
            return {**a, **b}
        if _type(a) == _type(b) and _type(a) in ("number", "string", "array"):
            return a + b
    if op == "-":
        if _type(a) == _type(b) == "number":
            return a - b
        if _type(a) == _type(b) == "array":
            return [x for x in a if x not in b]
    if op in ("*", "/", "%") and _type(a) == _type(b) == "number":
        if op == "*":
            return a * b
        if b == 0:
            raise JqError("--jq: division by zero.")
        return a / b if op == "/" else int(a) % int(b)
    if op == "/" and _type(a) == _type(b) == "string":
        return a.split(b)
    raise JqError(f"--jq: cannot apply {op} to {_type(a)} and {_type(b)}.")


def _one(outputs: list[Any], name: str) -> Any:
    if len(outputs) != 1:
        raise JqError(f"--jq: {name} takes one value.")
    return outputs[0]


class Evaluator:
    def __init__(self) -> None:
        self.funcs: dict[str, Callable[[list[Node], Any], list[Any]]] = {}

    def run(self, n: Node, v: Any) -> list[Any]:
        kind = n[0]
        if kind == "id":
            return [v]
        if kind == "lit":
            return [n[1]]
        if kind == "pipe":
            return [y for x in self.run(n[1], v) for y in self.run(n[2], x)]
        if kind == "comma":
            return self.run(n[1], v) + self.run(n[2], v)
        if kind == "alt":
            try:
                left = [x for x in self.run(n[1], v) if _truthy(x)]
            except JqError:
                left = []
            return left or self.run(n[2], v)
        if kind in ("or", "and"):
            out = []
            for a in self.run(n[1], v):
                if _truthy(a) == (kind == "or"):
                    out.append(kind == "or")
                else:
                    out.extend(_truthy(b) for b in self.run(n[2], v))
            return out
        if kind == "bin":
            return [_binop(n[1], a, b) for b in self.run(n[3], v) for a in self.run(n[2], v)]
        if kind == "index":
            return [_index(base, k, n) for base in self.run(n[1], v) for k in self.run(n[2], v)]
        if kind == "each":
            out: list[Any] = []
            for base in self.run(n[1], v):
                if isinstance(base, list):
                    out.extend(base)
                elif isinstance(base, dict):
                    out.extend(base.values())
                else:
                    raise JqError(f"--jq: cannot iterate over {_type(base)}.")
            return out
        if kind == "slice":
            res = []
            for base in self.run(n[1], v):
                lo = _one(self.run(n[2], v), "a slice") if n[2] is not None else None
                hi = _one(self.run(n[3], v), "a slice") if n[3] is not None else None
                if base is None:
                    res.append(None)
                elif isinstance(base, (list, str)):
                    res.append(base[None if lo is None else int(lo): None if hi is None else int(hi)])
                else:
                    raise JqError(f"--jq: cannot slice {_type(base)}.")
            return res
        if kind == "try":
            try:
                return self.run(n[1], v)
            except JqError:
                return []
        if kind == "recurse":
            out = []

            def walk(x: Any) -> None:
                out.append(x)
                if isinstance(x, list):
                    for y in x:
                        walk(y)
                elif isinstance(x, dict):
                    for y in x.values():
                        walk(y)

            walk(v)
            return out
        if kind == "array":
            return [self.run(n[1], v)]
        if kind == "object":
            results: list[dict[str, Any]] = [{}]
            for knode, vnode in n[1]:
                keys = self.run(knode, v)
                vals = self.run(vnode, v)
                nxt = []
                for r in results:
                    for k in keys:
                        if not isinstance(k, str):
                            raise JqError("--jq: an object's key is a string.")
                        for val in vals:
                            nxt.append({**r, k: val})
                results = nxt
            return results
        if kind == "call":
            return self.call(n[1], n[2], v)
        raise JqError("--jq: cannot run this.")

    def call(self, name: str, args: list[Node], v: Any) -> list[Any]:
        a = len(args)
        if name == "empty" and a == 0:
            return []
        if name == "not" and a == 0:
            return [not _truthy(v)]
        if name == "length" and a == 0:
            if v is None:
                return [0]
            if isinstance(v, bool):
                raise JqError("--jq: a boolean has no length.")
            if isinstance(v, (int, float)):
                return [abs(v)]
            return [len(v)]
        if name == "type" and a == 0:
            return [_type(v)]
        if name in ("keys", "keys_unsorted") and a == 0:
            if isinstance(v, dict):
                return [sorted(v) if name == "keys" else list(v)]
            if isinstance(v, list):
                return [list(range(len(v)))]
            raise JqError(f"--jq: {_type(v)} has no keys.")
        if name == "values" and a == 0:
            return [v] if v is not None else []
        if name == "has" and a == 1:
            return [(k in v) if isinstance(v, dict) else (isinstance(k, int) and 0 <= k < len(v)) for k in self.run(args[0], v)]
        if name == "select" and a == 1:
            return [v for c in self.run(args[0], v) if _truthy(c)]
        if name == "map" and a == 1:
            if not isinstance(v, (list, dict)):
                raise JqError(f"--jq: cannot map over {_type(v)}.")
            items = v if isinstance(v, list) else list(v.values())
            return [[y for x in items for y in self.run(args[0], x)]]
        if name == "first" and a == 0:
            return [v[0] if isinstance(v, list) and v else None]
        if name == "last" and a == 0:
            return [v[-1] if isinstance(v, list) and v else None]
        if name == "first" and a == 1:
            out = self.run(args[0], v)
            return out[:1]
        if name == "limit" and a == 2:
            n = _one(self.run(args[0], v), "limit")
            return self.run(args[1], v)[: max(0, int(n))]
        if name == "tostring" and a == 0:
            return [v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)]
        if name == "tonumber" and a == 0:
            try:
                return [v if isinstance(v, (int, float)) else (float(v) if "." in v else int(v))]
            except (TypeError, ValueError) as e:
                raise JqError("--jq: not a number.") from e
        if name in ("ascii_downcase", "ascii_upcase") and a == 0:
            if not isinstance(v, str):
                raise JqError(f"--jq: {name} takes a string.")
            return [v.lower() if name == "ascii_downcase" else v.upper()]
        if name == "join" and a == 1:
            sep = _one(self.run(args[0], v), "join")
            return [str(sep).join("" if x is None else x if isinstance(x, str) else json.dumps(x) for x in v)]
        if name == "split" and a == 1:
            return [v.split(s) for s in self.run(args[0], v)]
        if name in ("sort", "unique", "reverse", "add", "min", "max", "any", "all") and a == 0:
            if not isinstance(v, list):
                if name == "reverse" and isinstance(v, str):
                    return [v[::-1]]
                raise JqError(f"--jq: {name} takes an array.")
            if name == "sort":
                return [sorted(v, key=_key)]
            if name == "unique":
                out = []
                for x in sorted(v, key=_key):
                    if not out or _key(out[-1]) != _key(x):
                        out.append(x)
                return [out]
            if name == "reverse":
                return [list(reversed(v))]
            if name == "add":
                acc: Any = None
                for x in v:
                    acc = _binop("+", acc, x)
                return [acc]
            if name in ("min", "max"):
                return [(min if name == "min" else max)(v, key=_key) if v else None]
            return [any(_truthy(x) for x in v) if name == "any" else all(_truthy(x) for x in v)]
        if name == "sort_by" and a == 1:
            return [sorted(v, key=lambda x: [_key(k) for k in self.run(args[0], x)])]
        if name in ("test", "startswith", "endswith", "contains", "ltrimstr", "rtrimstr") and a == 1:
            out = []
            for arg in self.run(args[0], v):
                if name == "contains":
                    out.append(_contains(v, arg))
                    continue
                if not isinstance(v, str) or not isinstance(arg, str):
                    if name in ("ltrimstr", "rtrimstr"):
                        out.append(v)
                        continue
                    raise JqError(f"--jq: {name} takes strings.")
                if name == "test":
                    try:
                        out.append(re.search(arg, v) is not None)
                    except re.error as e:
                        raise JqError(f"--jq: not a regular expression ({e}).") from e
                elif name == "startswith":
                    out.append(v.startswith(arg))
                elif name == "endswith":
                    out.append(v.endswith(arg))
                elif name == "ltrimstr":
                    out.append(v[len(arg):] if v.startswith(arg) else v)
                else:
                    out.append(v[: -len(arg)] if arg and v.endswith(arg) else v)
            return out
        if name == "to_entries" and a == 0:
            if not isinstance(v, dict):
                raise JqError("--jq: to_entries takes an object.")
            return [[{"key": k, "value": x} for k, x in v.items()]]
        if name == "from_entries" and a == 0:
            if not isinstance(v, list):
                raise JqError("--jq: from_entries takes an array.")
            return [{str(e.get("key", e.get("name"))): e.get("value") for e in v if isinstance(e, dict)}]
        raise JqError(f"--jq: this subset has no function {name}/{a} (oscr help formatting); pipe --json into jq for it.")


def _contains(a: Any, b: Any) -> bool:
    if isinstance(a, str) and isinstance(b, str):
        return b in a
    if isinstance(a, list) and isinstance(b, list):
        return all(any(_contains(x, y) for x in a) for y in b)
    if isinstance(a, dict) and isinstance(b, dict):
        return all(k in a and _contains(a[k], y) for k, y in b.items())
    return a == b and _type(a) == _type(b)


def run(expr: str, data: Any) -> list[Any]:
    """The outputs of ``expr`` on ``data``."""
    tree = Parser(expr).parse()
    return Evaluator().run(tree, data)
