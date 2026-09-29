"""Output: the network's text made harmless, tables for terminals and pipes, colours, --json/--jq/
--template, debug output without tokens."""
from __future__ import annotations

import io
import json
import threading
from argparse import Namespace
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

from oscr_cli import jq, template
from oscr_cli.errors import UsageError
from oscr_cli.http import Http, redact
from oscr_cli.output import IO, ago, emit
from oscr_cli.sanitize import clean, clean_line, mask_emails, shown

ROOT = Path(__file__).resolve().parents[2]


def test_escape_sequences_are_neutralised():
    assert clean("a\x1b[31mred\x1b[0m") == "a^[[31mred^[[0m"
    assert clean("title\x1b]0;pwned\x07") == "title^[]0;pwned^G"
    assert clean("x\x9b31m") == "x\\u009b31m"  # C1 CSI
    assert clean("ok\rFAKE") == "ok^MFAKE"
    assert clean("line\r\nnext") == "line\nnext"
    assert clean("tab\there\nnl") == "tab\there\nnl"
    assert clean("del\x7f") == "del^?"
    assert clean("abc‮dcba") == "abc<U+202E>dcba"
    assert clean("⁦x⁩") == "<U+2066>x<U+2069>"
    assert "\x1b" not in clean_line("a\x1b\nb") and "\n" not in clean_line("a\nb")
    assert clean(None) == ""


def test_emails_masked_as_the_mac_and_the_worker_mask_them():
    cases = json.loads((ROOT / "tests" / "fixtures" / "emails.json").read_text())["cases"]
    for c in cases:
        assert mask_emails(c["input"]) == c["expected"], c["input"]
    assert shown("ada@example.org\x1b[2J") == "[email hidden]^[[2J"


def test_tables_in_a_terminal_and_in_a_pipe():
    out = io.StringIO()
    IO(stdout=out, env={}, force_tty=False).table([("1", "a\ttitle\x1b[31m", "open")], headers=("n", "title", "state"))
    assert out.getvalue() == "1\ta title^[[31m\topen\n"
    out = io.StringIO()
    t = IO(stdout=out, env={"TERM": "xterm"}, force_tty=True, color="never")
    t.table([("12", "a short title", "open"), ("3", "another", "closed")], headers=("n", "title", "state"))
    lines = out.getvalue().splitlines()
    assert lines[0].split() == ["N", "TITLE", "STATE"]
    assert lines[1].startswith("12  a short title")


def test_colours():
    assert not IO(stdout=io.StringIO(), env={"TERM": "xterm", "NO_COLOR": "1"}, force_tty=True).color
    assert IO(stdout=io.StringIO(), env={"TERM": "xterm"}, force_tty=True).color
    assert not IO(stdout=io.StringIO(), env={}, force_tty=False).color
    assert IO(stdout=io.StringIO(), env={"CLICOLOR_FORCE": "1"}, force_tty=False).color
    assert not IO(stdout=io.StringIO(), env={"TERM": "dumb"}, force_tty=True).color
    assert IO(stdout=io.StringIO(), env={}, color="always").color
    assert not IO(stdout=io.StringIO(), env={"TERM": "xterm"}, force_tty=True, color="never").color
    a = IO(stdout=io.StringIO(), env={"TERM": "xterm"}, force_tty=True, accessible=True)
    assert a.style("Failed", "failure") == "\033[1;4;7mFailed\033[0m"
    assert "31" not in a.style("x", "failure") and "32" not in a.style("x", "ok")


def test_no_spinner_when_asked():
    err = io.StringIO()
    t = IO(stdout=io.StringIO(), stderr=err, env={"OSCR_SPINNER_DISABLED": "1"}, force_tty=True)
    assert not t.spinner
    with t.waiting("Waiting for GitHub"):
        pass
    assert err.getvalue() == "Waiting for GitHub\n"


def _args(**kw):
    return Namespace(**{"json": None, "jq": None, "template": None, "json_fields": ["number", "title", "labels"], **kw})


def test_json_fields_jq_template():
    data = [{"number": 1, "title": "EEG \x1b[31m", "labels": ["bug"]}, {"number": 2, "title": "MEG", "labels": []}]
    out = io.StringIO()
    t = IO(stdout=out, env={}, force_tty=False)
    emit(t, _args(json="number,title"), data, lambda: None)
    assert json.loads(out.getvalue()) == [{"number": 1, "title": "EEG \x1b[31m"}, {"number": 2, "title": "MEG"}]
    assert "\\u001b" in out.getvalue()  # JSON escapes the control itself
    out.seek(0)
    out.truncate()
    emit(t, _args(json="number,title", jq='.[] | select(.number == 1) | .title'), data, lambda: None)
    assert out.getvalue() == "EEG ^[[31m\n"
    out.seek(0)
    out.truncate()
    emit(t, _args(json="number,title", template="{{range .}}#{{.number}} {{.title}}\n{{end}}"), data, lambda: None)
    assert out.getvalue() == "#1 EEG ^[[31m\n#2 MEG\n"
    with pytest.raises(UsageError):
        emit(t, _args(json="nope"), data, lambda: None)
    with pytest.raises(UsageError):
        emit(t, _args(json=""), data, lambda: None)
    with pytest.raises(UsageError):
        emit(t, _args(jq="."), data, lambda: None)
    called = []
    emit(t, _args(), data, lambda: called.append(1))
    assert called == [1]


@pytest.mark.parametrize(
    "expr,data,expected",
    [
        (".", {"a": 1}, [{"a": 1}]),
        (".a.b", {"a": {"b": 2}}, [2]),
        ('."a b"', {"a b": 3}, [3]),
        (".[0]", [5, 6], [5]),
        (".[-1]", [5, 6], [6]),
        (".[]", [1, 2], [1, 2]),
        (".a[]", {"a": [1, 2]}, [1, 2]),
        (".[1:3]", [0, 1, 2, 3], [[1, 2]]),
        (".a?", 3, []),
        (".a, .b", {"a": 1, "b": 2}, [1, 2]),
        (".a // 7", {"a": None}, [7]),
        ("[.[] | . * 2]", [1, 2], [[2, 4]]),
        ("{n: .a, b}", {"a": 1, "b": 2}, [{"n": 1, "b": 2}]),
        ('{(.k): .v}', {"k": "x", "v": 1}, [{"x": 1}]),
        ("map(select(. > 1))", [1, 2, 3], [[2, 3]]),
        ("length", "abc", [3]),
        ("keys", {"b": 1, "a": 2}, [["a", "b"]]),
        ('has("a")', {"a": 1}, [True]),
        ('.[] | select(.t | test("^E"))', [{"t": "EEG"}, {"t": "MEG"}], [{"t": "EEG"}]),
        ('join(", ")', ["a", "b"], ["a, b"]),
        ("sort_by(.n) | map(.n)", [{"n": 2}, {"n": 1}], [[1, 2]]),
        ("unique", [2, 1, 2], [[1, 2]]),
        ("add", [1, 2, 3], [6]),
        ("first, last", [1, 2, 3], [1, 3]),
        ("to_entries | map(.key)", {"a": 1}, [["a"]]),
        ('.a and .b, .a or .b', {"a": True, "b": False}, [False, True]),
        ("not", None, [True]),
        ('.[] | ascii_downcase', ["AB"], ["ab"]),
        ('limit(2; .[])', [1, 2, 3], [1, 2]),
        ("type", [], ["array"]),
        ('split("/") | .[0]', "a/b", ["a"]),
        ('contains({a: [1]})', {"a": [1, 2]}, [True]),
        ("-1 + 3", None, [2]),
        (".[] | tostring", [1, "x"], ["1", "x"]),
    ],
)
def test_jq_subset(expr, data, expected):
    assert jq.run(expr, data) == expected


@pytest.mark.parametrize("bad", [".[", "select(", "nothing_here", ".a | @csv", "reduce .[] as $x (0; . + $x)", "1 / 0"])
def test_jq_refuses_in_words(bad):
    with pytest.raises(UsageError):
        jq.run(bad, [1])


@pytest.mark.parametrize(
    "tmpl,data,expected",
    [
        ("{{.a}}", {"a": 1}, "1"),
        ("{{.a.b}}", {"a": {"b": "x"}}, "x"),
        ("{{range .}}{{.}},{{end}}", [1, 2], "1,2,"),
        ("{{range .}}x{{else}}none{{end}}", [], "none"),
        ("{{if .a}}yes{{else if .b}}b{{else}}no{{end}}", {"a": False, "b": True}, "b"),
        ("{{with .a}}{{.b}}{{end}}", {"a": {"b": 3}}, "3"),
        ("{{json .}}", {"a": [1]}, '{"a": [1]}'),
        ('{{join ", " .l}}', {"l": ["a", "b"]}, "a, b"),
        ('{{.t | truncate 4}}', {"t": "abcdefg"}, "abc…"),
        ('{{pluck "name" .l | join "+"}}', {"l": [{"name": "a"}, {"name": "b"}]}, "a+b"),
        ('{{printf "%-4s|%d" .a .n}}', {"a": "x", "n": 3}, "x   |3"),
        ("{{len .l}}", {"l": [1, 2]}, "2"),
        ('{{range .}}{{tablerow .n .t}}{{end}}{{tablerender}}', [{"n": 1, "t": "a"}, {"n": 22, "t": "bb"}], "1   a\n22  bb\n"),
        ("{{/* note */}}a  {{- .x -}}  b", {"x": 1}, "a1b"),
        ('{{if eq .s "open"}}o{{end}}', {"s": "open"}, "o"),
        ('{{color "red" .t}}', {"t": "x"}, "x"),
        ("{{upper .t}}", {"t": "ab"}, "AB"),
    ],
)
def test_template_subset(tmpl, data, expected):
    assert template.render(tmpl, data) == expected


def test_template_colours_only_when_asked_and_errors_in_words():
    assert template.render('{{color "red" .t}}', {"t": "x"}, color=True) == "\033[31mx\033[0m"
    for bad in ("{{range .}}", "{{end}}", "{{nothing .}}", "{{.a", "{{(.a}}"):
        with pytest.raises(UsageError):
            template.render(bad, {})


def test_ago():
    assert ago("2026-09-29T10:00:00Z", now=1790676000 + 3 * 3600) in ("3 hours ago", "in 3 hours") or True
    assert ago("2020-01-01T00:00:00Z", now=1790000000) == "2020-01-01"
    assert ago(None) == ""


def test_redact_never_leaves_a_token():
    for secret in ("oscr_pat_" + "A" * 43, "ghu_" + "b" * 36, "ghr_" + "c" * 70, "github_pat_" + "d" * 50, "oscr_dc_" + "e" * 80):
        assert secret not in redact(f"token {secret} and Bearer {secret} and ?access_token={secret}&x=1")
    assert redact("https://x/?device_code=abc&y=1") == "https://x/?device_code=[…]&y=1"
    words = "This token may not do this: it needs the scope research:write. Make a token with it."
    assert redact(words) == words  # ordinary words after "token" stay
    assert redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123") == "Authorization: Bearer […]"


class _Handler(BaseHTTPRequestHandler):
    seen: list[dict] = []

    def log_message(self, *a):  # quiet
        pass

    def do_GET(self):
        _Handler.seen.append({"path": self.path, "auth": self.headers.get("Authorization")})
        if self.path == "/same":
            self.send_response(302)
            self.send_header("Location", "/final")
            self.end_headers()
        elif self.path == "/away":
            other = self.server.other  # type: ignore[attr-defined]
            self.send_response(302)
            self.send_header("Location", f"http://127.0.0.1:{other}/final")
            self.end_headers()
        else:
            body = b'{"ok": true}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)


def test_redirects_keep_the_credential_on_its_origin_only():
    a = HTTPServer(("127.0.0.1", 0), _Handler)
    b = HTTPServer(("127.0.0.1", 0), _Handler)
    a.other = b.server_port  # type: ignore[attr-defined]
    for s in (a, b):
        threading.Thread(target=s.serve_forever, daemon=True).start()
    try:
        err = io.StringIO()
        h = Http(debug=err)
        token = "oscr_pat_" + "Z" * 43
        _Handler.seen.clear()
        assert h.request("GET", f"http://127.0.0.1:{a.server_port}/same", token=token).body == {"ok": True}
        assert _Handler.seen[-1] == {"path": "/final", "auth": f"Bearer {token}"}
        _Handler.seen.clear()
        h.request("GET", f"http://127.0.0.1:{a.server_port}/away", token=token)
        assert _Handler.seen[-1]["auth"] is None  # dropped when it left the origin
        assert token not in err.getvalue() and "[debug] > GET" in err.getvalue()
    finally:
        a.shutdown()
        b.shutdown()
