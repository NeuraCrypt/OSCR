# Contributing to OSCR

Thank you for helping. OSCR is research infrastructure: it tells readers where the authors
of a paper published their code, so every change has to keep its verdicts right, its
sources respected and its costs at zero. Bug reports, new sources of links, sharper
heuristics, documentation and accessibility fixes are all welcome.

## The rules, first

These are not negotiable; a pull request that breaks one will not be merged.

- **No article text or PDF is ever published**: only DOI links. The sentences that justified
  a verdict stay in the private database; alignment evidence is a handful of short technical
  terms, never a span of the article.
- **Code without a license stays a link and a commit**, never a copy.
- **No mass email** to authors: they come to OSCR, never the reverse.
- **Zero cost.** If a feature does not fit the free tiers, say so and propose an alternative
  instead of building it.
- **Be polite to the services**: a minimum interval per host, the on-disk cache, no repeated
  request, and a pause when a quota runs out (see `oscr/net.py` and `oscr/repos.py`).
- **No secret in the code**: tokens live in the macOS keychain, at their standard location, or
  in Cloudflare secrets; never in the repository, the settings file, a test or a log.
- **No email address or other non-public personal data is displayed.**
- **DOIs only for tracing maps validated by one of the paper's authors**; all development
  uses the Zenodo sandbox.
- **English everywhere**: code, comments, messages, documentation.

The complete list, including the website's style rules, is in [CLAUDE.md](CLAUDE.md).

## Set up

You need Python 3.12 (3.11 works), [uv](https://docs.astral.sh/uv/) and git; Node.js 22.12 or
later for the website.

```bash
git clone https://github.com/NeuraCrypt/OSCR.git
cd OSCR
uv sync
uv run pytest -q
uv run ruff check oscr tests
```

To try the harvester on a few papers without touching anyone's database, give it its own
files:

```bash
uv run oscr --db /tmp/oscr-try.db --out /tmp/oscr-try --no-records doi 10.7554/eLife.100605
uv run oscr --db /tmp/oscr-try.db stats
```

The website:

```bash
cd website
npm ci
CATALOG_DIR=../data/public npm run build   # a folder written by `oscr nightly` (public mode only)
npm run preview                            # http://localhost:4321
```

## How the code is written

- Python with type hints and dataclasses; the standard library first (the only runtime
  dependencies are `httpx` and `huggingface_hub`).
- Docstrings are short and say **why**, not what.
- A measured fact carries its date and its sample: "10 of 11 verdicts right on new papers,
  measured 2026-09-25".
- The regular expressions target English article text; keep them that way.
- Tests need no network: build what they need in a temporary folder, and answer HTTP with
  `httpx.MockTransport`.
- A change to finding or judging code (`oscr/role.py`, `oscr/find.py`, `oscr/jats.py`,
  `oscr/links.py`) states its effect on precision or recall: a sample read by hand, or the
  Zenodo benchmark (`tools/zenodo_benchmark.py`), with the date.

## The website

- `website/src/styles/science.css` is the only source of style, imported once in
  `src/layouts/Base.astro`: no other stylesheet, no `<style>` block, no `style` attribute, no
  utility class, no component library. A component that needs a new style comes with a
  proposed addition to `science.css`, and waits for approval.
- The site's display name comes from `SITE_NAME` (and `SITE_TAGLINE`) in
  `website/src/config.ts`; never write it in a page.
- The site never serves the text of a paper: the Code ↔ Paper reader has the visitor's
  browser load it from Europe PMC.

## Pull requests

1. One topic per pull request, on its own branch; link the issue it closes.
2. Add or update tests with every change of behavior.
3. Run `uv run pytest -q` and `uv run ruff check oscr tests` before pushing.
4. Update the documentation (README and `docs/`) when a command, a setting or a number
   changes.
5. Figures in the README are regenerated with `uv run python tools/make_figures.py`, from a
   database in the English schema.

The template of the pull request repeats this checklist.

## Reporting

- Bugs and ideas: open an issue with one of the templates.
- Security: never in a public issue; see [SECURITY.md](SECURITY.md).
- Conduct: this project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).

If you are an author of a paper in the catalogue and its tracing map is wrong or
incomplete, open an issue with the paper's DOI. Signing in with ORCID to validate or correct
a map on the website is on the roadmap.

## License of contributions

By contributing, you agree that your code is released under the
[Apache License 2.0](LICENSE), and any data you contribute to the catalogue under
[CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/).
