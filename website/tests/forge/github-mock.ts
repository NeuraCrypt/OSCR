// Test support for the GitHub adapter (worker/forge/github/): a fetch that records every request
// and answers from routes, and answers shaped like GitHub's documented ones. The fixtures carry
// `email` fields on purpose (commit authors, users, pushers): no returned object may keep one.

export interface Recorded {
  method: string;
  url: URL;
  headers: Headers;
  /** The body as text ("" when none; a form or JSON as sent). */
  body: string;
  bytes: Uint8Array | null;
  init: RequestInit & { duplex?: string };
}

type Reply = Response | ((req: Recorded) => Response | Promise<Response>);

export class MockFetch {
  calls: Recorded[] = [];
  private routes: { method: string; path: string | RegExp; reply: Reply; times: number }[] = [];
  /** Answer anything unrouted with this, instead of failing the test. */
  fallback: Reply | null = null;

  /** Answer `method path` (the URL's path, or a pattern over path + query) with `reply`, `times`
   *  times (default: always). */
  on(method: string, path: string | RegExp, reply: Reply, times = Infinity): this {
    this.routes.push({ method, path, reply, times });
    return this;
  }

  readonly fetch: typeof fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    let body = "";
    let bytes: Uint8Array | null = null;
    const b = init.body;
    if (typeof b === "string") body = b;
    else if (b instanceof URLSearchParams) body = b.toString();
    else if (b instanceof Uint8Array) {
      bytes = b;
      body = new TextDecoder().decode(b);
    } else if (b instanceof ReadableStream) {
      const parts: Uint8Array[] = [];
      const reader = b.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value as Uint8Array);
      }
      const n = parts.reduce((s, p) => s + p.length, 0);
      bytes = new Uint8Array(n);
      let at = 0;
      for (const p of parts) {
        bytes.set(p, at);
        at += p.length;
      }
      body = new TextDecoder().decode(bytes);
    }
    const req: Recorded = { method, url, headers, body, bytes, init: init as Recorded["init"] };
    this.calls.push(req);
    const target = url.pathname + url.search;
    const route = this.routes.find((r) => r.method === method && r.times > 0 && (typeof r.path === "string" ? r.path === url.pathname : r.path.test(target)));
    if (!route) {
      if (this.fallback) return typeof this.fallback === "function" ? this.fallback(req) : this.fallback.clone();
      throw new Error(`unrouted ${method} ${url.href}`);
    }
    route.times--;
    return typeof route.reply === "function" ? route.reply(req) : route.reply.clone();
  };

  last(): Recorded {
    const c = this.calls[this.calls.length - 1];
    if (!c) throw new Error("no request");
    return c;
  }

  json(i = this.calls.length - 1): Record<string, unknown> {
    return JSON.parse(this.calls[i].body) as Record<string, unknown>;
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
}

export function raw(body: string | Uint8Array, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body as BodyInit, { status, headers: { "Content-Type": "application/vnd.github.raw", ...headers } });
}

export const SHA = (n: number | string): string => String(n).padStart(40, "0").slice(-40).replace(/[^0-9a-f]/g, "a");
export const EMAIL = "private.person@example.org";

export function ghUser(login = "ada", id = 101, type = "User"): Record<string, unknown> {
  return { login, id, node_id: `U_${id}`, type, site_admin: false, email: EMAIL, html_url: `https://github.com/${login}` };
}

export function ghRepo(o: Partial<{ owner: string; name: string; id: number; private: boolean; archived: boolean; default_branch: string | null; parent: unknown; permissions: unknown; ownerType: string }> = {}): Record<string, unknown> {
  const owner = o.owner ?? "ada";
  const name = o.name ?? "compendium";
  return {
    id: o.id ?? 5001,
    node_id: `R_${o.id ?? 5001}`,
    name,
    full_name: `${owner}/${name}`,
    owner: ghUser(owner, owner === "ada" ? 101 : 202, o.ownerType ?? "User"),
    private: o.private ?? false,
    visibility: o.private ? "private" : "public",
    html_url: `https://github.com/${owner}/${name}`,
    clone_url: `https://github.com/${owner}/${name}.git`,
    description: "Code of the paper",
    homepage: null,
    topics: ["neuroscience"],
    license: { key: "mit", spdx_id: "MIT", name: "MIT License" },
    size: 42,
    archived: o.archived ?? false,
    disabled: false,
    is_template: false,
    default_branch: o.default_branch === undefined ? "main" : o.default_branch,
    has_issues: true,
    has_wiki: false,
    allow_auto_merge: false,
    delete_branch_on_merge: true,
    created_at: "2026-01-02T03:04:05Z",
    pushed_at: "2026-09-01T00:00:00Z",
    ...(o.parent ? { parent: o.parent } : {}),
    ...(o.permissions ? { permissions: o.permissions } : {}),
  };
}

export function ghCommit(sha: string, o: Partial<{ parents: string[]; message: string; login: string | null }> = {}): Record<string, unknown> {
  const account = o.login === null ? null : ghUser(o.login ?? "ada");
  return {
    sha,
    node_id: `C_${sha.slice(0, 8)}`,
    commit: {
      author: { name: "Ada Lovelace", email: EMAIL, date: "2026-09-01T10:00:00Z" },
      committer: { name: "GitHub", email: "noreply@github.com", date: "2026-09-01T10:00:01Z" },
      message: o.message ?? "Fit the model\n\nSigned-off-by: Ada Lovelace <ada@example.org>",
      tree: { sha: SHA("7ee") },
      verification: { verified: true, reason: "valid" },
    },
    author: account,
    committer: ghUser("web-flow", 19864447),
    parents: (o.parents ?? [SHA("aaa1")]).map((p) => ({ sha: p, url: "https://api.github.com/x" })),
  };
}

export function ghFile(filename: string, status = "modified", extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { sha: SHA("b10b"), filename, status, additions: 2, deletions: 1, changes: 3, patch: "@@ -1 +1 @@\n-a\n+b", ...extra };
}

export function ghPull(number = 7, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 90007,
    node_id: "PR_kwDO7",
    number,
    title: "Add the sensitivity analysis",
    body: "Fixes #3",
    state: "open",
    draft: false,
    merged: false,
    merged_at: null,
    merge_commit_sha: SHA("m3"),
    user: ghUser("bo", 303),
    created_at: "2026-09-02T00:00:00Z",
    updated_at: "2026-09-03T00:00:00Z",
    closed_at: null,
    head: { ref: "sensitivity", sha: SHA("11"), repo: ghRepo({ owner: "bo", name: "compendium", id: 5002 }), user: ghUser("bo", 303) },
    base: { ref: "main", sha: SHA("22"), repo: ghRepo(), user: ghUser() },
    mergeable: true,
    mergeable_state: "clean",
    requested_reviewers: [ghUser("cy", 404)],
    labels: [{ id: 1, name: "analysis", color: "0e8a16", description: "" }],
    assignees: [ghUser()],
    milestone: { number: 2, title: "Revision 1", state: "open", open_issues: 1, closed_issues: 0, description: null, due_on: null },
    auto_merge: null,
    maintainer_can_modify: true,
    commits: 2,
    additions: 10,
    deletions: 3,
    changed_files: 2,
    comments: 1,
    review_comments: 2,
    ...extra,
  };
}

export function ghIssue(number = 3, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 80003,
    node_id: "I_kwDO3",
    number,
    title: "Figure 2 does not reproduce",
    body: "With seed 42. Write to someone@example.org",
    state: "open",
    state_reason: null,
    user: ghUser("cy", 404),
    labels: [{ id: 1, name: "reproduction", color: "ff0000", description: "" }],
    assignees: [ghUser()],
    milestone: null,
    locked: false,
    active_lock_reason: null,
    comments: 2,
    reactions: { url: "x", total_count: 3, "+1": 2, "-1": 0, laugh: 0, hooray: 0, confused: 0, heart: 1, rocket: 0, eyes: 0 },
    sub_issues_summary: { total: 2, completed: 1, percent_completed: 50 },
    created_at: "2026-09-02T00:00:00Z",
    updated_at: "2026-09-03T00:00:00Z",
    closed_at: null,
    ...extra,
  };
}

export function ghRelease(id = 60001, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    tag_name: "v1.0.0",
    target_commitish: "main",
    name: "Version of the paper",
    body: "As published",
    draft: false,
    prerelease: false,
    immutable: false,
    author: ghUser(),
    created_at: "2026-09-04T00:00:00Z",
    published_at: "2026-09-04T00:00:01Z",
    html_url: "https://github.com/ada/compendium/releases/tag/v1.0.0",
    assets: [ghAsset()],
    ...extra,
  };
}

export function ghAsset(id = 70001): Record<string, unknown> {
  return {
    id,
    name: "results.csv",
    label: "Results",
    content_type: "text/csv",
    size: 12,
    download_count: 5,
    browser_download_url: "https://github.com/ada/compendium/releases/download/v1.0.0/results.csv",
    created_at: "2026-09-04T00:00:02Z",
    uploader: ghUser(),
  };
}

export function ghCheckRun(id = 40001, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: "Tracing map",
    head_sha: SHA("11"),
    status: "completed",
    conclusion: "neutral",
    started_at: "2026-09-05T00:00:00Z",
    completed_at: "2026-09-05T00:00:05Z",
    details_url: "https://registry.example/maps/1",
    app: { slug: "code-registry", id: 1 },
    output: { title: "2 traced lines changed", summary: "…", annotations_count: 1 },
    ...extra,
  };
}

/** Every key named like an email field, anywhere. */
export function emailKeys(v: unknown, path = "$", out: string[] = []): string[] {
  if (v instanceof Uint8Array || v === null || typeof v !== "object") return out;
  if (Array.isArray(v)) v.forEach((x, i) => emailKeys(x, `${path}[${i}]`, out));
  else {
    for (const [k, x] of Object.entries(v)) {
      if (/e-?mail/i.test(k)) out.push(`${path}.${k}`);
      emailKeys(x, `${path}.${k}`, out);
    }
  }
  return out;
}
