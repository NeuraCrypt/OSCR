// The records the pages rendered on demand are made of (lib/render.ts), built once when the site
// is built, from the same export as the static pages: an entity's record for its page in the
// browser, a paper's record for its page rendered by the Worker. Written into
// /records/<type>/NN.json by src/pages/records/[type]/[shard].json.ts.
import { europePmcUrl, lotEntry, onDemand, rowOf, shortName, withPage, type Article } from "./catalog";
import {
  authorOf, authors, authorUrl, categoriesOf, datasetName, datasetOf, datasets, datasetUrl, institutionOf, institutions,
  institutionUrl, journals, journalUrl, rridUrl, toolOf, tools, toolUrl,
} from "./entities";
import { countryName } from "./format";
import { licenseLabel, pageOf, PROMINENT, typeLabel } from "./paper";
import { factsOfRecord, FILES_LISTED, type PaperFacts } from "./removal.ts";
import { storedRow, type EntityShard, type Link, type PaperRecord, type RecordOf, type StoredRow } from "./render.ts";
import { ENTITY_ROWS_MAX, groupShards, keyOf, LINKS_MAX, packEntities, SHARDS, type EntityType } from "./shards.ts";

const bySlug = new Map(withPage.map((a) => [a.slug, a]));
/** The papers of an entity that have a page, the most recent first (the export's order). */
const papersOf = (slugs: string[]) => slugs.map((s) => bySlug.get(s)).filter((a): a is Article => a !== undefined);
const search = (params: Record<string, string>) => `/search/?${new URLSearchParams(params)}`;

type Built<T extends EntityType> = { key: string; record: RecordOf<T>; papers: Article[] };

/** Each entity's record, with the papers its page lists (at most ENTITY_ROWS_MAX). */
function build<T extends EntityType>(
  type: T,
  list: { key: string; papers: string[]; record: (listed: string[]) => RecordOf<T> }[],
): Built<T>[] {
  return list.map((e) => {
    const papers = papersOf(e.papers).slice(0, ENTITY_ROWS_MAX);
    return { key: keyOf(type, e.key), record: e.record(papers.map((a) => a.slug)), papers };
  });
}

const named = <T>(ids: string[], name: (id: string) => string, url: (id: string) => string): Link[] =>
  ids.map((id) => ({ text: name(id), href: url(id) }));

/** The records of every entity of the export, by type. */
export function entityRecords(): { [T in EntityType]: Built<T>[] } {
  return {
    author: build(
      "author",
      authors.map((x) => ({
        key: x.orcid,
        papers: x.papers,
        record: (papers) => ({
          orcid: x.orcid,
          name: x.name,
          counts: x.counts,
          affiliations: x.affiliations,
          institutions: named(x.institutions, (id) => institutionOf(id)?.name ?? id, institutionUrl),
          tools: named(x.tools.slice(0, LINKS_MAX), (id) => toolOf(id)?.name ?? id, toolUrl),
          tools_total: x.tools.length,
          papers,
          search: search({ q: `author:"${x.name.replace(/"/g, "")}"` }),
        }),
      })),
    ),
    journal: build(
      "journal",
      journals.map((x) => ({
        key: x.slug,
        papers: x.papers,
        record: (papers) => ({
          title: x.title,
          issn: x.issn,
          eissn: x.eissn,
          publisher: x.publisher,
          counts: x.counts,
          papers,
          search: search({ journal: x.title }),
        }),
      })),
    ),
    institution: build(
      "institution",
      institutions.map((x) => ({
        key: x.id,
        papers: x.papers,
        record: (papers) => ({
          id: x.id,
          name: x.name,
          country: countryName(x.country ?? ""),
          type: x.type ?? "",
          counts: x.counts,
          authors: named(x.authors, (o) => authorOf(o)?.name ?? o, authorUrl)
            .sort((p, q) => p.text.localeCompare(q.text))
            .slice(0, LINKS_MAX),
          authors_total: x.authors.length,
          papers,
          search: search({ q: `id:${x.id}` }),
        }),
      })),
    ),
    tool: build(
      "tool",
      tools.map((x) => ({
        key: x.slug,
        papers: x.papers,
        record: (papers) => ({
          name: x.name,
          kind: x.kind,
          homepage: x.homepage,
          rrid: x.rrid,
          rrid_url: rridUrl(x.rrid),
          counts: x.counts,
          repositories: x.repositories.slice(0, LINKS_MAX).map((r) => ({ text: shortName(r), href: r.url })),
          papers,
          search: search({ tool: x.name }),
        }),
      })),
    ),
    dataset: build(
      "dataset",
      datasets.map((x) => ({
        key: x.slug,
        papers: x.papers,
        record: (papers) => ({
          id: x.id,
          name: datasetName(x),
          repository: x.repository,
          url: x.url,
          license: x.license,
          counts: x.counts,
          papers,
          search: search({ q: `id:"${x.id.replace(/"/g, "")}"` }),
        }),
      })),
    ),
  };
}

/** The shards of one entity type (lib/shards.ts, packEntities): at most SHARDS[type] files. */
export async function entityShards<T extends EntityType>(type: T, built: Built<T>[]): Promise<Map<string, EntityShard<T>>> {
  return packEntities(
    built.map((b) => ({ key: b.key, record: b.record, rows: b.papers.map((a) => [a.slug, storedRow(rowOf(a))] as [string, StoredRow]) })),
    SHARDS[type],
  );
}

/** The record of a paper whose page is rendered on demand: what catalog.json and its lot of
 *  src/data/papers/ say, with the addresses of the pages it links to. */
export function paperRecord(a: Article): PaperRecord {
  const p = pageOf(a);
  const o = p?.overview;
  const people = o?.authors.length ? o.authors : (a.authors ?? []);
  const cited = new Set(a.datasets ?? []);
  return {
    id: a.id,
    slug: a.slug,
    doi: a.doi,
    title: a.title,
    journal: { text: a.journal, href: journalUrl(a.journal_id) },
    published: a.published,
    type: typeLabel(o?.type ?? ""),
    license: licenseLabel(o?.license ?? ""),
    status: a.status,
    notices: (o?.notices ?? []).filter((n) => PROMINENT.has(n.kind)),
    authors: people.map((x) => ({ text: x.name, href: authorUrl(x.orcid) })),
    institutions: (o?.institutions ?? []).map((x) => ({
      text: countryName(x.country) ? `${x.name} (${countryName(x.country)})` : x.name,
      href: institutionUrl(x.ror),
    })),
    categories: categoriesOf(a).map((c) => ({ text: `${c.name} (${c.facet})`, href: c.url })),
    // Each repository's files, for a removal request's choice (src/lib/removal.ts): their paths,
    // and whether the site holds copies of their text.
    code: a.code.map((r) => {
      const e = lotEntry(r);
      const paths = (e?.files ?? []).filter((f) => f.kind !== "note").map((f) => f.path);
      const listed = (e?.files ?? []).filter((f) => f.kind !== "note");
      return {
        repo: r.repo, name: shortName(r), url: r.url, license: r.license, state: r.state,
        copies: !!e?.published && (e?.files ?? []).some((f) => f.text !== null),
        // Why the registry keeps no copy of its files: their license, or a removal request.
        held: !e || e.published || !listed.length ? undefined : listed.every((f) => /removal request/i.test(f.note)) ? "withheld" : "license",
        files: paths.slice(0, FILES_LISTED),
        files_more: Math.max(0, paths.length - FILES_LISTED),
      };
    }),
    files: a.code.reduce((n, d) => n + (d.files_read || 0), 0),
    pairs: a.alignment?.pairs ?? 0,
    map: a.card?.doi ?? "",
    datasets: (a.datasets ?? []).map((id) => {
      const d = datasetOf(id);
      return { text: d ? datasetName(d) : id, href: datasetUrl(id) };
    }),
    data: (p?.data ?? []).map((d) => ({ repo: d.repo, url: d.url, repository: d.repository, cited: !!d.dataset && cited.has(d.dataset) })),
    tools: (a.tools ?? []).map((id) => ({ text: toolOf(id)?.name ?? id, href: toolUrl(id) })),
    europepmc: europePmcUrl(a),
  };
}

/** The facts a removal request needs of a paper (src/lib/removal.ts): what its record says. A static
 *  page carries them at the top of its <main> (src/pages/paper/[slug]/index.astro), the record of a
 *  paper rendered on demand holds them already: no file of their own. */
export function paperFacts(a: Article): PaperFacts {
  return factsOfRecord(paperRecord(a));
}

/** The shards of the papers rendered on demand: at most SHARDS.paper files. */
export async function paperShards(papers: readonly Article[] = onDemand): Promise<Map<string, Record<string, PaperRecord>>> {
  const groups = await groupShards(papers.map((a) => [a.slug, a] as [string, Article]), SHARDS.paper);
  return new Map([...groups].map(([name, members]) => [name, Object.fromEntries([...members].map(([slug, a]) => [slug, paperRecord(a)]))]));
}

/** Every file of /records/: the shards of each entity type, then those of the papers rendered on
 *  demand. */
export async function recordFiles(): Promise<{ type: string; shard: string; content: unknown }[]> {
  const built = entityRecords();
  const files: { type: string; shard: string; content: unknown }[] = [];
  const add = (type: string, shards: Map<string, unknown>) => {
    for (const [shard, content] of shards) files.push({ type, shard, content });
  };
  add("author", await entityShards("author", built.author));
  add("journal", await entityShards("journal", built.journal));
  add("institution", await entityShards("institution", built.institution));
  add("tool", await entityShards("tool", built.tool));
  add("dataset", await entityShards("dataset", built.dataset));
  add("paper", await paperShards());
  return files;
}
