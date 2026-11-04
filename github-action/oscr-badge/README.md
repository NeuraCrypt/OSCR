# OSCR badge, as a GitHub Action

Keeps the [Open Scientific Code Registry](https://openscicode.org)'s badge in your repository's README.
It writes the badge between two marks under the README's title, or replaces what is between them, and
commits the README when it changed. It runs nothing of your code and needs no key: it reads the
registry's public facts only.

Add this file to your repository as `.github/workflows/oscr-badge.yml`:

```yaml
name: OSCR badge
on:
  workflow_dispatch:
  release:
    types: [published]
  schedule:
    - cron: "17 4 1 * *"   # once a month
permissions:
  contents: write
jobs:
  badge:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: NeuraCrypt/OSCR/github-action/oscr-badge@main
```

Inputs (all optional): `doi` (the paper; default, the one the registry links to the repository),
`repo-badge` (`true`: the repository's own badge), `readme`, `format`, `commit` (`false`: write only,
for a later step that opens a pull request), `commit-message`. Output: `changed`.

The marks are `<!-- oscr-badge:start -->` and `<!-- oscr-badge:end -->` (Markdown, HTML),
`.. oscr-badge:start` and `.. oscr-badge:end` (reStructuredText). To remove the badge, delete the
workflow, then the lines between the marks.
