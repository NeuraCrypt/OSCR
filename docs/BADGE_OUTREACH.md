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
