/* Top nav for the simple-funnel mocks. The account menu (open when body[data-menu="open"]) is just
   Settings and Sign out; WhatsApp is the chat icon and Settings → Integrations, and webinars you're
   attending are the Attending tab on the home page. Messages is inbox.html. body[data-title] puts
   that screen's name in the bar; body[data-back] is a link back to Your webinars. */
(function () {
  const nav = document.querySelector("[data-nav]");
  if (nav) {
    const title = document.body.dataset.title || "";
    const backHref = document.body.dataset.back || "";
    const onInbox = /inbox\.html$/.test(location.pathname);
    const back = backHref ? `<a class="nav-back" href="${backHref}">← Your webinars</a><span class="nav-sep"></span>` : "";
    const heading = title ? `<h1 class="nav-title">${title}</h1>` : "";
    nav.outerHTML = `
<header class="nav"><div class="nav-in">
  <a class="logo" href="index.html"><span class="logo-mark">W</span><b>Webinar Liv</b><span class="beta">Beta</span></a>
  ${back}${heading}
  <span class="grow"></span>
  <a class="bell${onInbox ? " on" : ""}" href="inbox.html" title="Messages" style="margin-right:6px"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/></svg><span class="count green" style="position:absolute;top:2px;right:0">4</span></a>
  <a class="bell" href="#" title="Alerts"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg><span class="count" style="position:absolute;top:2px;right:0">1</span></a>
  <span class="acct" style="position:relative">Aarti Menon <span class="av sm a1">AM</span> <span class="faint" style="font-size:10px">▾</span>
    ${document.body.dataset.menu === "open" ? `<div class="card" style="position:absolute;right:0;top:40px;width:220px;padding:6px;z-index:5;box-shadow:0 12px 32px -8px rgba(0,0,0,.18)">
      <div class="xs faint" style="padding:6px 10px">demo@webinarliv.com</div>
      <a href="settings.html" style="display:block;padding:8px 10px;border-radius:6px;font-size:13px;background:var(--surface-2)">Settings</a>
      <div style="height:1px;background:var(--line);margin:4px 0"></div>
      <a href="#" style="display:block;padding:8px 10px;border-radius:6px;font-size:13px;color:var(--ink-2)">Sign out</a>
    </div>` : ""}
  </span>
</div></header>`;
  }
  if (new URLSearchParams(location.search).has("clean")) document.querySelectorAll(".note").forEach((n) => n.remove());
})();
