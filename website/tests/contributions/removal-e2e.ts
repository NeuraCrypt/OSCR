// The removal request end to end, in a real browser (headless Chrome, driven by chrome.ts), against
// `wrangler dev --env local` and the mocks of tests/account/e2e.sh: the page /removal/?paper=… signed
// out; the sign-in, which comes back to it; the form and its own checks; the review, where nothing has
// been sent yet; "Confirm and send" and the receipt. Then, after the Mac's `oscr jobs poll --local` and
// the Mac's poll, whose rules apply a verified author's request at once (oscr/moderation.py; e2e.sh),
// the accepted request with the rules' words, on the page and on the account page.
//
//   node --experimental-strip-types tests/contributions/removal-e2e.ts ask
//   node --experimental-strip-types tests/contributions/removal-e2e.ts decided
//
// SITE, MOCK: the servers; CDP_PORT: Chrome's DevTools port (e2e.sh starts it, every outside address
// blocked); SCREENS: a folder for the screenshots, at 1280×860 and 390×844 (none when unset);
// REMOVAL_STATE: a file the two steps share (the request's number). Exits 1 on a failure.
import { readFileSync, writeFileSync } from "node:fs";
import { openPage, type Page } from "./chrome.ts";

const SITE = process.env.SITE ?? "http://localhost:8792";
const MOCK = process.env.MOCK ?? "http://127.0.0.1:9492";
const CDP = Number(process.env.CDP_PORT ?? 9397);
const SCREENS = process.env.SCREENS ?? "";
const STATE = process.env.REMOVAL_STATE ?? "/tmp/oscr-e2e-removal.json";
const step = process.argv[2] ?? "ask";

const ADA = "0000-0000-0000-001X";
const P1 = "doi:10.5555/oscr.fixture.1";
const EEG = "github.com/oscr-fixture/eeg-analysis";
const PAGE = `${SITE}/removal/?paper=${encodeURIComponent(P1)}`;
const JUSTIFICATION =
  "The file plot.py reproduces a figure script that a publisher's agreement keeps private: the repository was opened by mistake, " +
  "and its history still holds it. The rest of the code may stay.";

let failures = 0;
function check(name: string, ok: boolean, detail: unknown = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail !== "" ? `, ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const visible = (id: string) => `(() => { const e = document.getElementById(${JSON.stringify(id)}); return !!e && !e.closest("[hidden]"); })()`;
const text = (p: Page, id: string) => p.evaluate<string>(`document.getElementById(${JSON.stringify(id)})?.textContent ?? ""`);

/** The page as it is, at a desktop's size and at a phone's. */
async function shots(p: Page, name: string): Promise<void> {
  if (!SCREENS) return;
  await sleep(200);
  await p.screenshot(`${SCREENS}/removal-${name}-desktop.png`);
  await p.viewport(390, 844, true);
  await sleep(300);
  await p.screenshot(`${SCREENS}/removal-${name}-phone.png`);
  await p.viewport(1280, 860);
  await sleep(200);
}

async function choose(p: Page, id: string, value: string): Promise<void> {
  await p.evaluate(
    `(() => { const s = document.getElementById(${JSON.stringify(id)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event("change", { bubbles: true })); })()`,
  );
}

async function ask(p: Page): Promise<void> {
  // No paper named, a paper read without a page: said, with the way to name another.
  await p.navigate(`${SITE}/removal/`);
  await p.waitFor(visible("removal-find"));
  check("no paper named: the DOI asked for", (await text(p, "removal-facts")).startsWith("Name the paper"));
  await p.navigate(`${SITE}/removal/?paper=10.5555/oscr.fixture.5`);
  await p.waitFor(visible("removal-find"));
  const none = await text(p, "removal-facts");
  check("a paper without a page: nothing to remove, said", none.includes("read this paper") && none.includes("no page"), none);
  check("a paper without a page: no sign-in asked", !(await p.evaluate<boolean>(visible("removal-signed-out"))));

  // Signed out: the paper, and the ways to sign in, each coming back here.
  await p.navigate(PAGE);
  await p.waitFor(visible("removal-signed-out"));
  check("signed out: the paper is named", (await text(p, "removal-facts")).includes("A synthetic EEG study for the OSCR build test"));
  const back = await p.evaluate<string>(`document.querySelector('#removal-sign-in a[data-provider="orcid"]').href`);
  check("signed out: sign-in returns to this page", back.endsWith(`return=${encodeURIComponent(`/removal/?paper=${encodeURIComponent(P1)}`)}`), back);
  check("signed out: no form", !(await p.evaluate<boolean>(visible("removal-form"))));
  await shots(p, "signed-out");

  // Signed in with ORCID: back on the same page, the form ready, the author recognized.
  await fetch(`${MOCK}/control`, { method: "POST", body: JSON.stringify({ who: { orcid: { sub: ADA, name: "Ada Fixture" } } }) });
  await p.click('#removal-sign-in a[data-provider="orcid"]');
  await p.waitFor(`location.pathname === "/removal/" && ${visible("removal-form")}`);
  const where = await p.evaluate<string>("location.pathname + location.search");
  check("after sign-in: the same page, its query cleaned", where === `/removal/?paper=${encodeURIComponent(P1)}`, where);
  check("after sign-in: said", (await text(p, "removal-message")).includes("signed in with ORCID"));
  check("signed in: who", (await text(p, "removal-who")).includes("Ada Fixture"));
  check("an author, verified", (await text(p, "removal-author-note")).includes("verified"));

  // The form's own checks, before any review.
  await p.click('#removal-form button[type="submit"]');
  await p.waitFor(visible("removal-form-error"));
  check("nothing chosen: said", (await text(p, "removal-form-error")).startsWith("Say who you are"));
  await p.click("#role-author");
  await p.click("#scope-file");
  await choose(p, "removal-file-repo", EEG);
  await choose(p, "removal-file", "plot.py");
  await p.click("#reason-copyright");
  await p.type("#removal-details", `${JUSTIFICATION} Write to ada.fixture@lab.example.org.`);
  await p.type("#removal-evidence", "https://lab.example/agreement");
  await p.click("#removal-confirm-accurate");
  await p.click("#removal-confirm-review");
  await p.click('#removal-form button[type="submit"]');
  await p.waitFor(`document.getElementById("removal-form-error").textContent.includes("email address")`);
  check("an email address: refused, in words", (await text(p, "removal-form-error")).includes("remove it"));
  await p.type("#removal-details", JUSTIFICATION);
  check("the count", (await text(p, "removal-details-count")).includes("characters of 2,000"));
  byStep = "form";
  await shots(p, "form");

  // The review: everything, and nothing sent yet.
  await p.click('#removal-form button[type="submit"]');
  await p.waitFor(visible("removal-review"));
  const review = await text(p, "removal-review-summary");
  check("review: what, where, why", review.includes("One file: plot.py, in github.com/oscr-fixture/eeg-analysis") && review.includes("Copyright or license"), review);
  check("review: the evidence and the confirmations", review.includes("https://lab.example/agreement") && review.includes("you read how requests are decided"));
  const before = await p.evaluate<{ report: unknown }>(`fetch("/api/contributions/paper?id=${encodeURIComponent(P1)}").then((r) => r.json())`);
  check("review: nothing sent yet", before.report === null, before.report);
  byStep = "review";
  await shots(p, "review");

  // Back to the form keeps what was typed; then confirm and send.
  await p.click("#removal-back");
  await p.waitFor(visible("removal-form"));
  check("back: the form as it was", (await p.evaluate<string>(`document.getElementById("removal-details").value`)) === JUSTIFICATION);
  await p.click('#removal-form button[type="submit"]');
  await p.waitFor(visible("removal-review"));
  await p.click("#removal-send");
  await p.waitFor(visible("removal-receipt"));
  const receipt = await text(p, "removal-receipt-summary");
  const id = Number(/^RequestNo\. (\d+)/.exec(receipt)?.[1] ?? 0);
  check("receipt: said, with what the rules will do", (await text(p, "removal-receipt-state")).startsWith("Your request is sent. The registry's rules apply it without waiting, as a request from a verified author of the paper"));
  check("receipt: its number and status", id > 0 && receipt.includes("StatusOpen: the registry's rules decide it within minutes"), receipt);
  check("receipt: when a decision takes effect", receipt.includes("the nightly publication (04:17, the registry's local time) that follows, the copy of plot.py leaves"), receipt);
  byStep = "receipt";
  await shots(p, "receipt");
  writeFileSync(STATE, JSON.stringify({ id }));
  console.log(`request ${id}`);
}

async function decided(p: Page): Promise<void> {
  const { id } = JSON.parse(readFileSync(STATE, "utf8")) as { id: number };
  await p.navigate(PAGE);
  await p.waitFor(visible("removal-request"));
  check("revisited: accepted", (await text(p, "removal-request-state")) === "Your request was accepted.");
  const state = await text(p, "removal-request-summary");
  check("revisited: its status, with the rules' words", state.includes("StatusAccepted on") && state.includes("The decision's words“Applied at once, as a request from a verified author of the paper"), state);
  check("revisited: when it takes effect", state.includes("Takes effectAt the nightly publication (04:17"), state);
  check("revisited: its number", (await text(p, "removal-request-title")) === `Your request No. ${id}`);
  check("decided: no form", !(await p.evaluate<boolean>(visible("removal-form"))));
  byStep = "accepted";
  await shots(p, "accepted");
  await p.navigate(`${SITE}/account/`);
  await p.waitFor(`document.querySelectorAll("#reports li").length > 0`);
  const items = await p.evaluate<{ text: string; href: string }[]>(
    `[...document.querySelectorAll("#reports li")].map((li) => ({ text: li.textContent, href: li.querySelector("a")?.getAttribute("href") ?? "" }))`,
  );
  const mine = items.find((i) => i.text.startsWith(`Request No. ${id}:`));
  check("the account page lists it, with its page", !!mine && mine.href === `/removal/?paper=${encodeURIComponent(P1)}` && mine.text.includes("accepted"), items);
}

let byStep = "";
const page = await openPage(CDP, 1280, 860);
try {
  if (step === "ask") await ask(page);
  else await decided(page);
} catch (e) {
  check(`the ${step} step ran to its end${byStep ? ` (after ${byStep})` : ""}`, false, String((e as Error).message ?? e));
}
// A shard of records that holds no paper is not written (the fixture has none rendered on demand): the
// page reads the record first, then the static page; that 404 is the answer, not an error.
const errors = page.errors.filter((e) => !/status of 404 .*\/records\/paper\/[0-9a-f]{2}\.json$/.test(e));
check("the pages' scripts: no error", errors.length === 0, errors);
await page.close();
console.log(failures ? `${failures} FAILED` : `removal ${step}: every check passed`);
process.exit(failures ? 1 : 0);
