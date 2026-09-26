/* demo.js — makes the Stitch exports walkable.
 *
 * The exports arrive as static documents: every link is href="#" and most buttons do
 * nothing. wire.py points the links at each other; this file handles everything that is
 * not a link — tabs, filters, search boxes, dropdowns, toggles, canvas zoom, the modals'
 * close buttons — and, where a control could only ever be faked, says so in a toast
 * instead of swallowing the click. Nothing here is real: there is no data behind it.
 *
 * GAP-FILLING ONLY. Nine of the screens ship their own inline behaviour script (journeys
 * has a working create-journey modal, contacts a detail drawer, campaigns a preview
 * slide-over, templates a sync simulation, step-branch-rules a test modal, the spacious
 * canvas its tool switcher…). Those handlers are the designer's intent and must win, so
 * this file first works out which elements the page already owns — by resolving the
 * selectors that appear in its own scripts — and then never touches them. That is why the
 * demo layer needs no per-screen special-casing and cannot double-handle a click.
 *
 * Loaded by every screen as <script src="../demo.js" data-demo>, injected by wire.py.
 */
(function () {
  "use strict";

  var HERE = location.pathname.split("/").pop().replace(/\.html$/, "");
  var IS_MODAL = /^modal-/.test(HERE);

  /* ---------------------------------------------------------------- what's already wired
   * Every selector the screen's own script asks for, resolved to elements. An element is
   * "owned" if it or any ancestor is one of those, or carries an inline onclick (contacts
   * uses onclick="selectContact(3)"), or is a native form control the browser handles.
   */
  var owned = new Set();

  /* If the screen's own script threw, its bindings are not there to respect. wire.py puts a
   * one-line error recorder at the top of <head> precisely so this is knowable: exec-logs'
   * script, for one, dies on `searchInput.addEventListener` because the markup calls that
   * input logSearchInput, and everything it would have bound after that line is dead. In
   * that case the demo layer takes the screen over — except for inline onclick handlers,
   * which liveInline() checks individually. */
  var broke = (window.__demoErrors || []).length > 0;
  if (broke)
    console.info("demo.js: this export's own script threw (" + window.__demoErrors[0] + ") — taking its controls over.");

  /* Naming a selector is not the same as binding one. journeys.html looks up .journey-row
   * only to hide rows as you type in its search box; treating that as ownership left every
   * row's Options button dead, because demo.js kept its hands off a control nothing was
   * listening to. So a selector is only respected when the script binds a listener to it:
   * the statement carrying the addEventListener — plus the statement before it, for the
   * `const btn = …; btn.addEventListener(…)` shape — must mention either the selector text
   * or the variable it was assigned to. `tabs.forEach(tab => tab.addEventListener('click'…))`
   * mentions `tabs`, which is why the variable and not just the literal is checked. */
  var BIND =
    /\.addEventListener\(\s*['"](?:click|input|change|keyup|keydown|submit|mousedown|pointerdown)['"]|\.onclick\s*=/;
  var LOOKUP =
    /(?:(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*)?[A-Za-z_$][\w$.]*\.(getElementById|querySelector|querySelectorAll)\(\s*['"`]([^'"`]+)['"`]/g;

  Array.prototype.forEach.call(broke ? [] : document.scripts, function (s) {
    if (s.src || s.id === "tailwind-config" || s.hasAttribute("data-demo")) return;
    var text = s.textContent;
    var stmts = text.split(/[;{}]/);
    var bound = "";
    stmts.forEach(function (stmt, i) {
      if (BIND.test(stmt)) bound += (i ? stmts[i - 1] : "") + stmt + "\n";
    });

    var m;
    while ((m = LOOKUP.exec(text))) {
      var name = m[1];
      var raw = m[3];
      if (bound.indexOf(raw) < 0 && !(name && new RegExp("\\b" + name + "\\b").test(bound))) continue;
      try {
        document.querySelectorAll(m[2] === "getElementById" ? "#" + raw : raw).forEach(function (el) {
          owned.add(el);
        });
      } catch (e) {
        /* a template-literal selector with ${} in it — not ours to resolve */
      }
    }
  });

  function isOwned(el) {
    for (var n = el; n; n = n.parentElement) {
      if (n.id === "demo-switcher") return true;
      if (liveInline(n)) return true;
      if (owned.has(n) && (n === el || confers(n, el))) return true;
    }
    return false;
  }

  /* Ownership is inherited from a clickable ancestor — a table row the export made
   * selectable — but NOT from a mere container. contacts.html's script names
   * #table-container to resize it, and letting that own everything inside would hand it the
   * filter buttons and the pager too, which it does nothing with.
   *
   * Nor does a listening row own a button inside it. campaigns.html says so in its own
   * comment — `if (e.target.closest('button')) return; // ignore more_vert clicks` — so the
   * row's listener is not a reason to leave that button dead. An inline onclick ancestor is
   * the exception, handled above: that one really does fire when the click bubbles. */
  function confers(n, el) {
    if (el !== n && /^(BUTTON|A)$/.test(el.tagName)) return false;
    if (/^(TR|LI|A|BUTTON)$/.test(n.tagName)) return true;
    if (n.getAttribute("role") === "button") return true;
    return getComputedStyle(n).cursor === "pointer";
  }

  /* An inline onclick counts as owned only if the function it names actually exists. Some
   * exports call a helper their own script never got to define — exec-logs' script dies on
   * a missing element before it declares filterByTab — and a handler that throws is not a
   * handler. Those controls fall through to demo.js instead of being dead. */
  function liveInline(n) {
    var attr = n.getAttribute && (n.getAttribute("onclick") || n.getAttribute("onchange"));
    if (!attr) return false;
    var name = (attr.match(/^\s*([A-Za-z_$][\w$]*)\s*\(/) || [])[1];
    if (!name) return true; // inline code rather than a call — assume it works
    return typeof window[name] === "function";
  }

  /* ------------------------------------------------------------------------------ toasts
   * Bottom LEFT: the screen switcher wire.py injects lives bottom right.
   */
  var deck;
  function toast(msg) {
    if (!deck) {
      deck = document.createElement("div");
      deck.style.cssText =
        "position:fixed;left:16px;bottom:16px;z-index:10000;display:flex;flex-direction:" +
        "column;gap:8px;max-width:min(380px,calc(100vw - 32px));font:500 12.5px/1.45 Inter," +
        "system-ui,sans-serif;pointer-events:none";
      document.body.appendChild(deck);
    }
    var t = document.createElement("div");
    t.textContent = msg;
    t.style.cssText =
      "background:#0b1c30;color:#fff;padding:9px 13px;border-radius:8px;box-shadow:0 8px " +
      "30px rgba(11,28,48,.28);opacity:0;transform:translateY(6px);transition:opacity .14s," +
      "transform .14s";
    deck.appendChild(t);
    requestAnimationFrame(function () {
      t.style.opacity = "1";
      t.style.transform = "none";
    });
    setTimeout(function () {
      t.style.opacity = "0";
      t.style.transform = "translateY(6px)";
      setTimeout(function () {
        t.remove();
      }, 200);
    }, 2800);
  }

  /* -------------------------------------------------------------------------- label of an
   * element: its prose with the Material Symbols ligatures dropped, so "arrow_back Back"
   * reads as "Back" and a bare icon button reads as "".
   */
  function labelOf(el) {
    var c = el.cloneNode(true);
    c.querySelectorAll(".material-symbols-outlined, .material-symbols-rounded").forEach(function (i) {
      i.remove();
    });
    return (c.textContent || "").replace(/\s+/g, " ").trim();
  }
  function key(s) {
    return s.toLowerCase().replace(/[+{}()]/g, " ").replace(/\s+/g, " ").trim();
  }

  /* ------------------------------------------------------------------ a button that answers
   * A toast saying "nothing is stored" is honest but it is not a response: the control
   * itself never moves, so the screen looks as static as it did before the click. These
   * three give a button the state it would have in the real app — busy, then done, then back
   * to itself — which is the difference between a mockup you can demonstrate and a picture.
   *
   * The label is written into whichever node actually holds the prose, so the icon beside it
   * survives; the icon, if there is one, spins and then becomes a tick.
   */
  function iconOf(el) {
    return el.querySelector(".material-symbols-outlined, .material-symbols-rounded");
  }

  function labelNode(btn) {
    var spans = btn.querySelectorAll("span:not(.material-symbols-outlined):not(.material-symbols-rounded)");
    for (var i = spans.length - 1; i >= 0; i--) if (labelOf(spans[i]).length && !spans[i].children.length) return spans[i];
    return btn; // the prose is the button's own text node
  }

  function setLabel(btn, text) {
    var node = labelNode(btn);
    if (node !== btn) {
      node.textContent = text;
      return;
    }
    var written = false;
    Array.prototype.forEach.call(btn.childNodes, function (n) {
      if (n.nodeType !== 3 || !n.textContent.trim()) return;
      n.textContent = written ? "" : text;
      written = true;
    });
    if (!written) btn.appendChild(document.createTextNode(text));
  }

  var spun;
  function spin() {
    if (spun) return;
    spun = document.createElement("style");
    spun.textContent = "@keyframes demo-spin{to{transform:rotate(1turn)}}";
    document.head.appendChild(spun);
  }

  /* busy → done → back. `after` runs at the moment the button reads "done", which is where a
   * side effect belongs (a row appearing, a status chip flipping); if it returns a string,
   * that becomes the button's resting label instead of the original — which is how Connect
   * stays Disconnect afterwards. */
  function busyRun(btn, busy, done, after) {
    if (btn.dataset.demoBusy) return true; // already mid-flight; a second click is not a hole
    spin();
    var node = labelNode(btn);
    var orig = node === btn ? labelOf(btn) : node.textContent;
    var ic = iconOf(btn);
    var icOrig = ic && ic.textContent;
    btn.dataset.demoBusy = "1";
    btn.style.opacity = "0.9";
    setLabel(btn, busy);
    if (ic) {
      ic.textContent = "progress_activity";
      ic.style.animation = "demo-spin .9s linear infinite";
    }
    setTimeout(function () {
      setLabel(btn, done);
      if (ic) {
        ic.style.animation = "";
        ic.textContent = "check";
      }
      var keep = after && after();
      setTimeout(function () {
        setLabel(btn, keep || orig);
        if (ic) ic.textContent = icOrig;
        btn.style.opacity = "";
        delete btn.dataset.demoBusy;
      }, 1600);
    }, 520);
    return true;
  }

  /* What a verb looks like mid-flight and once finished. Matched on the label's first word,
   * so "Save Changes", "Save Draft" and "Save Step Configuration" all conjugate the same. */
  var TENSE = [
    [/^saving|^save\b/, "Saving…", "Saved"],
    [/^publish/, "Publishing…", "Published"],
    [/^(send|resend|dispatch)\b/, "Sending…", "Sent"],
    [/^(test|run|simulate|quick test|preview)\b/, "Running…", "Passed"],
    [/^(sync|refresh|reload|re-?sync)\b/, "Syncing…", "Synced"],
    [/^(connect|reconnect|setup|set up)\b/, "Connecting…", "Connected"],
    [/^(disconnect|revoke)\b/, "Disconnecting…", "Disconnected"],
    [/^(import|upload|replace)\b/, "Uploading…", "Imported"],
    [/^(invite|add)\b/, "Adding…", "Added"],
    [/^(create|generate|start)\b/, "Creating…", "Created"],
    [/^(schedule|queue|begin)\b/, "Scheduling…", "Scheduled"],
    [/^(apply|confirm|submit|approve|use)\b/, "Applying…", "Applied"],
    [/^(duplicate|clone)\b/, "Duplicating…", "Duplicated"],
    [/^(remove|delete|discard|clear|reset)\b/, "Removing…", "Removed"],
    [/^(export|download)\b/, "Preparing…", "Downloaded"],
    // `opens: true` — the verb promises another screen rather than an effect in place, and
    // for these that screen is what was never drawn. Kept in the table anyway so a toolbar's
    // "Edit" is still read as an action and not as a tab.
    [/^(edit|configure|manage|change|open|view)\b/, "Opening…", "Opened", true],
  ];

  function tense(label) {
    var l = key(label);
    for (var i = 0; i < TENSE.length; i++)
      if (TENSE[i][0].test(l)) return { busy: TENSE[i][1], done: TENSE[i][2], opens: !!TENSE[i][3] };
    return null;
  }

  /* A control whose label starts with a verb is an action, never a tab. Save and Discard sit
   * side by side in one toolbar with two different class strings, which is exactly the shape
   * of a tab strip — and being read as one is how "Save Changes" came to answer "only the
   * Discard panel is drawn in this mockup". */
  function looksLikeAction(label) {
    return !!tense(label) || /^(cancel|back|next|continue|skip|done|finish|got it)\b/.test(key(label));
  }

  /* ------------------------------------------------------------------------- where things
   * go. Label (normalised) -> screen file. Only consulted for controls the page does not
   * already own, so e.g. journeys.html's own "Create Journey" still opens its in-page
   * modal while the dashboard's "+ New Journey" comes here instead.
   */
  var GO = {
    "new journey": "modal-create-journey",
    "create journey": "modal-create-journey",
    "use template": "modal-create-journey",
    "new campaign": "modal-create-campaign",
    "new broadcast": "modal-create-campaign",
    "create campaign": "modal-create-campaign",
    import: "modal-import-contacts",
    "add contact": "modal-import-contacts",
    "add contacts": "modal-import-contacts",
    "continue to journey builder": "journey-builder",
    "continue to flow builder": "journey-builder",
    "append next journey action": "journey-builder-spacious",
    "add next step": "journey-builder-spacious",
    "edit step": "step-branch-rules",
    "configure 3": "step-branch-rules",
    "stop conditions 3 rules": "step-branch-rules",
    "activity log": "exec-logs",
    "view activity log": "exec-logs",
    "view broadcast logs": "exec-logs",
    "open full campaign telemetry": "analytics",
    "manage numbers": "whatsapp-hub",
    "manage in whatsapp hub": "whatsapp-hub",
    "manage numbers & templates in hub": "whatsapp-hub",
  };

  /* Verbs that can only be simulated: a save with no server, a test send with no number. */
  var PRETEND = /^(save|publish|submit|sync|test|run|connect|disconnect|invite|discard|export|upload|remove|replace|duplicate|change|import \d|add keyword|edit limits|setup|configure studio|preview|use custom domain|read api|manage payment)/;

  /* ------------------------------------------------------------- rows a control can filter
   * The nearest table body above the control, or failing that the nearest run of sibling
   * cards (templates and integrations draw their lists as cards, not rows).
   */
  function rowsNear(el) {
    // Tables first, across every ancestor, before any run of cards is considered: a filter
    // bar's own three identical buttons are a "run of cards" by shape, and letting the
    // nearest ancestor win would hand back the toolbar instead of the table under it.
    var n;
    for (n = el; n && n !== document.body; n = n.parentElement) {
      var rows = n.querySelectorAll("tbody tr");
      if (rows.length > 1) return Array.prototype.slice.call(rows);
    }
    for (n = el; n && n !== document.body; n = n.parentElement) {
      var cards = cardRun(n);
      if (cards) return cards;
    }
    var any = document.querySelectorAll("tbody tr");
    return any.length > 1 ? Array.prototype.slice.call(any) : null;
  }

  function cardRun(scope) {
    var best = null;
    scope.querySelectorAll("div, ul, ol").forEach(function (box) {
      var kids = Array.prototype.filter.call(box.children, function (k) {
        return k.tagName !== "SCRIPT";
      });
      if (kids.length < 3) return;
      // All but one alike, rather than all alike: the hub's chat list draws the SELECTED chat
      // with its own background, and demanding one class string for every member made that
      // whole list invisible to every filter on the screen. One odd member out is a selection;
      // two would be a layout, not a run.
      var seen = {};
      kids.forEach(function (k) {
        var c = String(k.className);
        if (c.length >= 20) seen[c] = (seen[c] || 0) + 1;
      });
      var major = Object.keys(seen).sort(function (a, b) {
        return seen[b] - seen[a];
      })[0];
      if (!major || seen[major] < kids.length - 1) return;
      var like = kids.filter(function (k) {
        return String(k.className) === major;
      })[0];
      if (like.getBoundingClientRect().height < 48) return; // chips and tabs, not rows
      if (!best || kids.length > best.length) best = kids;
    });
    return best;
  }

  function show(row, on) {
    row.style.display = on ? "" : "none";
  }

  function filterRows(rows, needle) {
    var q = needle.toLowerCase();
    var hits = 0;
    rows.forEach(function (r) {
      var on = !q || (r.innerText || "").toLowerCase().indexOf(q) >= 0;
      show(r, on);
      if (on) hits++;
    });
    return hits;
  }

  /* -------------------------------------------------------------------------- tab strips
   * A tab strip is a parent whose button children carry exactly two distinct class
   * strings, one of them used once — that once is the active tab. That shape is how every
   * one of these exports draws a selected tab, so the strips are found rather than listed.
   */
  function tabStrip(btn) {
    var box = btn.parentElement;
    if (!box) return null;
    var tabs = Array.prototype.filter.call(box.children, function (k) {
      return k.tagName === "BUTTON" && labelOf(k).length && labelOf(k).length < 40;
    });
    if (tabs.length < 2 || tabs.indexOf(btn) < 0) return null;
    // A toolbar of actions has this exact shape — two buttons, two class strings, one of them
    // the primary — so it has to be excluded by meaning rather than by form.
    if (
      tabs.some(function (t) {
        return looksLikeAction(labelOf(t));
      })
    )
      return null;
    if (
      tabs.every(function (t) {
        return /^\d+$/.test(labelOf(t).trim());
      })
    )
      return null; // a pager, handled as one

    var seen = {};
    tabs.forEach(function (t) {
      seen[t.className] = (seen[t.className] || 0) + 1;
    });
    var classes = Object.keys(seen);
    var active = classes.filter(function (c) {
      return seen[c] === 1;
    })[0];
    // The hub's chat filters are three distinct class strings, not two: "Needs Reply (14)" is
    // red whether it is selected or not, so the selected tab cannot be found by counting. It
    // is the one the browser paints a background on — which is what "selected" means here.
    if (classes.length > 2 || !active) {
      var painted = tabs.filter(function (t) {
        var bg = getComputedStyle(t).backgroundColor;
        return bg && bg !== "transparent" && !/rgba\(0, 0, 0, 0\)/.test(bg);
      });
      if (painted.length !== 1) return null;
      active = painted[0].className;
    }
    var idle = classes.filter(function (c) {
      return c !== active && seen[c] === Math.max.apply(null, classes.filter(function (k) { return k !== active; }).map(function (k) { return seen[k]; }));
    })[0];
    if (!idle) return null;
    // Each tab remembers the class string it arrived with, so deselecting "Needs Reply" gives
    // it back its own red rather than the plain grey of its neighbours.
    tabs.forEach(function (t) {
      if (t.dataset.demoTab === undefined) t.dataset.demoTab = t.className === active ? "" : t.className;
    });
    return { tabs: tabs, active: active, idle: idle };
  }

  function onTab(btn) {
    var strip = tabStrip(btn);
    if (!strip) return false;
    var wasActive = strip.tabs.filter(function (t) {
      return t.className === strip.active;
    })[0];
    strip.tabs.forEach(function (t) {
      t.className = t === btn ? strip.active : t.dataset.demoTab || strip.idle;
    });
    // "All (14)" and "Active 6" carry their own counts; the word is the filter.
    var bare = function (t) {
      return t
        .replace(/\(\d[\d,.]*\)/g, "")
        .replace(/\s\d[\d,.]*$/, "")
        .trim();
    };
    var label = bare(labelOf(btn));
    var rows = rowsNear(btn);

    // Is this a filter over the list below, or a rail between panels? Answered from the
    // data: a filter's tabs name values that appear in the rows ("Pending", "Failed"),
    // while a rail names sections that do not ("Team & Permissions"). Settings is the
    // second kind, and only its Workspace panel was ever drawn.
    var filters =
      rows &&
      strip.tabs.some(function (t) {
        var l = bare(labelOf(t));
        if (!l || /^all\b/i.test(l)) return false;
        return rows.some(function (r) {
          return (r.innerText || "").toLowerCase().indexOf(l.toLowerCase()) >= 0;
        });
      });

    if (!filters) {
      toast(
        "Tab switched — but only the “" +
          bare(labelOf(wasActive)) +
          "” panel is drawn in this mockup."
      );
      return true;
    }
    if (/^all\b/i.test(label)) {
      filterRows(rows, "");
      return true;
    }
    if (!filterRows(rows, label)) {
      filterRows(rows, "");
      toast("No “" + label + "” rows are in the sample data — showing all of them.");
    }
    return true;
  }

  /* ------------------------------------------------------- "Status: All ▾" filter buttons
   * The menu is built from the table column whose header matches the label, so it offers
   * exactly the values the sample data actually contains.
   */
  function columnValues(rows, name) {
    var table = rows[0] && rows[0].closest("table");
    if (!table) return null;
    var heads = table.querySelectorAll("thead th, thead td");
    var idx = -1;
    heads.forEach(function (h, i) {
      if (idx < 0 && labelOf(h).toLowerCase().indexOf(name.toLowerCase()) >= 0) idx = i;
    });
    if (idx < 0) return null;
    var vals = [];
    rows.forEach(function (r) {
      var cell = r.children[idx];
      if (!cell) return;
      var v = labelOf(cell).split("\n")[0].trim();
      if (v && vals.indexOf(v) < 0 && v.length < 28) vals.push(v);
    });
    return vals.length ? { index: idx, values: vals } : null;
  }

  var openMenu;
  function closeMenu() {
    if (openMenu) openMenu.remove();
    openMenu = null;
  }

  /* One menu, anchored under whatever opened it. Items are {label, tick, on} — `on` runs the
   * actual effect, so a menu is a way of offering real behaviour rather than a wider toast.
   */
  function menuAt(anchor, items) {
    closeMenu();
    var r = anchor.getBoundingClientRect();
    var menu = document.createElement("div");
    menu.style.cssText =
      "position:fixed;left:" +
      Math.round(Math.min(r.left, innerWidth - 240)) +
      "px;top:" +
      Math.round(r.bottom + 6) +
      "px;z-index:10000;background:#fff;border:1px solid #c7c4d8;border-radius:8px;" +
      "box-shadow:0 10px 34px rgba(11,28,48,.18);padding:4px 0;min-width:" +
      Math.max(150, Math.round(r.width)) +
      "px;font:500 12.5px/1.5 Inter,system-ui,sans-serif";
    items.forEach(function (spec) {
      if (spec.rule) {
        var hr = document.createElement("div");
        hr.style.cssText = "height:1px;background:#e5eeff;margin:4px 0";
        menu.appendChild(hr);
        return;
      }
      var item = document.createElement("button");
      item.type = "button";
      item.textContent = (spec.tick ? "✓  " : "") + spec.label;
      item.style.cssText =
        "display:block;width:100%;text-align:left;padding:6px 13px;border:0;background:none;" +
        "color:" +
        (spec.tick ? "#3525cd" : "#464555") +
        ";cursor:pointer;font:inherit";
      item.addEventListener("mouseenter", function () {
        item.style.background = "#f8f9ff";
      });
      item.addEventListener("mouseleave", function () {
        item.style.background = "none";
      });
      item.addEventListener("click", function (e) {
        e.stopPropagation();
        closeMenu();
        if (spec.on) spec.on();
      });
      menu.appendChild(item);
    });
    document.body.appendChild(menu);
    openMenu = menu;
    return true;
  }

  function onDropdown(btn) {
    var full = labelOf(btn);
    var chev = btn.querySelector(".material-symbols-outlined");
    var isChevron = chev && /arrow_drop_down|expand_more|keyboard_arrow_down|unfold_more/.test(chev.textContent);
    if (!isChevron) return false;
    var name = (full.split(":")[0] || full).trim();
    var rows = rowsNear(btn);
    var col = rows && columnValues(rows, name);
    if (!col) return false;

    var current = (full.split(":")[1] || "").trim();
    return menuAt(
      btn,
      ["All"].concat(col.values).map(function (v) {
        return {
          label: v,
          tick: v === current,
          on: function () {
            // Keep the button reading "Status: Approved" — the last span is the value.
            var spans = btn.querySelectorAll("span");
            for (var i = spans.length - 1; i >= 0; i--) {
              if (!spans[i].classList.contains("material-symbols-outlined")) {
                spans[i].textContent = v === "All" ? "All" : v;
                break;
              }
            }
            var q = v === "All" ? "" : v;
            rows.forEach(function (row) {
              var cell = row.children[col.index];
              show(row, !q || (cell && labelOf(cell).toLowerCase().indexOf(q.toLowerCase()) >= 0));
            });
          },
        };
      }),
    );
  }

  /* ------------------------------------------------------------------------ hide a column
   * "Columns" offers the table's own headers, and picking one really does drop that column —
   * header cell and every row cell together.
   */
  function onColumns(btn) {
    if (key(labelOf(btn)) !== "columns") return false;
    var rows = rowsNear(btn);
    var table = rows && rows[0] && rows[0].closest("table");
    if (!table) return false;
    var heads = Array.prototype.slice.call(table.querySelectorAll("thead th, thead td"));
    return menuAt(
      btn,
      heads.map(function (h, i) {
        var name = labelOf(h) || "Column " + (i + 1);
        var hidden = h.style.display === "none";
        return {
          label: (hidden ? "Show " : "Hide ") + name,
          tick: !hidden,
          on: function () {
            h.style.display = hidden ? "" : "none";
            rows.forEach(function (r) {
              if (r.children[i]) r.children[i].style.display = hidden ? "" : "none";
            });
            toast("“" + name + "” column " + (hidden ? "shown" : "hidden") + ".");
          },
        };
      }),
    );
  }

  /* ---------------------------------------------------------------------------- pagination
   * The page a visitor clicks becomes the selected page, because a pager that does not even
   * move its own highlight reads as broken. What it cannot do is show page 2: Stitch drew
   * five sample rows under a footer claiming eighteen, and inventing the other thirteen would
   * put numbers on the screen that no designer chose. So it moves, and says exactly that.
   */
  function pagerCounts(btn) {
    // "Showing 1–5 of 18 campaigns" — the footer the pager sits in states both numbers.
    var box = btn.closest("div");
    for (var n = box, hops = 0; n && hops < 4; n = n.parentElement, hops++) {
      var m = (n.innerText || "").match(/showing\s+([\d,]+)[–—-]([\d,]+)\s+of\s+([\d,]+)/i);
      if (m) return { to: m[2], of: m[3] };
    }
    return null;
  }

  function onPager(btn) {
    var l = labelOf(btn).trim();
    if (!/^(next|previous|prev|\d+)$/i.test(l)) return false;
    var counts = pagerCounts(btn);
    var drawn = counts ? counts.to : null;
    var total = counts ? counts.of : null;

    // Move the highlight: onto the clicked page, or one step along for Next and Previous —
    // the rows behind page 2 were never drawn, but which page you are on is real and is what
    // the pager is for.
    var pages = Array.prototype.filter.call((btn.parentElement || btn).children, function (k) {
      return k.tagName === "BUTTON" && /^\d+$/.test(labelOf(k).trim());
    });
    var landed = null;
    if (pages.length > 1) {
      var seen = {};
      pages.forEach(function (p) {
        seen[p.className] = (seen[p.className] || 0) + 1;
      });
      var activeCls = Object.keys(seen).filter(function (c) {
        return seen[c] === 1;
      })[0];
      var idleCls = Object.keys(seen).filter(function (c) {
        return c !== activeCls;
      })[0];
      var at = pages.filter(function (p) {
        return p.className === activeCls;
      })[0];
      var want = /^\d+$/.test(l)
        ? btn
        : pages[Math.min(pages.length - 1, Math.max(0, pages.indexOf(at) + (/^next$/i.test(l) ? 1 : -1)))];
      if (activeCls && idleCls && want) {
        pages.forEach(function (p) {
          p.className = p === want ? activeCls : idleCls;
        });
        landed = labelOf(want).trim();
      }
    }
    toast(
      drawn
        ? "Page " + (landed || "moved") + " — only the first " + drawn + " of " + total + " rows were drawn as sample data."
        : "Only the first page of sample data is drawn.",
    );
    return true;
  }

  /* ------------------------------------------------------------------------------ toggles
   * Found by shape, not by class name: a pill roughly 30–72px wide with a single round
   * child. Moved with flex alignment rather than by guessing at Tailwind translate
   * classes, so it works on every screen's own markup.
   */
  function asToggle(el) {
    for (var n = el, hops = 0; n && hops < 3; n = n.parentElement, hops++) {
      if (n.children.length !== 1) continue;
      var box = n.getBoundingClientRect();
      var knob = n.children[0].getBoundingClientRect();
      if (box.width < 28 || box.width > 76 || box.height < 13 || box.height > 38) continue;
      if (box.width <= box.height * 1.4) continue;
      if (!knob.width || knob.width > box.width * 0.75) continue;
      return n;
    }
    return null;
  }

  function onToggle(el) {
    var t = asToggle(el);
    if (!t) return false;
    var on = t.dataset.demoOn !== "0";
    t.dataset.demoOn = on ? "0" : "1";
    t.style.display = "flex";
    t.style.alignItems = "center";
    t.style.justifyContent = on ? "flex-start" : "flex-end";
    t.style.background = on ? "#c7c4d8" : "#4f46e5";
    return true;
  }

  /* -------------------------------------------------------------------------- canvas zoom
   * The zoom buttons identify themselves with title="Zoom In|Zoom Out|Fit…". The graph is
   * scaled by wrapping it once in a stage element — the control strip, the dot grid and
   * anything floating are left out of the wrapper so they do not scale with it.
   */
  function scrollRegion(from) {
    // The canvas is a scroll box. On the docked builder the zoom strip sits inside it; on
    // the spacious one the strip is up in the toolbar, so fall back to the biggest scroll
    // box on the page — which also leaves the step palette out of the zoom, since the
    // palette is a sibling of that box rather than inside it.
    for (var n = from; n && n !== document.body; n = n.parentElement) {
      if (/auto|scroll/.test(getComputedStyle(n).overflowX + getComputedStyle(n).overflowY) && n.clientHeight > 300)
        return n;
    }
    var best = null;
    document.querySelectorAll("div, section, main").forEach(function (d) {
      var cs = getComputedStyle(d);
      if (!/auto|scroll/.test(cs.overflowX + cs.overflowY)) return;
      var r = d.getBoundingClientRect();
      if (r.width < 400 || r.height < 280) return;
      if (!best || r.width * r.height > best.w) best = { el: d, w: r.width * r.height };
    });
    return best && best.el;
  }

  function stageFor(bar) {
    var host = scrollRegion(bar);
    if (!host) return null;
    if (host.__demoStage) return host.__demoStage;
    var stage = document.createElement("div");
    stage.style.cssText = "transform-origin:top center;transition:transform .16s ease-out";
    var move = Array.prototype.filter.call(host.children, function (k) {
      if (k.contains(bar) || k === bar) return false;
      if (k.id === "canvas-dots" || k.id === "flow-palette" || k.id === "demo-switcher") return false;
      var pos = getComputedStyle(k).position;
      return pos !== "fixed" && pos !== "sticky" && pos !== "absolute";
    });
    if (!move.length) return null;
    host.insertBefore(stage, move[0]);
    move.forEach(function (k) {
      stage.appendChild(k);
    });
    host.__demoStage = stage;
    return stage;
  }

  function onZoom(btn) {
    var title = btn.getAttribute("title") || "";
    if (!/zoom in|zoom out|^fit/i.test(title)) return false;
    var bar = btn.parentElement;
    var stage = stageFor(bar);
    if (!stage) return false;
    var z = parseFloat(stage.dataset.demoZoom || "1");
    if (/zoom in/i.test(title)) z = Math.min(1.6, z + 0.1);
    else if (/zoom out/i.test(title)) z = Math.max(0.5, z - 0.1);
    else z = 1;
    stage.dataset.demoZoom = z;
    stage.style.transform = "scale(" + z + ")";
    // The strip prints the level next to the buttons; keep it honest.
    Array.prototype.forEach.call(bar.querySelectorAll("span"), function (s) {
      if (/^\d{2,3}%$/.test(s.textContent.trim())) s.textContent = Math.round(z * 100) + "%";
    });
    return true;
  }

  /* --------------------------------------------------------------------- nodes on a canvas
   * Clicking a step selects it; clicking a branch step opens the rules screen that is
   * drawn for exactly that kind of step.
   */
  function onNode(el) {
    var host = el.closest("[data-demo-node], .group");
    var node = el.closest("div[class*='rounded-']");
    if (!node || node === document.body) return false;
    var box = node.getBoundingClientRect();
    if (box.width < 170 || box.width > 460 || box.height < 48) return false;
    var text = labelOf(node);
    if (!text || text.length > 220) return false;
    if (!/^\s*(trigger|branch|condition|wait|delay|send|message|reminder|split|attendance|end|webinar|if\b)/i.test(text))
      return false;
    if (/branch|condition|^if\b|split/i.test(text)) {
      location.href = "step-branch-rules.html";
      return true;
    }
    document.querySelectorAll("[data-demo-selected]").forEach(function (n) {
      n.style.boxShadow = "";
      n.removeAttribute("data-demo-selected");
    });
    node.setAttribute("data-demo-selected", "1");
    node.style.boxShadow = "0 0 0 2px #4f46e5";
    toast("Step selected. The inspector is drawn for one step only.");
    return !!host || true;
  }

  /* ---------------------------------------------------------------------- modals: get out
   * A modal screen is a whole page with the modal already open, so "close" means going
   * back where you came from — or to the parent screen when the demo started here.
   */
  var PARENT = {
    "modal-create-journey": "journeys",
    "modal-create-campaign": "campaigns",
    "modal-import-contacts": "contacts",
  };
  function leaveModal() {
    if (history.length > 1) history.back();
    else location.href = (PARENT[HERE] || "dashboard") + ".html";
  }
  function onModalClose(el) {
    if (!IS_MODAL) return false;
    var title = el.getAttribute("title") || "";
    var l = key(labelOf(el));
    // "Back" in a modal that is a wizard standing on step two or later means the step before
    // it, not the way out — so that one is left to onWizard. On step one there is no step
    // before it, and Back means what it meant when only one panel existed: leave.
    if (l === "back" && WIZ && WIZ.at > 1) return false;
    if (/close/i.test(title) || l === "cancel" || l === "close" || l === "back") {
      leaveModal();
      return true;
    }
    return false;
  }

  /* ------------------------------------------------------- variable chips in the inspector
   * "+ Add {{first_name}}" is the one control here with an obvious real effect: put the
   * token in the message body next to it.
   */
  function onToken(el) {
    var m = labelOf(el).match(/\{\{[a-z0-9_]+\}\}/i);
    if (!m) return false;
    var card = el.closest("section, div[class*='rounded-']");
    var field = card && card.querySelector("textarea, [contenteditable='true']");
    if (!field) {
      var all = document.querySelectorAll("textarea, [contenteditable='true']");
      field = all[all.length - 1];
    }
    if (!field) {
      // templates.html has no editable body: the message is drawn as the phone simulator's
      // bubble, paragraphs of prose. Appending the token to the last of them is the same
      // effect the real inspector would have, and it is visible in the place a visitor is
      // already looking.
      var para = null;
      document.querySelectorAll("p").forEach(function (p) {
        if (!plainish(p) || labelOf(p).length < 12) return;
        if (p.closest("button, a, header, nav, aside")) return;
        para = p;
      });
      if (!para) {
        toast(m[0] + " copied — no message body is drawn on this screen.");
        return true;
      }
      para.appendChild(document.createTextNode(" " + m[0]));
      flashRow(para);
      toast(m[0] + " added to the message body — the preview updates, nothing is saved.");
      return true;
    }
    if (field.tagName === "TEXTAREA") field.value += " " + m[0];
    else field.textContent += " " + m[0];
    field.scrollIntoView({ block: "center", behavior: "smooth" });
    toast(m[0] + " added to the message body.");
    return true;
  }

  /* ============================================================ controls with a real effect
   * Everything below answers a click by changing the screen rather than by describing what
   * the real app would have done. Each one is found by shape — a row's own status chip, the
   * table a button sits above, the composer below a thread — so there is no per-screen
   * casing to drift out of date, and a control that does not match simply falls through to
   * the next handler and eventually to a toast.
   */

  /* An element whose own text is the whole of its prose: a status chip is one, a table cell
   * full of markup is not. An icon child is allowed, since half these chips carry one. */
  function plainish(el) {
    return Array.prototype.every.call(el.children, function (c) {
      // An icon, or a purely decorative element with no words in it — journeys draws its
      // status chip as a coloured dot beside the word, and the dot must not disqualify it.
      return /material-symbols/.test(String(c.className)) || !c.textContent.trim();
    });
  }

  /* The row a control belongs to — a <tr>, or the member of the nearest run of cards that
   * contains it, since templates and integrations draw their lists as cards. */
  function rowOf(el) {
    var tr = el.closest("tr");
    if (tr) return tr;
    var rows = rowsNear(el);
    if (!rows) return null;
    for (var i = 0; i < rows.length; i++) if (rows[i].contains(el)) return rows[i];
    return null;
  }

  // The vocabulary these screens actually use for state. A chip is recognised by its words,
  // not its colour classes: the same "Paused" is amber here and grey two screens over.
  var STATE =
    /^(active|paused|live|draft|sent|sending|failed|delivered|read|pending|approved|rejected|scheduled|queued|running|stopped|completed|in review|opted in|opted out|connected|not connected|disconnected|inactive|syncing|healthy|error)$/i;

  function chipIn(scope, re) {
    var hit = null;
    scope.querySelectorAll("span, div, p, td").forEach(function (s) {
      if (hit || !plainish(s)) return;
      if (re.test(labelOf(s))) hit = s;
    });
    return hit;
  }

  function statusChip(row) {
    return chipIn(row, STATE);
  }

  /* The thing a row is about — its name, for saying which row just changed. The first short
   * run of prose in it, which in every one of these tables is the name column. */
  function nameNode(row) {
    var best = null;
    row.querySelectorAll("span, p, a, h3, h4, h5, td, div").forEach(function (e) {
      // An icon is plain and short and comes first, so without this the name of a card whose
      // title sits beside one is the ligature: "label" instead of "A contact tag".
      if (/material-symbols/.test(String(e.className))) return;
      if (best || !plainish(e)) return;
      var t = labelOf(e);
      if (t.length > 2 && t.length < 60) best = e;
    });
    return best;
  }

  function nameOf(row) {
    var n = nameNode(row);
    return n ? labelOf(n) : "this row";
  }

  /* A label change with no busy phase, for a control whose work is instantaneous. */
  function flashDone(btn, word) {
    if (btn.dataset.demoBusy) return;
    var node = labelNode(btn);
    var orig = node === btn ? labelOf(btn) : node.textContent;
    var ic = iconOf(btn);
    var icOrig = ic && ic.textContent;
    btn.dataset.demoBusy = "1";
    if (orig) setLabel(btn, word);
    if (ic) ic.textContent = "check";
    setTimeout(function () {
      if (orig) setLabel(btn, orig);
      if (ic) ic.textContent = icOrig;
      delete btn.dataset.demoBusy;
    }, 1400);
  }

  /* ------------------------------------------------------------------ the row's own ⋮ menu
   * Every list on every screen ends in a more_vert, and every one of them was dead. The menu
   * is built from what the row itself shows: if it has a status chip, the first item flips
   * it; the rest act on the row as a row.
   */
  function onOptionsMenu(btn) {
    var ic = iconOf(btn);
    if (!ic || !/^(more_vert|more_horiz)$/.test(ic.textContent.trim())) return false;
    var row = rowOf(btn);
    if (!row || !row.parentElement) return false;
    var name = nameOf(row);
    var items = [];
    var chip = statusChip(row);
    if (chip && /^(active|live|running|paused|stopped)$/i.test(labelOf(chip))) {
      var paused = /paused|stopped/i.test(labelOf(chip));
      items.push({
        label: paused ? "Resume" : "Pause",
        on: function () {
          setLabel(chip, paused ? "Active" : "Paused");
          row.style.opacity = paused ? "" : "0.55";
          toast("“" + name + "” is now " + (paused ? "active" : "paused") + " — on this screen only.");
        },
      });
    }
    items.push({
      label: "Duplicate",
      on: function () {
        var copy = row.cloneNode(true);
        // Name the copy, so what appears is obviously the duplicate and not a second original.
        var n = nameNode(copy);
        if (n) setLabel(n, "Copy of " + labelOf(n));
        row.parentElement.insertBefore(copy, row.nextSibling);
        copy.scrollIntoView({ block: "center", behavior: "smooth" });
        toast("Duplicated “" + name + "” — the copy lives until you reload.");
      },
    });
    items.push({ rule: true });
    items.push({
      label: "Remove from this list",
      on: function () {
        row.style.display = "none";
        toast("“" + name + "” removed from the list — reload to bring it back.");
      },
    });
    return menuAt(btn, items);
  }

  /* --------------------------------------------------------------------------- copy, really
   * There is a clipboard in the browser, so a Copy button has no excuse: it copies the code
   * block, payload or field beside it.
   */
  function onCopy(btn) {
    var ic = iconOf(btn);
    var l = key(labelOf(btn));
    var byIcon = ic && /^(content_copy|copy_all|file_copy)$/.test(ic.textContent.trim());
    if (!byIcon && !/^copy\b/.test(l)) return false;
    var scope = btn.closest("section, div[class*='rounded-']") || document.body;
    var src = null;
    // `font-code-*` is how both design systems mark a value as literal — a URL, a webhook
    // endpoint, an API key — so it finds the copyable text on screens that use a styled
    // <span> where a developer would have written <code>.
    for (var n = scope, hops = 0; n && hops < 4 && !src; n = n.parentElement, hops++)
      src = n.querySelector("pre, code, textarea, input[readonly], [class*='font-code']");
    if (!src) src = rowOf(btn);
    var text = ((src && (src.value || src.innerText)) || "").replace(/\s+$/, "");
    if (!text) return false;
    try {
      if (navigator.clipboard) navigator.clipboard.writeText(text).catch(function () {});
    } catch (err) {
      /* a file:// page without clipboard permission still gets the toast */
    }
    flashDone(btn, "Copied");
    toast(
      text.length > 48
        ? "Copied " + text.length + " characters to the clipboard."
        : "Copied “" + text.replace(/\s+/g, " ") + "” to the clipboard.",
    );
    return true;
  }

  /* -------------------------------------------------------------------------- export, really
   * A CSV built from the table that is on the screen — its own headers, its own visible rows,
   * so an export taken after filtering matches what the visitor is looking at.
   */
  function csvOf(rows) {
    var esc = function (s) {
      return '"' + String(s).replace(/\s+/g, " ").trim().replace(/"/g, '""') + '"';
    };
    var table = rows[0].closest("table");
    var out = [];
    var heads = table ? Array.prototype.slice.call(table.querySelectorAll("thead th, thead td")) : [];
    if (heads.length)
      out.push(
        heads
          .map(function (h) {
            return esc(labelOf(h) || "column");
          })
          .join(","),
      );
    rows.forEach(function (r) {
      if (r.style.display === "none") return;
      var cells = heads.length ? Array.prototype.slice.call(r.children) : [r];
      out.push(
        cells
          .map(function (c) {
            return esc(labelOf(c));
          })
          .join(","),
      );
    });
    return out.join("\n") + "\n";
  }

  function onExport(btn) {
    // Not anchored, and read through verbOf: attendance writes this button "CSV Export", and
    // a row's export is sometimes an icon with the verb only in its title.
    var l = key(verbOf(btn));
    if (!/\b(export|download)\b/.test(l) || l.length > 40) return false;
    var rows = rowsNear(btn);
    if (!rows || !rows.length) return false;
    var csv = csvOf(rows);
    var name = HERE + "-" + key(verbOf(btn)).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + ".csv";
    return busyRun(btn, "Preparing…", "Downloaded", function () {
      var a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      a.download = name;
      a.click();
      setTimeout(function () {
        URL.revokeObjectURL(a.href);
      }, 4000);
      toast(name + " — " + (csv.split("\n").length - 2) + " rows, built from the table on this screen.");
    });
  }

  /* ------------------------------------------------------------------------ retry a delivery
   * The log's own top row, cloned to the top of the table and marked queued: what a retry
   * looks like is a new attempt appearing, not a toast about one.
   */
  function onResend(btn) {
    if (!/^(resend|retry|send again)\b/.test(key(verbOf(btn)))) return false;
    var row = rowOf(btn);
    var rows = rowsNear(btn);
    if (!row) row = rows && rows[0];
    if (!row || !row.parentElement) return false;
    return busyRun(btn, "Sending…", "Queued", function () {
      var copy = row.cloneNode(true);
      var chip = statusChip(copy);
      if (chip) setLabel(chip, "Queued");
      copy.style.background = "#eef2ff";
      row.parentElement.insertBefore(copy, row.parentElement.firstChild);
      copy.scrollIntoView({ block: "center", behavior: "smooth" });
      toast("A fresh attempt is at the top of the log, queued — nothing was actually sent.");
    });
  }

  /* ------------------------------------------------------------- connect / disconnect a card
   * The card's own status chip flips, and the button keeps the opposite verb afterwards, so
   * the state a visitor left the card in is the state they find it in.
   */
  function onConnect(btn) {
    var orig = labelOf(btn);
    var l = key(orig);
    var off = /^(disconnect|revoke)\b/.test(l);
    if (!off && !/^(connect|reconnect)\b/.test(l)) return false;
    var chip = null;
    for (var n = btn.parentElement, hops = 0; n && hops < 5 && !chip; n = n.parentElement, hops++)
      chip = chipIn(n, /^(connected|not connected|disconnected|inactive|active)$/i);
    return busyRun(btn, off ? "Disconnecting…" : "Connecting…", off ? "Disconnected" : "Connected", function () {
      if (chip) setLabel(chip, off ? "Not connected" : "Connected");
      toast(
        (off ? "Disconnected" : "Connected") + " in the mockup — no credentials change hands on this screen.",
      );
      return off ? orig.replace(/^(disconnect|revoke)/i, "Connect") : orig.replace(/^(re)?connect/i, "Disconnect");
    });
  }

  /* ---------------------------------------------------------------------------- add to a list
   * "Add Keyword", "Add Tag", "Invite Member": the input beside the button has a value and the
   * list beside it has a shape, so the new item is that value drawn in that shape.
   */
  function chipRun(scope) {
    var best = null;
    scope.querySelectorAll("div, ul").forEach(function (box) {
      var kids = Array.prototype.filter.call(box.children, function (k) {
        return !/^(script|input|button|label)$/i.test(k.tagName);
      });
      if (kids.length < 2) return;
      var first = String(kids[0].className);
      if (!first || first.length < 12) return;
      if (
        !kids.every(function (k) {
          return String(k.className) === first;
        })
      )
        return;
      var h = kids[0].getBoundingClientRect().height;
      if (!h || h > 46) return; // a chip, not a card
      if (!best || kids.length > best.length) best = kids;
    });
    return best;
  }

  function onAddItem(btn) {
    var l = key(labelOf(btn));
    if (!/^(add|invite)\b/.test(l)) return false;
    var scope = btn.closest("div[class*='rounded-'], section, form, fieldset");
    for (var hops = 0; scope && hops < 3; hops++, scope = scope.parentElement && scope.parentElement.closest("div[class*='rounded-'], section, form, fieldset")) {
      var input = scope.querySelector("input[type='text'], input[type='email'], input:not([type])");
      var chips = chipRun(scope);
      if (!chips) continue;
      // Settings' opt-out keywords have no input at all — the row is chips and an Add button.
      // So the new chip IS the input: it arrives empty and editable, which is how this row
      // would behave in the real app anyway.
      if (!input) {
        var fresh = chips[chips.length - 1].cloneNode(true);
        setLabel(fresh, "");
        btn.parentElement === chips[chips.length - 1].parentElement
          ? btn.parentElement.insertBefore(fresh, btn)
          : chips[chips.length - 1].parentElement.appendChild(fresh);
        fresh.contentEditable = "true";
        fresh.focus();
        var finish = function () {
          if (fresh.contentEditable !== "true") return;
          var typed = labelOf(fresh).trim();
          if (!typed) return fresh.remove();
          fresh.contentEditable = "false";
          toast("“" + typed + "” added to the list — until you reload.");
        };
        fresh.addEventListener("blur", finish);
        fresh.addEventListener("keydown", function (ev2) {
          if (ev2.key === "Enter") {
            ev2.preventDefault();
            finish();
          } else if (ev2.key === "Escape") fresh.remove();
        });
        toast("Type it in, then press Enter.");
        return true;
      }
      var val = (input.value || "").trim();
      if (!val) {
        input.focus();
        toast("Type it in the box first — “" + labelOf(btn) + "” then puts it in the list.");
        return true;
      }
      var chip = chips[chips.length - 1].cloneNode(true);
      setLabel(chip, val);
      chips[chips.length - 1].parentElement.appendChild(chip);
      input.value = "";
      flashDone(btn, "Added");
      toast("“" + val + "” added to the list — until you reload.");
      return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------------------ the composer
   * The hub draws a reply box, quick-reply pills and a thread of bubbles. The pills fill the
   * box, Send appends a bubble cloned from the last outgoing one. Nothing leaves the page.
   */
  function composerNear(el) {
    for (var n = el, hops = 0; n && hops < 7; n = n.parentElement, hops++) {
      var fields = Array.prototype.filter.call(n.querySelectorAll("input, textarea"), function (f) {
        return /repl|message|type a|comment|note/i.test(f.placeholder || "");
      });
      if (fields.length) return fields[fields.length - 1];
    }
    return null;
  }

  function onQuickReply(btn) {
    // Stitch draws the pills with their brackets: "[Send Replay Link]".
    var m = labelOf(btn).match(/^\[(.+)\]$/);
    if (!m) return false;
    var input = composerNear(btn);
    if (!input) return false;
    input.value = (input.value ? input.value.trim() + " " : "") + m[1];
    input.focus();
    toast("“" + m[1] + "” dropped into the reply box — Send puts it in the thread.");
    return true;
  }

  /* The paperclip beside the composer. There is no template library on this screen, but the
   * canned replies ARE drawn on it as bracketed pills — so the menu offers those rather than
   * inventing template names, and picking one fills the box exactly as the pill does. */
  function onAttach(btn) {
    var t = (btn.getAttribute("title") || "").toLowerCase();
    if (!/attach|template|canned|snippet/.test(t) || labelOf(btn)) return false;
    var input = composerNear(btn);
    if (!input) return false;
    var items = [];
    document.querySelectorAll("button, a").forEach(function (p) {
      var m = labelOf(p).match(/^\[(.+)\]$/);
      if (!m || items.length >= 6) return;
      items.push({
        label: m[1],
        on: function () {
          input.value = (input.value ? input.value.trim() + " " : "") + m[1];
          input.focus();
          toast("“" + m[1] + "” is in the reply box — Send puts it in the thread.");
        },
      });
    });
    if (!items.length) return false;
    return menuAt(btn, items);
  }

  function onCompose(btn) {
    if (!/^send$/.test(key(labelOf(btn)))) return false;
    var input = composerNear(btn);
    if (!input) return false;
    var text = input.value.trim();
    if (!text) {
      input.focus();
      toast("Type a reply first — Send then adds it to the thread.");
      return true;
    }
    // An outgoing bubble is the template for the next one: same alignment, same colour.
    var bubble = null;
    for (var n = btn.parentElement, hops = 0; n && hops < 8 && !bubble; n = n.parentElement, hops++) {
      // Whatever the thread uses to push a bubble to the right is what marks it as outgoing.
      var outs = n.querySelectorAll("[class*='items-end'], [class*='self-end'], [class*='ml-auto'], [class*='justify-end']");
      if (outs.length) bubble = outs[outs.length - 1];
    }
    if (!bubble || !bubble.parentElement) return false;
    var copy = bubble.cloneNode(true);
    var body = copy.querySelector("p");
    if (body) {
      // One paragraph: the bubble being copied is a templated message with a body and a
      // details line, and a two-paragraph reply to "ok thanks" would look absurd.
      Array.prototype.slice.call(copy.querySelectorAll("p")).forEach(function (p, i) {
        if (i) p.remove();
      });
      body.textContent = text;
    } else setLabel(copy, text);
    // The timestamp beside it is part of the bubble, so it says now rather than 10:04 AM.
    Array.prototype.forEach.call(copy.querySelectorAll("span"), function (sp) {
      if (/^\d{1,2}:\d{2}(\s?[AP]M)?$/i.test(sp.textContent.trim()))
        sp.textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    });
    bubble.parentElement.appendChild(copy);
    input.value = "";
    copy.scrollIntoView({ block: "center", behavior: "smooth" });
    toast("Added to the thread — nothing was sent: this is a mockup.");
    return true;
  }

  /* --------------------------------------------------------------------------- a step wizard
   * The campaign modal numbers four steps across its top and Stitch drew the second one, so
   * its Next button had nowhere to go and its stepper drew step 3 half-finished: a wizard that
   * is a picture of a wizard. The other three panels are authored in
   * panels/modal-create-campaign.html and injected by wire.py; everything below is what makes
   * them a wizard — the stepper is a tab strip, Next and Back move one step, and the footer's
   * primary button becomes the step's own action on the last one.
   *
   * The steps are found by their numbering ("1. Audience"), and the three states — done,
   * current, still to come — are read off the three steps that are in them, so the classes
   * moved are the designer's own.
   */
  function stepper() {
    var groups = [];
    document.querySelectorAll("div, li").forEach(function (d) {
      var t = labelOf(d);
      // Searched, not anchored: a step that is not yet done shows its own number in the
      // marker circle as well as in the label, so the block reads "2 2. Template".
      if (t.length > 46 || !/[1-9][.)]\s+[A-Za-z]/.test(t)) return;
      var p = d.parentElement;
      if (!p) return;
      var g = null;
      groups.forEach(function (x) {
        if (x.parent === p) g = x;
      });
      if (!g) groups.push((g = { parent: p, steps: [] }));
      g.steps.push(d);
    });
    // The step blocks and their inner rows both match; they differ in their parent, and the
    // outer group is the one with every step in it.
    var best = null;
    groups.forEach(function (g) {
      if (g.steps.length >= 3 && (!best || g.steps.length > best.steps.length)) best = g;
    });
    return best;
  }

  /* The marker circle, the label and the progress bar of one step. */
  function partsOf(step) {
    var circle = null;
    var text = null;
    var bar = null;
    step.querySelectorAll("span").forEach(function (s) {
      if (/material-symbols/.test(String(s.className))) return;
      if (circle && circle.contains(s)) return;
      var r = s.getBoundingClientRect();
      if (!circle && r.width && r.width <= 40 && Math.abs(r.width - r.height) < 9) circle = s;
      else if (!text && labelOf(s)) text = s;
    });
    step.querySelectorAll("div").forEach(function (d) {
      if (bar || d.children.length) return;
      if (d.getBoundingClientRect().height <= 8) bar = d;
    });
    return circle && text ? { circle: circle, text: text, bar: bar } : null;
  }

  /* What a step in one of the three states looks like, captured before anything moves. Taken
   * live it would be wrong the moment the first step was re-dressed: the step that has just
   * become "done" is then also the model for the step that should become "current". */
  function snapOf(step) {
    var p = partsOf(step);
    if (!p) return null;
    var tick = iconOf(p.circle);
    return {
      circle: p.circle.className,
      text: p.text.className,
      bar: p.bar && p.bar.className,
      marker: tick ? tick.outerHTML : null, // a tick for a done step, else the step's number
    };
  }

  function dressStep(step, snap, index) {
    var mine = partsOf(step);
    if (!mine || !snap) return false;
    mine.circle.className = snap.circle;
    mine.text.className = snap.text;
    if (mine.bar && snap.bar) mine.bar.className = snap.bar;
    mine.circle.innerHTML = snap.marker || String(index + 1);
    return true;
  }

  /* A step's name without its numbering: the marker circle holds the number too, so labelOf
   * of the whole block reads "3 3. Variables & Preview". */
  function stepName(step) {
    return labelOf(step)
      .replace(/^\d+\s+/, "")
      .replace(/^\d+[.)]\s*/, "");
  }

  /* The wizard, once: its steps, its panels, the three state snapshots and the footer's
   * primary button as the export wrote it. Null on every screen that has no authored panels,
   * which is how onWizard keeps its old stepper-only behaviour everywhere else. */
  var WIZ = null;

  function initWizard() {
    var box = document.querySelector("[data-demo-panels]");
    if (!box) return;
    var st = stepper();
    if (!st || st.steps.length < 2) return;
    var steps = st.steps;
    var own = parseInt(box.getAttribute("data-demo-panels"), 10);
    var panels = {};
    // The export's own body is the sibling the panels were injected in front of — found by
    // position so that wire.py never has to put an attribute on Stitch's markup.
    panels[own] = box.nextElementSibling;
    Array.prototype.forEach.call(box.children, function (p) {
      var n = parseInt(p.getAttribute("data-demo-panel"), 10);
      if (n) panels[n] = p;
    });
    // Captured before anything is re-dressed: the step that has just become "done" would
    // otherwise be the model for the step that should become "current".
    var done = snapOf(steps[0]);
    var here = snapOf(steps[own - 1]);
    var later = snapOf(steps[steps.length - 1]);
    if (!panels[own] || !done || !here || !later || !done.marker) return;
    var next = null;
    document.querySelectorAll("button").forEach(function (b) {
      if (!next && /^next\b/i.test(labelOf(b))) next = b;
    });
    WIZ = {
      steps: steps,
      panels: panels,
      at: own,
      done: done,
      here: here,
      later: later,
      next: next,
      nextHTML: next && next.innerHTML,
    };
    steps.forEach(function (s, i) {
      s.style.cursor = "pointer";
      s.setAttribute("title", "Go to step " + (i + 1));
      s.addEventListener("click", function (e) {
        // Stops here: the document-level handler would otherwise read the marker circle as a
        // control of its own and toast over the step it just moved to.
        e.stopPropagation();
        if (WIZ.at === i + 1) return toast("Step " + (i + 1) + " is the one you are on.");
        showWizardStep(i + 1);
        toast("Step " + (i + 1) + " of " + steps.length + " — " + stepName(steps[i]) + ".");
      });
    });
    // Puts the stepper into three states instead of four (Stitch drew step 3's progress bar
    // as half-filled while its marker said "not started"), and corrects the footer, which
    // promised "Next: Schedule & Dispatch" while standing two steps away from it.
    showWizardStep(own);
  }

  function showWizardStep(n) {
    if (!WIZ || n < 1 || n > WIZ.steps.length) return false;
    Object.keys(WIZ.panels).forEach(function (k) {
      var p = WIZ.panels[k];
      if (p) p.style.display = Number(k) === n ? "" : "none";
    });
    WIZ.steps.forEach(function (s, i) {
      dressStep(s, i + 1 < n ? WIZ.done : i + 1 === n ? WIZ.here : WIZ.later, i);
    });
    WIZ.at = n;
    var b = WIZ.next;
    if (b) {
      b.innerHTML = WIZ.nextHTML; // the export's own arrow and spacing, back as drawn
      if (n < WIZ.steps.length) setLabel(b, "Next: " + stepName(WIZ.steps[n]));
      else {
        // The last step's Next is not a Next. Relabelled, it falls to onAct, which gives it
        // the send verb's busy → done — and no longer moves a stepper that has run out.
        setLabel(b, "Send broadcast");
        var ic = iconOf(b);
        if (ic) ic.textContent = "send";
      }
    }
    return true;
  }

  function onWizard(btn) {
    var l = key(labelOf(btn));
    var fwd = /^(next|continue|proceed)\b/.test(l);
    var back = /^(back|previous)\b/.test(l);
    if (!fwd && !back) return false;
    if (WIZ) {
      var want = WIZ.at + (fwd ? 1 : -1);
      if (want < 1 || want > WIZ.steps.length) {
        toast(fwd ? "This is the last step of the wizard." : "This is the first step of the wizard.");
        return true;
      }
      showWizardStep(want);
      toast(
        "Step " + want + " of " + WIZ.steps.length + " — " + stepName(WIZ.steps[want - 1]) +
          ". Nothing is stored: this is a mockup.",
      );
      return true;
    }
    var st = stepper();
    if (!st) return false;
    var steps = st.steps;
    // Current step = the first one that is not already ticked off.
    var at = 0;
    while (at < steps.length && iconOf(steps[at])) at++;
    if (at >= steps.length) at = steps.length - 1;
    var done = at > 0 ? steps[at - 1] : null;
    var idle = at + 1 < steps.length ? steps[at + 1] : null;
    var to = fwd ? at + 1 : at - 1;
    if (to < 0 || to >= steps.length) {
      toast(fwd ? "This is the last step of the wizard." : "This is the first step of the wizard.");
      return true;
    }
    if (fwd && (!done || !idle)) return false; // no reference state to copy; let it toast
    if (back && !done) return false;
    var asDone = done && snapOf(done);
    var asHere = snapOf(steps[at]);
    var asLater = idle && snapOf(idle);
    var moved = fwd
      ? dressStep(steps[at], asDone, at) && dressStep(steps[to], asHere, to)
      : dressStep(steps[at], asLater || asHere, at) && dressStep(steps[to], asHere, to);
    if (!moved) return false;
    toast(
      "Step " + (to + 1) + " of " + steps.length + " — " + labelOf(steps[to]) +
        ". Only one step's panel was drawn, so the form below stays put.",
    );
    return true;
  }

  /* ------------------------------------------------------------------- the workspace switcher
   * "Acme ▾" in the header, "Acme Growth Co ⇅" in the sidebar: the same control, and on
   * thirteen screens it did nothing. What a workspace menu holds is knowable — the workspaces
   * you have, the settings for this one, the way out — and two of those three are honest here.
   */
  function onIdentityMenu(btn) {
    if (!btn.closest("header, aside, nav")) return false;
    var name = labelOf(btn);
    if (!name || name.length > 34) return false;
    var ic = iconOf(btn);
    var chev = ic && /arrow_drop_down|expand_more|unfold_more|keyboard_arrow_down/.test(ic.textContent);
    if (!chev) return false;
    var settings = document.querySelector("a[href='settings.html'], a[href='settings-channels.html']");
    var items = [
      {
        label: name,
        tick: true,
        on: function () {
          toast("“" + name + "” is the only workspace in the sample data.");
        },
      },
    ];
    if (settings)
      items.push({
        label: "Workspace settings",
        on: function () {
          location.href = settings.getAttribute("href");
        },
      });
    items.push({ rule: true });
    items.push({
      label: "Sign out",
      on: function () {
        toast("Signing out is outside the mockup — there is no session behind it.");
      },
    });
    return menuAt(btn, items);
  }

  /* An icon-only control names itself with a title. Handlers that decide by label read it
   * through this, because "Resend Calendar / Encore WhatsApp Link" is the same verb whichever
   * attribute the designer wrote it in. */
  function verbOf(btn) {
    return labelOf(btn) || btn.getAttribute("title") || btn.getAttribute("aria-label") || "";
  }

  /* Say where something landed. Used wherever a click adds or changes a row far enough down
   * the page that the change would otherwise happen off screen. */
  function flashRow(el) {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    var was = el.style.boxShadow;
    el.style.boxShadow = "0 0 0 2px #4f46e5";
    setTimeout(function () {
      el.style.boxShadow = was;
    }, 1500);
  }

  /* ------------------------------------------------------------------- one of a look-alike run
   * The run's odd member out IS the current selection, so choosing another means the two swap
   * wardrobes — no guessing at which Tailwind classes mean "selected". A marker the selected
   * one carries alone (the flow strip draws a dot) moves with the selection. Returns false
   * when nothing in the run is drawn as selected, which is how a toolbar is told apart from
   * a choice.
   */
  function selectAmong(btn) {
    var parent = btn.parentElement;
    if (!parent) return false;
    var run = Array.prototype.filter.call(parent.children, function (k) {
      return k.tagName === btn.tagName && String(k.className).length >= 20;
    });
    if (run.length < 2 || run.indexOf(btn) < 0) return false;
    var seen = {};
    run.forEach(function (k) {
      seen[k.className] = (seen[k.className] || 0) + 1;
    });
    var classes = Object.keys(seen);
    if (classes.length !== 2) return false;
    var chosen = classes.filter(function (c) {
      return seen[c] === 1;
    })[0];
    var rest = classes.filter(function (c) {
      return c !== chosen;
    })[0];
    if (!chosen || chosen === btn.className) return false;
    var was = run.filter(function (k) {
      return k.className === chosen;
    })[0];
    var mark = Array.prototype.filter.call(was.children, function (c) {
      return !c.children.length && !c.textContent.trim() && /rounded-full/.test(String(c.className));
    })[0];
    was.className = rest;
    btn.className = chosen;
    if (mark) btn.insertBefore(mark, btn.firstChild);
    return true;
  }

  /* ----------------------------------------------------------------- a card with a detail pane
   * Authored panels only — nothing Stitch exports carries these attributes. A card marked
   * `data-demo-reveals="tag"` shows the `data-demo-shown-when="tag"` block in its own panel and
   * hides that block's siblings, because choosing "A contact tag" and leaving a webinar picker
   * underneath it would be a design lie rather than a missing behaviour.
   */
  function onReveal(btn) {
    var k = btn.getAttribute && btn.getAttribute("data-demo-reveals");
    if (!k) return false;
    var scope = btn.closest("[data-demo-panel]") || document;
    var already = null;
    scope.querySelectorAll("[data-demo-shown-when]").forEach(function (b) {
      if (b.style.display !== "none") already = b.getAttribute("data-demo-shown-when");
    });
    selectAmong(btn);
    var shown = null;
    scope.querySelectorAll("[data-demo-shown-when]").forEach(function (b) {
      var mine = b.getAttribute("data-demo-shown-when") === k;
      b.style.display = mine ? "" : "none";
      if (mine) shown = b;
    });
    // Clicking the card that is already chosen moves nothing, so say that rather than
    // announce a choice the visitor can see was already made.
    if (already === k) toast("“" + nameOf(btn) + "” is already the choice.");
    else toast("“" + nameOf(btn) + "” chosen" + (shown ? " — the detail below follows it." : "."));
    return true;
  }

  /* ------------------------------------------------------------------- a row feeding a preview
   * Also authored-only: the row's [data-demo-value="2"] cells are copied into the preview's
   * [data-demo-slot="2"] beside it. It is what makes the wizard's variable step a resolution
   * preview — click the recipient whose first_name is missing and the bubble reads "Hey there".
   */
  function onSampleRow(btn) {
    if (!btn.querySelectorAll) return false;
    var cells = btn.querySelectorAll("[data-demo-value]");
    if (!cells.length) return false;
    var scope = btn.closest("[data-demo-panel]") || document;
    var filled = 0;
    Array.prototype.forEach.call(cells, function (c) {
      var text = labelOf(c);
      scope.querySelectorAll('[data-demo-slot="' + c.getAttribute("data-demo-value") + '"]').forEach(function (slot) {
        slot.textContent = text;
        filled++;
      });
    });
    if (!filled) return false;
    selectAmong(btn);
    toast("Preview rendered for " + nameOf(btn) + " — " + cells.length + " variables resolved.");
    return true;
  }

  /* ---------------------------------------------------------------------------- option cards
   * A grid of look-alike cards, each naming a thing rather than an action — the modal's
   * trigger events, an import method, a plan. Clicking one chooses it: classes are swapped
   * where the design draws a chosen card, and a ring is added where it draws none.
   */
  function onOptionCard(btn) {
    if (btn.tagName !== "BUTTON" && btn.getAttribute("role") !== "button") return false;
    var parent = btn.parentElement;
    if (!parent) return false;
    var box = btn.getBoundingClientRect();
    // A card, not a pill in a toolbar. 44px because the create-journey modal draws its five
    // trigger cards 50px tall; what actually keeps a tab out of here is the <p> below.
    if (box.height < 44 || box.width < 200) return false
    var like = Array.prototype.filter.call(parent.children, function (k) {
      return k.tagName === btn.tagName && Math.abs(k.getBoundingClientRect().height - box.height) < 24;
    });
    if (like.length < 2) return false;
    var label = labelOf(btn);
    // A card reads as a noun and carries a description under its name. A verb this size is a
    // primary action, and one line of text is a tab.
    if (!label || label.length > 140 || looksLikeAction(label)) return false;
    if (!btn.querySelector("p")) return false; // a name with a description under it
    if (!selectAmong(btn)) {
      like.forEach(function (k) {
        if (k.hasAttribute("data-demo-chosen")) {
          k.style.boxShadow = "";
          k.removeAttribute("data-demo-chosen");
        }
      });
      btn.style.boxShadow = "0 0 0 2px #4f46e5";
      btn.setAttribute("data-demo-chosen", "1");
    }
    toast("“" + nameOf(btn) + "” chosen — what it configures is drawn on its own screen.");
    return true;
  }

  /* ------------------------------------------------------------------- the header's own icons
   * Every shell draws a bell and a help icon, and on every screen both were dead. The bell
   * is built out of the screen: anything on it carrying a relative timestamp is a thing that
   * just happened, and clicking one goes to it. Help points at the mockup's own documentation,
   * which is the honest answer to "where do I read about this".
   */
  function onHeaderTool(btn) {
    if (labelOf(btn)) return false; // icon-only chrome, not a labelled button
    var t = (btn.getAttribute("title") || btn.getAttribute("aria-label") || "").toLowerCase();
    var ic = iconOf(btn);
    var lig = ic ? ic.textContent.trim() : "";
    if (/help|documentation/.test(t) || /^(help|help_outline|help_center|info)$/.test(lig)) {
      var details = document.querySelector("#demo-switcher details");
      return menuAt(btn, [
        {
          label: "What is wired in this mockup",
          on: function () {
            location.href = "../README.md";
          },
        },
        {
          label: "The design system behind these screens",
          on: function () {
            location.href = "../design-system.md";
          },
        },
        { rule: true },
        {
          label: "Every screen in the set",
          on: function () {
            if (!details) return location.href = "../index.html";
            details.open = true;
            flashRow(details);
          },
        },
      ]);
    }
    if (!/notification|alert|inbox/.test(t) && !/^notifications(_active|_none)?$/.test(lig)) return false;

    var items = [];
    document.querySelectorAll("span, p, time, td").forEach(function (s) {
      if (items.length >= 4 || !plainish(s)) return;
      if (!/^\d+\s?(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)\s+ago$/i.test(labelOf(s))) return;
      // Dashboard's activity feed is neither a table nor a list — it is a stack of divs — so
      // when the row shapes miss, the item is the nearest ancestor that holds more words than
      // the timestamp itself: the message it belongs to.
      var row = rowOf(s) || s.closest("li, tr");
      if (!row)
        for (var n = s.parentElement, hops = 0; n && hops < 3; n = n.parentElement, hops++)
          if (labelOf(n).length > labelOf(s).length + 8) {
            row = n;
            break;
          }
      if (!row || row.contains(btn)) return;
      var text = labelOf(row).replace(/\s+/g, " ").trim();
      if (!text) return;
      var already = items.some(function (x) {
        return x.row === row || x.row.contains(row) || row.contains(x.row);
      });
      if (already) return;
      items.push({
        row: row,
        label: labelOf(s) + " · " + text.slice(0, 52),
        on: function () {
          flashRow(row);
        },
      });
    });
    // The unread dot is the one part of the bell that can honestly be cleared, and clearing
    // it is what makes opening the panel visible rather than merely announced.
    var dot = Array.prototype.filter.call(btn.children, function (c) {
      return !c.children.length && !c.textContent.trim();
    })[0];
    if (dot) dot.style.display = "none";
    if (!items.length)
      items.push({
        label: "Nothing on this screen is timestamped",
        on: function () {
          toast("The bell is drawn on every screen; this one lists nothing recent to point at.");
        },
      });
    items.push({ rule: true });
    items.push({
      label: "Mark all as read",
      on: function () {
        toast("Read — the badge is cleared on this screen only.");
      },
    });
    return menuAt(btn, items);
  }

  /* ------------------------------------------------------------------------ collapse the shell
   * The sidebar is an <aside>, and the column beside it is held off it by a padding class in
   * the same scale (pl-60 is 240px, the aside's width). Collapsing is therefore hiding the
   * one and dropping the other; the class is parked in a dataset so the second click can put
   * back exactly what the first took away.
   */
  function onSidebarToggle(btn) {
    var t = (btn.getAttribute("title") || "").toLowerCase();
    var ic = iconOf(btn);
    var lig = ic ? ic.textContent.trim() : "";
    if (
      !/sidebar|canvas width|collapse|full ?width/.test(t) &&
      !/^(dock_to_right|dock_to_left|menu_open|left_panel_close|view_sidebar)$/.test(lig)
    )
      return false;
    var aside = document.querySelector("aside");
    if (!aside) return false;
    if (aside.dataset.demoCollapsed) {
      aside.style.display = "";
      delete aside.dataset.demoCollapsed;
      document.querySelectorAll("[data-demo-inset]").forEach(function (n) {
        n.classList.add(n.dataset.demoInset);
        n.removeAttribute("data-demo-inset");
      });
      toast("Sidebar back.");
      return true;
    }
    var unit = Math.round(aside.getBoundingClientRect().width / 4); // Tailwind's 4px scale
    var token = new RegExp("^(pl|ml|left)-" + unit + "$");
    aside.style.display = "none";
    aside.dataset.demoCollapsed = "1";
    document.querySelectorAll("div, header, main, section, footer").forEach(function (n) {
      for (var i = 0; i < n.classList.length; i++)
        if (token.test(n.classList[i])) {
          n.dataset.demoInset = n.classList[i];
          n.classList.remove(n.classList[i]);
          return;
        }
    });
    toast("Sidebar collapsed — the canvas has the whole window.");
    return true;
  }

  /* --------------------------------------------------------------- add a step to the canvas
   * The + on a connector. What a step being added looks like is a step appearing, so the node
   * above the gap is cloned into it and renamed: an empty box would not show what the canvas
   * does with a new step. The clone is stripped of its own buttons and absolutely positioned
   * decoration, or it would arrive carrying another + and another connector.
   */
  function nodeish(n) {
    if (!n || n.nodeType !== 1) return false;
    var box = n.getBoundingClientRect();
    return (
      box.width >= 200 && box.width <= 560 && box.height >= 56 && /rounded-/.test(String(n.className)) && labelOf(n).length > 4
    );
  }

  function onInsertStep(btn) {
    var t = (btn.getAttribute("title") || "") + " " + labelOf(btn);
    if (!/\b(add|insert)\b/i.test(t) || !/\bstep\b/i.test(t)) return false;
    var slot = btn.parentElement;
    if (!slot || !slot.parentElement) return false;
    var model = null;
    for (var n = slot.previousElementSibling; n && !model; n = n.previousElementSibling) if (nodeish(n)) model = n;
    if (!model) model = Array.prototype.filter.call(slot.parentElement.children, nodeish)[0];
    if (!model) return false;
    var copy = model.cloneNode(true);
    Array.prototype.forEach.call(copy.querySelectorAll("button, [class*='absolute']"), function (k) {
      k.remove();
    });
    var head = copy.querySelector("h1, h2, h3, h4, h5") || nameNode(copy);
    if (head) setLabel(head, "New Step");
    Array.prototype.slice.call(copy.querySelectorAll("p")).forEach(function (p, i) {
      if (i) p.remove();
      else if (p !== head) setLabel(p, "Unconfigured — choose a message, delay or branch");
    });
    copy.style.outline = "2px dashed #4f46e5";
    copy.setAttribute("data-demo-new-step", "1");
    slot.parentElement.insertBefore(copy, slot.nextSibling);
    flashRow(copy);
    toast("A step is on the canvas at that point — unconfigured, and gone when you reload.");
    return true;
  }

  function onDeleteNode(btn) {
    var t = verbOf(btn).toLowerCase();
    if (!/^(delete|remove|discard)\b/.test(t.trim())) return false;
    var node = null;
    for (var n = btn.parentElement; n && !node; n = n.parentElement) if (nodeish(n)) node = n;
    var row = node || rowOf(btn);
    if (row) {
      var name = nameOf(row);
      row.style.display = "none";
      toast("“" + name + "” removed — reload to bring it back.");
      return true;
    }
    // step-branch-rules draws this in the page header, because what it deletes is the step
    // the whole screen configures — there is no card to hide. Leaving for the canvas the step
    // lives on is what deleting it has to look like here.
    if (!/\bstep\b/i.test(t)) return false;
    var back =
      document.querySelector("a[href='journey-builder.html']") ||
      document.querySelector("nav a[href$='.html'], header a[href$='.html']");
    if (!back) return false;
    location.href = back.getAttribute("href");
    return true;
  }

  /* --------------------------------------------------------------------------- mode strips
   * A pair of buttons that name two halves of the same page — the create-journey modal's
   * "Start from Pre-built Blueprint" and "Choose Trigger Event (Custom)", both of which are
   * drawn, one under the other. So choosing one moves the selection and goes to the section
   * it names, which is the whole of what the real control would do.
   */
  function onSectionJump(btn) {
    var label = labelOf(btn);
    if (!label || label.length < 10 || label.length > 46) return false;
    var run = Array.prototype.filter.call((btn.parentElement || btn).children, function (k) {
      return k.tagName === "BUTTON";
    });
    if (run.length < 2 || run.length > 4) return false;
    // A word long enough to be the name of a thing, ignoring the verb in front of it.
    var words = label.match(/[A-Za-z][a-z]{4,}/g) || [];
    var heads = Array.prototype.slice.call(
      document.querySelectorAll("h1, h2, h3, h4, h5, [class*='font-headline']"),
    ).filter(function (h) {
      return !h.contains(btn) && !btn.contains(h) && labelOf(h).length < 70;
    });
    var hit = null;
    for (var i = 0; i < words.length && !hit; i++) {
      var w = new RegExp("\\b" + words[i] + "s?\\b", "i");
      var matches = heads.filter(function (h) {
        return w.test(labelOf(h));
      });
      if (matches.length === 1) hit = matches[0];
    }
    if (!hit) return false;
    selectAmong(btn);
    flashRow(hit);
    toast("“" + labelOf(hit) + "” — that section is further down this same screen.");
    return true;
  }

  /* ---------------------------------------------------------------------- mark as resolved
   * The open conversation is drawn twice: as the thread, and as a card in the list beside it.
   * The chip that has to change is the one in the list, found by the name the thread's own
   * header shows — and it borrows the classes of a card that is already resolved, so the
   * flipped chip is drawn the way this screen draws that state.
   */
  function onResolve(btn) {
    var t = verbOf(btn).toLowerCase().trim();
    if (!/^(mark as |mark )?(resolved|resolve|handled|done reading)$/.test(t) && !/^mark as (read|done)$/.test(t))
      return false;
    var head = btn.parentElement && btn.parentElement.parentElement;
    var who = head ? nameOf(head) : "this chat";
    var open = /^(needs reply|unresolved|open|awaiting reply|pending|new)$/i;
    var card = null;
    document.querySelectorAll("div, li, tr").forEach(function (c) {
      if (card || c.contains(btn) || c.children.length < 2) return;
      if (c.getBoundingClientRect().height > 240) return;
      var text = labelOf(c);
      if (who !== "this chat" && text.indexOf(who) < 0) return;
      if (chipIn(c, open)) card = c;
    });
    var chip = card && chipIn(card, open);
    if (!chip) return false;
    var model = chipIn(document.body, /^(resolved|handled|closed)$/i);
    if (model && model !== chip) chip.className = model.className;
    setLabel(chip, "Resolved");
    flashRow(card);
    flashDone(btn, "");
    toast("“" + who + "” is marked resolved in the list — on this screen only.");
    return true;
  }

  /* The logs live on one screen in this set, and several screens offer to show them. */
  function onViewLog(btn) {
    var t = verbOf(btn).trim();
    if (!/^(view|open|see|inspect)\b/i.test(t) || !/\blogs?\b/i.test(t)) return false;
    if (HERE === "exec-logs") return false;
    location.href = "exec-logs.html";
    return true;
  }

  /* Cancel outside a modal means leaving an editor without saving: back where the visitor
   * came from, or to whatever the breadcrumb above names. */
  function onCancel(btn) {
    if (key(labelOf(btn)) !== "cancel") return false;
    if (history.length > 1) {
      history.back();
      return true;
    }
    var crumb = document.querySelector("nav a[href$='.html'], header a[href$='.html']");
    if (!crumb) return false;
    location.href = crumb.getAttribute("href");
    return true;
  }

  /* ------------------------------------------------------- buttons drawn inside a preview
   * A template preview draws the recipient's own buttons — "Join Webinar", "Stop promotions".
   * Making those do something would be a lie about who is looking at the screen, so they say
   * whose buttons they are. This is the one handler whose honest answer is words.
   */
  function onPreviewButton(btn) {
    var bubble = btn.closest(
      "[class*='preview'], [id*='preview'], [class*='d9fdd3'], [class*='dcf8c6'], [class*='e7ffdb']",
    );
    if (!bubble || bubble === btn) return false;
    toast("“" + labelOf(btn) + "” is drawn inside the message preview — that is the recipient's button, not yours.");
    return true;
  }

  /* -------------------------------------------------------------------------- everything else
   * A control whose label begins with a verb gets the state the real one would have: busy,
   * then done, then itself again. The claim it makes is only that the click was received —
   * the toast is what says nothing was stored.
   */
  function onAct(btn) {
    var orig = labelOf(btn);
    var t = tense(orig);
    if (!t) return false;
    if (t.opens) {
      // "Edit Limits", "Configure Studio": these open a screen, and the screen is the thing
      // that was not drawn. Pretending to succeed would be the one dishonest answer.
      toast("“" + orig + "” would open its own screen — that one was not drawn in this mockup.");
      return true;
    }
    return busyRun(btn, t.busy, t.done, function () {
      toast("“" + orig + "” — the control responds, but nothing is stored: this is a mockup.");
    });
  }

  /* ------------------------------------------------------------------- search-as-you-type */
  document.querySelectorAll("input").forEach(function (input) {
    if (isOwned(input)) return;
    var hint = (input.placeholder || "") + " " + (input.type || "");
    if (!/search|filter|find/i.test(hint)) return;
    var rows = rowsNear(input);
    if (!rows) return;
    input.addEventListener("input", function () {
      if (!filterRows(rows, input.value.trim()) && input.value.trim())
        toast("Nothing in the sample data matches “" + input.value.trim() + "”.");
    });
  });

  /* ------------------------------------------------------------------ native selects, too */
  document.querySelectorAll("select").forEach(function (sel) {
    if (isOwned(sel)) return;
    sel.addEventListener("change", function () {
      var rows = rowsNear(sel);
      if (rows && filterRows(rows, sel.value)) return;
      if (rows) filterRows(rows, "");
      toast("“" + sel.options[sel.selectedIndex].text + "” chosen — nothing behind it changes.");
    });
  });

  /* -------------------------------------------------------------------------- one listener
   * Everything above is tried in order for a single click, so a control can never be
   * handled twice. Anything that falls through says out loud that it is static, which is
   * the point: a reviewer should never be left wondering whether they mis-clicked.
   */
  document.addEventListener("click", function (e) {
    if (openMenu && !openMenu.contains(e.target)) closeMenu();

    // The real control first: closest() on a broad selector can stop at an inner rounded
    // <span> and make an icon button look like a non-control, which is how a click ends up
    // silently dead.
    var el = e.target.closest("a, button, [role='button'], [role='switch']") || e.target.closest("[class*='rounded-']");
    if (!el) return;
    if (el.closest("#demo-switcher")) return;
    if (/^(input|select|textarea|label|option)$/i.test(e.target.tagName)) return;

    // Getting out of a modal is the one thing that beats the export's own handler. These
    // screens were drawn as a modal over a parent that is not there, so the import modal's
    // inline Cancel — which only sets its scrim to display:none — would leave a blank page.
    // Going back where the visitor came from is what dismissing it has to mean here.
    if (onModalClose(el)) {
      e.preventDefault();
      return;
    }
    if (isOwned(el)) return; // the screen's own script has this one

    // A link wire.py gave a destination is simply a link.
    var href = el.getAttribute && el.getAttribute("href");
    if (el.tagName === "A" && href && href !== "#") return;

    // wire.py tags sidebar items whose screen was never drawn, so the click can say why
    // nothing happened instead of looking broken.
    var undrawn = el.getAttribute("data-demo-undrawn");
    if (undrawn) {
      e.preventDefault();
      toast("“" + undrawn + "” is a sidebar item only — no screen was drawn for it.");
      return;
    }

    var l = key(labelOf(el));

    // The Flow Engine shell lists its four flows beside the nav; one canvas is drawn.
    if (/^flow \d/.test(l)) {
      e.preventDefault();
      // "Flow 2: Calendar Invite" — what follows the colon is how the log rows are tagged, so
      // on a screen that lists those rows the answer is to filter them rather than to leave.
      var flow = (labelOf(el).split(":")[1] || "").trim();
      var frows = flow ? rowsNear(el) : null;
      if (
        frows &&
        frows.some(function (r) {
          return (r.innerText || "").toLowerCase().indexOf(flow.toLowerCase()) >= 0;
        })
      ) {
        toast(filterRows(frows, flow) + " rows tagged “" + flow + "”.");
        return;
      }
      if (HERE !== "flow-builder") {
        location.href = "flow-builder.html";
        return;
      }
      // On the canvas itself the strip is a breadcrumb of the four flows: move the selection
      // onto the one that was clicked, and say why the board did not change with it.
      selectAmong(el);
      toast("“" + labelOf(el) + "” selected — this canvas draws all four flows on one board.");
      return;
    }

    var target = GO[l];
    if (target && target !== HERE) {
      e.preventDefault();
      location.href = target + ".html";
      return;
    }

    // Order matters in two places only, and both are a general shape shadowing a specific
    // one: onToken before onAddItem (a "+ Add {{first_name}}" chip is not an Add button), and
    // onQuickReply/onCompose before onTab (a row of identical pills has a tab strip's shape).
    if (
      onZoom(el) ||
      onDropdown(el) ||
      onIdentityMenu(el) ||
      onColumns(el) ||
      onOptionsMenu(el) ||
      onCopy(el) ||
      onExport(el) ||
      onPager(el) ||
      onWizard(el) ||
      onQuickReply(el) ||
      onAttach(el) ||
      onCompose(el) ||
      onTab(el) ||
      onToken(el) ||
      onPreviewButton(el) ||
      onResend(el) ||
      onConnect(el) ||
      onHeaderTool(el) ||
      onSidebarToggle(el) ||
      onInsertStep(el) ||
      onDeleteNode(el) ||
      onResolve(el) ||
      onAddItem(el) ||
      onReveal(el) ||
      onSampleRow(el) ||
      onOptionCard(el) ||
      onSectionJump(el) ||
      onViewLog(el) ||
      onCancel(el)
    ) {
      e.preventDefault();
      return;
    }
    if (onNode(el) || onToggle(e.target)) {
      e.preventDefault();
      return;
    }

    if (el.tagName !== "A" && el.tagName !== "BUTTON" && el.getAttribute("role") !== "button") return;
    e.preventDefault();
    if (onAct(el)) return; // a verb with no specific handler still gets busy → done → itself
    if (!l) {
      // An icon-only control: its title if it has one, otherwise the ligature is the only
      // name it has. Either way it answers, because silence reads as a broken demo.
      var t = el.getAttribute("title") || el.getAttribute("aria-label");
      var icon = el.querySelector(".material-symbols-outlined, .material-symbols-rounded");
      if (t) toast("“" + t + "” is drawn but does nothing here.");
      else if (icon) toast("The " + icon.textContent.trim().replace(/_/g, " ") + " control is drawn but does nothing here.");
      else toast("This control is drawn but does nothing in the mockup.");
      return;
    }
    if (PRETEND.test(l)) toast("“" + labelOf(el) + "” — nothing is stored: this is a mockup.");
    else toast("“" + labelOf(el) + "” is drawn but not wired in this mockup.");
  });

  /* Esc leaves a modal screen, and also shuts a dropdown. */
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (openMenu) return closeMenu();
    if (IS_MODAL) leaveModal();
  });

  /* The wizard has to be read before it can be moved — partsOf() measures the marker circle
   * to tell it from the label — and Tailwind's CDN build generates this page's classes after
   * this script has run. So the wizard is set up once the page has actually painted; every
   * other handler only ever measures inside a click, by which time it always has. */
  if (document.readyState === "complete") requestAnimationFrame(initWizard);
  else
    window.addEventListener("load", function () {
      requestAnimationFrame(initWizard);
    });

  /* Exposed for the CDP verification script (scripts/verify.mjs), which asserts against the
   * demo's own idea of what a row is and what the page already owns rather than
   * re-implementing either and drifting from it. Nothing on the page reads this. */
  window.__demo = {
    isOwned: isOwned,
    labelOf: labelOf,
    rowsNear: rowsNear,
    scrollRegion: scrollRegion,
    stageFor: stageFor,
    stepper: stepper,
    wizardAt: function () {
      return WIZ && WIZ.at;
    },
    statusChip: statusChip,
    toast: toast,
  };

  /* The import modal draws its own scrim; clicking it should dismiss, as it would. */
  var scrim = document.getElementById("importModalScrim");
  if (scrim && !isOwned(scrim))
    scrim.addEventListener("click", function (e) {
      if (e.target === scrim) leaveModal();
    });
})();
