/* Collapsed / expanded sidebar.
 *
 * `wl-sidebar` is the saved choice (`collapsed` or `expanded`). It applies at
 * 1280px and wider. Below that the rail is the default until this visit expands
 * it (`side-expanded` on <body>, not saved as the narrow-screen layout).
 *
 * sidebarBootScript() runs from the root layout before first paint. syncSidebarClass()
 * is the same rule after hydration and on resize — React may reset <html>'s class
 * while hydrating, the same way the theme boot script is re-applied. */

export const SIDEBAR_STORAGE_KEY = "wl-sidebar";

export type SidebarChoice = "collapsed" | "expanded";

export function readSidebarChoice(): SidebarChoice | null {
  try {
    const stored = localStorage.getItem(SIDEBAR_STORAGE_KEY);
    return stored === "collapsed" || stored === "expanded" ? stored : null;
  } catch {
    return null;
  }
}

export function writeSidebarChoice(choice: SidebarChoice) {
  try {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, choice);
  } catch {
    // Private mode can refuse storage. The class still updates for this view.
  }
}

/** Rail class for the current width and the saved choice. */
export function syncSidebarClass() {
  const saved = readSidebarChoice();
  const root = document.documentElement;
  if (window.innerWidth < 1280) {
    if (document.body.classList.contains("side-expanded")) {
      root.classList.remove("side-collapsed");
    } else {
      root.classList.add("side-collapsed");
    }
    return;
  }
  document.body.classList.remove("side-expanded");
  if (saved === "collapsed") root.classList.add("side-collapsed");
  else root.classList.remove("side-collapsed");
}

/** Chevron. A nav click must not call this — only the chevron does.
 *  On a phone the chevron closes the drawer. */
export function toggleSidebar() {
  if (window.matchMedia("(max-width: 767px)").matches) {
    document.body.classList.remove("nav-open");
    return;
  }
  const rail = document.documentElement.classList.contains("side-collapsed");
  if (rail) {
    document.documentElement.classList.remove("side-collapsed");
    // side-expanded only overrides the automatic rail below 1280. A choice
    // made on a wide screen must not keep the sidebar open after a shrink.
    if (window.innerWidth < 1280) document.body.classList.add("side-expanded");
    else document.body.classList.remove("side-expanded");
    writeSidebarChoice("expanded");
    return;
  }
  document.documentElement.classList.add("side-collapsed");
  document.body.classList.remove("side-expanded");
  writeSidebarChoice("collapsed");
}

export function sidebarBootScript(): string {
  const key = JSON.stringify(SIDEBAR_STORAGE_KEY);
  return `(function(){try{var s=localStorage.getItem(${key});var n=window.innerWidth<1280;if(n||s==="collapsed")document.documentElement.classList.add("side-collapsed");}catch(e){}})();`;
}
