// The interface's words, in one place (night phase 15, localization). English only for now, but the
// strings the ease-of-use features show (the skip link, the command palette, the keyboard-shortcut
// help, the preferences page's own frame) live here, so a translation can come later without hunting
// through the modules. One object, one language: a future `STRINGS_FR` of the same shape, picked by
// the page's lang, is all it would take (D15-n: the rest of the pages' strings stay in place for now).
//
// Pure data, no DOM, no platform name: a sentence that needs the registry's name takes it from the
// page (src/config.ts) at the call site, as the browser modules already do.

export interface Strings {
  skipToContent: string;
  palette: {
    label: string;
    placeholder: string;
    empty: string;
    hint: string;
    groups: { go: string; commands: string; issues: string; people: string; repos: string };
    close: string;
  };
  shortcuts: {
    title: string;
    open: string;
    close: string;
    disabledNote: string;
  };
  preferences: {
    title: string;
    intro: string;
    reset: string;
    saved: string;
    storageOff: string;
  };
}

export const STRINGS: Strings = {
  skipToContent: "Skip to the content",
  palette: {
    label: "Command palette",
    placeholder: "Jump to a page, or type a command",
    empty: "Nothing matches.",
    hint: "Type to filter. # for issues and pull requests, @ for people and organizations, > for commands. Enter opens, Escape closes.",
    groups: { go: "Go to", commands: "Commands", issues: "Issues and pull requests", people: "People and organizations", repos: "Repositories" },
    close: "Close",
  },
  shortcuts: {
    title: "Keyboard shortcuts",
    open: "Keyboard shortcuts (press ? at any time)",
    close: "Close",
    disabledNote: "Single-key shortcuts are turned off in your preferences. The command palette and this help still work.",
  },
  preferences: {
    title: "Preferences",
    intro: "These choices are kept in this browser only. Nothing is sent to the registry, and they work whether or not you are signed in.",
    reset: "Reset to the defaults",
    saved: "Saved",
    storageOff: "This browser is not keeping the choices (a private window, or site data is blocked). They last until you leave the page.",
  },
};
