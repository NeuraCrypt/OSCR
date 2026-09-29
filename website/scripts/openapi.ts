// Writes public/developers/openapi.json from the Worker's own routes (worker/forge/service/openapi.ts),
// after a change of the public API's routes (night phase 10):
//   node --experimental-strip-types scripts/openapi.ts
// A test compares the file with the routes, so a forgotten run fails the suite.
import { writeFileSync } from "node:fs";
import { openApi } from "../worker/forge/service/openapi.ts";

const out = new URL("../public/developers/openapi.json", import.meta.url);
writeFileSync(out, `${JSON.stringify(openApi(), null, 2)}\n`);
console.log(`written: ${out.pathname}`);
