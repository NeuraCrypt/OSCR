# arXivLabs proposal: the Open Scientific Code Registry

A draft for the owner to send through arXivLabs' proposal form (the Labs support portal, linked from
https://info.arxiv.org/labs/). arXiv decides; nothing here is a commitment of arXiv's. The figures are
the registry's own, counted on 2026-11-04 in its database; update them before sending. Every statement
must stay true of the code (CLAUDE.md "Every statement is true").

## What we propose

A link, on the abstract page of an arXiv paper, to that paper's record in the Open Scientific Code
Registry (OSCR, https://openscicode.org) when the registry holds one: the authors' code found in the
paper and verified at its source, the files read, and, when an author validated it, the tracing map
that ties the paper's Methods paragraphs to the lines of code that implement them (deposited on Zenodo
with its own DOI, related to the paper with `IsSupplementTo`).

## Why it serves arXiv's readers

- Readers of computational neuroscience preprints reach the code the authors published, checked to be
  alive, with its licence said, and read side by side with the paper.
- The registry is free, keyless and read-only for readers; its catalogue is static files on a CDN, so a
  Labs component costs arXiv nothing and asks the registry no quota.
- No reader data: the registry sets no tracking cookie, shows no advertising, and a signed-out page view
  asks its server nothing (its privacy statement: https://openscicode.org/privacy/).

## What exists today (true on 2026-11-04)

- About 35,700 open-access neuroscience papers with a page, out of about 170,000 harvested.
- About 1,360 harvested papers have a linked arXiv preprint (from OpenAlex and Europe PMC), and about
  730 of those have a code link found in the paper.
- A public, keyless read API (`/api/v1/`, OpenAPI at `/api/v1/openapi.json`) and static JSON files
  under `/data/`. A paper is found by its DOI today.

## What the registry would add for the integration

- A static lookup by arXiv identifier (one file per shard, like the DOI lookup), so that a Labs
  component asks one static file for `arXiv:YYMM.NNNNN` and gets the record's address, or nothing.
- A small component for arxiv-browse that reads that lookup in the reader's browser and shows one line
  ("Code and tracing map on OSCR") only when the registry holds the paper.

## Who maintains it

The registry's operator (named on https://openscicode.org/privacy/ once the operator is set) develops
and maintains the component, answers arXiv's review and fixes what arXiv asks, as arXivLabs requires.

## Contact

Through the arXivLabs portal only. No email address of the operator or of an author is published by the
registry.
