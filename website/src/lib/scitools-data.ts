// The scientific tools' manifests (src/scitools/*.json, src/lib/scitools.ts), read at build time
// by Vite. Their own folder: scripts/data.mjs and the harvester's export never touch it.
import { ordered, problemsOf, type SciTool } from "./scitools";

const loaded = import.meta.glob<SciTool>("../scitools/*.json", { eager: true, import: "default" });

/** Every tool, the most recently added first; a malformed manifest stops the build with its reason
 *  (tests/scitools.test.ts catches it before). */
export const sciTools: SciTool[] = ordered(
  Object.entries(loaded).map(([path, tool]) => {
    const problems = problemsOf(tool, path.split("/").pop()!);
    if (problems.length) throw new Error(`scientific tools: ${problems.join("; ")}`);
    return tool;
  }),
);
