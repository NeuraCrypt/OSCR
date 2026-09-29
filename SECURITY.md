# Security policy

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through GitHub's security
advisories:
[report a vulnerability](https://github.com/NeuraCrypt/OSCR/security/advisories/new).

Include what you can of:
- the component and the commit (`git rev-parse --short HEAD`);
- the steps to reproduce, or a proof of concept;
- the impact you expect.

Never include a real token, password or personal data in the report. If you came across
someone's secret, say where it is, not what it is.

We will acknowledge the report, keep you informed while we fix it, and credit you in the
published advisory unless you prefer otherwise.

## Scope

- **The harvester** (`oscr/`) processes untrusted input on every paper: JATS XML, zip
  archives, git repositories, files from Zenodo, OSF, figshare and publishers. Path
  traversal, decompression bombs, XML entity expansion, command injection through a
  repository URL, or a way to make it store or publish what the rules forbid (article text,
  the text of unlicensed code) are all in scope.
- **The local dashboard** (`oscr dashboard`), meant to listen on 127.0.0.1 only and to be
  read-only.
- **The website** (`website/`) and, when they exist, its Cloudflare Pages Functions.
- **The workflows** in `.github/workflows/`.
- **The handling of secrets**: Hugging Face and Zenodo tokens, the macOS keychain.

Out of scope: the services OSCR reads or publishes to (Europe PMC, Crossref, DataCite,
GitHub, Zenodo, Software Heritage, Hugging Face, Cloudflare). Please report their issues to
them.

## Supported versions

Only the `main` branch is supported.
