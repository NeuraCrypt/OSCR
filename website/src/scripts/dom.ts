// View trees as DOM nodes (night phase 01, moved here in phase 02 so that every /r/ module shares
// one): allowed elements and attributes only (src/lib/repo-view.ts TAGS, ATTRS), text as text
// nodes masked for email addresses, links and image sources checked again (safeHref, safeSrc).
// MathML's elements are made in MathML's namespace, so the browser renders math natively. No HTML
// string is ever parsed: nothing a repository holds can become markup or script.

import { maskEmails } from "../../worker/forge/mask.ts";
import { allowedAttr, type El, MATH_TAGS, safeHref, safeSrc, TAGS } from "../lib/repo-view.ts";

const MATHML = "http://www.w3.org/1998/Math/MathML";
const MATH = new Set<string>(MATH_TAGS);

/** A view tree as DOM nodes. */
export function toDom(node: string | El): Node {
  if (typeof node === "string") return document.createTextNode(maskEmails(node));
  const known = (TAGS as readonly string[]).includes(node.tag);
  const tag = known ? node.tag : "span";
  const el = MATH.has(tag) ? document.createElementNS(MATHML, tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(node.attrs)) {
    if (!allowedAttr(k)) continue;
    if (k === "href") {
      const safe = safeHref(v);
      if (safe) el.setAttribute("href", safe);
    } else if (k === "src") {
      const safe = safeSrc(v);
      if (safe) el.setAttribute("src", safe);
    } else el.setAttribute(k, v);
  }
  for (const c of node.children) el.appendChild(toDom(c));
  return el;
}

/** Replace a node's children with view trees. */
export function show(root: Element, ...nodes: (string | El | null | undefined | false)[]): void {
  root.replaceChildren(...nodes.filter((n): n is string | El => !!n).map(toDom));
}
