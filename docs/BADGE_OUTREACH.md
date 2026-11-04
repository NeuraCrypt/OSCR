# The letters the owner sends (reader-side links)

The registry's link on every paper's page at Europe PMC and PubMed (docs/BADGE.md, "The sites where
papers are read"). The files are built every night by `oscr linkfeeds`. These two requests speak for
the registry, so the owner sends them. Fill in the bracketed parts. The arXivLabs proposal is in
`docs/ARXIVLABS_PROPOSAL.md`.

Before sending, run `oscr linkfeeds` on the Mac and attach (or quote) its line of counts, and one
`links-001.xml.gz` as a sample.

## 1. Europe PMC External Links

To: labslink@europepmc.org
Subject: External Links provider request: Open Scientific Code Registry (OSCR)

> Dear Europe PMC team,
>
> I run the Open Scientific Code Registry (OSCR, https://openscicode.org), a free, non-commercial
> registry of the code that the authors of open-access neuroscience papers publish. For each paper it
> finds the code the paper links to, checks it at its source, and shows it side by side with the
> paper's methods. Every page is public, with no account, subscription or advertising.
>
> We would like to become an External Links provider, with one link per paper the registry has a page
> for: [N] papers today ([n1] by PMID, [n2] by PMCID, [n3] by DOI). Each link opens the paper's page in
> the registry. We have prepared the profile and links files to schema 1.2 and regenerate them every
> night; a sample is attached.
>
> Could you assign us a provider ID, and tell us how you prefer to receive the files (FTP or another
> route)? The technical contact for the automated reports is [contact address].
>
> Best regards,
> [name], [role], OSCR

After the answer, on the Mac (`~/.config/oscr/settings`):

```
OSCR_LABSLINK_PROVIDER=<the id>
OSCR_LABSLINK_EMAIL=<the contact address>
OSCR_LABSLINK_FTP=<host>/<folder>
OSCR_LABSLINK_FTP_USER=<user>
```

and the password in the keychain, typed, never shown:

```
security add-generic-password -s org.oscr.labslink -a oscr -w
```

## 2. PubMed LinkOut

LinkOut takes an application from the provider page,
https://www.ncbi.nlm.nih.gov/projects/linkout/ (Information for Other Resource Providers, "Apply for
Inclusion in LinkOut"). What to give in the application:

- **Resource**: Open Scientific Code Registry (OSCR), https://openscicode.org, a free, non-commercial
  registry of the code published by the authors of open-access neuroscience papers, verified at its
  source and shown beside the paper's methods.
- **Type**: research tool, free resource, no registration.
- **Links**: one per PubMed record whose paper has a page in the registry ([N] with a PMID today); each
  goes straight to that paper's page, never to a search.
- **Files**: a LinkOut resource file (`resources-NNN.xml`, one `Link` per PMID), regenerated every
  night.
- **Contact**: [contact address].

After approval: `OSCR_LINKOUT_PROVIDER`, `OSCR_LINKOUT_FTP`, `OSCR_LINKOUT_FTP_USER` in the settings,
and `security add-generic-password -s org.oscr.linkout -a oscr -w`. The NCBI checks the first file it
receives; if it asks for a change of format, `oscr/linkfeeds.py` `linkout_resources` is the one place
to change.

## The files behind the letters below

`oscr outreach` (every night, `data/outreach/` on the Mac; `OSCR_OUTREACH=0` stops it) writes:
`scilite-annotations.jsonl.gz` (Europe PMC Annotations), `scholix.json.gz` (OpenAIRE),
`mixnmatch.tsv` (Wikidata's Mix'n'match) and `journals/<journal>.csv` (one list per journal). Its line
of counts gives the figures to put in each letter. On 2026-11-04: Europe PMC annotations 14,628 papers
(22,086 code links); Scholix 28,212 links; Mix'n'match 36,594 papers; eLife 842, eNeuro 239, PLOS
Computational Biology 533, Imaging Neuroscience 720, Frontiers journals 932. The Atom feed
`https://openscicode.org/papers.atom` (the newest 100 papers with code) is on the site.

What leaves in these files: identifiers (DOI, PMCID), titles, page addresses, and the code link
exactly as the paper writes it. Never an author's name or address, and never the sentence around a
link (CLAUDE.md: the sentences that decided a link's verdict stay private). An annotation is made only
for a paper whose licence lets its statement be shown (CC BY, CC0, CC BY-SA, CC BY-NC).

## 3. Europe PMC Annotations (SciLite)

Europe PMC shows partners' annotations on the paper's own page (SciLite) and serves them through its
Annotations API. The submission format (one JSON object per article: `src`, `id`, `provider`, `anns`)
is described on Europe PMC's annotation submission page; check the current address of its contact
there before sending (at the time of writing, the page names annotations@europepmc.org; the general
helpdesk is helpdesk@europepmc.org).

To: [the annotations contact named on Europe PMC's submission page]
Subject: Annotations provider request: code links verified by the Open Scientific Code Registry

> Dear Europe PMC team,
>
> The Open Scientific Code Registry (OSCR, https://openscicode.org) is a free, non-commercial registry
> of the code that the authors of open-access neuroscience papers publish. For each paper it checks
> the code the paper links to at its source and shows it beside the paper's methods.
>
> We would like to contribute annotations to SciLite: for each open-access article in Europe PMC whose
> licence is CC BY, CC BY-SA, CC BY-NC or CC0, the code link as it appears in the article, tagged
> "Code verified on OSCR" with the address of the paper's page in the registry. Today that is [N]
> articles and [M] code links. The file follows your submission format, one JSON object per article;
> a sample is attached, and we regenerate it every night.
>
> Could you tell us whether this fits your annotation types, and how you prefer to receive it?
>
> Best regards,
> [name], [role], OSCR

Attach: the first lines of `data/outreach/scilite-annotations.jsonl.gz` (for example
`gzip -dc data/outreach/scilite-annotations.jsonl.gz | head -50 > sample.jsonl`).

## 4. OpenAIRE (ScholeXplorer)

ScholeXplorer gathers links between literature, data and software (the Scholix model) from link
providers. `scholix.json.gz` holds one Scholix record per paper and code repository: the paper (its
DOI) `IsSupplementedBy` the software (the repository's address). OpenAIRE's onboarding of a new link
provider is not documented on a public form: ask its helpdesk.

To: OpenAIRE helpdesk, https://www.openaire.eu/support/helpdesk
Subject: New Scholix link provider: paper to software links (Open Scientific Code Registry)

> Dear OpenAIRE team,
>
> The Open Scientific Code Registry (OSCR, https://openscicode.org) links open-access neuroscience
> papers to the code their authors published, verified at the source. We can provide these links as
> Scholix records: [N] links today, each from a paper's DOI to its code repository, relation
> IsSupplementedBy, regenerated every night. A sample is attached.
>
> How can we become a link provider for ScholeXplorer, and which delivery do you prefer (a file at a
> stable address, or another route)?
>
> Best regards,
> [name], [role], OSCR

## 5. Wikidata: an identifier for the registry's pages

Nothing is written to Wikidata by the registry. The owner proposes the property on
https://www.wikidata.org/wiki/Wikidata:Property_proposal/Generic (signed in with a Wikidata account),
then, once it exists, loads `mixnmatch.tsv` into Mix'n'match (https://mix-n-match.toolforge.org/,
"Import new catalog"), where volunteers match it to the papers' items.

The proposal:

- **Label**: OSCR paper ID
- **Description**: identifier of a scholarly article in the Open Scientific Code Registry, which lists
  the code its authors published, verified at the source
- **Represents**: Open Scientific Code Registry (create the item first if it does not exist)
- **Data type**: External identifier
- **Domain**: scholarly article (Q13442814)
- **Allowed values**: `(doi|pmcid|pmid)_[a-z0-9._-]+` (the page's name: the DOI or the identifier, in
  lower case, other characters as `_`)
- **Example**: [an item of a paper with a page, for example the item whose DOI is 10.7554/ELIFE.100056]
  → `doi_10.7554_elife.100056`
- **Formatter URL**: `https://openscicode.org/paper/$1/`
- **Source**: https://openscicode.org/list/
- **Expected completeness**: will never be complete (the registry grows every night)
- **Number of IDs in source**: [N, the Mix'n'match count]
- **Mix'n'match**: a catalogue file is ready (`mixnmatch.tsv`: id, name, description with the DOI)
- **Motivation**: links an article to the code its authors published, verified at the source; free,
  no account, no advertising.

## 6. SciCrunch: an RRID for the registry

On https://scicrunch.org/resources ("Add a resource", signed in), the form's content:

- **Resource name**: Open Scientific Code Registry (OSCR)
- **Description**: a free, non-commercial registry of the code published by the authors of
  open-access neuroscience papers. For each paper it finds the code the paper links to, verifies it at
  its source, shows it beside the paper's methods, and lets an author validate a tracing map (methods
  paragraph to code lines) deposited on Zenodo with its own DOI.
- **Resource URL**: https://openscicode.org
- **Resource type**: software resource; database; registry
- **Keywords**: research software, reproducibility, neuroscience, code availability, open science
- **Funding / parent organization**: [the operator, as named on /privacy/]
- **License**: the registry's data is open to read through its keyless API (https://openscicode.org/api/)

## 7. Altmetric

Altmetric follows sources it is told about. Suggest the feed through its support form
(https://help.altmetric.com/, "Submit a request"):

> The Open Scientific Code Registry (https://openscicode.org) publishes an Atom feed of the newest
> neuroscience papers whose authors' code it verified: https://openscicode.org/papers.atom. Each entry
> links the paper's DOI. Could it be tracked as a source of mentions?

## 8. Sciety

Sciety lists evaluations of preprints made by groups. The registry does not evaluate papers, so this
is a request to be shown as a resource, not as an evaluating group: whether Sciety can show it is
theirs to say (not verified on a public page).

To: Sciety, https://sciety.org/contact-us
Subject: Showing verified code for preprints (Open Scientific Code Registry)

> Dear Sciety team,
>
> The Open Scientific Code Registry (https://openscicode.org) verifies, for open-access neuroscience
> papers and their preprints, the code the authors published, and shows it beside the paper. Its data
> is open through a keyless API (https://openscicode.org/api/). Would a link to a paper's verified code
> be useful on Sciety's article pages, and in what form could you read it?
>
> Best regards,
> [name], [role], OSCR

## 9. Journals: eLife, eNeuro, PLOS Computational Biology, Imaging Neuroscience, Frontiers

One letter per journal, to its editorial office (the address on the journal's contact page). Attach
`data/outreach/journals/<journal>.csv` (the DOI and the registry's page of each of its papers with
code): `elife.csv`, `eneuro.csv`, `plos-computational-biology.csv`, `imaging-neuroscience.csv`,
`frontiers.csv` (every Frontiers journal).

> Dear editors of [journal],
>
> The Open Scientific Code Registry (OSCR, https://openscicode.org) lists [N] papers published in
> [journal] whose authors' code it found and verified at its source; the list is attached (DOI and
> page). Each page shows the code beside the paper's methods, free and without an account.
>
> If it is useful to your readers, a link from your article pages to the registry's page (by DOI:
> `https://openscicode.org/badge/doi/<doi>` redirects to it) or a mention in your code and data
> policy would help authors find their code. Your publisher can also record the code as a relation in
> the paper's Crossref metadata (`isSupplementedBy`).
>
> Best regards,
> [name], [role], OSCR

## 10. CatalyzeX and alphaXiv

Both show code next to arXiv papers. The registry's data is open: suggest that they read it.

> Dear [CatalyzeX / alphaXiv] team,
>
> The Open Scientific Code Registry (https://openscicode.org) verifies the code published with
> neuroscience papers, about 1,360 of them with an arXiv preprint. Its read API is free and keyless;
> for example `https://openscicode.org/api/v1/paper/10.7554/eLife.100056` returns a paper's verified
> code repositories as JSON (reference: https://openscicode.org/help/api/). Would you show it next to
> the papers it covers?
>
> Best regards,
> [name], [role], OSCR

CatalyzeX: https://www.catalyzex.com (contact page). alphaXiv: https://www.alphaxiv.org (contact page).

## 11. Software Heritage

`oscr outreach --swh` and the nightly step `swh` ask Software Heritage's "Save code now" to archive
the public repositories linked from a paper with a page that it has not archived, anonymously, at most
`OSCR_SWH_PER_NIGHT` (10) a night, stopping at the first refusal or a spent rate limit, and never
asking again for the same repository within 90 days (`data/outreach/swh-asked.json`). A repository a
removal request withheld is never asked. **On every night** since the owner decided it on 2026-11-04
(docs/DECISIONS.md); `OSCR_SWH=0` in `~/.config/oscr/settings` stops it. A repository hosted through
the GitHub side keeps the on-request rule.

## 12. bio.tools, NITRC, FAIRsharing, re3data

- **bio.tools** (https://bio.tools, "Add content", signed in): register evoparam (name evoparam;
  homepage https://openscicode.org/scientific-tools/evoparam/; repository
  https://github.com/yannbellec/evoparam; licence Apache-2.0; topic Neurophysiology, Electrophysiology;
  operation Parameter estimation; language Python) and, as a database, OSCR itself (homepage
  https://openscicode.org; topic Neuroscience, Software engineering; type Database portal).
- **NITRC** (https://www.nitrc.org, "Register a new tool", signed in): evoparam, with the same facts
  and the description "evoked response parameterization: each evoked response (ERP, CCEP) as a few
  peaks with a latency, an amplitude and a width"; and OSCR as a resource (a registry of the code of
  open-access neuroscience papers).
- **FAIRsharing** (https://fairsharing.org, "Add content", database record): OSCR; description as in
  section 6; data access: keyless API and static JSON files; licence of the data: [the owner's choice].
- **re3data** (https://www.re3data.org/suggest): re3data lists research DATA repositories. The
  registry holds the code of papers, not datasets, so it may be out of re3data's scope: suggest it
  only with that said, under "Other".
