// The versions of a paper a release may accompany (night phase 07; docs/RELEASES.md): the Worker's
// release actions (act-releases.ts) and the pages (src/lib/releases.ts) share them, and the Mac
// (oscr/forgelayer.py PAPER_VERSIONS) and the database (migrations/d1-forge/0006_releases.sql) list the
// same. A module of its own, so that a page naming a version carries none of the Worker's code.

export const PAPER_VERSIONS = ["preprint", "submitted", "accepted", "published", "correction"] as const;
export type PaperVersion = (typeof PAPER_VERSIONS)[number];

export const VERSION_WORDS: Readonly<Record<PaperVersion, string>> = {
  preprint: "the preprint",
  submitted: "the submitted manuscript",
  accepted: "the accepted manuscript",
  published: "the version of record",
  correction: "a correction",
};
