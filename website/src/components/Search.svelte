<script lang="ts">
  // The search page's island. The page is static; this component reads the address, and runs
  // a search only when a search was asked for: the form submitted, a facet, a page or a
  // shared address followed. Never as one types (the owner's decision D3). Every search is one
  // request to /api/search; the address says it all (/search/?q=…&modality=eeg&sort=newest), so
  // it can be shared, and Back and Forward replay it.
  //
  // Markup only, science.css's: the results as the catalogue lists papers (dl.listing, h2.day
  // when sorted by date), the facets in the .sidebar of a .record. Like every browser script,
  // it never names the platform.
  //
  // `labels`: the names of the category values, as the Browse pages show them (facet → value →
  // name, built with the page from the export's categories); a value without one is shown as is.
  import { onMount } from "svelte";
  import { FACET_BY_PARAM, FACETS } from "../lib/facets.ts";
  import { dateInWords, dayInWords, number, plural } from "../lib/format.ts";
  import { type Field, fielded, highlight, parseQuery, titleTerms } from "../lib/query.ts";
  import { STATUSES, status } from "../lib/status.ts";

  type Doc = {
    slug: string;
    doi: string;
    title: string;
    journal: string;
    published: string;
    status: string;
    code: { name: string; url: string; license: string }[];
    data: number;
    files: number;
    pairs: number;
    map?: string;
    cited?: number | null;
  };
  type Answer = {
    results: Doc[];
    total: number;
    complete: boolean;
    window: number;
    pages: number;
    facets: Record<string, [string, number][]>;
    facets_scope: "results" | "window" | "catalogue" | "none";
    notices: string[];
    query: { q: string; sort: string; page: number; size: number };
  };
  type Failure = { code: string; message: string };
  type State = { q: string; filters: [string, string][]; from: string; to: string; sort: string; page: number };

  /** "" lets the search choose: relevance when words are searched, else the newest first. */
  const SORTS: [string, string][] = [
    ["", "Relevance"],
    ["newest", "Newest first"],
    ["oldest", "Oldest first"],
    ["cited", "Most cited"],
  ];
  const ORDERS: Record<string, string> = {
    relevance: "the most relevant first",
    newest: "the newest first",
    oldest: "the oldest first",
    cited: "the most cited first",
  };
  /** The masthead's "where to search" (layouts/Base.astro): a field of the query language. */
  const MASTHEAD_FIELDS: Record<string, Field> = {
    title: "title", author: "author", journal: "journal", doi: "id", repo: "repo", tool: "tool",
  };
  const FAILURES: Record<string, string> = {
    quota: "The search has used its daily quota: it runs on a free plan, with a fixed number of searches a day. Please try again tomorrow.",
    unavailable: "The search is unavailable at the moment. Please try again later.",
    not_configured: "The search is not available yet.",
  };

  let { labels = {} }: { labels?: Record<string, Record<string, string>> } = $props();

  let current: State = $state({ q: "", filters: [], from: "", to: "", sort: "", page: 1 });
  let q = $state("");
  let sort = $state("");
  let answer: Answer | null = $state(null);
  let failure: Failure | null = $state(null);
  let loading = $state(false);
  let asked = 0;
  let advancedOpen = $state(false);
  let adv = $state({
    all: "", phrase: "", any: "", none: "", title: "", author: "", journal: "", tool: "", keyword: "", repo: "",
    id: "", from: "", to: "", status: "",
  });

  const terms = $derived(titleTerms(parseQuery(answer?.query.q ?? "").node));
  const byDate = $derived(answer !== null && (answer.query.sort === "newest" || answer.query.sort === "oldest"));
  const hasFilters = $derived(current.filters.length > 0 || current.from !== "" || current.to !== "");

  /** The address of a search: the canonical order, no default values. */
  function params(s: State, extra: Record<string, string> = {}): URLSearchParams {
    const p = new URLSearchParams();
    if (s.q) p.set("q", s.q);
    for (const f of FACETS) for (const [param, v] of s.filters) if (param === f.param) p.append(param, v);
    if (s.from) p.set("from", s.from);
    if (s.to) p.set("to", s.to);
    if (s.sort) p.set("sort", s.sort);
    if (s.page > 1) p.set("page", String(s.page));
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return p;
  }
  const pageUrl = (s: State) => {
    const p = params(s).toString();
    return p ? `/search/?${p}` : "/search/";
  };
  const apiUrl = (s: State, extra: Record<string, string> = {}) => `/api/search?${params(s, extra)}`;

  function readAddress(): State {
    const p = new URLSearchParams(location.search);
    let text = (p.get("q") ?? "").trim();
    const field = MASTHEAD_FIELDS[p.get("field") ?? ""];
    if (field && text) text = fielded(field, text);
    const filters: [string, string][] = [];
    for (const f of FACETS) for (const v of p.getAll(f.param)) if (v.trim()) filters.push([f.param, v.trim()]);
    const page = Number(p.get("page") ?? "1");
    return {
      q: text,
      filters,
      from: (p.get("from") ?? "").trim(),
      to: (p.get("to") ?? "").trim(),
      sort: p.get("sort") ?? "",
      page: Number.isInteger(page) && page > 0 ? page : 1,
    };
  }

  /** Whether the address asks for a search: /search/ alone shows the form only. */
  const asksSearch = () => location.search.length > 1;

  async function run(s: State) {
    const n = ++asked;
    current = s;
    q = s.q;
    sort = s.sort;
    loading = true;
    failure = null;
    try {
      const res = await fetch(apiUrl(s), { headers: { Accept: "application/json" } });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      if (n !== asked) return;
      const error = (body as { error?: Failure } | null)?.error;
      if (!res.ok || error || body === null) {
        // Cloudflare answers 429, in HTML, once the Workers' daily requests are spent.
        const code = error?.code ?? (res.status === 429 ? "quota" : "unavailable");
        failure = { code, message: error?.message ?? "" };
        answer = null;
      } else {
        answer = body as Answer;
      }
    } catch {
      if (n !== asked) return;
      failure = { code: "unavailable", message: "" };
      answer = null;
    } finally {
      if (n === asked) loading = false;
    }
  }

  function go(s: State, replace = false) {
    const url = pageUrl(s);
    if (replace) history.replaceState(null, "", url);
    else history.pushState(null, "", url);
    void run(s);
    // A new page of results starts at the results.
    if (!replace) document.getElementById("results")?.scrollIntoView({ block: "start" });
  }

  /** A link that is also a search: followed in place, or opened elsewhere as usual. */
  function follow(ev: MouseEvent, s: State) {
    if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    ev.preventDefault();
    go(s);
  }

  function submit(ev: SubmitEvent) {
    ev.preventDefault();
    go({ ...current, q: q.trim(), sort, page: 1 });
  }

  /** The advanced form writes a query in the query language, into the main field. */
  function built(): string {
    const parts: string[] = [];
    const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);
    if (adv.all.trim()) parts.push(adv.all.trim());
    if (adv.phrase.trim()) parts.push(`"${adv.phrase.replace(/"/g, " ").trim()}"`);
    const any = words(adv.any);
    if (any.length) parts.push(any.length > 1 ? `(${any.join(" OR ")})` : any[0]);
    for (const w of words(adv.none)) parts.push(`-${w}`);
    const fields: [keyof typeof adv, Field][] = [
      ["title", "title"], ["author", "author"], ["journal", "journal"], ["tool", "tool"], ["repo", "repo"], ["id", "id"],
    ];
    for (const [key, field] of fields) if (adv[key].trim()) parts.push(fielded(field, adv[key]));
    if (adv.keyword.trim()) parts.push(`(${fielded("keyword", adv.keyword)} OR ${fielded("mesh", adv.keyword)})`);
    return parts.join(" ");
  }

  function submitAdvanced(ev: SubmitEvent) {
    ev.preventDefault();
    const filters = current.filters.filter(([param]) => param !== "status");
    if (adv.status) filters.push(["status", adv.status]);
    go({ q: built(), filters, from: adv.from.trim(), to: adv.to.trim(), sort, page: 1 });
  }

  const withFilter = (param: string, value: string): State => ({
    ...current,
    filters: [...current.filters.filter(([p, v]) => !(p === param && v === value)), [param, value]],
    page: 1,
  });
  const withoutFilter = (param: string, value: string): State => ({
    ...current,
    filters: current.filters.filter(([p, v]) => !(p === param && v.toLowerCase() === value.toLowerCase())),
    page: 1,
  });
  const isActive = (param: string, value: string) =>
    current.filters.some(([p, v]) => p === param && v.toLowerCase() === value.toLowerCase());

  /** A facet value in words. */
  function valueInWords(param: string, value: string): string {
    if (labels[param]?.[value]) return labels[param][value];
    if (param === "status") return STATUSES[value]?.label ?? value.replace(/_/g, " ");
    if (["modality", "organism", "population", "subfield"].includes(param)) return value.replace(/_/g, " ");
    if (param === "matches") return value === "yes" ? "with matches" : "without";
    if (param === "oa") return value === "yes" ? "open access" : "not open access";
    if (param === "type") return value.replace(/-/g, " ");
    if (param === "code_license" && value === "none") return "no license";
    return value;
  }

  function scopeInWords(a: Answer): string {
    if (a.facets_scope === "results") return `Counts over the ${plural(a.total, "result")}.`;
    if (a.facets_scope === "window") return `Counts over the first ${number(a.window)} results.`;
    if (a.facets_scope === "catalogue") return "Counts over the whole catalogue.";
    return "";
  }

  function summaryInWords(a: Answer): string {
    const count = a.complete ? plural(a.total, "result") : `More than ${number(a.window)} results`;
    const what = a.query.q ? ` for “${a.query.q}”` : "";
    const first = (a.query.page - 1) * a.query.size + 1;
    const shown = a.results.length ? `; ${number(first)}–${number(first + a.results.length - 1)} shown` : "";
    return `${count}${what}${shown}, ${ORDERS[a.query.sort] ?? a.query.sort}.`;
  }

  /** The results, by day of publication when sorted by date, else in one ranked list. */
  const groups = $derived.by(() => {
    if (!answer) return [];
    const first = (answer.query.page - 1) * answer.query.size;
    const rows = answer.results.map((d, i) => ({ d, n: first + i + 1 }));
    if (!byDate) return [{ day: "", rows }];
    const out: { day: string; rows: typeof rows }[] = [];
    for (const r of rows) {
      const last = out[out.length - 1];
      if (last && last.day === r.d.published) last.rows.push(r);
      else out.push({ day: r.d.published, rows: [r] });
    }
    return out;
  });

  onMount(() => {
    const s = readAddress();
    q = s.q;
    sort = s.sort;
    current = s;
    adv.from = s.from;
    adv.to = s.to;
    if (asksSearch()) go(s, true);
    const back = () => {
      const again = readAddress();
      if (asksSearch()) void run(again);
      else {
        current = again;
        q = "";
        answer = null;
        failure = null;
      }
    };
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  });
</script>

<form role="search" action="/search/" method="get" onsubmit={submit}>
  <p class="line">
    <label for="search-q">Search</label>
    <input id="search-q" name="q" type="text" enterkeyhint="search" size="48" bind:value={q} placeholder='eeg "working memory" -meg' />
    <label for="search-sort">sorted</label>
    <select id="search-sort" name="sort" bind:value={sort}>
      {#each SORTS as [value, label]}<option {value}>{label}</option>{/each}
    </select>
    <button type="submit">Search</button>
  </p>
</form>

<details bind:open={advancedOpen}>
  <summary>Advanced search</summary>
  <form onsubmit={submitAdvanced}>
    <p class="line"><label for="adv-all">All of these words</label> <input id="adv-all" type="text" bind:value={adv.all} size="36" /></p>
    <p class="line"><label for="adv-phrase">This exact phrase</label> <input id="adv-phrase" type="text" bind:value={adv.phrase} size="36" /></p>
    <p class="line"><label for="adv-any">Any of these words</label> <input id="adv-any" type="text" bind:value={adv.any} size="36" /></p>
    <p class="line"><label for="adv-none">None of these words</label> <input id="adv-none" type="text" bind:value={adv.none} size="36" /></p>
    <p class="line"><label for="adv-title">In the title</label> <input id="adv-title" type="text" bind:value={adv.title} size="36" /></p>
    <p class="line"><label for="adv-author">Author</label> <input id="adv-author" type="text" bind:value={adv.author} size="36" placeholder="Lovelace" /></p>
    <p class="line"><label for="adv-journal">Journal</label> <input id="adv-journal" type="text" bind:value={adv.journal} size="36" /></p>
    <p class="line"><label for="adv-tool">Tool used in the code</label> <input id="adv-tool" type="text" bind:value={adv.tool} size="36" placeholder="MNE-Python" /></p>
    <p class="line"><label for="adv-keyword">Keyword or MeSH term</label> <input id="adv-keyword" type="text" bind:value={adv.keyword} size="36" /></p>
    <p class="line"><label for="adv-repo">Code repository</label> <input id="adv-repo" type="text" bind:value={adv.repo} size="36" placeholder="github.com/owner/name" /></p>
    <p class="line"><label for="adv-id">DOI, PMID, PMCID or dataset</label> <input id="adv-id" type="text" bind:value={adv.id} size="36" /></p>
    <p class="line">
      <label for="adv-from">Published from</label> <input id="adv-from" type="text" bind:value={adv.from} size="10" placeholder="2020" />
      <label for="adv-to">to</label> <input id="adv-to" type="text" bind:value={adv.to} size="10" placeholder="2026-06" />
    </p>
    <p class="line">
      <label for="adv-status">Status</label>
      <select id="adv-status" bind:value={adv.status}>
        <option value="">any</option>
        {#each ["code_verified", "code_found", "code_empty", "code_dead", "on_request", "data_only"] as s}
          <option value={s}>{status(s).label}</option>
        {/each}
      </select>
    </p>
    <p class="line"><button type="submit">Search</button> {#if built()}The query: <code>{built()}</code>{/if}</p>
  </form>
  <p class="line">
    The query language, in the main field: words (all of them are searched), <code>"a phrase"</code>, <code>OR</code>,
    <code>NOT</code> or <code>-word</code>, parentheses, <code>neuro*</code> for a prefix, and a field before a word, a phrase
    or a group: <code>title:</code>, <code>author:</code>, <code>journal:</code>, <code>keyword:</code>, <code>mesh:</code>,
    <code>tool:</code>, <code>repo:</code>, <code>id:</code>, <code>abstract:</code>. Abstracts are searched only when the
    paper's license is open; they are never shown.
  </p>
</details>

<div class="record" id="results">
  <div class="body">
    {#if loading}
      <p class="summary" role="status">Searching…</p>
    {:else if failure}
      {#if failure.code === "bad_query"}
        <p class="warning" role="alert">{failure.message || "The query could not be understood."}</p>
      {:else}
        <p class="warning" role="alert">{FAILURES[failure.code] ?? FAILURES.unavailable}</p>
        <p class="line">
          Meanwhile, <a href="/browse/">Browse</a> and the <a href="/lookup/">DOI lookup</a> are static and always work.
        </p>
      {/if}
    {:else if answer}
      <p class="summary" role="status">{summaryInWords(answer)}</p>
      {#each answer.notices as notice}<p class="line warning">{notice}</p>{/each}
      {#if hasFilters}
        <p class="line">
          <span class="label">Filters:</span>
          {#each current.filters as [param, value], i}
            {i > 0 ? "; " : ""}{FACET_BY_PARAM.get(param)?.label ?? param}: {valueInWords(param, value)}
            (<a href={pageUrl(withoutFilter(param, value))} onclick={(e) => follow(e, withoutFilter(param, value))}>remove</a>)
          {/each}
          {#if current.from || current.to}
            {current.filters.length ? "; " : ""}published {current.from ? `from ${current.from}` : ""}{current.from && current.to ? " " : ""}{current.to ? `to ${current.to}` : ""}
            (<a href={pageUrl({ ...current, from: "", to: "", page: 1 })} onclick={(e) => follow(e, { ...current, from: "", to: "", page: 1 })}>remove</a>)
          {/if}
        </p>
      {/if}
      {#if answer.results.length === 0 && answer.query.page > 1}
        <p>No result on this page: <a href={pageUrl({ ...current, page: 1 })} onclick={(e) => follow(e, { ...current, page: 1 })}>back to the first page</a>.</p>
      {:else if answer.results.length === 0}
        <p>No paper matches. Try fewer words, <code>OR</code> between them, or fewer filters.</p>
      {:else}
        {@const page = answer.query.page}
        {@const previous = { ...current, page: page - 1 }}
        {@const next = { ...current, page: page + 1 }}
        {#each groups as g}
          {#if byDate}
            <h2 class="day">{dayInWords(g.day)} <small>({plural(g.rows.length, "paper")})</small></h2>
          {/if}
          <dl class="listing">
            {#each g.rows as { d, n }}
              {@const s = status(d.status)}
              <dt>
                <span class="num">[{n}]</span>
                {#if d.code.length}<a class="reader-link" href={`/paper/${d.slug}/#code`}>Code ↔ Paper</a>{/if}
                <a href={`/paper/${d.slug}/`}>doi:{d.doi}</a>
                [<a href={`https://doi.org/${d.doi}`}>paper</a>{#if d.code.length}, <a href={`/paper/${d.slug}/#code`}>repository</a>{:else if d.data > 0}, <a href={`/paper/${d.slug}/#data`}>data</a>{/if}]
              </dt>
              <dd>
                <div class="title">{#each highlight(d.title, terms) as part}{#if part.mark}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</div>
                <div class="line"><span class="label">Journal:</span> {d.journal || "—"}</div>
                {#if !byDate}
                  <div class="line"><span class="label">Published:</span> {d.published ? dateInWords(d.published) : "—"}</div>
                {/if}
                {#if d.code.length}
                  <div class="line">
                    <span class="label">Authors' code:</span>
                    {#each d.code as r, i}{i > 0 ? ", " : ""}<a class="code" href={`/paper/${d.slug}/#code`}>{r.name}</a> ({r.license || "no license"}){/each}
                  </div>
                {/if}
                <div class="line">
                  <span class="label">Status:</span>
                  {#if s.tone}<span class={s.tone}>{s.label}</span>{:else}{s.label}{/if}{#if d.files > 0}, {plural(d.files, "file")} readable{/if}{#if d.pairs > 0}, {plural(d.pairs, "match", "matches")}{/if}{#if d.map}, map validated by an author (<a href={`https://doi.org/${d.map}`}>DOI</a>){/if}{#if !d.code.length && d.data > 0}, {plural(d.data, "dataset")} cited{/if}{#if answer.query.sort === "cited" && d.cited}, cited {plural(d.cited, "time")}{/if}
                </div>
              </dd>
            {/each}
          </dl>
        {/each}
        <p class="line">
          {#if page > 1}
            <a href={pageUrl(previous)} onclick={(e) => follow(e, previous)}>« Previous</a> ·
          {/if}
          Page {page} of {Math.max(answer.pages, 1)}{#if !answer.complete} (the first {number(answer.window)} results; narrow the search to see the others){/if}
          {#if page < answer.pages}
            · <a href={pageUrl(next)} onclick={(e) => follow(e, next)}>Next »</a>
          {/if}
        </p>
        <p class="line">
          <span class="label">Download:</span>
          <a href={apiUrl({ ...current, page: 1 }, { format: "csv" })} download="search-results.csv">CSV</a>,
          <a href={apiUrl({ ...current, page: 1 }, { format: "json" })} download="search-results.json">JSON</a>
          ({answer.complete ? plural(answer.total, "result") : `the first ${number(answer.window)} results`}; one line per paper,
          with its page, its code and their licenses, never an abstract)
        </p>
      {/if}
    {:else}
      <p class="line">
        Type words and press Search: nothing is searched before. Filters by modality, organism, tool, journal, year and
        status appear next to the results; <a href={pageUrl({ q: "", filters: [], from: "", to: "", sort: "newest", page: 1 })} onclick={(e) => follow(e, { q: "", filters: [], from: "", to: "", sort: "newest", page: 1 })}>all
        the papers</a>, the newest first, show them for the whole catalogue.
      </p>
    {/if}
  </div>

  {#if answer && !loading && !failure && Object.keys(answer.facets).length}
    <aside class="sidebar" aria-label="Filters">
      <h3>Refine</h3>
      <p>{scopeInWords(answer)}</p>
      {#each FACETS as f}
        {#if answer.facets[f.param]?.length}
          <h3>{f.label}</h3>
          <ul>
            {#each answer.facets[f.param] as [value, count]}
              <li>
                {#if isActive(f.param, value)}
                  <strong>{valueInWords(f.param, value)}</strong> ({number(count)},
                  <a href={pageUrl(withoutFilter(f.param, value))} onclick={(e) => follow(e, withoutFilter(f.param, value))}>remove</a>)
                {:else}
                  <a href={pageUrl(withFilter(f.param, value))} onclick={(e) => follow(e, withFilter(f.param, value))}>{valueInWords(f.param, value)}</a> ({number(count)})
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      {/each}
    </aside>
  {/if}
</div>
