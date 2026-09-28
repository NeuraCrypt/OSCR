// GitHub's webhook deliveries (https://docs.github.com/en/webhooks), checked and read as
// forge-neutral events. Pure: no request, no storage.
//
// - Headers read: X-GitHub-Event, X-GitHub-Delivery, X-Hub-Signature-256 ("sha256=<hex>", an
//   HMAC-SHA-256 of the raw body under the webhook secret).
// - A delivery over `maxBytes` (1 MiB, OSCR's WEBHOOK_BYTES: the HMAC and JSON.parse must fit the
//   Worker's 10 ms of CPU) is refused before any hashing; the Mac's polling catches up. Measured
//   in V8 (Node 26 and 22, 2026-09-29): the HMAC of 1 MiB takes 0.5 ms, and parsing a 1 MiB push of
//   3,300 commits into its event 3.1 to 3.4 ms.
// - The signature is checked in constant time, by crypto.subtle.verify (hmac.ts).
// - Events mapped: ping, installation, installation_repositories, push, repository, create and
//   delete (both become `ref`), pull_request, release. Everything else becomes `other`; an action
//   outside the ones listed in types.ts too.
// - No email address is copied: not `pusher.email`, not `commits[].author.email`, not the
//   sender's. The pusher is its name, with the sender's account when they are the same person.
// - Private repositories (in installation_repositories, or any event whose repository is not
//   public) are mapped to stubs with their `visibility`: the forge service drops them without
//   storing their names (D00-14).

import { GitBackendError, invalid, isGitError } from "../errors.ts";
import type { WebhookCodec } from "../gitbackend.ts";
import { checkBody } from "../hmac.ts";
import { text } from "../objects.ts";
import type * as T from "../types.ts";
import * as map from "./map.ts";

export const WEBHOOK_MAX_BYTES = 2 ** 20;

const INSTALLATION_ACTIONS = new Set(["created", "deleted", "suspend", "unsuspend", "new_permissions_accepted"]);
const REPOSITORY_ACTIONS = new Set(["created", "deleted", "archived", "unarchived", "renamed", "transferred", "publicized", "privatized", "edited"]);

function installationId(p: map.J): string | null {
  return p.installation ? map.id(map.obj(p.installation, "installation")) : null;
}

function event(name: string, delivery: string, p: map.J): T.ForgeEvent {
  const other: T.ForgeEvent = { kind: "other", delivery, event: name };
  const action = typeof p.action === "string" ? p.action : "";
  switch (name) {
    case "ping":
      return { kind: "ping", delivery };
    case "installation":
      if (!INSTALLATION_ACTIONS.has(action)) return other;
      return { kind: "installation", delivery, action: action as "created", installation: map.installation(p.installation), sender: map.user(p.sender) };
    case "installation_repositories": {
      if (action !== "added" && action !== "removed") return other;
      const stubs = (k: string) => (p[k] === undefined || p[k] === null ? [] : map.list(p[k], k).map(map.stub));
      return {
        kind: "installation_repositories",
        delivery,
        action,
        installation: map.installation(p.installation),
        added: stubs("repositories_added"),
        removed: stubs("repositories_removed"),
        sender: map.user(p.sender),
      };
    }
    case "push": {
      const repo = map.stub(p.repository);
      const r = map.obj(p.repository, "repository");
      const sender = p.sender ? map.user(p.sender) : null;
      const pusher = p.pusher ? map.obj(p.pusher, "pusher") : {};
      const pusherName = map.optStr(pusher, "name") ?? sender?.login ?? "";
      const same = sender && sender.login !== null && sender.login.toLowerCase() === pusherName.toLowerCase();
      const pushedAt = typeof r.pushed_at === "number" ? r.pushed_at : Math.floor(Date.parse(String(r.pushed_at ?? "")) / 1000) || 0;
      const paths = (c: map.J, k: string) => (c[k] === undefined ? [] : map.list(c[k], k).map((x) => (typeof x === "string" ? x : "")).filter(Boolean));
      return {
        kind: "push",
        delivery,
        installation: installationId(p),
        repo,
        ref: map.str(p, "ref"),
        before: map.sha(p, "before"),
        after: map.sha(p, "after"),
        created: map.bool(p, "created", false),
        deleted: map.bool(p, "deleted", false),
        forced: map.bool(p, "forced", false),
        pushedAt,
        commits: (p.commits === undefined || p.commits === null ? [] : map.list(p.commits, "commits")).map((v) => {
          const c = map.obj(v, "commit");
          return { sha: map.sha(c, "id"), added: paths(c, "added"), removed: paths(c, "removed"), modified: paths(c, "modified") };
        }),
        pusher: same && sender ? { name: pusherName, login: sender.login, id: sender.id } : { name: pusherName, login: null, id: null },
      };
    }
    case "repository": {
      if (!REPOSITORY_ACTIONS.has(action)) return other;
      const changes = p.changes && typeof p.changes === "object" ? (p.changes as map.J) : null;
      let previous: { owner: string | null; name: string | null } | null = null;
      if (changes) {
        const nameFrom = changes.repository && typeof changes.repository === "object" ? (changes.repository as map.J).name : undefined;
        const ownerFrom = changes.owner && typeof changes.owner === "object" ? (changes.owner as map.J).from : undefined;
        const name = nameFrom && typeof nameFrom === "object" ? map.optStr(nameFrom as map.J, "from") : null;
        let owner: string | null = null;
        if (ownerFrom && typeof ownerFrom === "object") {
          const f = ownerFrom as map.J;
          const who = (f.user ?? f.organization) as unknown;
          owner = who && typeof who === "object" ? map.optStr(who as map.J, "login") : null;
        }
        if (name !== null || owner !== null) previous = { owner, name };
      }
      return { kind: "repository", delivery, installation: installationId(p), action: action as "created", repo: map.stub(p.repository), previous, sender: map.user(p.sender) };
    }
    case "create":
    case "delete": {
      const refType = map.str(p, "ref_type");
      if (refType !== "branch" && refType !== "tag") return other;
      return {
        kind: "ref",
        delivery,
        installation: installationId(p),
        action: name === "create" ? "created" : "deleted",
        refType,
        ref: map.str(p, "ref"),
        repo: map.stub(p.repository),
        sender: map.user(p.sender),
      };
    }
    case "pull_request": {
      const pr = map.obj(p.pull_request, "pull_request");
      const head = map.obj(pr.head, "head");
      const base = map.obj(pr.base, "base");
      return {
        kind: "pull_request",
        delivery,
        installation: installationId(p),
        action,
        number: map.num(p, "number"),
        repo: map.stub(p.repository),
        head: { ref: map.str(head, "ref"), sha: map.sha(head) },
        base: { ref: map.str(base, "ref") },
        merged: pr.merged === true,
        sender: map.user(p.sender),
      };
    }
    case "release": {
      const rel = map.obj(p.release, "release");
      return {
        kind: "release",
        delivery,
        installation: installationId(p),
        action,
        repo: map.stub(p.repository),
        releaseId: map.id(rel),
        tagName: map.str(rel, "tag_name"),
        sender: map.user(p.sender),
      };
    }
    default:
      return other;
  }
}

export function githubWebhooks(maxBytes = WEBHOOK_MAX_BYTES): WebhookCodec {
  return {
    maxBytes,
    async verify(headers, body, secret) {
      if (!(body instanceof Uint8Array) || body.length > maxBytes) return false;
      return checkBody(secret, body, headers.get("X-Hub-Signature-256"));
    },
    parse(headers, body) {
      if (!(body instanceof Uint8Array)) throw invalid("no delivery");
      if (body.length > maxBytes) throw new GitBackendError("too_large", "the delivery is larger than OSCR reads");
      const name = headers.get("X-GitHub-Event") ?? "";
      const delivery = headers.get("X-GitHub-Delivery") ?? "";
      if (!/^[a-z_]{1,64}$/.test(name)) throw invalid("not a GitHub delivery");
      if (!/^[A-Za-z0-9-]{1,100}$/.test(delivery)) throw invalid("a delivery has an id");
      let payload: unknown;
      try {
        payload = JSON.parse(text(body));
      } catch {
        throw invalid("the delivery is not JSON");
      }
      try {
        return event(name, delivery, map.obj(payload, "payload"));
      } catch (e) {
        if (isGitError(e, "unavailable")) throw invalid("a malformed delivery");
        throw e;
      }
    },
  };
}
