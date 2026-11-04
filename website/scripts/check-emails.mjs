// No email address in the built site (CLAUDE.md), checked on its own: the nightly runs it after the
// build and before `wrangler deploy` (oscr/publish.py), so a page or a record that holds an address
// never goes online. The same rule as the check's step 5 (scripts/check.mjs, src/lib/emails.ts).
//
//   npm run check:emails     after `npm run build`; exits 1 and names each file that holds one
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkedText, EMAIL_ON_PAGE } from "../src/lib/emails.ts";

const DIST = "dist";
if (!existsSync(DIST)) {
  console.error("No dist/: run `npm run build` first.");
  process.exit(1);
}
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const problems = [];
for (const path of walk(DIST)) {
  const f = path.slice(DIST.length).split("\\").join("/");
  if (!/\.(html|json)$/.test(f) || f.startsWith("/scripts/")) continue;
  const m = checkedText(readFileSync(path, "utf8")).match(EMAIL_ON_PAGE);
  if (m) problems.push(`${f}: an email address (${m[0]})`);
}
for (const p of problems) console.error(`FAIL ${p}`);
console.log(problems.length ? `${problems.length} files hold an email address: not deployed.` : "No email address in the built site.");
process.exit(problems.length ? 1 : 0);
