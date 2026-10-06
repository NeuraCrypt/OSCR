-- The forge database, part 17: repository statistics (night phase 12). See docs/STATISTICS.md,
-- docs/FORGE.md and docs/DECISIONS.md D12-*.
--
-- These are PUBLIC-repository facts, written by the Mac (oscr/usedby.py, within the facts push's
-- daily budget) for the repositories whose numbers changed. GitHub's own statistics (Pulse,
-- contributors, commits, code frequency) are NOT here: the reader's browser reads them from GitHub
-- directly (0 Worker and 0 Mac requests, D12-1). Only the parts OSCR alone has live here: who depends
-- on a repository ("Used by", counting papers, D12-2), the research marks the charts overlay, and the
-- history of the registry's own stars.
--
-- Nothing here holds an email address, a token, a secret or any user code. Every read the Worker does
-- is a key or a key range on the primary key (service/statistics.ts; tests check the plan), never a
-- scan. Times are Unix seconds; a day is at / 86400. WITHOUT ROWID where the key is text.

-- One summary row per repository: how many papers and repositories depend on it ("Used by"), and the
-- history of its registry stars as a small JSON array of [day, cumulative] points (bounded by the
-- Mac). The Worker reads exactly this one row for the counters and the star-history chart.
CREATE TABLE repo_stats (
    forge        TEXT NOT NULL CHECK (forge IN ('github', 'memory')),
    repo_id      TEXT NOT NULL CHECK (repo_id NOT GLOB '*[^0-9]*'),
    usedby_papers INTEGER NOT NULL DEFAULT 0 CHECK (usedby_papers >= 0),
    usedby_repos  INTEGER NOT NULL DEFAULT 0 CHECK (usedby_repos >= 0),
    stars        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(stars) AND length(stars) <= 4000),
    computed_at  INTEGER NOT NULL,
    PRIMARY KEY (forge, repo_id)
) WITHOUT ROWID;

-- A sample of the dependants of a repository, for the "Used by" list (the full counts are in
-- repo_stats; the Mac keeps at most a bounded sample here). `dep_kind` is 'paper' (the research
-- angle: a paper that depends on this repository's code) or 'repo' (another repository in the
-- registry). `via` is the package the dependency goes through ("PyPI:numpy"). A paper names its DOI,
-- its page slug (when it has a page) and its title; a repository names its owner and name. Keyed so a
-- repository's dependants are one key range, ordered paper-before-repo then by key.
CREATE TABLE repo_dependents (
    forge        TEXT NOT NULL CHECK (forge IN ('github', 'memory')),
    repo_id      TEXT NOT NULL CHECK (repo_id NOT GLOB '*[^0-9]*'),
    dep_kind     TEXT NOT NULL CHECK (dep_kind IN ('paper', 'repo')),
    dep_ref      TEXT NOT NULL CHECK (length(dep_ref) BETWEEN 1 AND 300),
    via          TEXT NOT NULL DEFAULT '' CHECK (length(via) <= 260),
    owner        TEXT NOT NULL DEFAULT '' CHECK (length(owner) <= 100),
    name         TEXT NOT NULL DEFAULT '' CHECK (length(name) <= 100),
    slug         TEXT NOT NULL DEFAULT '' CHECK (length(slug) <= 300),
    title        TEXT NOT NULL DEFAULT '' CHECK (length(title) <= 500),
    computed_at  INTEGER NOT NULL,
    PRIMARY KEY (forge, repo_id, dep_kind, dep_ref)
) WITHOUT ROWID;

-- The research marks the insights charts overlay: a commit a paper or a map cites, or a tag tied to a
-- paper version or a DOI. `t` is when to place the mark on the chart's time axis (a paper mark sits at
-- the paper's publication day, a tag mark at the tag's day). `kind` is 'paper', 'map' or 'tag';
-- `label` is a short, email-masked description (the paper's title and DOI, the tag's name). `ref` is a
-- stable id within (repo, kind): the paper id, or the tag name. No email address, no user code.
CREATE TABLE repo_marks (
    forge        TEXT NOT NULL CHECK (forge IN ('github', 'memory')),
    repo_id      TEXT NOT NULL CHECK (repo_id NOT GLOB '*[^0-9]*'),
    kind         TEXT NOT NULL CHECK (kind IN ('paper', 'map', 'tag')),
    ref          TEXT NOT NULL CHECK (length(ref) BETWEEN 1 AND 300),
    t            INTEGER NOT NULL CHECK (t > 0),
    label        TEXT NOT NULL DEFAULT '' CHECK (length(label) <= 500),
    computed_at  INTEGER NOT NULL,
    PRIMARY KEY (forge, repo_id, kind, ref)
) WITHOUT ROWID;
