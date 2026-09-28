// Test support: the places the Worker's checks ask (worker/contributions/checks.ts) — the DOI proxy's
// handle API and the pages of forges and archives. The unit tests install it as `fetch` beside the
// mock providers (world.ts); the end-to-end run serves it over HTTP under /checks/
// (tests/account/mock-server.ts), where the Worker's CHECKS_URL points.

export interface Asked {
  method: string;
  url: string;
}

export class MockPlaces {
  /** The DOIs that are registered, lower case. */
  dois = new Set<string>();
  /** The pages that exist ("https://github.com/owner/name"), with the status they answer. Any other
   *  page answers 404. */
  pages = new Map<string, number>();
  /** Places that refuse HEAD (405): the check asks again with GET. */
  noHead = new Set<string>();
  /** Places that do not answer at all (the check's request fails, as on a timeout). */
  silent = new Set<string>();
  log: Asked[] = [];

  /** A page that exists (200 unless said otherwise). */
  page(url: string, status = 200): this {
    this.pages.set(url, status);
    return this;
  }

  /** The answer to a request for `url` (the real address the Worker checks). */
  answer(method: string, url: string): Response {
    this.log.push({ method, url });
    const u = new URL(url);
    const place = `${u.origin}${u.pathname}`;
    if (this.silent.has(place) || this.silent.has(u.origin)) throw new TypeError("fetch failed: the place did not answer");
    const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (u.hostname === "doi.org" && u.pathname.startsWith("/api/handles/")) {
      const doi = decodeURIComponent(u.pathname.slice("/api/handles/".length)).toLowerCase();
      return this.dois.has(doi)
        ? json({ responseCode: 1, handle: doi, values: [{ index: 1, type: "URL", data: { format: "string", value: "https://publisher.example/x" } }] }, 200)
        : json({ responseCode: 100, handle: doi }, 404);
    }
    if (method === "HEAD" && (this.noHead.has(place) || this.noHead.has(u.origin))) return new Response(null, { status: 405 });
    const status = this.pages.get(place) ?? this.pages.get(place.replace(/\/$/, "")) ?? 404;
    return new Response(method === "HEAD" ? null : "<!doctype html><title>a page</title>", { status, headers: { "Content-Type": "text/html" } });
  }

  /** The requests the Worker made (method and address). */
  asked(): string[] {
    return this.log.map((l) => `${l.method} ${l.url}`);
  }

  /** The end-to-end run's form: http://127.0.0.1:<port>/checks/<host>/<path> → https://<host>/<path>. */
  answerMapped(method: string, url: string, prefix = "/checks/"): Response {
    const u = new URL(url);
    return this.answer(method, `https://${u.pathname.slice(prefix.length)}${u.search}`);
  }
}

/** The Zenodo sandbox as the Mac's job runner reaches it (oscr/zenodo.py, `OSCR_ZENODO_SANDBOX_URL`),
 *  for the end-to-end run: an InvenioRDM in miniature under /zenodo/, which records the deposits and
 *  answers with test DOIs (10.5072/…). Nothing reaches the real sandbox. */
export class MockZenodo {
  deposits: { metadata: Record<string, unknown>; map?: Record<string, unknown> }[] = [];
  calls: string[] = [];
  private n = 0;
  base: string;
  constructor(base: string) {
    this.base = base;
  }

  async handle(request: Request): Promise<Response> {
    const u = new URL(request.url);
    const path = u.pathname.replace(/^\/zenodo/, "");
    this.calls.push(`${request.method} ${path}`);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (!/^Bearer \S+/.test(request.headers.get("Authorization") ?? "") && request.method !== "GET") return json({ message: "no token" }, 401);
    const record = (id: string) => ({
      id,
      pids: { doi: { identifier: `10.5072/zenodo.${id}` } },
      parent: { pids: { doi: { identifier: `10.5072/zenodo.${id}0` } } },
      links: { self_html: `${this.base}/records/${id}` },
    });
    if (request.method === "POST" && path === "/api/records") {
      this.n += 1;
      this.deposits.push({ metadata: ((await request.json()) as { metadata: Record<string, unknown> }).metadata });
      return json({ id: `${900000 + this.n}` }, 201);
    }
    if (request.method === "POST" && /^\/api\/records\/[^/]+\/versions$/.test(path)) {
      this.n += 1;
      return json({ id: `${900000 + this.n}` }, 201);
    }
    if (request.method === "PUT" && /\/draft$/.test(path)) {
      this.deposits.push({ metadata: ((await request.json()) as { metadata: Record<string, unknown> }).metadata });
      return json({ id: path.split("/")[3] });
    }
    if (request.method === "PUT" && /\/content$/.test(path)) {
      const last = this.deposits[this.deposits.length - 1];
      if (last) last.map = JSON.parse(await request.text()) as Record<string, unknown>;
      return json({});
    }
    if (request.method === "GET" && path.startsWith("/api/communities/")) return json({ id: "community-uuid", slug: path.split("/")[3] });
    if (path.endsWith("/submit-review")) return json({ id: "request-1" });
    if (path.endsWith("/actions/publish")) return json(record(path.split("/")[3]), 202);
    if (request.method === "GET" && path.startsWith("/api/records/")) return json(record(path.split("/")[3]));
    return json({});
  }
}
