/* Shared chrome for the v1 mocks: the portal top nav (top-nav.tsx) and a few
   click behaviours so the screens can be clicked through. Not product code. */
(function () {
  const nav = document.querySelector("[data-nav]");
  if (nav) {
    const active = nav.dataset.nav;
    nav.outerHTML = `
<header class="nav"><div class="nav-in">
  <a class="logo" href="host.html"><span class="logo-mark">W</span><b>WebinarLiv</b><span class="beta">Beta</span></a>
  <span class="grow"></span>
  <a class="bell" href="host.html#alerts" title="Alerts"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg><i></i></a>
  <span class="acct">Priya Nair <span class="av sm" style="background:#7c4dff">PN</span></span>
</div></header>`;
  }

  // Row checkboxes: toggle, keep the selection bar count in step.
  const bar = document.querySelector("[data-selbar]");
  function sync() {
    const n = document.querySelectorAll("tbody .check.on").length;
    if (bar) {
      bar.querySelector("[data-n]").textContent = n;
      bar.style.display = n ? "flex" : "none";
    }
  }
  document.querySelectorAll("tbody .check").forEach((c) =>
    c.addEventListener("click", () => {
      c.classList.toggle("on");
      c.closest("tr").classList.toggle("sel", c.classList.contains("on"));
      sync();
    }),
  );
  document.querySelectorAll("[data-chipset] .chip").forEach((c) =>
    c.addEventListener("click", () => {
      c.parentElement.querySelectorAll(".chip").forEach((x) => x.classList.remove("on"));
      c.classList.add("on");
    }),
  );

  // Dialogs open from [data-open=id] and via #id in the URL (for screenshots).
  const show = (id) => { const d = document.getElementById(id); if (d) d.style.display = "flex"; };
  document.querySelectorAll("[data-open]").forEach((b) =>
    b.addEventListener("click", () => show(b.dataset.open)),
  );
  document.querySelectorAll("[data-close]").forEach((b) =>
    b.addEventListener("click", () => (b.closest(".scrim").style.display = "none")),
  );
  if (location.hash) show(location.hash.slice(1));

  // Views switched by #hash: elements with data-view="name" show only when the hash matches.
  const views = document.querySelectorAll("[data-view]");
  if (views.length) {
    const want = location.hash.slice(1);
    const has = [...views].some((v) => v.dataset.view === want);
    views.forEach((v) => (v.style.display = v.dataset.view === (has ? want : views[0].dataset.view) ? "" : "none"));
  }
  if (document.querySelector("[data-hidenote]") || new URLSearchParams(location.search).has("clean"))
    document.querySelectorAll(".note").forEach((n) => n.remove());
})();
