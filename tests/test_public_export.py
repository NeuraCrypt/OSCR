"""`oscr public-export` writes the public catalogue dump folder and publishes nothing (the owner
decides whether a public catalogue dataset is ever created). The real dump is catalog.generate with
public=True (covered elsewhere); here we check the CLI wrapper calls it in public mode, writes to the
chosen folder, and says in words that nothing was published."""
from pathlib import Path
from unittest import mock

from oscr import cli


def test_public_export_calls_generate_in_public_mode(tmp_path, monkeypatch):
    con = mock.MagicMock()
    seen = {}

    def fake_generate(c, folder, *, public=False, mirror=None):
        seen["public"] = public
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "oscr_public.db").write_text("")
        (folder / "catalog.json").write_text("{}")
        return folder / "catalog.json"

    monkeypatch.setattr(cli.catalog, "generate", fake_generate)
    out = tmp_path / "dump"
    message = cli._public_export(con, out)

    assert seen["public"] is True
    assert (out / "oscr_public.db").exists()
    assert "Nothing was published" in message
    assert "owner's decision" in message


def test_public_export_is_wired_into_main(tmp_path, monkeypatch):
    # The subcommand parses and dispatches to _public_export, without opening a real database or a
    # network client.
    monkeypatch.setattr(cli.db, "open_db", lambda path: mock.MagicMock())
    monkeypatch.setattr(cli, "Client", lambda *a, **k: mock.MagicMock(requests=0))
    monkeypatch.setattr(cli, "Cache", lambda *a, **k: mock.MagicMock())
    called = {}
    monkeypatch.setattr(cli, "_public_export", lambda con, out: called.setdefault("out", out) or "done")

    code = cli.main(["public-export", "--out", str(tmp_path / "d")])
    assert code == 0
    assert called["out"] == Path(tmp_path / "d")
