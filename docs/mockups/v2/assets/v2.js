/* Shared chrome for the v2 mocks: the portal top nav as it is today (top-nav.tsx),
   the Hosting tabs, and #hash-switched views. Not product code. */
(function () {
  const nav = document.querySelector("[data-nav]");
  if (nav) {
    nav.outerHTML = `
<header class="nav"><div class="nav-in">
  <a class="logo" href="index.html"><span class="logo-mark">W</span><b>Webinar Liv</b><span class="beta">Beta</span></a>
  <span class="grow"></span>
  <a class="bell" href="home.html" title="Alerts"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg><span class="count" style="position:absolute;top:2px;right:0">4</span></a>
  <span class="acct">Aarti Menon <span class="av sm a1">AM</span></span>
</div></header>`;
  }

  const tabs = document.querySelector("[data-hosttabs]");
  if (tabs) {
    const on = tabs.dataset.hosttabs;
    const t = (id, label, href, count, cls = "") =>
      `<a class="tab ${on === id ? "on" : ""}" href="${href}">${label}${count ? ` <span class="count ${cls}">${count}</span>` : ""}</a>`;
    tabs.outerHTML = `<div class="tabs">
      ${t("upcoming", "Upcoming", "home.html", "1")}${t("past", "Past", "#", "2")}${t("drafts", "Drafts", "#")}${t("watch", "WatchList", "#")}
      <span class="tabsep"></span>
      ${t("people", "People", "people.html", "14")}${t("messages", "Messages", "inbox.html", "4", "green")}
    </div>`;
  }

  const views = document.querySelectorAll("[data-view]");
  if (views.length) {
    const want = location.hash.slice(1);
    const has = [...views].some((v) => v.dataset.view === want);
    views.forEach((v) => (v.style.display = v.dataset.view === (has ? want : views[0].dataset.view) ? "" : "none"));
  }
  document.querySelectorAll("[data-chipset] .chip").forEach((c) =>
    c.addEventListener("click", () => {
      c.parentElement.querySelectorAll(".chip").forEach((x) => x.classList.remove("on"));
      c.classList.add("on");
    }),
  );
  if (new URLSearchParams(location.search).has("clean")) document.querySelectorAll(".note").forEach((n) => n.remove());
})();
