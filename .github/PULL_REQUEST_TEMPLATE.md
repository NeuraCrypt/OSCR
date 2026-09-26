## What and why

<!-- One topic per pull request. Link the issue it closes, for example "Closes #12". -->

## How it was checked

<!-- The tests added or changed. For a change to finding or judging code, its effect on
precision or recall (a sample read by hand, or tools/zenodo_benchmark.py), with the date. -->

## Checklist

- [ ] `uv run pytest -q` passes, and the tests need no network.
- [ ] `uv run ruff check oscr tests` passes.
- [ ] The rules hold: no article text or PDF is published; code without a license stays a link and a commit; no mass email; no paid service; no secret in the code; no non-public personal data displayed.
- [ ] Website changes use `website/src/styles/science.css` only, and take the site's name from `SITE_NAME`.
- [ ] The documentation (README, `docs/`) is updated, in English.
