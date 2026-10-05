"""Seed the end-to-end run's security facts into the local oscr_forge (night phase 11).

Run from the repository root by tests/forge-service/e2e.sh. It uses the real Mac code paths:
- the dependency graph (oscr.depgraph) of a small fixed environment;
- the OSV client (oscr.osv) against the FAKE OSV (never the real one), writing a vulnerability and a
  malware alert;
- a secret finding (oscr.secretscan) → a secret alert (reports, never blocks);
- the repository's licence and its dependencies' compatibility summary.

Usage: python seed_security.py <repo_id> <osv_base> <state_dir> <head_sha>
"""
import sys
from pathlib import Path

from oscr import community, depgraph, net, osv, sbom, secretscan, security

repo_id, osv_base, state_dir, head = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
FORGE = "github"
NOW = 1_790_600_000

d1 = community.open_d1("local", settings={}, persist_to=Path(state_dir), database="oscr_forge")

# The environment the fixture's code needs (as its manifests would say).
files = {
    "requirements.txt": "numpy==1.26.0\nscipy>=1.11,<1.12\nmne==1.6.0\ncolourama==0.1.0\n",
    "package.json": '{"dependencies": {"d3": "^7.8.0"}, "devDependencies": {"vitest": "1.2.0"}}',
    ".github/workflows/ci.yml": "jobs:\n  test:\n    steps:\n      - uses: actions/checkout@v4\n",
}
nodes = depgraph.graph(files)

statements = security.deps_statements(FORGE, repo_id, "default", nodes, head, NOW)

# The OSV alerts, through the real client against the fake OSV.
client = net.Client(offline=False)
try:
    def post(url, body):
        return client.post_json(url, body)

    def get(url):
        return client.get(url, ttl_s=None)

    alerts = security.scan_osv(post, get, nodes, base=osv_base)
finally:
    client.close()
statements += security.osv_statements(FORGE, repo_id, alerts, NOW)

# A secret found after the push (reports, never blocks).
finding = secretscan.scan_text("config.py", 'TOKEN = "ghp_' + "a" * 36 + '"\n')
statements += security.secret_statements(FORGE, repo_id, finding, NOW)

# The repository's licence and its dependencies' compatibility.
summary = sbom.licence_summary("MIT", [(n.name, "") for n in nodes])
statements += security.licences_statements(FORGE, repo_id, "MIT", summary, NOW)

written = 0
for i in range(0, len(statements), 50):
    written += d1.run(statements[i:i + 50])
print(f"seeded {written} security fact rows: {len(nodes)} deps, {len(alerts)} OSV alerts, {len(finding)} secret")
