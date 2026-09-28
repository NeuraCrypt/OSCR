// The accounts' answers: JSON for the account page's script, redirects for the browser's
// navigations (sign-in), cookies and the headers every answer carries.

/** Never cached (an account's answer is personal), never sniffed, never indexed, and no address
 *  of ours leaks to another site through the Referer header. */
const HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex",
};

function headers(extra: Record<string, string>, cookies: string[]): Headers {
  const h = new Headers({ ...HEADERS, ...extra });
  for (const c of cookies) h.append("Set-Cookie", c);
  return h;
}

export function json(body: unknown, status = 200, cookies: string[] = []): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: headers({ "Content-Type": "application/json; charset=utf-8" }, cookies),
  });
}

/** A failure the account page can say in words: `code` for the script, `message` for people. */
export function problem(status: number, code: string, message: string, cookies: string[] = []): Response {
  return json({ error: { code, message } }, status, cookies);
}

export function redirect(location: string, cookies: string[] = []): Response {
  return new Response(null, { status: 302, headers: headers({ Location: location }, cookies) });
}

/** A path of this site to come back to after a sign-in: "/account/" unless the request names
 *  another page of the site. Never another site (an open redirect), never an API route. */
export function returnPath(value: string | null): string {
  if (!value || value.length > 200) return "/account/";
  if (!/^\/[A-Za-z0-9._~\-/]*$/.test(value) || value.startsWith("//") || value.startsWith("/api/")) return "/account/";
  return value;
}

/** `path` with these query parameters ("/account/?signed_in=orcid"). */
export function withQuery(path: string, params: Record<string, string>): string {
  const q = new URLSearchParams(params).toString();
  return q ? `${path}?${q}` : path;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** A cookie the page's scripts cannot read (HttpOnly), sent over HTTPS only (Secure; browsers
 *  also accept it on http://localhost), sent when a provider's redirect brings the browser back
 *  (SameSite=Lax: top-level navigations only), for this host and the whole site (__Host-,
 *  Path=/, no Domain). */
export function setCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAge))}`;
}

export function clearCookie(name: string): string {
  return setCookie(name, "", 0);
}
