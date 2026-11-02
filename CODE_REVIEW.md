# Code Review: background.js

**Date:** 2026-11-01
**Scope:** `background.js` (with the filename fallback changes for page filename and site name) and `manifest.json`
**Status:** Fixes #1, #2 and #4–#7 applied and tested in Chrome on 2026-11-01. #3 was made unnecessary by a later change: the extension now saves through the system Save dialog instead of downloading the file. #8 is left as is. See [Fix log](#fix-log).

> **New session?** Read [Session handoff](#session-handoff) at the end of this file first.

## Summary

No real security problems. There's one likely bug that matters: the extension probably never sees the page title, because the manifest doesn't request the permission Chrome needs for that. The selected text also loses its line breaks, and failed downloads give no feedback.

| # | Finding | Severity | Location |
|---|---------|----------|----------|
| 1 | `tab.title` is probably always empty | High | `manifest.json`, `background.js:16` |
| 2 | Selected text loses its line breaks | Medium | `background.js:13` |
| 3 | Failed downloads give no feedback | Medium | `background.js:29-33` |
| 4 | Filename cleanup still lets bad names through | Medium | `background.js:23` |
| 5 | Crash if `tab` is missing | Low | `background.js:16` |
| 6 | Check for untitled pages is a rough guess | Low | `background.js:45` |
| 7 | Duplicate menu warning on reload | Minor | `background.js:3` |
| 8 | Large selections make long data URLs | Minor | `background.js:26` |

---

## Bugs

### 1. `tab.title` is probably always empty

**Location:** `manifest.json` (permissions), `background.js:16`

In Manifest V3, Chrome only fills in `tab.title` and `tab.url` if the extension has the `"tabs"` permission or access to that site. This extension has neither, so `tab.title` is most likely `undefined` on every click.

**Impact:** The original code would always have saved `saved_selection.txt`. With the new fallbacks you'd get the page filename or site name instead, which hides the problem.

**Fix:** Add `"activeTab"` to `permissions` in `manifest.json`. It gives access to the current tab only when the user clicks the menu item, and it doesn't add a warning at install time.

**Note:** This is based on Chrome's documentation. It hasn't been checked in a browser yet. Confirm it by logging `tab.title` before and after the change.

### 2. Selected text loses its line breaks

**Location:** `background.js:13`

Chrome's `info.selectionText` merges whitespace, so a selection with several paragraphs saves as one long line. This is a known, long-standing Chrome behavior.

**Impact:** Probably the most noticeable problem for anyone using the extension.

**Fix:** Read the selection from the page instead:

```js
const [{ result }] = await chrome.scripting.executeScript({
  target: { tabId: tab.id },
  func: () => getSelection().toString()
});
```

This needs the `"scripting"` and `"activeTab"` permissions. Keep `info.selectionText` as a fallback for pages where scripts can't run, such as `chrome://` pages, the Chrome Web Store and the PDF viewer.

### 3. Failed downloads give no feedback

**Location:** `background.js:29-33`

`chrome.downloads.download` returns a promise, and nothing catches errors from it.

**Impact:** If Chrome rejects the filename, nothing happens and the user sees nothing. The gaps in #4 make this more likely.

**Fix:** Add a `.catch()` that retries with `saved_selection.txt`. You could also log the error.

### 4. Filename cleanup still lets bad names through

**Location:** `background.js:23`

The regex replaces the characters Windows doesn't allow (`\ / : * ? " < > |`), but these still get through:

- **Control characters:** tabs, newlines and other characters from `\x00` to `\x1F`
- **Trailing dots or spaces:** Windows strips these, and Chrome may reject or rename the file
- **Reserved Windows names:** `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`
- **No length limit:** very long titles can make the path too long

**Fix:** Remove control characters, trim trailing dots and spaces, add `_` to the end of reserved names, and cap the name at about 150 characters. If the result is empty, use `saved_selection`.

### 5. Crash if `tab` is missing

**Location:** `background.js:16`

`tab` is optional in `contextMenus.onClicked`, so `tab.title` would throw a `TypeError` if it's ever absent.

**Fix:** Use `tab?.title`.

### 6. Check for untitled pages is a rough guess

**Location:** `background.js:45` (`getRealTitle`)

The check treats the title as missing when the page URL ends with it. Two ways this goes wrong:

- **Trailing slash:** Chrome drops the trailing slash when it uses a URL as the title. For `https://example.com/news/`, a title of `example.com/news` doesn't match, so the file saves as `example.com_news.txt`.
- **Real titles that match the URL:** a real title that happens to match the end of the URL is ignored. This is rare, and the page filename fallback usually gives a similar name anyway.

**Fix:** Compare the two after removing the `http://` or `https://` and the trailing slash from both.

---

## Minor

### 7. Duplicate menu warning on reload

**Location:** `background.js:3`

Reloading the extension while developing can log a "Cannot create item with duplicate id" warning.

**Fix:** Call `chrome.contextMenus.removeAll()` before `create`.

### 8. Large selections make long data URLs

**Location:** `background.js:26`

`encodeURIComponent` makes the data URL about 3x longer than the text for non-ASCII content. That's fine at normal sizes. A Blob URL would be leaner, but service workers can't use `URL.createObjectURL`.

**Recommendation:** Leave as is.

---

## Security

No real problems.

- **Download contents:** downloads only ever contain the text the user selected, saved as `text/plain`. Nothing from the page is run.
- **File location:** path separators are replaced, so a page title can't make the file save outside the Downloads folder.
- **Permissions:** minimal (`contextMenus`, `downloads`). Adding `activeTab`, and `scripting` for #2, keeps them limited to the tab the user clicked in.
- **Page-chosen titles (low):** a page can choose its own title. A title like `invoice.pdf` gives `invoice.pdf.txt`, which shows as `invoice.pdf` if Windows hides extensions. Unicode direction-change characters in the title could also make the name look misleading. The file is still harmless text either way. Fix #4 already removes control characters, and it could remove the Unicode direction characters (U+202A–U+202E, U+2066–U+2069) too.

---

## Suggested fix order

1. **One change:** #1, #3, #4, #5 and #6. They're small and mostly touch the same lines.
2. **Separately:** #2, because it adds the `scripting` permission and makes the click handler `async`.
3. **Optional:** #7.

---

## Fix log

Tested in Chrome on 2026-11-01, with the unpacked extension loaded through the DevTools MCP and a manual right-click on `https://example.com/`.

- **#1, confirmed and fixed.** Before the fix, the log showed `tab.title` as `undefined` and the file saved as `example.com.txt`. After adding `"activeTab"`, the log showed `"Example Domain"` and the file saved as `Example Domain.txt`. `activeTab` is enough, so `tabs` and its "Read your browsing history" warning aren't needed. The user wants the extension to ask for as few permissions as possible.
- **#2, confirmed and fixed.** Before the fix, a two-paragraph selection saved with no line breaks. Now `chrome.scripting.executeScript` reads the selection from the frame that was right-clicked, including text selected inside `<textarea>` and `<input>`, and the paragraph breaks are kept. `info.selectionText` is the fallback. Added the `"scripting"` permission, which adds no install warning.
- **#3, fixed.** The download is awaited. If it fails, the extension logs a warning and tries again as `saved_selection.txt`. The retry path hasn't run in Chrome yet.
- **#4, fixed.** `sanitizeFilename()` also removes the Unicode direction characters from the security section. If a name candidate cleans up to nothing, the next fallback is used. Tested with the title `Q3 Report: "draft" <v2> final...`, which saved as `Q3 Report_ _draft_ _v2_ final.txt`.
- **#5, fixed.** Uses `tab?.title`.
- **#6, fixed.** Removes the scheme and trailing slash from both the title and the URL before comparing.
- **Old extension:** the "Download Selection" extension loaded from `TextDownloader` was uninstalled from Chrome. Text2txt is loaded unpacked from this folder.

### Later change: Save dialog replaces automatic downloads

To drop the `downloads` permission and its "Manage your downloads" install warning, the extension no longer downloads the file itself. The user picks where to save and what to call the file.

- **Main path:** the click handler runs `showSaveFilePicker` in the clicked tab's top frame through `chrome.scripting.executeScript` (`saveFromPage` in `background.js`). The system Save dialog opens straight away, with the cleaned-up name filled in. In testing, Chrome treated a script run from a context-menu click as a recent user click, even when the user waited a long time before right-clicking and before choosing the menu item.
- **Fallback:** if Chrome refuses or the page can't run scripts (`chrome://` pages, the Web Store, the PDF viewer), a small popup window (`save.html`, `save.js`, `save.css`) opens. It shows a preview of the text and a **Save…** button, and the button click lets the dialog open. The text reaches the window through `chrome.storage.session` under a one-off id, and the window deletes it as soon as it has read it. Deleting it on close didn't work, because the window closed before the call finished. Tested by opening the window directly. It hasn't been reached through a real script-blocked page yet.
- **Folder memory:** Chrome remembers the dialog's last folder separately for each site, and separately for the fallback window.
- **#3 no longer applies:** there's no download to retry. A failed save shows an error in the window. On the main path, a failure falls back to the window.
- **#7 applied:** `removeAll()` before `create`. The menu item is now "Save Selection as TXT…".

Current permissions: `activeTab`, `contextMenus`, `scripting`, `storage`. None of them adds an install warning.

---

## Session handoff

Notes for picking up this work in a new Claude Code session started in `D:\work\projects\chrome extensions\text2txt`. The earlier session ran in `D:\work\projects\chrome extensions\TextDownloader`, and its history doesn't carry over to this folder.

### What was done in the earlier session

**Filename logic in `background.js`.** The saved file is named by the first of these that gives a value:

1. **Real page title (`getRealTitle`):** treated as missing if it's blank, or if the page URL ends with it. Chrome uses the URL as the tab title when a page has no `<title>`.
2. **Page filename (`getFilenameFromUrl`):** the last part of the URL path, with `%20`-style codes decoded and the extension removed. `.../newsflash.html` gives `newsflash.txt`.
3. **Site name (`getHostnameFromUrl`):** `https://example.com/` gives `example.com.txt`. `www.` is kept, as decided.
4. **Default:** `saved_selection`.

The URL comes from `info.pageUrl`, which context menu clicks always provide and which needs no permission. These helpers were tested in Node only, not in Chrome.

**Project setup:**
- **Name:** the extension was renamed from "Download Selection" to **Text2txt** in `manifest.json`. The right-click menu item still reads "Download Selection as TXT".
- **npm:** `package.json` was created with `"name": "text2txt"` and `"private": true`, so it can't be published to npm by accident. It now has `"license": "MIT"` and `"author": "matt lohkamp"`, matching `LICENSE`.
- **`.gitignore`:** excludes `node_modules/`, `*.zip`, `*.crx`, `*.pem` and `.claude/settings.local.json`.
- **Chrome DevTools MCP:** added for this project only, in `.mcp.json`, using the command from Chrome's [Build extensions with coding agents](https://developer.chrome.com/docs/extensions/ai/build-with-ai) page. The command was changed to `cmd /c npx ...` because on Windows Claude Code can't start `npx` directly.
- **Skill pack:** the user installed it with `npx modern-web-guidance@latest install --choose`. It's in `.agents/skills/` (`chrome-extensions`, `modern-web-guidance`), and `skills-lock.json` records the versions.
- **Repo:** the git repo is `https://github.com/mattlohkamp/text2txt`, branch `main`. The user created it. Only `LICENSE` and `README.md` are committed so far.

### Check at the start of the new session

- [ ] **MCP server:** `chrome-devtools` loads. Approve it when asked, then check with `/mcp`.
- [ ] **Skills:** `chrome-extensions` and `modern-web-guidance` appear in the skills list. They were installed to `.agents/skills/`, and Claude Code may only look in `.claude/skills/` and `~/.claude/skills/`. If they're missing, run the installer again and choose Claude Code as the agent.
- [ ] **Remote debugging:** to test in Chrome, the user opens `chrome://inspect/#remote-debugging` and selects "Allow remote debugging for this browser instance." This is needed in every browser session.

### Still open

- **Fixes from this review:** all done or no longer needed (see [Fix log](#fix-log)).
- **Fallback Save window on a real blocked page:** not tested yet. Try selecting text in Chrome's PDF viewer.
- **First commit:** all files except `LICENSE` and `README.md` are untracked. Ask the user before committing or pushing. Commit `skills-lock.json`. Committing `.agents/` is the user's call.
- **`CHROMEWEBSTORE.md`:** Chrome's guide recommends this file for store listing details and permission justifications. It only matters if the user publishes. If they do, the `activeTab` and `scripting` permissions from fixes #1 and #2 each need a justification.
- **Old folder:** `TextDownloader` can be deleted once the user is happy with the new folder. Leave it unless they ask.
