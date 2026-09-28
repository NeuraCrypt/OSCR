// The /submit/ page, in the reader's browser: whether a session is there (GET /api/account/me,
// asked only when the hint cookie says so), then the form, sent to POST /api/submissions with the
// session's CSRF token. Everything is written as text nodes, never as HTML. Like every browser
// script, it never names the platform: "the registry".

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;
type Part = string | { href: string; text: string };

function write(el: HTMLElement | null, tone: "" | "ok" | "warning", ...parts: Part[]) {
  if (!el) return;
  if (tone) el.className = tone;
  else el.removeAttribute("class");
  el.replaceChildren(
    ...parts.map((p) => {
      if (typeof p === "string") return document.createTextNode(p);
      // Only this site's pages and web addresses become links; anything else stays text.
      if (!/^(\/(?!\/)|https?:\/\/)/i.test(p.href)) return document.createTextNode(p.text);
      const a = document.createElement("a");
      a.href = p.href;
      a.textContent = p.text;
      return a;
    }),
  );
}

let csrf = "";
const message = byId("submit-message");

/** A sign-in started here comes back with ?signed_in=… or ?error=…: said once. */
function sayArrival() {
  const q = new URLSearchParams(location.search);
  if (q.has("signed_in")) write(message, "ok", "You are signed in: give the paper and its code below.");
  else if (q.has("error")) write(message, "warning", "The sign-in did not complete. Please try again.");
  else return;
  history.replaceState(null, "", location.pathname);
}

async function load() {
  if (!document.cookie.split(/;\s*/).includes("__Host-oscr_signed_in=1")) return;
  try {
    const res = await fetch("/api/account/me", { credentials: "same-origin", headers: { Accept: "application/json" } });
    const me = (await res.json()) as { signed_in?: boolean; csrf?: string; error?: { message: string } };
    if (me.error) return write(message, "warning", me.error.message);
    if (!me.signed_in) return;
    csrf = me.csrf ?? "";
    byId("submit-signed-out")?.setAttribute("hidden", "");
    byId("submit-form")?.removeAttribute("hidden");
  } catch {
    write(message, "warning", "The registry could not be reached. Please try again in a moment.");
  }
}

byId<HTMLFormElement>("submit-form")?.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const form = ev.currentTarget as HTMLFormElement;
  const out = byId("submit-result");
  const value = (id: string) => byId<HTMLInputElement | HTMLTextAreaElement>(id)?.value ?? "";
  const links = value("submit-links").split(/\s+/).map((l) => l.trim()).filter(Boolean);
  for (const b of form.querySelectorAll("button")) b.disabled = true;
  write(out, "", "Checking the DOI and the links…");
  let res: Response;
  try {
    res = await fetch("/api/submissions", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ doi: value("submit-doi"), code_urls: links, note: value("submit-note") }),
    });
  } catch {
    for (const b of form.querySelectorAll("button")) b.disabled = false;
    return write(out, "warning", "The registry could not be reached: check the connection, then try again.");
  }
  const data = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string }; submission?: { doi: string } };
  for (const b of form.querySelectorAll("button")) b.disabled = false;
  if (!res.ok) {
    const text = data.error?.message ?? "Something went wrong. Please try again.";
    if (data.error?.code === "already_submitted") return write(out, "warning", text.replace(/: see it on your account page\.$/, ": see it on "), { href: "/account/#submissions", text: "your account page" }, ".");
    return write(out, "warning", text);
  }
  form.reset();
  write(
    out,
    "ok",
    `Submitted: ${data.submission?.doi ?? "the paper"} is checked and queued. The registry reads it and writes a draft of its record; review it and publish it from `,
    { href: "/account/#submissions", text: "your account page" },
    ".",
  );
});

sayArrival();
void load();

export {};
