// The copy buttons of a paper's page (its Cite section, and the badge's snippets (Phase 6)) in
// the reader's browser. Progressive: without JavaScript, each text is plain text to select; with
// it, a button after each one copies it, or selects it when the browser does not allow copying.
// The result is said in the section's own status line ([data-copy-status]). Like every browser
// script, it never names the platform.
for (const block of document.querySelectorAll<HTMLElement>("[data-copy]")) {
  const status = block.closest("section")?.querySelector<HTMLElement>("[data-copy-status]") ?? null;
  const say = (text: string) => {
    if (status) status.textContent = text;
  };
  const what = block.dataset.copy || "the citation";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Copy";
  button.setAttribute("aria-label", `Copy ${what}`);
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(block.textContent ?? "");
      say(`Copied ${what}.`);
    } catch {
      const range = document.createRange();
      range.selectNodeContents(block);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      say(`This browser does not let the page copy: ${what} is selected, copy it with the keyboard.`);
    }
  });
  const holder = document.createElement("p");
  holder.append(button);
  (block.closest("p") ?? block).after(holder);
}
