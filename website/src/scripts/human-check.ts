// The human check (night phase 16): Cloudflare Turnstile's widget, drawn in the reader's browser in a
// frame of Cloudflare's own (challenges.cloudflare.com), for every public write form of the GitHub side.
// The page's box carries the site key the build wrote (data-sitekey); the token the widget gives is sent
// with the form, and the Worker verifies it with Cloudflare before anything is written (turnstile.ts).
// Without a site key, or when Cloudflare's script cannot load, the box says so and the form is not sent.
// Like every browser script, it never names the platform.

interface Turnstile {
  render(el: HTMLElement, options: Record<string, unknown>): string;
  reset(id?: string): void;
}

const API = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loading: Promise<boolean> | null = null;

function load(): Promise<boolean> {
  loading ??= new Promise<boolean>((resolve) => {
    const w = window as unknown as { turnstile?: Turnstile };
    if (w.turnstile) return resolve(true);
    const s = document.createElement("script");
    s.src = API;
    s.async = true;
    const timer = setTimeout(() => resolve(false), 10_000);
    s.addEventListener("load", () => (clearTimeout(timer), resolve(!!w.turnstile)));
    s.addEventListener("error", () => (clearTimeout(timer), resolve(false)));
    document.head.append(s);
  });
  return loading;
}

export interface HumanCheck {
  /** The widget's token, "" until the check passed (or after it expired). */
  token(): string;
  /** A new check (a token is good once: after every send). */
  reset(): void;
}

/** The widget in `box` (its data-sitekey), or null when the form cannot be sent: said in the box. */
export async function humanCheck(box: HTMLElement): Promise<HumanCheck | null> {
  const sitekey = box.dataset.sitekey ?? "";
  const say = (text: string) => {
    box.replaceChildren(text);
    box.classList.add("warning");
  };
  if (!sitekey) {
    say("The registry's human check is not set up yet: this form cannot be sent. Please come back later.");
    return null;
  }
  box.textContent = "Loading the human check (Cloudflare Turnstile)…";
  if (!(await load())) {
    say("The human check could not load: it comes from Cloudflare (challenges.cloudflare.com), and the form cannot be sent without it. Check that nothing blocks it, then reload the page.");
    return null;
  }
  const t = (window as unknown as { turnstile: Turnstile }).turnstile;
  box.replaceChildren();
  let token = "";
  const id = t.render(box, {
    sitekey,
    callback: (value: string) => void (token = value),
    "expired-callback": () => void (token = ""),
    "error-callback": () => void (token = ""),
  });
  return { token: () => token, reset: () => ((token = ""), t.reset(id)) };
}

const boxes = new WeakMap<HTMLElement, Promise<HumanCheck | null>>();

/** The site key the build wrote into the page (<meta name="turnstile-site-key">), or "". */
export const siteKey = (): string => document.querySelector<HTMLMetaElement>('meta[name="turnstile-site-key"]')?.content ?? "";

/** The token for one send of a form, the widget drawn just before `anchor` (its send button) on first
 *  use. "" when the page has no site key: the Worker asks for none while Turnstile is not set up (only
 *  the owner can write then). null when the check has not passed yet: the box says so, and the reader
 *  sends again once it has. A token is good once: the widget starts again after each send. */
export async function humanToken(anchor: HTMLElement): Promise<string | null> {
  const key = siteKey();
  if (!key) return "";
  let pending = boxes.get(anchor);
  if (!pending) {
    const box = document.createElement("div");
    box.className = "human-check";
    box.dataset.sitekey = key;
    anchor.before(box);
    pending = humanCheck(box);
    boxes.set(anchor, pending);
  }
  const check = await pending;
  if (!check) return null;
  for (let i = 0; i < 20 && !check.token(); i++) await new Promise((r) => setTimeout(r, 200));
  const token = check.token();
  if (!token) return null;
  check.reset();
  return token;
}

/** What a form says when the human check has not passed yet. */
export const HUMAN_WAIT = "Complete the human check just above the button, then send again.";
