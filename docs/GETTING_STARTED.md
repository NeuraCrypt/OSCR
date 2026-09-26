# Getting started: install and connect OSCR

Everything to do, in order. The commands are typed in the Mac's Terminal.

## Where things stand (2026-09-26)

| Piece | State |
|---|---|
| **The harvester** (continuous watch) | running since 2026-09-26 |
| **The local dashboard** | running on http://127.0.0.1:8790 |
| **The nightly publication** (Hugging Face) | connected through `hf auth login` (OAuth, renews itself) |
| **The public website** (Cloudflare Pages) | online at https://oscr-2lj.pages.dev, rebuilt every night |
| **Map DOIs** (Zenodo) | sandbox connected, community `oscr` created, one test deposit made |
| **The code** | on https://github.com/yannbellec/Open-Scientific-Code-Registry-OSCR- |
| **Author validation** (ORCID) | not built yet; without it, no real DOI |

The steps below say how each piece was connected, so that it can be done again on another
machine or after a failure.

## Step 1: check that the harvester runs (2 min)

```bash
launchctl list | grep oscr
```

Three lines must appear:
- `org.oscr.harvester` and `org.oscr.dashboard` have a number (a PID) in the first column;
- `org.oscr.nightly` has a dash: it only runs at 04:17.

A `78` or a `127` in the second column signals a failure: see "When something goes wrong".

```bash
tail -f ~/Library/Logs/oscr/harvester.log   # the harvester, live (Ctrl-C to quit)
open http://127.0.0.1:8790                   # the dashboard
```

## Step 2: set the Mac up to run without you (5 min)

These macOS settings are yours; nothing here changes them.

- **System Settings → Energy**:
  - turn on "Prevent automatic sleeping when the display is off"; otherwise the harvester
    stops when the Mac sleeps;
  - turn on "Start up automatically after a power failure".
- **After a restart**, the tasks start again when you open your session. As long as nobody
  is logged in, they wait.
  - Automatic login (Users & Groups) avoids that wait, but it is impossible with FileVault.
- **The Expansion disk** must stay plugged in. Unplugged, the harvester stops; plugged back
  in, it starts again by itself.

## Step 3: Hugging Face, replace the token (5 min)

The previous token was pasted into a conversation: it must be replaced.

1. On huggingface.co, open **Settings → Access Tokens → Create new token**.
   - Choose *Fine-grained*, with write access to the repositories of your namespace.
   - Name it `oscr-mac`.
2. In the Terminal, run the command below. It opens the browser to sign you in, or asks you
   to paste the token (it stays invisible). Never put the token in the command itself: it
   would stay in the Terminal's history.
   ```bash
   /Volumes/Expansion/Scrapper/.venv/bin/hf auth login --force
   ```
3. On the website, delete the previous token.
4. Test by running the publication right away:
   ```bash
   launchctl kickstart gui/$(id -u)/org.oscr.nightly
   tail -f ~/Library/Logs/oscr/nightly.log
   ```
   The log must end with a line `… files, … MB → huggingface.co/datasets/opsecsystems/oscr-catalog`.

The dataset stays **private**. Making it public is a decision to take on its Hugging Face
page.

## Step 4: Zenodo, the sandbox (10 min)

All development happens on **sandbox.zenodo.org**: its DOIs are fake (prefix `10.5072`).

1. Create an account on https://sandbox.zenodo.org: with an email address, GitHub or ORCID.
2. Create a token: the menu under your name → **Applications → Personal access tokens → New
   token**.
   - Name: `oscr`.
   - Tick `deposit:write` and `deposit:actions`.
   - Click **Create**, then copy the token.
3. Store the token in the Mac's keychain. Paste it twice when asked (it stays invisible).
   Paste it nowhere else, neither in a file nor in a conversation.
   ```bash
   security add-generic-password -s org.oscr.zenodo-sandbox -a "$USER" -w
   ```
4. Create the community:
   ```bash
   cd /Volumes/Expansion/Scrapper
   uv run oscr zenodo community --create
   ```
   If Zenodo refuses, create it by hand on https://sandbox.zenodo.org/communities-new with
   the identifier `oscr`.
5. Try the whole chain with Josiah Carberry, the fictitious researcher ORCID provides for
   tests:
   ```bash
   uv run oscr zenodo card 10.7554/elife.106554              # the proposed map
   uv run oscr zenodo validate 10.7554/elife.106554 --orcid 0000-0002-1825-0097 --name "Carberry, Josiah"
   uv run oscr zenodo deposit 10.7554/elife.106554 --dry-run    # the record, nothing sent
   uv run oscr zenodo deposit 10.7554/elife.106554              # the real upload, to the sandbox
   ```
   The last command returns a DOI `10.5072/zenodo.…` and the address of the record, filed in
   the community.

   This test validation stays in your database, marked `test`. It never appears in the
   exports, and the real Zenodo ignores it.

## Step 5: Cloudflare Pages, put the website online (10 min)

**First, a decision**: once deployed, the website is **public**. It only shows the public
catalogue:
- the links to the papers and to their repositories;
- the text of the scripts whose license allows it;
- no text of any paper: the Code ↔ Paper reader has the visitor's browser load it from
  Europe PMC.

1. Create a free account on https://dash.cloudflare.com, if you do not have one.
2. Sign in. The browser opens; click **Allow**.
   ```bash
   cd /Volumes/Expansion/Scrapper/website
   npx wrangler login
   ```
3. Create the project. If the name is taken, choose another one, and replace `oscr` in the
   `deploy` script of `package.json`.
   ```bash
   npx wrangler pages project create oscr --production-branch main
   ```
4. Put the site online:
   ```bash
   npm run deploy
   ```
   The build reads the public catalogue that `oscr nightly` writes to `../data/public`
   (another folder with `CATALOG_DIR=…`). The site is then at https://oscr-2lj.pages.dev.
5. **Every night, automatically**: in `~/.config/oscr/settings`, set
   `OSCR_CLOUDFLARE_PROJECT=oscr`.
   - At 04:17, after Hugging Face, the site is rebuilt with the day's catalogue and put
     online.
   - Wrangler keeps and renews its own sign-in.
   - To test right away: `launchctl kickstart gui/$(id -u)/org.oscr.nightly`.

The website takes its display name from `SITE_NAME` (default `OSCR`) and `SITE_TAGLINE`,
read at build time (`website/src/config.ts`); no page writes the name itself.

A domain name would be the only possible cost (about €10 a year). It is not needed: the
`.pages.dev` address is free.

## Step 6: save the code (5 min)

The code is on https://github.com/yannbellec/Open-Scientific-Code-Registry-OSCR- (a
**public** repository). It is pushed over SSH, with the Mac's key.

- **What never goes in**: the data (`data/`), the generated outputs (`library/`, `mirror/`),
  the Python environment, the website's modules, the tokens.
- **The identity of the commits** is GitHub's "noreply" address, not your email address.
- **To send the next changes**:
  ```bash
  cd /Volumes/Expansion/Scrapper
  git add -A
  git commit -m "…"
  git push
  ```

**The private database** (`data/oscr.db`) is not in git. It can be rebuilt, but that takes
weeks of harvesting. Copy it from time to time; this command is safe even while the
harvester writes:

```bash
sqlite3 /Volumes/Expansion/Scrapper/data/oscr.db ".backup '$HOME/oscr-backup.db'"
```

## Day to day

There is nothing to do:
- the harvester works continuously: the new papers every hour, the backlog the rest of the
  time;
- at 04:17, the publication sends the catalogue to Hugging Face, and to the website when
  that is set.

| To | Command |
|---|---|
| see where the harvester is | the top of http://127.0.0.1:8790, or `tail -f ~/Library/Logs/oscr/harvester.log` |
| pause the harvester | `launchctl bootout gui/$(id -u)/org.oscr.harvester` |
| resume it | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/org.oscr.harvester.plist` |
| publish right away | `launchctl kickstart gui/$(id -u)/org.oscr.nightly` |
| apply a changed setting | `/Volumes/Expansion/Scrapper/tools/install_mac.sh` (the data stays) |
| remove everything | `/Volumes/Expansion/Scrapper/tools/install_mac.sh --uninstall` (the data stays) |

The settings are in `~/.config/oscr/settings`.

| Setting | Value | Effect |
|---|---|---|
| `OSCR_DOMAIN` | `neuro` | the scope of the papers: `neuro`, `electrophysiology`, or a Europe PMC query |
| `OSCR_NEWS_MINUTES` | `60` | how often the new papers are read |
| `OSCR_SLICE_MINUTES` | `30` | the length of each slice of backlog |
| `OSCR_BACK_TO` | `2000` | the oldest year the backfill walks back to |
| `OSCR_PRIORITY` | `background` or `normal` | discreet, or ~3 times faster; run the installer again after a change |
| `OSCR_HF_DATASET` | `opsecsystems/oscr-catalog` | the Hugging Face dataset (empty: nothing sent) |
| `OSCR_CLOUDFLARE_PROJECT` | empty or `oscr` | the website put online every night |
| `OSCR_ZENODO_INSTANCE` | `sandbox` | `zenodo` only once real validations exist |
| `OSCR_ZENODO_COMMUNITY` | `oscr` | the community of the maps |
| `OSCR_PLATFORM_NAME` | `Open Scientific Code Registry (OSCR)` | the platform named as co-creator of each deposited map |

## When something goes wrong

| Symptom | Likely cause | What to do |
|---|---|---|
| the dashboard does not answer | the disk is unplugged, or the task is stopped | `launchctl list \| grep oscr`, then `tail ~/Library/Logs/oscr/dashboard.log` |
| `78` in `launchctl list` | a log placed on the external disk | run the installer again (it puts the logs in `~/Library/Logs`) |
| `127` in `launchctl list` | a shell script started by launchd from the external disk | run the installer again (it starts Python directly) |
| `! Outage: …` in `harvester.log` | a service is down or the network is cut | nothing: it retries by itself, after 2 minutes, then up to 1 hour |
| `Hugging Face: …` in `nightly.log` | a missing or expired token | do step 3 again |
| `Cloudflare: …` in `nightly.log` | wrangler's sign-in expired | `cd website && npx wrangler login` |
| `No token for sandbox` | the Zenodo token is not in the keychain | do step 4.3 again |

## What does not exist yet

- **Author validation**: an author signs in on the website with their ORCID, reviews their
  map, validates or corrects it.
  - ORCID offers sign-in for free (public API; registration on orcid.org/developer-tools).
  - The validation will go through a Pages Function and D1 at Cloudflare. The Mac will pick
    it up and deposit the map on Zenodo.
  - **Without it, no real DOI is possible**: on purpose (see [CLAUDE.md](../CLAUDE.md)).
- **Search** on the website: designed in [PLATFORM_PLAN.md](PLATFORM_PLAN.md), awaiting the
  owner's validation.
- **A better code ↔ paper alignment**: the first method, `lexical-v1`, runs on the Mac. Next:
  GROBID for the text, tree-sitter for the code, a local model.

The architecture and the free-tier limits are described in [ARCHITECTURE.md](ARCHITECTURE.md).
