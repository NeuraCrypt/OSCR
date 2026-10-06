# The rules and privacy pages (night phase 16)

Static pages of the site, one file each, drafted in the site's voice. **Every one is a draft awaiting
the owner's review**: each opens with a notice saying it is not yet in force and is not legal advice
(`website/src/components/PolicyDraft.astro`). The owner removes that notice from a page once reviewed,
and writes the date here. Decisions: [DECISIONS.md](DECISIONS.md) D16-17, D16-18.

| page | file | what it says | reviewed |
|---|---|---|---|
| `/terms/` | `website/src/pages/terms.astro` | the service; accounts; the GitHub side under GitHub's own terms, in the researchers' own accounts; what users own and the licence they give; the rules and what happens; suspension and appeal; limits; liability; changes |, |
| `/acceptable-use/` | `website/src/pages/acceptable-use.astro` | what is not allowed (unlawful content, harassment, private information, malware, spam, impersonation, misinformation, infringement, abuse of the service), the reasons a report may give, and what the owner may do |, |
| `/guidelines/` | `website/src/pages/guidelines.astro` | the community guidelines: about the code and the paper, with evidence, in good faith |, |
| `/privacy/` | `website/src/pages/privacy.astro` | every personal datum held (accounts, the GitHub side, the researchers' data in the catalogue, **the private collection of authors' contact details**), cookies and browser storage, the processors, transfers, Do Not Track and Global Privacy Control, children, the rights |, |
| `/limits/` | `website/src/pages/limits.astro` | the daily limits of an account and of the service, and what the site says when one is reached, its numbers imported from the Worker's constants at build time |, |
| `/copyright/` | `website/src/pages/copyright.astro` | takedowns: what the registry holds (the removal page, reports), code on GitHub (GitHub's notice; hidden meanwhile), private information, counter-notices and restoration, public notices |, |
| `/data-rights/` | `website/src/pages/data-rights.astro` | the form: access, portability, rectification, erasure, objection, restriction; answered in the site within one month |, |
| `/notices/` | `website/src/pages/notices.astro` | the public, redacted notices of the moderation decisions (built from the nightly export) | not a policy |

## What only the owner can complete

Left as bracketed blanks in the drafts:

- `/privacy/` §1: the controller's name and postal address.
- `/privacy/` §6: the safeguard each processor outside the European Union relies on (standard
  contractual clauses of its data-processing terms, or the EU–US Data Privacy Framework where it is
  certified).
- `/terms/` §7: the limitation of liability the owner's law allows, and the law and courts that apply.
- `/copyright/` §4: the counter-notice's delay (the draft says 14 days) and the procedure under the law
  that applies.

## What the pages promise, and where the code keeps it

| promise | kept by |
|---|---|
| no email address asked, read, stored or sent | the sign-in scopes (ACCOUNTS.md), `cleanText` and the CHECKs (MODERATION.md) |
| the authors' contact details never public, no mass email | `oscr/contacts.py`, `catalog.public_db`, the private dataset check (CLAUDE.md) |
| cookies strictly necessary, `__Host-` only | `worker/account/session.ts`, `flow.ts`, `forge/service/flow.ts` |
| retention | `oscr/retention.py`, the sessions' expiry |
| answers within one month, in the site | `rights.ts`; the queue shows the date due |
| a notice for every decision, redacted | `oscr/moderation.py` `notices`, `/notices/` |

## Publishing the policies under CC0

The plan proposes keeping the policies in a public repository under CC0. Their texts are the files
above; publishing them so (and choosing the licence) is the owner's decision (D16-17).
