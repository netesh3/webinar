#!/usr/bin/env python3
"""Turn the Stitch exports into one navigable demo.

Stitch renders every screen as a complete HTML document whose links are all `href="#"`.
The screens are otherwise a coherent app, so the only thing standing between them and a
walkable demo is those dead hrefs — this wires each one to the sibling file that IS that
screen, and injects the demo chrome: a switcher for the screens no sidebar item names, and
`demo.js`, which handles the controls that are not links (tabs, filters, dropdowns,
toggles, canvas zoom, closing a modal).

The project draws THREE app shells, so the sidebar cannot be wired from one map: an Engage
screen's Contacts item and a Flow Engine screen's Audience item are different products.
Each screen is assigned a shell, and only that shell's own sidebar is wired — a nav item
whose screen was never drawn keeps `href="#"` and is tagged `data-demo-undrawn`, so
demo.js can say so out loud rather than leave the click silent.

Nothing else in the markup is touched, with one exception that is additive rather than an
edit: where the designer numbered a set of panels and drew only one of them, the missing
panels are authored under `panels/` and injected inside their own fence — see PANELS.

The point of a mockup is to be the designer's output, not this script's. Re-runnable: every
injected block is stripped before it is added back.
"""
import html as htmllib
import json
import re
import sys

OUT = "/Users/gpillay/Personal/webinar/docs/mockups/engage"
manifest = json.load(open(f"{OUT}/manifest.json"))
by_slug = {m["slug"]: m for m in manifest}

# Which shell each screen was drawn in. Wiring a screen with another shell's sidebar would
# teleport between two products and misrepresent both.
SHELLS = {
    "engage": [
        "dashboard", "contacts", "journeys", "campaigns", "templates", "analytics",
        "integrations", "settings", "journey-builder", "journey-builder-spacious",
        "step-branch-rules", "modal-create-journey", "modal-create-campaign",
        "modal-import-contacts",
    ],
    "webinarliv": ["settings-channels", "whatsapp-hub"],
    "flow": ["flow-builder", "attendance", "exec-logs", "database-webhooks"],
}
SHELL_OF = {slug: shell for shell, slugs in SHELLS.items() for slug in slugs}

# Each shell's sidebar: label -> the file that IS that screen, or None when the screen was
# never drawn. Labels are matched whole and case-insensitively, after the Material Symbols
# ligature is dropped and entities are unescaped.
NAV = {
    "engage": {
        "dashboard": "dashboard",
        "contacts": "contacts",
        "journeys": "journeys",
        "campaigns": "campaigns",
        "templates": "templates",
        "analytics": "analytics",
        "integrations": "integrations",
        "settings": "settings",
    },
    "webinarliv": {
        "dashboard": None,
        "webinars": None,
        "templates": None,
        "whatsapp": "whatsapp-hub",
        "analytics": None,
        "settings": "settings-channels",
        # The settings sub-rail, drawn on settings-channels only.
        "account & presenter details": None,
        "workspace & team": None,
        "integrations & channels": "settings-channels",
        "billing & plan": None,
    },
    "flow": {
        "flow builder": "flow-builder",
        "template library": None,
        "audience & segmentation": None,
        "attendance & engagement": "attendance",
        "execution & delivery logs": "exec-logs",
        "database & webhooks": "database-webhooks",
    },
}

# In-page links worth honouring beyond the sidebar, by their whole label. Buttons are left
# to demo.js; these are anchors, which only this script can point somewhere.
EXTRA = {
    "go to journeys": "journeys",  # from the campaigns-vs-journeys guidance card
    "view all": "journeys",  # dashboard's Active Journeys panel
    "journeys canvas": "journey-builder",
}

# Everything reachable, grouped for the switcher. Order is the order a host would meet
# these screens, not the order Stitch happens to list them in.
GROUPS = [
    ("Engage — the eight main screens", [
        ("dashboard", "Live sends, active journeys, recent activity"),
        ("contacts", "The audience CRM: numbers, source, consent"),
        ("journeys", "Every automated journey and its state"),
        ("campaigns", "One-off broadcasts and their delivery"),
        ("templates", "Meta-approved templates and the variable inspector"),
        ("analytics", "Delivery, read velocity and show-up by channel"),
        ("integrations", "Webinar Liv, Cloud API, calendar and webhooks"),
        ("settings", "Workspace, WABA, team, API keys, billing"),
    ]),
    ("Engage — journey builder", [
        ("journey-builder", "The canvas inside the app, with a step inspector"),
        ("journey-builder-spacious", "Full-bleed canvas with a step palette"),
        ("step-branch-rules", "One branch step: rule, both paths, preview"),
    ]),
    ("Engage — modals", [
        ("modal-create-journey", "Create a journey: trigger or blueprint"),
        ("modal-create-campaign", "The four-step broadcast wizard"),
        ("modal-import-contacts", "Import contacts and map the columns"),
    ]),
    ("WebinarLiv shell", [
        ("settings-channels", "Connected integrations and channels"),
        ("whatsapp-hub", "The inbox: chats needing a reply, senders, templates"),
    ]),
    ("Flow Engine shell", [
        ("flow-builder", "The four flows as an orchestrator canvas"),
        ("attendance", "Attendance cohorts and engagement thresholds"),
        ("exec-logs", "Every message attempt, with its payload"),
        ("database-webhooks", "Schema, webhook endpoints, a payload simulator"),
    ]),
]

# Screens where a control the export draws leads to a panel it never drew, and the missing
# panel is authored under panels/ instead. Only one so far: the campaign wizard numbers four
# steps across the top and draws the second, so its own stepper and its own "Next" had nothing
# to move to — a wizard that is a picture of a wizard. Value is (panel file, the export comment
# the panels are inserted after).
#
# The panels go in BEFORE the export's own body, which is what lets demo.js find that body
# without this script marking up Stitch's markup: it is the injected wrapper's next element
# sibling, and the wrapper's data-demo-panels says which step it is.
PANELS = {
    "modal-create-campaign": (
        "modal-create-campaign.html",
        "<!-- Modal Body (Split 2-Column Wizard Layout) -->",
    ),
}
PANEL_MARK = "<!-- demo-panels -->"
PANEL_END = "<!-- /demo-panels -->"

MARK = "<!-- demo-chrome -->"
END = "<!-- /demo-chrome -->"

# Goes at the very top of <head>, so it is listening before the screen's own script runs.
# Some exports are broken: exec-logs binds `searchInput` where the markup says
# logSearchInput, so its script dies part-way and every control it would have wired after
# that line is dead. demo.js reads this to know whether the page's own bindings can be
# trusted, and takes the screen over when they cannot. Resource errors (the Tailwind CDN,
# a missing favicon) are not script failures, so they are filtered out by target.
GUARD_MARK = "<!-- demo-guard -->"
GUARD_END = "<!-- /demo-guard -->"
GUARD = (
    GUARD_MARK + "<script>window.__demoErrors=[];addEventListener('error',function(e){"
    "if(e.target===window||e.error)window.__demoErrors.push(String(e.message||e.error));"
    "},true);</script>" + GUARD_END
)


def chrome(current: str) -> str:
    """Demo-only markup: the screen switcher, and demo.js. Fenced by comments so it is
    obvious which markup is Stitch's and which is this script's."""
    out = [
        MARK,
        # The one correction made to how an export renders, fenced in with the demo's own
        # markup so it cannot be mistaken for Stitch's. Tailwind's `.sr-only` is
        # position:absolute with no inset, so it keeps its static position — and
        # campaigns.html puts one ("Actions", the last <th>) inside a horizontally scrolling
        # table whose containing block is the positioned <main> OUTSIDE that scroller. The
        # scroller therefore does not clip it, the invisible 1px label lands at x=1946, and
        # the whole page scrolls 347px sideways at every window width. Pinning it to its
        # containing block's origin cannot move anything visible: it is 1px square and
        # clipped. Inputs are left alone — `sr-only peer` checkboxes drive the toggles.
        "<style>.sr-only:not(input):not(select):not(textarea){left:0;top:0}</style>",
        '<div id="demo-switcher" style="position:fixed;right:16px;bottom:16px;z-index:9999;'
        'font:500 12px/1.4 Inter,system-ui,sans-serif;">',
        '<details style="background:#fff;border:1px solid #c7c4d8;border-radius:10px;'
        'box-shadow:0 8px 30px rgba(11,28,48,.18);max-width:340px;overflow:hidden">',
        '<summary style="cursor:pointer;padding:9px 13px;list-style:none;color:#3525cd;'
        f'font-weight:600">All {len(manifest)} screens</summary>',
        '<div style="max-height:62vh;overflow:auto;padding:4px 0 8px">',
        '<a href="../index.html" style="display:block;padding:6px 13px;color:#464555;'
        'text-decoration:none">← Contact sheet</a>',
    ]
    for group, items in GROUPS:
        out.append(
            '<div style="padding:8px 13px 3px;color:#777587;font-size:10.5px;'
            f'text-transform:uppercase;letter-spacing:.04em">{group}</div>'
        )
        for slug, _ in items:
            here = slug == current
            style = (
                "display:block;padding:5px 13px;text-decoration:none;"
                + ("color:#3525cd;background:#e5eeff;font-weight:600" if here else "color:#464555")
            )
            out.append(f'<a href="{slug}.html" style="{style}">{by_slug[slug]["title"]}</a>')
    out += [
        '<div style="padding:9px 13px 2px;color:#777587;font-size:10.5px;border-top:'
        '1px solid #e5eeff;margin-top:6px">Buttons and filters are simulated — nothing is '
        'stored. <a href="../README.md" style="color:#3525cd">What is wired</a></div>',
        "</div>",
        "</details>",
        "</div>",
        '<script src="../demo.js" data-demo></script>',
        END,
    ]
    return "".join(out)


def label_of(inner: str) -> str:
    """The anchor's prose, with Material Symbols ligatures dropped. Ligatures are
    all-lowercase tokens ("grid_view", "arrow_forward"); the prose is capitalised."""
    text = htmllib.unescape(re.sub(r"<[^>]+>", " ", inner))
    words = " ".join(text.split()).split()
    while words and re.fullmatch(r"[a-z][a-z0-9_]*", words[0]):
        words.pop(0)
    # A trailing ligature is only ever recognised by its underscore: stripping every
    # lowercase word from the end would turn "View all arrow_right_alt" into "View".
    while words and re.fullmatch(r"[a-z][a-z0-9]*_[a-z0-9_]*", words[-1]):
        words.pop()
    return " ".join(words)


report = []
for m in manifest:
    slug = m["slug"]
    shell = SHELL_OF[slug]
    nav = NAV[shell]
    path = f"{OUT}/screens/{slug}.html"
    src = open(path).read()
    if MARK in src:  # idempotent: re-running must not stack chrome
        src = re.sub(re.escape(MARK) + r".*?" + re.escape(END), "", src, flags=re.S)
    if GUARD_MARK in src:
        src = re.sub(re.escape(GUARD_MARK) + r".*?" + re.escape(GUARD_END), "", src, flags=re.S)
    if PANEL_MARK in src:
        src = re.sub(re.escape(PANEL_MARK) + r".*?" + re.escape(PANEL_END), "", src, flags=re.S)

    hits, undrawn = [], []

    def wire(mo):
        tag, label = mo.group(0), label_of(mo.group(2))
        if not label:
            return tag
        low = label.lower()
        if low in nav or (shell == "engage" and low.split()[-1] in nav):
            target = nav.get(low, nav.get(low.split()[-1]))
            if target is None:  # a sidebar item whose screen was never drawn
                undrawn.append(label)
                if "data-demo-undrawn" in tag:  # already tagged by an earlier run
                    return tag
                return tag.replace("<a", f'<a data-demo-undrawn="{htmllib.escape(label)}"', 1)
        elif shell == "engage" and low in EXTRA:
            target = EXTRA[low]
        else:
            return tag
        if not target or target == slug:
            return tag
        hits.append(label)
        return tag.replace('href="#"', f'href="{target}.html"', 1)

    out = re.sub(r'<a\b[^>]*href="(#)"[^>]*>(.*?)</a>', wire, src, flags=re.S)
    # After the charset declaration, which belongs first in the document, and before every
    # other script — the recorder is no use to demo.js unless it is listening first.
    out = re.sub(
        r"<head\b[^>]*>(?:\s*<meta\s+charset=[^>]*>)?",
        lambda mo: mo.group(0) + GUARD,
        out,
        count=1,
    )
    panels = 0
    if slug in PANELS:
        name, anchor = PANELS[slug]
        body = open(f"{OUT}/panels/{name}").read().rstrip()
        # Anchored on a comment the export itself writes. If a revision renames it the panels
        # would silently vanish, so say so instead: a stepper with three dead steps is exactly
        # the fault they were written to fix.
        if anchor not in out:
            print(f"PANEL ANCHOR GONE in {slug}: {anchor!r} — panels not injected", file=sys.stderr)
        else:
            out = out.replace(anchor, anchor + PANEL_MARK + body + PANEL_END, 1)
            panels = len(re.findall(r'data-demo-panel="\d+"', body))

    out = out.replace("</body>", chrome(slug) + "</body>", 1)
    open(path, "w").write(out)
    report.append((slug, shell, hits, undrawn, panels))

for slug, shell, hits, undrawn, panels in report:
    print(f"{slug:26} {shell:11} {len(hits)} links" + (f", {panels} authored panels" if panels else ""))
    for label in sorted(set(h for h in hits if h.lower() in EXTRA)):
        print(f"{'':26} {'':11}   + {label}")
    if undrawn:
        print(f"{'':26} {'':11}   not drawn: {', '.join(sorted(set(undrawn)))}")
