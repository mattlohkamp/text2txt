const DEFAULT_NAME = "saved_selection";
const MAX_NAME_LENGTH = 150;

// Create the context menu item when the extension installs
// (removeAll first, so reloading or updating doesn't hit a "duplicate id" error)
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: "download-selection",
    title: "Save Selection as TXT…", // "…" because it opens a window before saving
    contexts: ["selection"] // Only shows up when text is highlighted
  });
});

// Listen for clicks on the context menu
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "download-selection") return;

  // Prefer the tab title, then the page's filename, then the site's hostname, then a default string.
  // Each candidate is sanitized first, so one that cleans up to nothing falls through to the next.
  // tab.title is only filled in because of the "activeTab" permission (granted by the menu click).
  const baseName = [
    getRealTitle(tab?.title, info.pageUrl),
    getFilenameFromUrl(info.pageUrl),
    getHostnameFromUrl(info.pageUrl)
  ].map(sanitizeFilename).find(Boolean) || DEFAULT_NAME;

  try {
    const text = await getSelectedText(info, tab);

    // First try opening the Save dialog straight from the page (see saveFromPage).
    const outcome = await saveFromPage(tab, text, `${baseName}.txt`);
    if (outcome.status === "unavailable") console.info("Save dialog unavailable in the page, opening the Save window:", outcome.reason);
    if (outcome.status === "saved" || outcome.status === "cancelled") return;

    // Otherwise fall back to the Save window, whose button provides the click the dialog needs.
    // Hand the text to the Save window through session storage (memory only, cleared when the
    // browser closes). The id keeps several Save windows from mixing up their text.
    const id = crypto.randomUUID();
    await chrome.storage.session.set({ [id]: { text, name: baseName } });
    await openSaveWindow(id, tab?.windowId);
  } catch (err) {
    console.error("Couldn't open the Save window:", err);
  }
});

// Opens the system Save dialog (showSaveFilePicker) from the clicked tab's top frame. The dialog
// needs a recent user click in the page; in testing (Chrome, 2026-11-01) a script run from a
// context-menu click counted as one, even after long waits. Reports "unavailable" when Chrome
// refuses or the page can't run scripts (chrome:// pages, the Web Store, the PDF viewer), so the
// caller can fall back to the Save window. The page's own scripts can't see the text or the file,
// because executeScript runs in a separate (isolated) world.
async function saveFromPage(tab, text, suggestedName) {
  if (tab?.id === undefined || tab.id < 0) return { status: "unavailable", reason: "no tab" };
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      args: [text, suggestedName],
      func: async (text, suggestedName) => {
        if (!("showSaveFilePicker" in window)) return { status: "unavailable", reason: "no API" };
        try {
          const handle = await showSaveFilePicker({
            id: "text2txt",
            suggestedName,
            types: [{ description: "Text file", accept: { "text/plain": [".txt"] } }]
          });
          const writable = await handle.createWritable();
          await writable.write(text);
          await writable.close();
          return { status: "saved", name: handle.name };
        } catch (err) {
          if (err?.name === "AbortError") return { status: "cancelled" };
          return { status: "unavailable", reason: `${err?.name}: ${err?.message}` };
        }
      }
    });
    return result ?? { status: "unavailable", reason: "no result" };
  } catch (err) {
    return { status: "unavailable", reason: err?.message };
  }
}

const SAVE_WINDOW_SIZE = { width: 560, height: 480 };

// Opens save.html in a small popup window, centered over the browser window that was clicked in.
async function openSaveWindow(id, parentWindowId) {
  const position = {};
  if (parentWindowId !== undefined) {
    try {
      const parent = await chrome.windows.get(parentWindowId);
      position.left = Math.round(parent.left + (parent.width - SAVE_WINDOW_SIZE.width) / 2);
      position.top = Math.round(parent.top + (parent.height - SAVE_WINDOW_SIZE.height) / 2);
    } catch (e) {} // Let Chrome place it
  }
  await chrome.windows.create({
    url: chrome.runtime.getURL(`save.html?id=${encodeURIComponent(id)}`),
    type: "popup",
    ...SAVE_WINDOW_SIZE,
    ...position
  });
}

// Reads the selection straight from the page so line breaks are kept.
// info.selectionText collapses all whitespace, so it's only the fallback for pages
// where scripts can't run (chrome:// pages, the Chrome Web Store, the PDF viewer, etc.).
async function getSelectedText(info, tab) {
  if (tab?.id !== undefined && tab.id >= 0) {
    try {
      const [{ result } = {}] = await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [info.frameId ?? 0] },
        func: readSelection
      });
      if (result) return result;
    } catch (err) {
      console.info("Couldn't read the selection from the page, using the menu's copy instead:", err?.message);
    }
  }
  return info.selectionText || "";
}

// Runs in the page. getSelection() doesn't see text selected inside <textarea> or <input>,
// so those are read from the field directly.
function readSelection() {
  const el = document.activeElement;
  if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT") &&
      typeof el.selectionStart === "number" && el.selectionStart !== el.selectionEnd) {
    return el.value.slice(el.selectionStart, el.selectionEnd);
  }
  return getSelection().toString();
}

// Turns any string into a filename that's safe on Windows, macOS and Linux.
// It's only the suggested name in the Save dialog; the user can still change it there.
// Returns an empty string if nothing usable is left.
function sanitizeFilename(name) {
  if (!name) return "";
  let safe = name
    // Control characters (tabs, newlines, etc.) and Unicode direction overrides, which can make a name look misleading
    .replace(/[\x00-\x1F\x7F‪-‮⁦-⁩]/g, "")
    // Characters Windows doesn't allow: \ / : * ? " < > |
    .replace(/[\\/:*?"<>|]/g, "_")
    .trim();
  // Cap the length, counting by code points so emoji etc. aren't cut in half
  safe = Array.from(safe).slice(0, MAX_NAME_LENGTH).join("");
  // Leading dots make hidden files (and ".." is a path); Windows strips trailing dots and spaces
  safe = safe.replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");
  // Reserved Windows device names, which also count with any extension (e.g. "CON.txt", "nul.tar")
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(safe)) safe += "_";
  return safe;
}

// Returns the tab title, or null if the page has no real <title>.
// When a page lacks a <title>, Chrome uses the URL as the tab title, usually without the
// scheme and the trailing slash, so both are removed before comparing.
function getRealTitle(title, pageUrl) {
  const trimmed = (title || "").trim();
  if (!trimmed) return null;
  if (pageUrl) {
    const normalizedTitle = stripSchemeAndTrailingSlash(trimmed);
    let decodedUrl = pageUrl;
    try { decodedUrl = decodeURI(pageUrl); } catch (e) {}
    for (const url of [pageUrl, decodedUrl]) {
      if (normalizedTitle && stripSchemeAndTrailingSlash(url).endsWith(normalizedTitle)) return null;
    }
  }
  return trimmed;
}

function stripSchemeAndTrailingSlash(s) {
  return s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/+$/, "");
}

// Returns the last path segment without its extension, e.g. ".../newsflash.html" -> "newsflash".
// Returns null if the URL has no filename (e.g. "https://example.com/").
function getFilenameFromUrl(pageUrl) {
  try {
    const segments = new URL(pageUrl).pathname.split("/").filter(Boolean);
    if (!segments.length) return null;
    let name = segments[segments.length - 1];
    try { name = decodeURIComponent(name); } catch (e) {}
    name = name.replace(/\.[^.]+$/, "").trim();
    return name || null;
  } catch (e) {
    return null;
  }
}

// Returns the site's hostname, e.g. "https://example.com/" -> "example.com".
// Returns null if the URL has no hostname (e.g. some file:// URLs).
function getHostnameFromUrl(pageUrl) {
  try {
    return new URL(pageUrl).hostname || null;
  } catch (e) {
    return null;
  }
}
