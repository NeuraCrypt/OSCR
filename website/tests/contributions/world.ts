// Test support: the accounts' world (a fresh database, the mock providers, a browser) with the places
// the contributions' checks ask (places.ts) behind the same `fetch`, and the fixture's facts: Ada
// (ORCID 0000-0000-0000-001X) is an author of papers 1 and 3, the repository
// github.com/oscr-fixture/eeg-analysis is paper 1's code.
import { world, type Browser, type World } from "../account/browser.ts";
import { addFacts } from "../account/d1.ts";
import { MockPlaces } from "./places.ts";

export const ADA = "0000-0000-0000-001X";
export const BEN = "0000-0000-0000-0028";
export const P1 = "doi:10.5555/oscr.fixture.1";
export const P2 = "doi:10.5555/oscr.fixture.2";
export const P3 = "doi:10.5555/oscr.fixture.3";
export const EEG = "github.com/oscr-fixture/eeg-analysis";
export const UNLICENSED = "github.com/oscr-fixture/unlicensed";
/** A 64-hex map digest, as the paper's page carries it. */
export const DIGEST = "ab".repeat(32);

export interface Contributions extends World {
  places: MockPlaces;
}

export function contributions(overrides: Parameters<typeof world>[0] = {}): Contributions {
  const w = world(overrides);
  const providers = globalThis.fetch;
  const places = new MockPlaces();
  places.dois.add("10.5555/oscr.fixture.1").add("10.5555/oscr.fixture.7").add("10.5555/oscr.fixture.8");
  places.page("https://github.com/oscr-fixture/eeg-analysis").page("https://github.com/oscr-fixture/new-code");
  places.page("https://zenodo.org/records/1234567").page("https://openneuro.org/datasets/ds000117");
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).hostname === "providers.test") return providers(request);
    return places.answer(request.method, request.url);
  }) as typeof fetch;
  addFacts(w.db, {
    papers: [
      [ADA, P1, "doi_10.5555_oscr.fixture.1", "A synthetic EEG study for the OSCR build test"],
      [BEN, P1, "doi_10.5555_oscr.fixture.1", "A synthetic EEG study for the OSCR build test"],
      [BEN, P2, "doi_10.5555_oscr.fixture.2", "A synthetic study whose code has no license"],
      [ADA, P3, "doi_10.5555_oscr.fixture.3", "A synthetic study with code on request"],
    ],
    repos: [
      [EEG, "github.com", "oscr-fixture"],
      [UNLICENSED, "github.com", "oscr-fixture"],
    ],
    paperRepos: [
      [EEG, P1],
      [UNLICENSED, P2],
    ],
  });
  return { ...w, places };
}

/** Ada, signed in with ORCID: a verified author of papers 1 and 3. */
export async function ada(w: World): Promise<Browser> {
  const b = w.browser();
  await b.signIn("orcid");
  return b;
}

/** Ben, signed in with GitHub only (no ORCID iD): no paper of his is verified. */
export async function benOnGithub(w: World): Promise<Browser> {
  w.mock.who.github = { id: 5_150_001, login: "ben-example", name: "Ben Example" };
  const b = w.browser();
  await b.signIn("github");
  return b;
}

/** The JSON of an answer. */
// deno-lint-ignore no-explicit-any
export async function body(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, unknown>;
}
