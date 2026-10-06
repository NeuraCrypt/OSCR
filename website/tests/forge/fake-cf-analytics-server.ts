// A FAKE Cloudflare GraphQL analytics source for the end-to-end run (night phase 12; the real one is
// never called on this machine). It answers any POST with one account's day, week, referrer and page
// groups, so the maintainer traffic view can be exercised offline. It returns NO unique-visitor field.
//
//   node --experimental-strip-types tests/forge/fake-cf-analytics-server.ts <port>
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 9494);
const DAY = 86400;
const now = Math.floor(Date.now() / 1000);
const iso = (n: number): string => new Date((now - n * DAY) * 1000).toISOString().slice(0, 10);

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    // Echo nothing of the token; answer the fixed shape (the query's path filter is ignored here).
    const payload = {
      data: { viewer: { accounts: [{
        days: [
          { dimensions: { date: iso(2) }, count: 8, sum: { visits: 3 } },
          { dimensions: { date: iso(1) }, count: 14, sum: { visits: 6 } },
          { dimensions: { date: iso(0) }, count: 21, sum: { visits: 9 } },
        ],
        weeks: [
          { dimensions: { date: iso(10) }, count: 40, sum: { visits: 18 } },
          { dimensions: { date: iso(3) }, count: 60, sum: { visits: 25 } },
        ],
        referrers: [
          { dimensions: { refererHost: "scholar.example.org" }, count: 22 },
          { dimensions: { refererHost: "news.example.com" }, count: 9 },
          { dimensions: { refererHost: "" }, count: 15 },
        ],
        pages: [
          { dimensions: { requestPath: "/r/oscr-fixture/eeg-analysis/" }, count: 30 },
          { dimensions: { requestPath: "/r/oscr-fixture/eeg-analysis/insights/" }, count: 12 },
        ],
      }] } },
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  });
});
server.listen(port, "127.0.0.1", () => console.log(`fake Cloudflare analytics on 127.0.0.1:${port}`));
