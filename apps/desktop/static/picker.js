// Screen-share picker. Gets its sources from the main process through the
// `picker` bridge (src/picker-preload.ts) and sends back one choice.
"use strict";

(function () {
  const grid = document.getElementById("grid");
  const empty = document.getElementById("empty");
  const share = document.getElementById("share");
  const audioRow = document.getElementById("audio-row");
  const audio = document.getElementById("audio");
  const tabs = Array.from(document.querySelectorAll(".tabs button"));

  let sources = [];
  let kind = "screen";
  let selected = null;

  function render() {
    grid.replaceChildren();
    const list = sources.filter((s) => s.kind === kind);
    empty.hidden = list.length > 0;
    for (const s of list) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "source";
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(s.id === selected));
      item.title = s.name;

      const thumb = document.createElement("div");
      thumb.className = "thumb";
      if (s.thumbnail) thumb.style.backgroundImage = `url("${s.thumbnail}")`;

      const label = document.createElement("div");
      label.className = "label";
      if (s.icon) {
        const icon = document.createElement("img");
        icon.src = s.icon;
        icon.alt = "";
        label.appendChild(icon);
      }
      const name = document.createElement("span");
      name.textContent = s.name;
      label.appendChild(name);

      item.append(thumb, label);
      item.addEventListener("click", () => {
        selected = s.id;
        share.disabled = false;
        render();
      });
      item.addEventListener("dblclick", () => {
        selected = s.id;
        choose();
      });
      grid.appendChild(item);
    }
  }

  function setKind(next) {
    kind = next;
    for (const t of tabs) t.setAttribute("aria-selected", String(t.dataset.kind === kind));
    if (!sources.some((s) => s.id === selected && s.kind === kind)) {
      selected = null;
      share.disabled = true;
    }
    render();
  }

  function choose() {
    if (!selected) return;
    window.picker.choose(selected, audio.checked);
  }

  for (const t of tabs) t.addEventListener("click", () => setKind(t.dataset.kind));
  share.addEventListener("click", choose);
  document.getElementById("cancel").addEventListener("click", () => window.picker.cancel());
  document.getElementById("open-settings").addEventListener("click", () => window.picker.openScreenSettings());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") window.picker.cancel();
    if (e.key === "Enter") choose();
  });

  window.picker.onInit((init) => {
    sources = init.sources;
    audioRow.hidden = !init.audioAvailable;
    document.getElementById("permission").hidden = !init.needsScreenPermission;
    const screens = sources.filter((s) => s.kind === "screen");
    if (screens.length === 1) selected = screens[0].id;
    share.disabled = !selected;
    setKind(screens.length > 0 ? "screen" : "window");
  });
})();
