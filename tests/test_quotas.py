"""Third-party service quotas (measured and documented on 2026-09-26): an exhausted
quota sets the service aside, it never blocks a pass."""
import time

from oscr import links, repos, role
from oscr.jats import Mention
from oscr.net import Response


class FakeClient:
    """Returns prepared responses, and counts the calls."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = 0

    def get(self, url, **kw):
        self.calls += 1
        return self.responses.pop(0) if self.responses else Response(url, 200, "{}")


def test_an_exhausted_software_heritage_is_set_aside_until_its_reset():
    repos._PAUSED.clear()
    reset = str(int(time.time()) + 1800)
    c = FakeClient([Response("u", 429, "", headers={"x-ratelimit-remaining": "0",
                                                    "x-ratelimit-reset": reset})])
    assert repos.swh_archived(c, "https://github.com/a/b") is None
    # The next one is not even sent: the service is paused.
    assert repos.swh_archived(c, "https://github.com/c/d") is None
    assert c.calls == 1
    repos._PAUSED.clear()


def test_an_exhausted_osf_gives_a_repository_to_check_again_not_a_dead_one():
    repos._PAUSED.clear()
    c = FakeClient([Response("u", 429, "")])
    record = repos.verify_osf(c, links.normalize("https://osf.io/abcde/"))
    assert record["state"] == "unreachable" and "quota" in record["error"]
    repos._PAUSED.clear()


def test_the_token_goes_in_a_header_never_in_the_address(monkeypatch):
    monkeypatch.setenv("GITHUB_TOKEN", "secret-token")
    args = repos._auth_github()
    assert args[0] == "-c" and args[1].startswith("http.https://github.com/.extraheader=AUTHORIZATION: basic ")
    assert "secret-token" not in args[1]
    monkeypatch.delenv("GITHUB_TOKEN")
    assert repos._auth_github() == []


def test_accession_codes_are_not_code():
    u = "https://www.rcsb.org/structure/9D8G"
    m = Mention(u, "The structures have been deposited in the Protein Data Bank with accession "
                   "codes 9D8G and 9D6P.", ("Methods",), "body")
    assert role.judge(m, links.normalize(u), ["X"]).role == "data"
    g = "https://github.com/lab/popcode"
    m = Mention(g, f"The population code analysis scripts are available at {g}.",
                ("Code availability",), "availability")
    assert role.judge(m, links.normalize(g), ["X"]).role == "code"


def test_the_github_token_comes_from_the_keychain_when_the_environment_has_none(monkeypatch):
    from oscr import net
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.setattr(net, "_keychain_github_token", lambda: "keychain-token")
    assert net.github_token() == "keychain-token"
    assert repos._auth_github()[0] == "-c"
    monkeypatch.setenv("GITHUB_TOKEN", "environment-token")
    assert net.github_token() == "environment-token"
