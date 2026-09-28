// What a reader chose in this browser (the paper pane hidden, long lines wrapped, the list of
// files closed), kept in localStorage. Storage may be missing or refuse (a private window,
// blocked site data): every access is guarded, and the page works the same without it,
// with the defaults. Pure: tested in tests/reader.test.ts with a storage that throws.

export type Store = Pick<Storage, "getItem" | "setItem">;

/** The browser's localStorage, or null when it cannot be reached. */
export function browserStore(): Store | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** A stored choice among `allowed`, else `fallback`. */
export function readPref<T extends string>(store: () => Store | null, key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = store()?.getItem(key);
    return v !== null && v !== undefined && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Keep a choice; false when the browser would not. */
export function writePref(store: () => Store | null, key: string, value: string): boolean {
  try {
    const s = store();
    if (!s) return false;
    s.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** The keys: they never name the platform. */
export const PREFS = {
  paper: "reader.paper",
  wrap: "reader.wrap",
  files: "reader.files",
} as const;
