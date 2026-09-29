// Test support: a page of a headless Chrome, driven through the Chrome DevTools Protocol (Node's own
// WebSocket), for the end-to-end run of the pages whose steps happen in the browser (the removal
// request's review: tests/contributions/removal-e2e.ts). Chrome is started by tests/account/e2e.sh,
// with every address outside this machine blocked (a resolver that finds no other host, and a proxy
// that answers nothing): nothing the pages ask leaves the machine.
//
// Not a unit test: it needs the servers and Chrome running.

export type Page = {
  send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  evaluate: <T = unknown>(expression: string) => Promise<T>;
  waitFor: (expression: string, ms?: number) => Promise<void>;
  navigate: (url: string) => Promise<void>;
  click: (selector: string) => Promise<void>;
  type: (selector: string, text: string) => Promise<void>;
  viewport: (width: number, height: number, mobile?: boolean) => Promise<void>;
  screenshot: (file: string) => Promise<void>;
  /** The page's own errors (exceptions, console errors, failed loads), for the checks. */
  errors: string[];
  close: () => Promise<void>;
};

type Message = { id?: number; method?: string; params?: Record<string, any>; result?: Record<string, unknown>; error?: unknown };

export async function openPage(port: number, width = 1280, height = 860): Promise<Page> {
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json()) as { id: string; webSocketDebuggerUrl: string };
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("Chrome's DevTools did not answer"));
  });
  let id = 0;
  const pending = new Map<number, (m: Message) => void>();
  const errors: string[] = [];
  ws.onmessage = (event) => {
    const m = JSON.parse(String(event.data)) as Message;
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)!(m);
      pending.delete(m.id);
      return;
    }
    if (m.method === "Runtime.exceptionThrown") errors.push(String(m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text));
    if (m.method === "Runtime.consoleAPICalled" && m.params?.type === "error") {
      errors.push((m.params.args ?? []).map((a: { value?: unknown; description?: string }) => a.value ?? a.description).join(" "));
    }
    if (m.method === "Log.entryAdded" && m.params?.entry?.level === "error") errors.push(`${m.params.entry.text} ${m.params.entry.url ?? ""}`);
  };
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const n = ++id;
      pending.set(n, (m) => (m.error ? reject(new Error(`${method}: ${JSON.stringify(m.error)}`)) : resolve(m.result ?? {})));
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  let size = { width, height, mobile: false };
  const viewport = async (w: number, h: number, mobile = false) => {
    size = { width: w, height: h, mobile };
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
  };
  await viewport(width, height);
  const evaluate = async <T>(expression: string): Promise<T> => {
    const r = (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })) as {
      result?: { value?: T };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (r.exceptionDetails) throw new Error(`evaluate: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}\n${expression}`);
    return r.result?.value as T;
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (expression: string, ms = 20_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await evaluate<boolean>(expression).catch(() => false)) return;
      await sleep(100);
    }
    throw new Error(`timeout waiting for: ${expression}`);
  };
  const navigate = async (url: string) => {
    await send("Page.navigate", { url });
    await sleep(150);
    await waitFor(`document.readyState === "complete"`);
  };
  /** A real click, at the element's center, the element brought into the window first. */
  const click = async (selector: string) => {
    const box = await evaluate<{ x: number; y: number } | null>(
      `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: "center" }); ` +
        `const r = e.getBoundingClientRect(); return { x: r.left + Math.min(r.width / 2, 12), y: r.top + r.height / 2 }; })()`,
    );
    if (!box) throw new Error(`no element ${selector}`);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    }
  };
  /** Text typed into a field, as a person does (an input event per insertion). */
  const type = async (selector: string, text: string) => {
    await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.focus(); e.value = ""; })()`);
    await send("Input.insertText", { text });
  };
  /** The whole page, whatever its height, at the window's width: the window is made as tall as the
   *  page for the capture (every part of it painted), then given back its size. A page wider than the
   *  window (a phone's page that scrolls sideways) shows at its own width. */
  const screenshot = async (file: string) => {
    const { writeFileSync } = await import("node:fs");
    const metrics = (await send("Page.getLayoutMetrics")) as { cssContentSize: { width: number; height: number } };
    const full = { width: Math.max(size.width, Math.ceil(metrics.cssContentSize.width)), height: Math.max(size.height, Math.ceil(metrics.cssContentSize.height)) };
    await send("Emulation.setDeviceMetricsOverride", { width: full.width, height: full.height, deviceScaleFactor: 1, mobile: size.mobile });
    await sleep(400);
    const r = (await send("Page.captureScreenshot", { format: "png" })) as { data: string };
    writeFileSync(file, Buffer.from(r.data, "base64"));
    await viewport(size.width, size.height, size.mobile);
  };
  const close = async () => {
    try {
      await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`);
    } catch {
      // Chrome is gone already
    }
    ws.close();
  };
  return { send, evaluate, waitFor, navigate, click, type, viewport, screenshot, errors, close };
}
