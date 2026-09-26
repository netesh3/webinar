/*
  Engage mockups — the shared shell.

  Every screen file contains only its own <main class="page">. The sidebar,
  topbar, icons, screen switcher and the handful of interactions that make the
  demo walkable are built here, so there is exactly one copy of the chrome. If
  the nav gains an item it gains it on all fifteen screens at once — which is
  the whole point of this rebuild.

  Everything is inline: no CDN, no fetch, no build step. Open a screen straight
  off disk and it works.
*/
(() => {
  "use strict";

  /* ------------------------------------------------------------- icon set */
  /* One stroke weight, one 24-grid, one visual voice. Screens ask for these
     with <svg class="icon" data-icon="users"></svg>. */
  const ICONS = {
    grid: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
    users:
      "M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20M9 10.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M22 20v-1.5a4 4 0 0 0-3-3.87M16 3.6a4 4 0 0 1 0 7.75",
    route:
      "M6 3v7a4 4 0 0 0 4 4h4a4 4 0 0 1 4 4v3M6 3 4 5.5M6 3l2 2.5M18 21l-2-2.5M18 21l2-2.5",
    megaphone: "M3 11v2a1 1 0 0 0 1 1h3l7 4V6l-7 4H4a1 1 0 0 0-1 1ZM18 9a3.2 3.2 0 0 1 0 6M7 14v5h3v-4",
    file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4",
    chart: "M3 20h18M7 20v-7M12 20V6M17 20v-4",
    plug: "M9 3v6M15 3v6M6 9h12v3a6 6 0 0 1-12 0zM12 18v3",
    settings:
      "M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4M19.4 14.6a1.4 1.4 0 0 0 .3 1.5l.1.1a1.7 1.7 0 1 1-2.4 2.4l-.1-.1a1.4 1.4 0 0 0-2.4 1v.2a1.7 1.7 0 1 1-3.4 0v-.1a1.4 1.4 0 0 0-2.4-1l-.1.1a1.7 1.7 0 1 1-2.4-2.4l.1-.1a1.4 1.4 0 0 0-1-2.4h-.2a1.7 1.7 0 1 1 0-3.4h.1a1.4 1.4 0 0 0 1-2.4l-.1-.1a1.7 1.7 0 1 1 2.4-2.4l.1.1a1.4 1.4 0 0 0 2.4-1v-.2a1.7 1.7 0 1 1 3.4 0v.1a1.4 1.4 0 0 0 2.4 1l.1-.1a1.7 1.7 0 1 1 2.4 2.4l-.1.1a1.4 1.4 0 0 0 1 2.4h.2a1.7 1.7 0 1 1 0 3.4h-.1a1.4 1.4 0 0 0-1.3.8Z",

    search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16M21 21l-4.3-4.3",
    bell: "M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0",
    help: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M9.1 9.5a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01",
    info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 16v-4M12 8h.01",
    plus: "M12 5v14M5 12h14",
    minus: "M5 12h14",
    check: "M20 6 9 17l-5-5",
    "check-check": "M18 6 7 17l-5-5M22 10l-6.5 6.5",
    x: "M18 6 6 18M6 6l12 12",
    dots: "M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2M19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2M5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2",
    grip: "M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01",

    "chevron-down": "M6 9l6 6 6-6",
    "chevron-up": "M18 15l-6-6-6 6",
    "chevron-right": "M9 18l6-6-6-6",
    "chevron-left": "M15 18l-6-6 6-6",
    "arrow-right": "M5 12h14M13 6l6 6-6 6",
    "arrow-left": "M19 12H5M11 18l-6-6 6-6",
    "arrow-up": "M12 19V5M6 11l6-6 6 6",
    "arrow-down": "M12 5v14M18 13l-6 6-6-6",
    "arrow-down-right": "M7 7v10h10M7 7l10 10",

    send: "M21 3 10.5 13.5M21 3l-6.5 18-4-8-8-4z",
    chat: "M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-4-.9L3 21l2-4a8.4 8.4 0 0 1 3-11.6 8.9 8.9 0 0 1 12 6.6z",
    inbox: "M3 12h5l2 3h4l2-3h5M4.5 5h15l1.5 7v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z",
    mail: "M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3.5 6.5l8.5 6 8.5-6",
    phone:
      "M21.5 16.9v2.6a1.8 1.8 0 0 1-2 1.8 18 18 0 0 1-7.8-2.8 17.6 17.6 0 0 1-5.4-5.4A18 18 0 0 1 3.5 5.2a1.8 1.8 0 0 1 1.8-2h2.6a1.8 1.8 0 0 1 1.8 1.5c.1.9.3 1.7.6 2.5a1.8 1.8 0 0 1-.4 1.9l-1.1 1.1a14.5 14.5 0 0 0 5.4 5.4l1.1-1.1a1.8 1.8 0 0 1 1.9-.4c.8.3 1.6.5 2.5.6a1.8 1.8 0 0 1 1.5 1.8z",
    video: "M22 8.5 16 12l6 3.5zM2 7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z",
    smartphone: "M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1M11 18.5h2",
    mic: "M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3M6 11v1a6 6 0 0 0 12 0v-1M12 18v3",
    smile: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M9 10h.01M15 10h.01M8.5 14.5a4.5 4.5 0 0 0 7 0",

    clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 7.5V12l3 2",
    hourglass: "M7 3h10M7 21h10M8 3v3.5L12 10l4-3.5V3M8 21v-3.5L12 14l4 3.5V21",
    calendar:
      "M5 6h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1M8 3v4M16 3v4M4 11h16",
    bolt: "M13 2 4 14h7l-1 8 9-12h-7z",
    shield: "M12 22s7-3 7-9V6l-7-3-7 3v7c0 6 7 9 7 9M9.5 12l1.8 1.8 3.4-3.6",
    filter: "M3 5h18l-7 8v6l-4 2v-8z",
    sliders: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4",
    upload: "M12 16V4M7 9l5-5 5 5M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2",
    download: "M12 4v12M7 11l5 5 5-5M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2",
    sync: "M20 11a8 8 0 0 0-13.7-5.3L3 9M3 4v5h5M4 13a8 8 0 0 0 13.7 5.3L21 15M21 20v-5h-5",
    external: "M14 4h6v6M20 4l-8.5 8.5M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
    link: "M10 13a4 4 0 0 0 5.7 0l3-3a4 4 0 1 0-5.7-5.7l-1.4 1.4M14 11a4 4 0 0 0-5.7 0l-3 3a4 4 0 1 0 5.7 5.7l1.4-1.4",
    eye: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6",
    edit: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z",
    copy: "M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1",
    trash: "M4 7h16M10 11v6M14 11v6M5 7l1 13a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1l1-13M9 7V4h6v3",
    play: "M7 4.5 19 12 7 19.5z",
    pause: "M9 5v14M15 5v14",
    publish: "M12 19V6M6 11l6-6 6 6M5 21h14",
    layers: "M12 3 3 8l9 5 9-5zM3 13l9 5 9-5M3 17.5l9 5 9-5",
    database:
      "M12 8c5 0 9-1.1 9-2.5S17 3 12 3 3 4.1 3 5.5 7 8 12 8M3 5.5v13C3 19.9 7 21 12 21s9-1.1 9-2.5v-13M3 12c0 1.4 4 2.5 9 2.5s9-1.1 9-2.5",
    webhook:
      "M9 9.5a3.5 3.5 0 1 1 5 3.2M7.5 20a3.5 3.5 0 1 1 2.6-5.8M18 20a3.5 3.5 0 1 1-3.3-4.7M10 20h5M8.3 12.8 6 16.5M14 11l2.4 4",
    tag: "M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9zM7.5 8h.01",
    "user-plus": "M15 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20M8.5 10.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M19 8v6M22 11h-6",
    logout: "M9 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4M16 17l5-5-5-5M21 12H9",
    building:
      "M4 21V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v16M15 21V10h3a2 2 0 0 1 2 2v9M3 21h18M8 7h3M8 11h3M8 15h3",
    key: "M14.5 9.5a4 4 0 1 1-1.6 3.2L4 21.5 2.5 20l1.5-1.5L2.5 17 4 15.5 12.8 7a4 4 0 0 1 1.7 2.5M17.5 7.5h.01",
    badge: "M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1M12 11.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4M8 16.5a4 4 0 0 1 8 0",
    card: "M3 7a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM3 10h18M7 14.5h3",
    globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M3.5 9h17M3.5 15h17M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18",
    star: "m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z",
    lightbulb: "M9 18h6M10 21h4M12 3a6 6 0 0 1 3.6 10.8c-.6.5-.9 1-1 1.7l-.1.5H9.5l-.1-.5c-.1-.7-.4-1.2-1-1.7A6 6 0 0 1 12 3",
    target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9M12 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3",
    split: "M6 21V9a4 4 0 0 1 4-4h8M18 5l-3-3M18 5l-3 3M6 21h12a4 4 0 0 0 4-4M22 17l-3-3M22 17l-3 3",
    rule: "M4 6h7M4 12h7M4 18h7M15 6h5M15 12h5M15 18h5",
    activity: "M3 12h4l3 8 4-16 3 8h4",
    "trending-up": "M3 17l6-6 4 4 8-8M15 7h6v6",
    gauge: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 13l4-4M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2",
    alert: "M12 3 2 20h20zM12 10v4M12 17h.01",
    table: "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1M3 10h18M9 10v9",
    sheet: "M5 3h14a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1M4 9h16M4 15h16M10 9v12",
    maximize: "M8 3H4a1 1 0 0 0-1 1v4M16 3h4a1 1 0 0 1 1 1v4M8 21H4a1 1 0 0 1-1-1v-4M16 21h4a1 1 0 0 0 1-1v-4",
    cursor: "M5 3l6 17 2.5-6.5L20 11z",
    hand: "M8 12V5.5a1.5 1.5 0 0 1 3 0V11M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-.5A6.5 6.5 0 0 1 3 14.5v-2a1.5 1.5 0 0 1 3 0",
    book: "M4 4.5A2.5 2.5 0 0 1 6.5 2H20v16H6.5A2.5 2.5 0 0 0 4 20.5zM4 20.5A2.5 2.5 0 0 1 6.5 18H20v4H6.5A2.5 2.5 0 0 1 4 19.5z",
    flask: "M10 3h4M10.5 3v6.5L5 19a1.5 1.5 0 0 0 1.3 2.3h11.4A1.5 1.5 0 0 0 19 19l-5.5-9.5V3M8 15h8",
    percent: "M19 5 5 19M7.5 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4M16.5 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4",
    money: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10M3 7h2M19 7h2M3 17h2M19 17h2M12 10v4M10.7 11h2.6M10.7 13h2.6",
    verified: "m12 2.5 2.3 1.7 2.8-.3 1 2.7 2.4 1.6-1 2.8 1 2.8-2.4 1.6-1 2.7-2.8-.3L12 21.5l-2.3-1.7-2.8.3-1-2.7-2.4-1.6 1-2.8-1-2.8 2.4-1.6 1-2.7 2.8.3zM9 12l2 2 4-4",
    lock: "M6 10h12a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1M8 10V7a4 4 0 0 1 8 0v3M12 15v2",
    paperclip: "M20 11.5 12.4 19a4.5 4.5 0 0 1-6.4-6.4l7.6-7.6a3 3 0 0 1 4.3 4.3l-7.6 7.6a1.5 1.5 0 0 1-2.2-2.1l6.9-6.9",
    "user-check": "M16 20v-1.5a4.5 4.5 0 0 0-4.5-4.5h-4A4.5 4.5 0 0 0 3 18.5V20M9.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M16.5 11.5l2 2 4-4",
  };

  const svg = (name, cls) => {
    const d = ICONS[name];
    return (
      `<svg class="${cls || "icon"}" viewBox="0 0 24 24" aria-hidden="true">` +
      (d ? `<path d="${d}"/>` : "") +
      "</svg>"
    );
  };

  /* ------------------------------------------------------------ screen map */
  const NAV = [
    { slug: "dashboard", label: "Dashboard", icon: "grid" },
    { slug: "inbox", label: "Inbox", icon: "inbox", count: "7" },
    { slug: "contacts", label: "Contacts", icon: "users", count: "24,892" },
    { slug: "journeys", label: "Journeys", icon: "route", count: "8" },
    { slug: "campaigns", label: "Campaigns", icon: "megaphone", count: "18" },
    { slug: "templates", label: "Templates", icon: "file", count: "14" },
    { slug: "analytics", label: "Analytics", icon: "chart" },
    { slug: "integrations", label: "Integrations", icon: "plug" },
    { slug: "settings", label: "Settings", icon: "settings" },
  ];

  /* Sub-screens keep their parent lit in the sidebar. */
  const PARENT = {
    "inbox-session-closed": "inbox",
    "journey-builder": "journeys",
    "journey-builder-spacious": "journeys",
    "step-branch-rules": "journeys",
    "modal-create-journey": "journeys",
    "modal-create-campaign": "campaigns",
    "modal-import-contacts": "contacts",
    "settings-channels": "settings",
  };

  const JUMP = [
    {
      group: "Main",
      items: [
        ["dashboard", "Dashboard"],
        ["inbox", "Inbox — session open"],
        ["inbox-session-closed", "Inbox — session expired"],
        ["contacts", "Contacts & audience"],
        ["journeys", "Journeys"],
        ["campaigns", "Campaigns & broadcasts"],
        ["templates", "Templates"],
        ["analytics", "Analytics & conversions"],
        ["integrations", "Integrations"],
        ["settings", "Settings"],
      ],
    },
    {
      group: "Journey builder",
      items: [
        ["journey-builder", "Builder — inspector open"],
        ["journey-builder-spacious", "Builder — spacious canvas"],
        ["step-branch-rules", "Step & branch rules"],
      ],
    },
    {
      group: "Dialogs",
      items: [
        ["modal-create-journey", "Create journey"],
        ["modal-create-campaign", "Create campaign wizard"],
        ["modal-import-contacts", "Add & import contacts"],
      ],
    },
    {
      group: "Settings detail",
      items: [["settings-channels", "Integrations & channels"]],
    },
  ];

  /* --------------------------------------------------------------- shell */
  const body = document.body;
  const slug = body.dataset.screen;
  const active = PARENT[slug] || slug;
  const page = document.querySelector("main.page");
  const overlay = document.querySelector(".overlay");
  if (overlay) overlay.remove();

  const el = (html) => {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  };

  /* The contact sheet has no data-screen and wants no app chrome — it still
     wants the icon set, the toasts and the click wiring below. */
  if (slug) buildChrome();

  function buildChrome() {
    const navItems = NAV.map((n) => {
      const current = n.slug === active ? ' aria-current="page"' : "";
      const count = n.count ? `<em class="nav-count">${n.count}</em>` : "";
      return `<a href="${n.slug}.html"${current}>${svg(n.icon)}<span>${n.label}</span>${count}</a>`;
    }).join("");

    const shell = el(`
      <div class="app">
        <aside class="sidebar">
          <div class="brand">
            <span class="brand-mark">${svg("chat", "icon icon-sm")}</span>
            <span>
              <span class="brand-name">Engage</span>
              <span class="brand-sub">Webinar Liv</span>
            </span>
          </div>
          <button class="workspace" data-toast="Workspace switcher — one workspace in this mockup.">
            ${svg("building")}
            <span>
              <span class="workspace-name">Acme Growth Co</span>
              <span class="brand-sub">Production</span>
            </span>
            ${svg("chevron-down", "icon icon-sm right")}
          </button>
          <nav class="nav">
            <div class="nav-label">Workspace</div>
            ${navItems}
          </nav>
          <div class="health">
            <div class="health-top">${svg("verified", "icon icon-sm")} WABA connected · Healthy</div>
            <div class="health-meta">+1 555-0192 · Tier 1 · 1,000/day</div>
          </div>
          <div class="account">
            <span class="avatar">GS</span>
            <span>
              <span class="account-name">Ganesh S P</span>
              <span class="account-role">Owner / Admin</span>
            </span>
            <button class="icon-btn right" title="Sign out" data-toast="Sign out is not wired in this mockup.">
              ${svg("logout")}
            </button>
          </div>
        </aside>
        <div class="main">
          <header class="topbar">
            <div class="crumb"></div>
            <button class="topbar-search" data-toast="Global search is not wired in this mockup.">
              ${svg("search", "icon icon-sm")} Search contacts, journeys…
              <kbd>⌘K</kbd>
            </button>
            <button class="icon-btn" title="Help" data-toast="Help centre is not wired in this mockup.">${svg("help")}</button>
            <button class="icon-btn" title="Notifications" data-toast="3 unread notifications — not wired in this mockup.">${svg("bell")}</button>
            <a class="btn btn-primary" href="modal-create-campaign.html">${svg("plus", "icon icon-sm")} New broadcast</a>
          </header>
        </div>
      </div>
    `);

    /* Breadcrumb: "Journeys / Webinar onboarding", last segment bold. */
    const crumbText = body.dataset.crumb || "Platform / Production";
    const parts = crumbText.split("/").map((s) => s.trim());
    shell.querySelector(".crumb").innerHTML = parts
      .map((p, i) =>
        i === parts.length - 1 ? `<b>${p}</b>` : `${p}<span class="sep">/</span>`,
      )
      .join(" ");

    if (page) {
      if (body.dataset.layout === "wide") page.classList.add("page-wide");
      shell.querySelector(".main").appendChild(page);
    }
    body.prepend(shell);

    if (overlay) body.appendChild(overlay);

    /* Screen switcher — reaches the screens no sidebar item names. */
    body.appendChild(
      el(`
        <details class="jump">
          <summary>${svg("layers", "icon icon-sm")} Screens</summary>
          <div class="jump-menu">
            ${JUMP.map(
              (g) =>
                `<h4>${g.group}</h4>` +
                g.items
                  .map(
                    ([s, label]) =>
                      `<a href="${s}.html"${s === slug ? ' aria-current="page"' : ""}>${label}</a>`,
                  )
                  .join(""),
            ).join("")}
            <h4>Reference</h4>
            <a href="../index.html">Contact sheet &amp; design system</a>
          </div>
        </details>
      `),
    );
  }

  const toasts = el('<div class="toasts" aria-live="polite"></div>');
  body.appendChild(toasts);

  /* ------------------------------------------------------------ hydration */
  function hydrate(scope) {
    scope.querySelectorAll("svg[data-icon]").forEach((node) => {
      const d = ICONS[node.dataset.icon];
      if (d) node.innerHTML = `<path d="${d}"/>`;
      node.setAttribute("viewBox", "0 0 24 24");
      node.setAttribute("aria-hidden", "true");
      if (!node.classList.contains("icon")) node.classList.add("icon");
    });
  }

  hydrate(document);

  /* --------------------------------------------------------- interactions */
  let toastTimer;
  function toast(message) {
    const node = el(`<div class="toast">${svg("info", "icon icon-sm")}<span></span></div>`);
    node.querySelector("span").textContent = message;
    toasts.appendChild(node);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      while (toasts.firstChild) toasts.firstChild.remove();
    }, 2600);
  }

  function selectIn(group, button) {
    Array.from(group.children).forEach((sibling) => {
      if (sibling.tagName === "BUTTON")
        sibling.setAttribute("aria-selected", String(sibling === button));
    });
  }

  /* -------------------------------------------------------------- wizard */
  /* A multi-step dialog is the one place where a static mockup stops being
     honest: the steps either side of the one on screen are the interesting
     part. Panels carry their own footer in a <template>, so each step owns
     its wording and its primary action. */
  const wizard = document.querySelector("[data-wizard]");
  const panels = wizard ? Array.from(wizard.querySelectorAll("[data-step]")) : [];
  let at = 0;
  /* Stepping back must not un-complete the steps already walked, or the rail
     becomes a one-way trip the second time through. */
  let reached = 0;

  function drawRail() {
    const rail = wizard.querySelector("[data-steps]");
    if (!rail) return;
    rail.innerHTML = panels
      .map((panel, i) => {
        const state = i < at ? " step-done" : i === at ? " step-now" : "";
        const mark = i < at ? svg("check", "icon icon-sm") : i + 1;
        const lock = i > reached ? " disabled" : "";
        return `<button class="step${state}" data-wiz-go="${i}"${lock}><i>${mark}</i> ${panel.dataset.stepTitle}</button>`;
      })
      .join('<span class="step-sep"></span>');
  }

  function drawFoot() {
    const foot = wizard.querySelector("[data-wizard-foot]");
    const template = panels[at].querySelector("template[data-foot]");
    if (!foot || !template) return;
    foot.innerHTML = template.innerHTML;
    hydrate(foot);
  }

  function goToStep(next, rewind) {
    at = Math.max(0, Math.min(panels.length - 1, next));
    reached = rewind ? at : Math.max(reached, at);
    panels.forEach((panel, i) => (panel.hidden = i !== at));
    drawRail();
    drawFoot();
    const scroller = wizard.querySelector(".modal-body");
    if (scroller) scroller.scrollTop = 0;
  }

  function showPanel(scope, name) {
    scope.querySelectorAll("[data-tabpanel]").forEach((p) => {
      if (p.closest("[data-tabs]") === scope)
        p.hidden = p.dataset.tabpanel !== name;
    });
  }

  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[href]");
    if (link && !link.getAttribute("href").startsWith("#")) return;

    const wizStep = event.target.closest("[data-wiz], [data-wiz-go]");
    if (wizStep) {
      const move = wizStep.dataset.wiz;
      if (move === "next") goToStep(at + 1);
      else if (move === "back") goToStep(at - 1);
      else if (move === "restart") goToStep(0, true);
      else goToStep(Number(wizStep.dataset.wizGo));
      if (wizStep.dataset.toast) toast(wizStep.dataset.toast);
      return;
    }

    /* Tabs and segmented controls share one selection model. */
    const tab = event.target.closest(".tabs button, .seg button");
    if (tab) {
      selectIn(tab.parentElement, tab);
      const scope = tab.closest("[data-tabs]");
      if (scope && tab.dataset.panel) showPanel(scope, tab.dataset.panel);
      if (tab.dataset.toast) toast(tab.dataset.toast);
      return;
    }

    const radio = event.target.closest(".radio-card");
    if (radio) {
      const group = radio.closest("[data-radiogroup]");
      if (group)
        group
          .querySelectorAll(".radio-card")
          .forEach((c) => c.setAttribute("aria-checked", String(c === radio)));
      else radio.setAttribute("aria-checked", "true");
      if (radio.dataset.toast) toast(radio.dataset.toast);
      return;
    }

    const toggle = event.target.closest(".switch, .check");
    if (toggle) {
      const on = toggle.getAttribute("aria-checked") !== "true";
      toggle.setAttribute("aria-checked", String(on));
      if (toggle.classList.contains("check"))
        toggle.innerHTML = on ? svg("check", "icon") : "";
      if (toggle.dataset.toast) toast(`${toggle.dataset.toast} — ${on ? "on" : "off"}`);
      return;
    }

    const zoomBtn = event.target.closest("[data-zoom]");
    if (zoomBtn) {
      const bar = zoomBtn.closest(".zoom");
      const out = bar.querySelector("output");
      const flow = document.querySelector(".flow");
      let pct = parseInt(out.textContent, 10) || 100;
      if (zoomBtn.dataset.zoom === "in") pct = Math.min(140, pct + 10);
      else if (zoomBtn.dataset.zoom === "out") pct = Math.max(60, pct - 10);
      else pct = 100;
      out.textContent = `${pct}%`;
      if (flow) {
        flow.style.transformOrigin = "top center";
        flow.style.transform = `scale(${pct / 100})`;
      }
      return;
    }

    /* Reference material that would otherwise pad the page out: hidden until
       a control asks for it, and hidden again by the same control. */
    const reveal = event.target.closest("[data-reveal]");
    if (reveal) {
      const panel = document.getElementById(reveal.dataset.reveal);
      if (panel) {
        const opening = panel.hidden;
        panel.hidden = !opening;
        document
          .querySelectorAll(`[data-reveal="${reveal.dataset.reveal}"]`)
          .forEach((b) => b.setAttribute("aria-expanded", String(opening)));
        if (opening) panel.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      return;
    }

    const close = event.target.closest("[data-close]");
    if (close) {
      const dialog = document.querySelector(".overlay");
      if (dialog) {
        dialog.hidden = true;
        toast("Dialog dismissed. Reload the screen to bring it back.");
      }
      return;
    }

    const chipX = event.target.closest(".tag button");
    if (chipX) {
      const chip = chipX.closest(".tag");
      toast(`Removed ${chip.textContent.trim()}`);
      chip.remove();
      return;
    }

    /* Anything else that looks like an action says so rather than dead-ending. */
    const action = event.target.closest("button, a[href='#']");
    if (action) {
      event.preventDefault();
      toast(action.dataset.toast || "Not wired in this mockup.");
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const dialog = document.querySelector(".overlay:not([hidden])");
    if (dialog) dialog.hidden = true;
  });

  /* ?step=4 opens the wizard on that layer, so a step can be linked to and
     screenshotted without a click. Everything before it counts as walked. */
  if (wizard) {
    const asked = Number(new URLSearchParams(location.search).get("step"));
    goToStep(asked > 0 ? asked - 1 : 0);
  }

  /* Selects are real controls; acknowledge a change so the demo feels alive. */
  document.addEventListener("change", (event) => {
    const select = event.target.closest("select");
    if (!select) return;
    toast(`${select.dataset.label || "Filter"}: ${select.selectedOptions[0].text}`);
  });
})();
