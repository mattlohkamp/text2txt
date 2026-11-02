// The Save window. background.js stores the selection in chrome.storage.session under a
// one-off id and opens this page with ?id=<that id>. Saving goes through the system Save
// dialog, so the extension doesn't need the "downloads" permission.

const id = new URLSearchParams(location.search).get("id");

const els = {
  filename: document.getElementById("filename"),
  preview: document.getElementById("preview"),
  stats: document.getElementById("stats"),
  status: document.getElementById("status"),
  save: document.getElementById("save"),
  cancel: document.getElementById("cancel")
};

const data = id ? (await chrome.storage.session.get(id))[id] : undefined;
// Delete the stored copy straight away; this page keeps the text in memory from here on.
// (Deleting on close doesn't work: the window is gone before the call finishes.)
if (id) await chrome.storage.session.remove(id);

if (!data) {
  els.filename.textContent = "";
  els.preview.hidden = true;
  els.save.disabled = true;
  setStatus("This selection is no longer available. Select the text and try again.", true);
} else {
  const suggestedName = `${data.name}.txt`;
  els.filename.textContent = suggestedName;
  els.preview.value = data.text;
  els.stats.textContent = describe(data.text);
  document.title = `Save ${suggestedName} – Text2txt`;

  els.save.addEventListener("click", () => save(data.text, suggestedName));
}

els.cancel.addEventListener("click", () => closeWindow());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeWindow();
});

async function save(text, suggestedName) {
  els.save.disabled = true;
  setStatus("");
  try {
    let savedAs;
    if ("showSaveFilePicker" in window) {
      const handle = await showSaveFilePicker({
        id: "text2txt", // Chrome reopens the dialog in the last folder used
        suggestedName,
        types: [{ description: "Text file", accept: { "text/plain": [".txt"] } }]
      });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      savedAs = handle.name;
    } else {
      // Fallback for browsers without the File System Access API: a normal browser download
      const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
      const a = Object.assign(document.createElement("a"), { href: url, download: suggestedName });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      savedAs = suggestedName;
    }
    setStatus(`Saved ${savedAs}`);
    setTimeout(closeWindow, 900);
  } catch (err) {
    if (err?.name === "AbortError") {
      // The user cancelled the Save dialog; leave the window open so they can try again
      els.save.disabled = false;
      return;
    }
    console.error("Save failed:", err);
    setStatus(`Couldn't save the file: ${err?.message || err}`, true);
    els.save.disabled = false;
  }
}

function describe(text) {
  const chars = Array.from(text).length;
  const lines = text ? text.split(/\r\n|\r|\n/).length : 0;
  return `${chars.toLocaleString()} character${chars === 1 ? "" : "s"}, ${lines.toLocaleString()} line${lines === 1 ? "" : "s"}`;
}

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle("error", isError);
}

function closeWindow() {
  window.close();
}
