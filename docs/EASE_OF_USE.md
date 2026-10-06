# Ease of use (night phase 15)

The cross-cutting comfort layer over every page: keyboard shortcuts, the command palette, the
reader's preferences (themes among them, light by default), the accessibility baseline, phone and
tablet layouts, the centralised interface strings, and a static service-status page. It adds to every
earlier phase; it removes nothing.

Three hard rules shape it: `science.css` is the only source of style (every new rule lives there, in
its spirit, no pills, no decorative uppercase); **no dark theme by default** (themes are opt-in, via
`html[data-theme]`); and the client features ask the Worker for nothing (they run in the browser, from
a static index and `localStorage`).

## Preferences and themes

- **Where they live.** `src/lib/preferences.ts` holds the schema: each preference is a `localStorage`
  key and an attribute it sets on `<html>` for a non-default choice. A default sets no attribute, so a
  page with nothing stored carries none: light, normal, nothing forced.
- **The preferences.** Theme (light default, dark), contrast (normal, more, for signed-out visitors
  too), colour-vision palette (default, deuteranopia and protanopia, tritanopia), link underlines,
  motion (follow the system, reduced), line spacing, tab size, Markdown font (normal, fixed-width),
  hovercards, animated-image autoplay, character shortcuts, emoji skin tone.
- **How they apply.** `src/scripts/site.ts`, imported once by `Base.astro`, runs on every page. It
  reads the stored values (guarded: a private window may throw), sets the attributes on `<html>`, keeps
  tabs in step (`storage` event), and exposes `window.oscr` (`setPreference`, `getPreference`,
  `applyPreferences`) for the preferences page and the palette. `science.css` redefines its `:root`
  tokens under `html[data-theme="dark"]`, `html[data-vision=…]`, `html[data-contrast="more"]`, and the
  spacing/tab/font/underline/motion attributes. Reduced motion is honoured from the system on its own
  (`@media (prefers-reduced-motion: reduce)`) and forced by the preference.
- **The page.** `/settings/preferences/` builds its controls from the schema, reads the current values
  on load and writes one on change, in this browser only (zero rows, nothing sent to the Worker). It
  works signed in or out.
- **A known flash.** A reader who chose the dark theme may see one light frame before the script runs:
  the Content-Security-Policy forbids an inline script that would set it sooner (D15-6).

## Keyboard shortcuts

- `src/lib/shortcuts.ts` holds the catalogue, the token a keystroke becomes (`tokenOf`), the matcher
  over a key buffer (`resolve`: single keys, sequences like `g s`, partials, the off switch), and the
  help dialog's view.
- **Global shortcuts** act on every page, carried out by `src/scripts/shortcuts.ts`: `?` opens the
  help, `/` jumps to the search box, `g h/s/b/r/e/n/a` navigate. **Context shortcuts** (reading code:
  `t l w y b e`; lists, issues, pull requests and notifications: `j k o e Shift+U I M`) are dispatched
  as a cancelable `oscr:shortcut` event for the page that owns that view to carry out; a page that does
  not listen ignores them. They match GitHub's keys so researchers keep their habits.
- Nothing fires while a field is focused or a dialog is open. The single-key shortcuts obey the
  `pref.shortcuts` preference; `?` and the palette work either way. The help is a modal `<dialog>`
  (focus trap and Escape for free).

## The command palette

- `src/lib/palette.ts` holds a STATIC index of destinations and in-place commands (switch the theme,
  the contrast, open the shortcut help), the prefix parsing (`#` issues and pull requests, `@` people
  and organizations, `>` or `/` commands), a fuzzy match with highlight ranges, and the grouped,
  ordered results. It lists no entity one by one: a prefix turns the query into a search of the
  registry, so the palette needs no request and no file per entity.
- `src/scripts/palette.ts` wires `Ctrl/Cmd+K` as a modal dialog, a combobox over a listbox
  (`aria-activedescendant`, arrow keys, Enter, Escape, click-outside), and runs a command through
  `window.oscr` or navigates.

## Accessibility

- **The baseline, on every page:** a skip link as the first focusable element, the `<main id="main">`
  landmark it points to, one top heading, the banner and footer landmarks, `lang="en"`. A built-HTML
  audit (`tests/forge-pages/accessibility.test.ts`) checks it across pages from every phase.
- **The statement:** `/accessibility/` says what is in place and where it falls short; every line is
  true of the code.
- **Charts:** the phase-12 SVG charts carry `role="img"`, an `aria-label`, an svg `<title>` and
  `<desc>`, and the same numbers as a table and a CSV, so nothing depends on seeing the shape or
  telling two colours apart.
- Visible focus in every theme (thicker under "More contrast"); math as MathML; status in words, never
  a colour alone.

## Phones and tablets

Every page reflows with no sideways scroll down to 320 to 390 px (checked in the screenshot harness at
390 px: overflow 0). The modal dialogs cap at 90vh, anchor near the top and scroll inside, and widen on
small screens. The responsive rules are `science.css`'s own.

## Localization

`src/lib/strings.ts` holds the new features' interface strings in one place, with a seam for a later
translation: `STRINGS_BY_LANG` and `stringsFor(lang)`, English only for now and the fallback. A
translation is a table of the same shape added later, without touching the modules. The rest of the
pages' own text stays in place for now (D15-7).

## Service status

- `/status/` shows 90 days of availability, the incidents, and the daily free-tier quotas in words,
  and says when it was built (it is static: it changes only on deploy).
- The availability comes from the Mac's OWN outbound checks (`oscr/sitestatus.py`): one GET of the site
  every five minutes, aggregated per day, a run of consecutive failures being one incident. Nothing on
  the site checks itself.
- `src/lib/status-page.ts` turns the data into the view and holds the quota wording;
  `src/data/site-status.json` is generated at build time from the export (a placeholder when the checks
  are not enabled yet).
- **Owner step:** the five-minute checks are a launchd job (or the watchdog) that runs `oscr status
  check`, then `oscr status build` before each deploy. Until then the page says the checks are not
  running yet. The mechanism is built and tested against a fake getter; nothing contacted the outside
  during the build.

## Files

- Libraries: `src/lib/preferences.ts`, `src/lib/shortcuts.ts`, `src/lib/palette.ts`,
  `src/lib/strings.ts`, `src/lib/status-page.ts` (and the chart `<title>`/`<desc>` in
  `src/lib/stats-view.ts`).
- Scripts: `src/scripts/site.ts` (the bootstrap), `src/scripts/shortcuts.ts`, `src/scripts/palette.ts`,
  `src/scripts/preferences.ts`.
- Pages: `src/pages/settings/preferences.astro`, `src/pages/accessibility.astro`,
  `src/pages/status.astro`; `Base.astro` (skip link, main id, the site-wide script, the footer links).
- The Mac: `oscr/sitestatus.py`, `oscr status` (`oscr/cli.py`), the fixture builder
  `tools/make_fixture.py`.
- Tests: `tests/forge-pages/{preferences,shortcuts,palette,strings,accessibility,status-page}.test.ts`
  and `tests/test_sitestatus.py`.
