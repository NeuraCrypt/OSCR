// Numbers and plurals, shared by the build and by the reader's browser.

export function number(n: number | undefined | null): string {
  return (n ?? 0).toLocaleString("en-GB");
}

/** "1 paper", "2 papers", "0 papers"; `pl` for irregular plurals. */
export const plural = (n: number, word: string, pl = `${word}s`) => `${number(n)} ${n === 1 ? word : pl}`;
