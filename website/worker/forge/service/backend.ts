// The GitBackend the forge service uses: the one the tests inject (MemoryBackend, through
// ForgeDeps), or in production GitHub's, built from the Worker's environment (the App's Cloudflare
// secrets, and the development mocks' addresses: ../github/index.ts, githubConfigFromEnv).
//
// The Worker's bundle never imports website/tests/: the test double reaches the service only as
// `deps.backend`. The fetch is wrapped so that the runtime's own `fetch` is called with the right
// `this` (workerd refuses a detached one).

import type { GitBackend } from "../gitbackend.ts";
import { githubBackend, githubConfigFromEnv } from "../github/index.ts";
import type { ForgeDeps, ForgeServiceEnv } from "./types.ts";

export function forgeBackend(env: ForgeServiceEnv, deps: ForgeDeps = {}): GitBackend {
  if (deps.backend) return deps.backend;
  const fetcher: typeof fetch = deps.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
  return githubBackend(githubConfigFromEnv(env), { fetch: fetcher, now: deps.now });
}
