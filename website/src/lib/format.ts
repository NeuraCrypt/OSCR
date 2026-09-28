// Numbers, plurals and dates, shared by the build and by the reader's browser.

export function number(n: number | undefined | null): string {
  return (n ?? 0).toLocaleString("en-GB");
}

/** "1 paper", "2 papers", "0 papers"; `pl` for irregular plurals. */
export const plural = (n: number, word: string, pl = `${word}s`) => `${number(n)} ${n === 1 ? word : pl}`;

/** "2026-09-21" → "Monday, 21 September 2026"; a month or a year alone stays so. */
export function dayInWords(day: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", {
      weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
    });
  }
  if (/^\d{4}-\d{2}$/.test(day)) {
    return new Date(`${day}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  }
  if (/^\d{4}$/.test(day)) return day;
  return "Unknown date";
}

/** "2026-09-21" → "21 September 2026" (no weekday); anything else stays as it is. */
export function dateInWords(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
}

/** "DE" → "Germany" (ISO 3166-1 alpha-2, as OpenAlex gives an institution's country); "" stays "". */
export function countryName(code: string): string {
  if (!/^[A-Z]{2}$/.test(code ?? "")) return "";
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}
