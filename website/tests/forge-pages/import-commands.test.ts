// Imports on the researcher's machine (D00-8), the commands of src/lib/import-commands.ts: every value
// validated then single-quoted, the mirror that keeps every commit id without the source's hidden
// refs, LFS only when asked, the converters per source kind, a subfolder split and a subtree merge,
// the bulk script (POSIX sh, "set -eu", one block per repository, no credential), a record as one
// commit citing its DOI, and "import from the paper" over the fixture catalogue's lookup shard.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { layerShard } from "../../src/lib/forge.ts";
import {
  backupCommands,
  BULK_MAX,
  bulkScript,
  CONVERT_KINDS,
  checkConvertSource,
  commandText,
  convertCommands,
  destinationUrl,
  HIDDEN_REFS,
  IMPORTER_URL,
  isBranch,
  isFolder,
  importSteps,
  isGitHost,
  layerExport,
  layerFileName,
  linkRepoUrl,
  lookupCode,
  lookupShardOf,
  lookupUrl,
  migrationArchiveCommands,
  MIRROR_REFSPECS,
  mirrorCommands,
  mirrorPlan,
  newRepoUrl,
  normalizeDoi,
  ongoingMirrorCommands,
  parseBulkList,
  parseGitUrl,
  parseRecord,
  parseRepoInput,
  prefillFromPaper,
  recordCommands,
  recordCommitMessage,
  shq,
  splitCommands,
  subtreeCommands,
  swhRestoreCommands,
  type GitSource,
  type LookupShard,
} from "../../src/lib/import-commands.ts";

const ADA = { owner: "ada", name: "eeg" };
const FIXTURE = new URL("../../../tests/fixtures/public-catalog/", import.meta.url);

/** Split a line of commands into the words a POSIX shell sees, with sh itself (no command runs:
 *  printf prints each argument on its own line). */
function words(line: string): string[] {
  const out = execFileSync("sh", ["-c", `printf '%s\\n' ${line}`], { encoding: "utf8" });
  return out.split("\n").slice(0, -1);
}

const source = (url: string): GitSource => {
  const s = parseGitUrl(url);
  assert.ok(s, url);
  return s;
};

/** Everything a shell could interpret, outside single quotes. */
const METACHARACTERS = [";", "|", "&", "$", "`", "(", ")", "<", ">", "\\", '"', "'", "*", "?", "[", "]", "{", "}", "!", "#", "~", " ", "\t", "\n", "%", "@"];

describe("shell quoting", () => {
  test("shq makes ONE word of anything, which the shell gives back unchanged", () => {
    for (const value of ["plain", "with space", "it's", "$(rm -rf /)", "`id`", "a;b|c&d", "*?[x]", "'''", "back\\slash", ""]) {
      assert.deepEqual(words(shq(value)), [value], value);
    }
  });

  test("control characters are refused", () => {
    assert.throws(() => shq("a\nb"), TypeError);
    assert.throws(() => shq("a\u0000b"), TypeError);
  });
});

describe("git addresses: https or ssh only, validated", () => {
  test("GitHub, GitLab (subgroups, web pages), Bitbucket, Codeberg, ssh forms", () => {
    const cases: [string, string, string, boolean][] = [
      ["https://github.com/oscr-fixture/eeg-analysis", "https://github.com/oscr-fixture/eeg-analysis.git", "eeg-analysis", true],
      ["https://github.com/oscr-fixture/eeg-analysis.git", "https://github.com/oscr-fixture/eeg-analysis.git", "eeg-analysis", true],
      ["https://github.com/oscr-fixture/eeg-analysis/tree/main/src", "https://github.com/oscr-fixture/eeg-analysis.git", "eeg-analysis", true],
      ["https://gitlab.com/lab/group/eeg", "https://gitlab.com/lab/group/eeg.git", "eeg", false],
      ["https://gitlab.com/lab/eeg/-/tree/main", "https://gitlab.com/lab/eeg.git", "eeg", false],
      ["https://bitbucket.org/lab/eeg/src/main/", "https://bitbucket.org/lab/eeg.git", "eeg", false],
      ["https://codeberg.org/lab/eeg.git", "https://codeberg.org/lab/eeg.git", "eeg", false],
      ["https://git.example.org:8443/lab/eeg", "https://git.example.org:8443/lab/eeg.git", "eeg", false],
      ["git@gitlab.com:lab/eeg.git", "git@gitlab.com:lab/eeg.git", "eeg", false],
      ["ssh://git@codeberg.org:2222/lab/eeg.git", "ssh://git@codeberg.org:2222/lab/eeg.git", "eeg", false],
      ["  https://gitlab.com/lab/eeg  ", "https://gitlab.com/lab/eeg.git", "eeg", false],
    ];
    for (const [text, url, name, onGithub] of cases) {
      const s = source(text);
      assert.equal(s.url, url, text);
      assert.equal(s.name, name, text);
      assert.equal(!!s.github, onGithub, text);
      // What parses once parses again to itself.
      assert.equal(parseGitUrl(s.url)?.url, s.url, text);
    }
    assert.deepEqual(source("https://github.com/oscr-fixture/eeg-analysis").github, { owner: "oscr-fixture", name: "eeg-analysis" });
    assert.equal(source("https://gitlab.com/lab/group/eeg").label, "gitlab.com/lab/group/eeg");
  });

  test("refused: other schemes, credentials, queries, local paths, GitHub's own pages, metacharacters", () => {
    const refused = [
      "http://gitlab.com/lab/eeg",
      "git://gitlab.com/lab/eeg.git",
      "file:///home/ada/eeg",
      "/home/ada/eeg",
      "../eeg",
      "eeg",
      "https://ada:ghp_secret@github.com/ada/eeg",
      "https://oauth2:glpat-secret@gitlab.com/lab/eeg.git",
      "https://ada@gitlab.com/lab/eeg.git",
      "ssh://git:hunter2@gitlab.com/lab/eeg.git",
      "https://gitlab.com/lab/eeg?private_token=x",
      "https://gitlab.com/lab/eeg#main",
      "https://gitlab.com/lab/e%20eg",
      "https://gitlab.com/lab/../eeg",
      "https://localhost/lab/eeg",
      "https://-evil.org/lab/eeg",
      "-oProxyCommand=id@evil.org:x/y",
      "git@-oProxyCommand=id:x/y",
      "https://github.com/settings/tokens",
      "https://github.com/ada",
      "https://gitlab.com/lab/eeg;rm -rf ~",
      "https://gitlab.com/lab/$(id)",
      "https://gitlab.com/lab/`id`",
      "https://gitlab.com/lab/eeg|sh",
      "https://gitlab.com/lab/eeg&&id",
      "https://gitlab.com/lab/e'eg",
      'https://gitlab.com/lab/e"eg',
      "https://gitlab.com/lab/eeg\nid",
      "https://gitlab.com/lab/eeg >x",
      "https://gitlab.com:99999/lab/eeg",
      "",
    ];
    for (const text of refused) assert.equal(parseGitUrl(text), null, JSON.stringify(text));
    assert.equal(parseGitUrl(42), null);
  });

  test("no shell metacharacter survives in an accepted address", () => {
    const tries = [
      "https://gitlab.com/lab/eeg", "git@gitlab.com:lab/eeg.git", "ssh://git@codeberg.org/lab/eeg",
      ...METACHARACTERS.map((c) => `https://gitlab.com/lab/e${c}eg`),
      ...METACHARACTERS.map((c) => `git@gitlab.com:lab/e${c}eg.git`),
    ];
    for (const text of tries) {
      const s = parseGitUrl(text);
      if (!s) continue;
      const bare = s.scheme === "ssh" ? s.url.replace(/^(?:ssh:\/\/)?[A-Za-z0-9._-]+@/, "") : s.url;
      for (const c of METACHARACTERS) {
        if (c === "~" || c === "@") continue;
        assert.ok(!bare.replace(/^https:\/\//, "").replace(/^ssh:\/\//, "").includes(c), `${text}: ${c}`);
      }
      assert.ok(!bare.includes("@"), text);
    }
  });

  test("the destination is github.com, checked", () => {
    assert.equal(destinationUrl(ADA), "https://github.com/ada/eeg.git");
    assert.throws(() => destinationUrl({ owner: "ada", name: "eeg.git" }), TypeError);
    assert.throws(() => destinationUrl({ owner: "a;b", name: "eeg" }), TypeError);
  });

  test("branches and folders for commands", () => {
    for (const b of ["main", "release/1.0", "v2_x"]) assert.ok(isBranch(b), b);
    for (const b of ["-x", "a..b", "a b", "a;b", "$(id)", "a'b", ""]) assert.ok(!isBranch(b), b);
    for (const f of ["analysis", "src/eeg", "My Folder/x", "analysis/"]) assert.ok(isFolder(f), f);
    for (const f of ["/abs", "../up", "a/../b", "-x", "a;b", "$HOME", "a'b", ".", ""]) assert.ok(!isFolder(f), f);
  });
});

describe("the mirror: every commit id kept", () => {
  const src = source("https://gitlab.com/lab/eeg");

  test("clone --mirror, the explicit refspecs, the hidden refs deleted, push --mirror", () => {
    const lines = mirrorCommands(src, ADA);
    assert.equal(lines[0], "git clone --mirror 'https://gitlab.com/lab/eeg.git' 'eeg.git'");
    assert.equal(lines[1], "cd 'eeg.git'");
    assert.ok(lines.includes(`git config --replace-all remote.origin.fetch '${MIRROR_REFSPECS[0]}'`));
    assert.ok(lines.includes(`git config --add remote.origin.fetch '${MIRROR_REFSPECS[1]}'`));
    assert.deepEqual(MIRROR_REFSPECS, ["+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"]);
    const del = lines.find((l) => l.startsWith("git for-each-ref")) ?? "";
    assert.ok(del.includes("refs/pull ") && del.endsWith("| git update-ref --stdin"), del);
    for (const ref of HIDDEN_REFS) assert.ok(del.includes(` ${ref}`), ref);
    assert.ok(HIDDEN_REFS.includes("refs/pull") && HIDDEN_REFS.includes("refs/merge-requests"));
    assert.equal(lines.at(-1), "git push --mirror 'https://github.com/ada/eeg.git'");
    // The hidden refs go before the push; nothing fetches refs/* again.
    assert.ok(lines.indexOf(del) < lines.indexOf(lines.at(-1)!));
    assert.ok(!lines.some((l) => l.includes("+refs/*:refs/*") || l.includes("refs/pull/*:")));
  });

  test("LFS steps only when asked, fetch before and push after the mirror", () => {
    assert.ok(!commandText(mirrorCommands(src, ADA)).includes("lfs"));
    assert.ok(!commandText(mirrorCommands(src, ADA, { lfs: false })).includes("lfs"));
    const lines = mirrorCommands(src, ADA, { lfs: true });
    const fetch = lines.indexOf("git lfs fetch --all origin");
    const push = lines.indexOf("git push --mirror 'https://github.com/ada/eeg.git'");
    const lfsPush = lines.indexOf("git lfs push --all 'https://github.com/ada/eeg.git'");
    assert.ok(fetch > 0 && fetch < push && push < lfsPush, commandText(lines));
  });

  test("every line splits into the words intended: the address stays one word", () => {
    for (const url of ["https://gitlab.com/lab/eeg", "git@codeberg.org:lab/eeg.git", "ssh://git@codeberg.org:2222/lab/eeg"]) {
      const s = source(url);
      const first = mirrorCommands(s, ADA)[0];
      assert.deepEqual(words(first), ["git", "clone", "--mirror", s.url, "eeg.git"]);
    }
  });

  test("a forged source object is refused", () => {
    const forged = { ...src, url: "https://gitlab.com/lab/eeg.git; id" };
    assert.throws(() => mirrorCommands(forged, ADA), TypeError);
    assert.throws(() => mirrorCommands(src, { owner: "ada", name: "$(id)" }), TypeError);
  });

  test("the ongoing mirror kept by the person: fetch --prune, push --mirror to GitHub", () => {
    const lines = ongoingMirrorCommands(ADA, { lfs: true });
    assert.deepEqual(lines.slice(0, 3), ["cd 'eeg.git'", "git remote set-url --push origin 'https://github.com/ada/eeg.git'", "git fetch --prune origin"]);
    assert.ok(lines.includes("git push --mirror"));
    assert.ok(lines.includes("git lfs push --all 'https://github.com/ada/eeg.git'"));
    assert.ok(!commandText(ongoingMirrorCommands(ADA)).includes("lfs"));
  });

  test("GitHub's own importer is a link: its page, no request", () => {
    assert.equal(IMPORTER_URL, "https://github.com/new/import");
  });
});

describe("the converters, per source kind", () => {
  const base = { dest: { owner: "ada", name: "legacy" } };
  const tool: Record<string, RegExp> = {
    svn: /^svn2git 'https:\/\/svn\.example\.org\/repo'$/m,
    "git-svn": /^git svn clone --stdlayout --prefix=svn\/ 'https:\/\/svn\.example\.org\/repo' 'legacy'$/m,
    hg: /^hg-fast-export\.sh -r '\.\.\/legacy-hg' -M main$/m,
    tfvc: /^git tfs clone 'https:\/\/dev\.azure\.com\/lab\/' '\$\/Project\/Main' 'legacy' --branches=all$/m,
    perforce: /^P4PORT='ssl:perforce\.example\.org:1666' git p4 clone '\/\/depot\/project@all' 'legacy'$/m,
  };
  const inputs = {
    svn: { source: "https://svn.example.org/repo" },
    "git-svn": { source: "https://svn.example.org/repo" },
    hg: { source: "https://hg.example.org/repo" },
    tfvc: { source: "https://dev.azure.com/lab/", tfvcPath: "$/Project/Main" },
    perforce: { source: "//depot/project/...", p4port: "ssl:perforce.example.org:1666" },
  } as const;

  test("each kind runs its own tool, then pushes to the new repository", () => {
    for (const kind of CONVERT_KINDS) {
      const text = commandText(convertCommands({ kind, ...base, ...inputs[kind] }));
      assert.match(text, tool[kind], `${kind}:\n${text}`);
      assert.match(text, /^git remote add origin 'https:\/\/github\.com\/ada\/legacy\.git'$/m, kind);
      assert.match(text, /^git push -u origin (--all|main)$/m, kind);
      assert.ok(!text.includes("lfs"), kind);
      assert.ok(!/authors/.test(text), kind);
    }
    assert.match(commandText(convertCommands({ kind: "hg", ...base, ...inputs.hg })), /^hg clone 'https:\/\/hg\.example\.org\/repo' 'legacy-hg'$/m);
    assert.match(commandText(convertCommands({ kind: "hg", ...base, ...inputs.hg })), /^git config core\.ignoreCase false$/m);
    assert.match(commandText(convertCommands({ kind: "git-svn", ...base, ...inputs["git-svn"] })), /^git svn fetch$/m);
  });

  test("authors maps and LFS for large files, only when asked, before the first push", () => {
    for (const kind of CONVERT_KINDS) {
      const lines = convertCommands({ kind, ...base, ...inputs[kind], authors: true, lfs: true });
      const text = commandText(lines);
      if (kind !== "perforce") assert.match(text, /authors/, kind);
      const migrate = lines.indexOf("git lfs migrate import --everything --above=50MB");
      const push = lines.findIndex((l) => l.startsWith("git push"));
      assert.ok(migrate > 0 && migrate < push, `${kind}:\n${text}`);
    }
  });

  test("sources are validated per kind", () => {
    assert.equal(checkConvertSource("svn", "svn://svn.example.org/repo"), "svn://svn.example.org/repo");
    assert.equal(checkConvertSource("svn", "svn+ssh://ada@svn.example.org/repo"), "svn+ssh://ada@svn.example.org/repo");
    assert.equal(checkConvertSource("hg", "ssh://ada@hg.example.org/repo"), "ssh://ada@hg.example.org/repo");
    assert.equal(checkConvertSource("perforce", "//depot/project/..."), "//depot/project");
    for (const [kind, text] of [
      ["svn", "http://svn.example.org/repo"],
      ["svn", "https://ada:pw@svn.example.org/repo"],
      ["svn", "https://ada@svn.example.org/repo"],
      ["svn", "https://svn.example.org/repo;id"],
      ["svn", "https://svn.example.org/../repo"],
      ["hg", "svn://hg.example.org/repo"],
      ["tfvc", "ssh://dev.azure.com/lab"],
      ["perforce", "//depot/$(id)"],
      ["perforce", "//depot/../x"],
      ["perforce", "depot/project"],
    ] as const) {
      assert.equal(checkConvertSource(kind, text), null, `${kind} ${text}`);
      assert.throws(() => convertCommands({ kind, ...base, source: text, tfvcPath: "$/P", p4port: "p4.example.org:1666" }), TypeError);
    }
    assert.throws(() => convertCommands({ kind: "tfvc", ...base, source: "https://dev.azure.com/lab/", tfvcPath: "$/P;id" }), TypeError);
    assert.throws(() => convertCommands({ kind: "tfvc", ...base, source: "https://dev.azure.com/lab/", tfvcPath: "/P" }), TypeError);
    assert.throws(() => convertCommands({ kind: "perforce", ...base, source: "//depot/p", p4port: "evil;id:1666" }), TypeError);
    // The TFVC path's "$" stays literal: one word.
    const tfs = convertCommands({ kind: "tfvc", ...base, ...inputs.tfvc })[0];
    assert.deepEqual(words(tfs).slice(3, 5), ["https://dev.azure.com/lab/", "$/Project/Main"]);
  });
});

describe("a subfolder split into a new repository, and subtree merges", () => {
  const src = source("https://gitlab.com/lab/eeg");

  test("split: a fresh clone, git filter-repo --subdirectory-filter, pushed to the new repository", () => {
    const lines = splitCommands(src, "analysis/eeg/", { owner: "ada", name: "eeg-analysis" });
    assert.deepEqual(lines.slice(0, 3), [
      "git clone 'https://gitlab.com/lab/eeg.git' 'eeg-analysis'",
      "cd 'eeg-analysis'",
      "git filter-repo --subdirectory-filter 'analysis/eeg'",
    ]);
    assert.ok(lines.includes("git remote add origin 'https://github.com/ada/eeg-analysis.git'"));
    assert.ok(lines.includes("git push -u origin --all") && lines.includes("git push origin --tags"));
    assert.throws(() => splitCommands(src, "../x", ADA), TypeError);
    assert.throws(() => splitCommands(src, "a;b", ADA), TypeError);
  });

  test("subtree: remote, fetch, merge -s ours, read-tree --prefix, commit; later pull -s subtree", () => {
    const lines = subtreeCommands(src, "vendor/eeg", "main");
    assert.deepEqual(lines.slice(0, 5), [
      "git remote add 'eeg' 'https://gitlab.com/lab/eeg.git'",
      "git fetch 'eeg'",
      "git merge -s ours --no-commit --allow-unrelated-histories 'eeg/main'",
      "git read-tree --prefix='vendor/eeg/' -u 'eeg/main'",
      "git commit -m 'Subtree merge of gitlab.com/lab/eeg into vendor/eeg/'",
    ]);
    assert.equal(lines.at(-1), "git pull -s subtree 'eeg' 'main'");
    assert.deepEqual(words(lines[3]), ["git", "read-tree", "--prefix=vendor/eeg/", "-u", "eeg/main"]);
    assert.throws(() => subtreeCommands(src, "vendor", "-x"), TypeError);
    assert.throws(() => subtreeCommands(src, "/abs", "main"), TypeError);
  });
});

describe("a Zenodo, figshare or OSF record: one commit citing its DOI", () => {
  test("records from their DOI or their page", () => {
    assert.deepEqual(parseRecord("https://doi.org/10.5281/zenodo.1234567"), {
      kind: "zenodo", doi: "10.5281/zenodo.1234567", id: "1234567",
      download: "https://zenodo.org/records/1234567/files-archive", label: "the Zenodo record",
    });
    assert.equal(parseRecord("https://zenodo.org/records/1234567")?.doi, "10.5281/zenodo.1234567");
    assert.equal(parseRecord("doi:10.6084/m9.figshare.987654.v2")?.download, "https://figshare.com/ndownloader/articles/987654/versions/2");
    assert.equal(parseRecord("https://figshare.com/articles/dataset/EEG_code/987654")?.doi, "10.6084/m9.figshare.987654");
    assert.equal(parseRecord("10.17605/OSF.IO/ABCDE")?.kind, "osf");
    assert.equal(parseRecord("https://osf.io/abcde/")?.download, "https://files.osf.io/v1/resources/abcde/providers/osfstorage/?zip=");
    assert.equal(parseRecord("10.1234/lab.code.7")?.kind, "other");
    assert.equal(parseRecord("10.1234/x';id;'")?.kind, undefined);
    assert.equal(parseRecord("not a doi"), null);
  });

  for (const text of ["10.5281/zenodo.1234567", "10.6084/m9.figshare.987654", "10.17605/OSF.IO/ABCDE", "10.1234/lab.code.7"]) {
    test(`the commit message cites the DOI (${text})`, () => {
      const record = parseRecord(text)!;
      const lines = recordCommands(record, { owner: "ada", name: "eeg-code" });
      const commit = lines.find((l) => l.startsWith("git commit"))!;
      const argv = words(commit);
      assert.equal(argv[2], "-m");
      assert.ok(argv[3].includes(`doi:${record.doi}`), argv[3]);
      assert.ok(argv[5].includes(`https://doi.org/${record.doi}`), argv[5]);
      assert.deepEqual(recordCommitMessage(record), [argv[3], argv[5]]);
      // One commit, on main, into the empty repository; the archive downloaded or pointed to.
      assert.equal(lines.filter((l) => l.startsWith("git commit")).length, 1);
      assert.ok(lines.includes("git init -b main") && lines.includes("git push -u origin main"));
      assert.ok(lines.includes("git remote add origin 'https://github.com/ada/eeg-code.git'"));
      if (record.download) assert.ok(lines.includes(`curl -L --fail -o ../record.zip '${record.download}'`));
      else assert.ok(lines.some((l) => l.startsWith("# Download") && l.includes(record.doi)));
    });
  }
});

describe("the bulk import: a script the researcher runs", () => {
  const list = [
    "# my lab's repositories",
    "https://gitlab.com/lab/eeg",
    "",
    "git@bitbucket.org:lab/meg.git meg-pipeline lfs",
    "https://codeberg.org/lab/fmri lab-org/fmri",
  ].join("\n");

  test("the list: one repository a line, a name or owner/name, lfs", () => {
    const { items, errors } = parseBulkList(list, "ada");
    assert.deepEqual(errors, []);
    assert.deepEqual(items.map((i) => [i.source.url, `${i.dest.owner}/${i.dest.name}`, i.lfs]), [
      ["https://gitlab.com/lab/eeg.git", "ada/eeg", false],
      ["git@bitbucket.org:lab/meg.git", "ada/meg-pipeline", true],
      ["https://codeberg.org/lab/fmri.git", "lab-org/fmri", false],
    ]);
  });

  test("refusals name their line; a destination twice is refused", () => {
    const { items, errors } = parseBulkList("https://gitlab.com/a/eeg\nhttp://x.org/a/b\nhttps://gitlab.com/b/eeg\nhttps://gitlab.com/c/x bad;name", "ada");
    assert.equal(items.length, 1);
    assert.deepEqual(errors.map((e) => e.split(":")[0]), ["Line 2", "Line 3", "Line 4"]);
    assert.deepEqual(parseBulkList(list, "not ok").items, []);
  });

  test("POSIX sh, set -eu, one block per repository, and sh -n accepts it", () => {
    const { items } = parseBulkList(list, "ada");
    const script = bulkScript(items);
    const lines = script.split("\n");
    assert.equal(lines[0], "#!/bin/sh");
    assert.ok(lines.includes("set -eu"));
    assert.ok(lines.indexOf("set -eu") < lines.findIndex((l) => l.trim().startsWith("git clone")));
    // One subshell block per repository, each with its clone and its push.
    assert.equal(lines.filter((l) => l === "(").length, items.length);
    assert.equal(lines.filter((l) => l === ")").length, items.length);
    assert.equal(lines.filter((l) => l.trim().startsWith("git clone --mirror")).length, items.length);
    assert.equal(lines.filter((l) => l.trim().startsWith("git push --mirror")).length, items.length);
    assert.equal(lines.filter((l) => l.trim().startsWith("git lfs push --all")).length, 1);
    assert.match(script, /^# 2 of 3: bitbucket\.org\/lab\/meg -> ada\/meg-pipeline \(with LFS\)$/m);
    // No bashism.
    const code = lines.filter((l) => !l.trim().startsWith("#")).join("\n");
    assert.ok(!/\[\[|\bfunction\b|^\s*(?:source|\.)\s|\$\{[^}]*\/\/|<\(|pipefail/m.test(code), code);
    const dir = mkdtempSync(join(tmpdir(), "oscr-import-"));
    writeFileSync(join(dir, "import.sh"), script);
    execFileSync("sh", ["-n", join(dir, "import.sh")]);
  });

  test("never a token or a password", () => {
    const { items } = parseBulkList(list, "ada");
    const script = bulkScript(items);
    assert.ok(!/password|passwd|token|secret|ghp_|github_pat_|glpat-|:\/\/[^/\s]*@/i.test(script), script);
    // An address that carries one is refused before it can reach the script.
    const { items: none, errors } = parseBulkList("https://ada:ghp_abc@github.com/ada/eeg\nhttps://oauth2:glpat-x@gitlab.com/a/b", "ada");
    assert.equal(none.length, 0);
    assert.equal(errors.length, 2);
    assert.throws(() => bulkScript([]), TypeError);
    assert.throws(() => bulkScript(Array.from({ length: BULK_MAX + 1 }, () => items[0])), TypeError);
  });
});

describe("import from the paper: the fixture's lookup shard", () => {
  const catalog = JSON.parse(readFileSync(new URL("catalog.json", FIXTURE), "utf8")) as {
    articles: { doi: string; code: { url: string }[] }[];
  };

  async function fixtureShard(doi: string): Promise<{ name: string; shard: LookupShard }> {
    const name = await lookupShardOf(doi);
    const shard = JSON.parse(readFileSync(new URL(`lookup/${name}.json`, FIXTURE), "utf8")) as LookupShard;
    return { name, shard };
  }

  /** The shard as scripts/data.mjs publishes it: each entry with its paper's code links. */
  function withCode(shard: LookupShard): LookupShard {
    const out: LookupShard = {};
    for (const [doi, entry] of Object.entries(shard)) {
      const article = catalog.articles.find((a) => a.doi === doi);
      const code = lookupCode(article?.code);
      out[doi] = code.length ? { ...entry, code } : { ...entry };
    }
    return out;
  }

  test("the shard is the SHA-1 rule of oscr/entities.py", async () => {
    for (const doi of ["10.5555/oscr.fixture.1", "10.5555/oscr.fixture.2"]) {
      assert.equal(await lookupShardOf(doi), createHash("sha1").update(doi).digest("hex").slice(0, 3));
      const { name, shard } = await fixtureShard(doi);
      assert.ok(shard[doi], name);
      assert.equal(lookupUrl(name), `/lookup/${name}.json`);
    }
  });

  test("?paper=<a fixture DOI> prefills its code links, the paper to link, and its page", async () => {
    const { shard } = await fixtureShard("10.5555/oscr.fixture.1");
    const prefill = prefillFromPaper("https://doi.org/10.5555/OSCR.fixture.1", withCode(shard))!;
    assert.equal(prefill.doi, "10.5555/oscr.fixture.1");
    assert.equal(prefill.found, true);
    assert.equal(prefill.slug, "doi_10.5555_oscr.fixture.1");
    assert.equal(prefill.status, "code_verified");
    assert.deepEqual(prefill.papers, ["10.5555/oscr.fixture.1"]);
    assert.deepEqual(prefill.sources.map((s) => s.url), ["https://github.com/oscr-fixture/eeg-analysis.git"]);
    assert.deepEqual(prefill.sources[0].github, { owner: "oscr-fixture", name: "eeg-analysis" });
    assert.deepEqual(prefill.records, []);
    // Then: link it (the mirror mode) with the paper, or create the copy and import.
    assert.equal(linkRepoUrl(prefill.sources[0].github!, prefill.papers), "/new/link/?repo=oscr-fixture%2Feeg-analysis&paper=10.5555%2Foscr.fixture.1");
    assert.equal(
      newRepoUrl({ name: prefill.sources[0].name, papers: prefill.papers }),
      "/new/?name=eeg-analysis&paper=10.5555%2Foscr.fixture.1&readme=0",
    );
  });

  test("the fixture's second paper, and papers with no code link", async () => {
    const two = prefillFromPaper("10.5555/oscr.fixture.2", withCode((await fixtureShard("10.5555/oscr.fixture.2")).shard))!;
    assert.deepEqual(two.sources.map((s) => s.label), ["github.com/oscr-fixture/unlicensed"]);
    const four = prefillFromPaper("10.5555/oscr.fixture.4", withCode((await fixtureShard("10.5555/oscr.fixture.4")).shard))!;
    assert.equal(four.found, true);
    assert.equal(four.status, "data_only");
    assert.deepEqual([four.sources, four.records, four.other], [[], [], []]);
  });

  test("a shard published without code links (before data.mjs adds them): found, nothing prefilled", async () => {
    const { shard } = await fixtureShard("10.5555/oscr.fixture.1");
    const prefill = prefillFromPaper("10.5555/oscr.fixture.1", shard)!;
    assert.equal(prefill.found, true);
    assert.equal(prefill.slug, "doi_10.5555_oscr.fixture.1");
    assert.deepEqual(prefill.sources, []);
  });

  test("not in the catalogue, not a DOI, and the kinds of code links", () => {
    const missing = prefillFromPaper("10.5555/not.read", {})!;
    assert.equal(missing.found, false);
    assert.deepEqual(missing.papers, ["10.5555/not.read"]);
    assert.equal(prefillFromPaper("not a doi", {}), null);
    assert.equal(prefillFromPaper("10.5555/x", null)?.found, false);
    const shard: LookupShard = {
      "10.5555/x": {
        status: "code_verified",
        read_on: "2026-09-25",
        code: [
          "https://gitlab.com/lab/eeg",
          "https://gitlab.com/lab/eeg/-/tree/main",
          "https://doi.org/10.5281/zenodo.42",
          "https://osf.io/abcde/",
          "https://www.lab.example.org/software",
          "https://ada:secret@gitlab.com/lab/x",
          "javascript:alert(1)",
        ],
      },
    };
    const p = prefillFromPaper("10.5555/x", shard)!;
    assert.deepEqual(p.sources.map((s) => s.url), ["https://gitlab.com/lab/eeg.git"]);
    assert.deepEqual(p.records.map((r) => r.doi), ["10.5281/zenodo.42", "10.17605/osf.io/abcde"]);
    assert.deepEqual(p.other, ["https://www.lab.example.org/software"]);
    // An inherited key is not an entry.
    assert.equal(prefillFromPaper("10.5555/__proto__", {})?.found, false);
  });

  test("git hosts and the lookup's code field", () => {
    for (const url of ["https://github.com/a/b", "https://gitlab.com/a/b", "https://codeberg.org/a/b", "https://gitlab.lab.org/a/b", "https://x.org/a/b.git"]) {
      assert.ok(isGitHost(url), url);
    }
    for (const url of ["https://www.lab.org/code", "https://doi.org/10.5281/zenodo.1", "http://github.com/a/b"]) assert.ok(!isGitHost(url), url);
    assert.deepEqual(lookupCode([{ url: "https://github.com/a/b" }, "https://github.com/a/b", "http://x.org/y", { url: 3 }, null]), ["https://github.com/a/b"]);
    assert.equal(lookupCode(Array.from({ length: 40 }, (_, i) => `https://github.com/a/r${i}`)).length, 20);
    assert.deepEqual(lookupCode("https://github.com/a/b"), []);
  });

  test("normalizeDoi: the rule of oscr/entities.py", () => {
    assert.equal(normalizeDoi("https://dx.doi.org/10.1234/ABC"), "10.1234/abc");
    assert.equal(normalizeDoi("doi: 10.1234/abc"), "10.1234/abc");
    assert.equal(normalizeDoi("10.1234%2Fabc"), "10.1234/abc");
    assert.equal(normalizeDoi("11.1234/abc"), "");
    assert.equal(normalizeDoi(null), "");
  });
});

describe("the next steps' addresses", () => {
  test("/new/ with no README; /new/link/ with the papers", () => {
    assert.equal(newRepoUrl({ name: "eeg", description: "Imported from gitlab.com/lab/eeg", papers: ["doi:10.5555/A", "nope"] }),
      "/new/?name=eeg&description=Imported+from+gitlab.com%2Flab%2Feeg&paper=10.5555%2Fa&readme=0");
    assert.throws(() => newRepoUrl({ name: "a b" }), TypeError);
    assert.equal(linkRepoUrl(ADA), "/new/link/?repo=ada%2Feeg");
    assert.throws(() => linkRepoUrl({ owner: "a/b", name: "c" }), TypeError);
  });

  test("a repository typed as owner/name or its GitHub address", () => {
    assert.deepEqual(parseRepoInput("ada/eeg"), ADA);
    assert.deepEqual(parseRepoInput(" ada/eeg.git/ "), ADA);
    assert.deepEqual(parseRepoInput("https://github.com/ada/eeg"), ADA);
    for (const bad of ["ada", "ada/eeg/x", "a;b/eeg", "https://gitlab.com/ada/eeg", 3]) assert.equal(parseRepoInput(bad), null, String(bad));
  });
});

describe("leaving: backups, GitHub's migration archive, Software Heritage, the layer", () => {
  test("backup with git: a mirror clone and a verified bundle; LFS when asked", () => {
    const lines = backupCommands(ADA);
    assert.equal(lines[0], "git clone --mirror 'https://github.com/ada/eeg.git' 'eeg.git'");
    assert.ok(lines.includes("git bundle create '../eeg.bundle' --all"));
    assert.ok(lines.includes("git bundle verify 'eeg.bundle'"));
    assert.ok(!commandText(lines).includes("lfs"));
    assert.ok(backupCommands(ADA, { lfs: true }).includes("git lfs fetch --all origin"));
  });

  test("GitHub's migration archive: the export options, the repository not locked", () => {
    const text = commandText(migrationArchiveCommands(ADA, { excludeReleases: true }));
    assert.match(text, /gh api --method POST \/user\/migrations -f 'repositories\[\]=ada\/eeg'/);
    assert.match(text, /-F lock_repositories=false/);
    assert.match(text, /-F exclude_releases=true/);
    for (const o of ["exclude_git_data", "exclude_metadata", "exclude_attachments", "exclude_owner_projects"]) assert.match(text, new RegExp(`-F ${o}=false`));
    assert.match(text, /\/user\/migrations\/\$MIGRATION_ID\/archive/);
    assert.ok(!/token|password/i.test(text));
  });

  test("Software Heritage: the vault's bare repository, pushed with --mirror", () => {
    const swhid = `swh:1:rev:${"a".repeat(40)}`;
    const lines = swhRestoreCommands(swhid, ADA);
    assert.ok(lines.includes(`curl -X POST 'https://archive.softwareheritage.org/api/1/vault/git-bare/${swhid}/'`));
    assert.equal(lines.at(-1), "git push --mirror 'https://github.com/ada/eeg.git'");
    assert.throws(() => swhRestoreCommands("swh:1:rev:xyz;id", ADA), TypeError);
  });

  test("the layer's export: the entry of the repository's static shard", async () => {
    const shard = await layerShard("Ada", "EEG");
    const entry = { mode: "public", papers: [{ doi: "10.5555/oscr.fixture.1" }] };
    const now = new Date("2026-09-28T12:00:00Z");
    assert.deepEqual(await layerExport({ owner: "Ada", name: "EEG" }, { "ada/eeg": entry, "ada/other": {} }, now), {
      repository: "Ada/EEG",
      exported_at: "2026-09-28T12:00:00.000Z",
      source: `/forge/layer/${shard}.json`,
      layer: entry,
    });
    assert.equal((await layerExport(ADA, {}, now)).layer, null);
    assert.equal((await layerExport(ADA, null, now)).layer, null);
    assert.equal((await layerExport({ owner: "a", name: "constructor" }, {}, now)).layer, null);
    await assert.rejects(layerExport({ owner: "a;b", name: "c" }, {}, now), TypeError);
  });
});

describe("the plan the import page shows", () => {
  test("a GitLab source: create empty with the papers, the mirror, then link", () => {
    const plan = mirrorPlan({ source: source("https://gitlab.com/lab/eeg"), owner: "ada", name: "eeg", lfs: true, papers: ["10.5555/oscr.fixture.1"] });
    assert.deepEqual(plan.dest, ADA);
    assert.equal(plan.createUrl, "/new/?name=eeg&description=Imported+from+gitlab.com%2Flab%2Feeg&paper=10.5555%2Foscr.fixture.1&readme=0");
    assert.equal(plan.linkUrl, "/new/link/?repo=ada%2Feeg&paper=10.5555%2Foscr.fixture.1");
    assert.deepEqual(plan.commands, mirrorCommands(source("https://gitlab.com/lab/eeg"), ADA, { lfs: true }));
    assert.equal(plan.ongoing, null);
    assert.equal(plan.linkInstead, null);
  });

  test("a GitHub source can be linked as it is; the ongoing mirror when asked", () => {
    const plan = mirrorPlan({ source: source("https://github.com/oscr-fixture/eeg-analysis"), owner: "ada", name: "eeg-copy", ongoing: true });
    assert.equal(plan.linkInstead, "/new/link/?repo=oscr-fixture%2Feeg-analysis");
    assert.deepEqual(plan.ongoing, ongoingMirrorCommands({ owner: "ada", name: "eeg-copy" }));
    assert.throws(() => mirrorPlan({ source: source("https://gitlab.com/lab/eeg"), owner: "a;b", name: "eeg" }), TypeError);
  });

  test("the steps of a record's import, and the layer's file name", () => {
    const steps = importSteps("ada", "eeg-code", [], "Imported from doi:10.5281/zenodo.1");
    assert.equal(steps.createUrl, "/new/?name=eeg-code&description=Imported+from+doi%3A10.5281%2Fzenodo.1&readme=0");
    assert.equal(steps.linkUrl, "/new/link/?repo=ada%2Feeg-code");
    assert.throws(() => importSteps("ada", "a b", [], ""), TypeError);
    assert.equal(layerFileName({ owner: "Ada", name: "EEG" }), "ada-eeg-layer.json");
    assert.throws(() => layerFileName({ owner: "..", name: "x" }), TypeError);
  });
});

describe("the three pages", () => {
  const page = (path: string) => readFileSync(new URL(`../../src/pages/${path}`, import.meta.url), "utf8");
  const script = readFileSync(new URL("../../src/scripts/import-repo.ts", import.meta.url), "utf8");
  /** The ids import-repo.ts reads, per page. */
  const IDS: Record<string, string[]> = {
    "new/import.astro": ["import-form", "import-owner", "import-name", "import-source", "import-lfs", "import-papers", "import-result", "import-commands", "import-link"],
    "hosting/import.astro": ["bulk-form", "bulk-owner", "bulk-list", "bulk-message", "bulk-errors", "bulk-result", "bulk-script", "bulk-download"],
    "hosting/leave.astro": [
      "leave-form", "leave-repo", "leave-lfs", "leave-message", "leave-result", "leave-backup", "leave-migration", "leave-settings",
      "leave-export", "leave-export-message",
    ],
  };

  test("each page holds the elements its script reads, and one script, a file of the site (no inline code)", () => {
    for (const [path, ids] of Object.entries(IDS)) {
      const html = page(path);
      for (const id of ids) {
        assert.ok(html.includes(`id="${id}"`), `${path}: #${id}`);
        assert.ok(script.includes(`"${id}"`), `import-repo.ts reads #${id}`);
      }
      const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
      assert.equal(scripts.length, 1, path);
      assert.equal(scripts[0][1], "", path);
      assert.match(scripts[0][2], /^\s*import "\.\.\/\.\.\/scripts\/import-repo";\s*$/, path);
      assert.ok(!/\son[a-z]+=/i.test(html), path);
      assert.ok(!/\sstyle=/i.test(html) && !/<style/i.test(html), path);
      // The forms are shown by the script: without it, the page's own text and commands stand.
      for (const form of html.matchAll(/<form id="([a-z-]+)"([^>]*)>/g)) assert.match(form[2], /\bhidden\b/, `${path}: #${form[1]}`);
      // No SSH address or anything shaped like an email address; the name of the platform from the configuration.
      assert.ok(!/[A-Za-z0-9._-]@[A-Za-z0-9-]+\./.test(html), path);
      assert.ok(!/\bOSCR\b/.test(html.replace(/^---[\s\S]*?---/, "")), path);
    }
  });

  test("the import guide names what the plan asks of it", () => {
    const html = page("hosting/import.astro");
    for (const phrase of [
      "Planning an import", "Trial imports", "git-sizer", "Migration logs, locks and aborting", "mannequins", "Commit attribution",
      "From GitLab", "Subversion", "git svn", "Mercurial", "hg-fast-export", "TFVC", "git-tfs", "Perforce", "git p4",
      "Large files before the first push", "git filter-repo", "subtree merge", "A copy without a fork, and an ongoing mirror",
      "Several repositories at once", "After the import", "topics", "licence", "When it goes wrong", "rulesets",
      "GitHub Enterprise Importer", "live migrations",
    ]) {
      assert.ok(html.includes(phrase), phrase);
    }
    // Its commands are the library's, with placeholders: the converters and the split each build at build time.
    for (const call of ["convertCommands({ kind: \"svn\"", "convertCommands({ kind: \"git-svn\"", "convertCommands({ kind: \"hg\"", "kind: \"tfvc\"", "kind: \"perforce\"", "splitCommands(", "subtreeCommands(", "ongoingMirrorCommands("]) {
      assert.ok(html.includes(call), call);
    }
  });

  test("the exit page names what the plan asks of it", () => {
    const html = page("hosting/leave.astro");
    for (const phrase of [
      "already in your own GitHub account", "unlink it from its papers", "ask for its layer to be deleted", "A complete backup with git",
      "bundle", "migration archive", "The registry's layer", "as JSON", "figshare", "Restoring from Software Heritage",
    ]) {
      assert.ok(html.includes(phrase), phrase);
    }
    assert.ok(html.includes("GRACE_SECONDS"), "the grace period comes from the caps");
  });
});
