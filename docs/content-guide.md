# Writing for the blog

The blog lives at `/blog` on the website. It has one index with three categories:

| Category | Slug | For |
|---|---|---|
| Tutorials | `tutorials` | Step-by-step "how to" guides for hosts, one feature per post |
| Engineering | `engineering` | How the platform is built and why: architecture, trade-offs, lessons |
| Product | `product` | What changed and what it means for hosts |

Each category has its own page (`/blog/category/<slug>`), and the index has filter chips
for them. One blog with categories, rather than separate `/learn` and `/blog` sections,
keeps one feed, one sitemap entry point and one set of templates. A tutorial can still
link to the engineering post behind it.

## Where posts live

A post is a TypeScript module in `web/content/blog/<slug>.ts` that exports a `Post`:

```ts
import type { Post } from "../../lib/blog.ts";

export const post: Post = {
  slug: "turn-a-recording-into-a-simulive",   // the URL: /blog/<slug>
  title: "Turn a recording into a Simulive",
  description: "One or two sentences, 50–200 characters. Used on cards, in search and the feed.",
  date: "2026-10-24",                         // first published, YYYY-MM-DD
  updated: "2026-11-02",                      // optional: last meaningful edit
  category: "tutorials",                      // tutorials | engineering | product
  tags: ["simulive", "recordings"],           // lowercase; drive "Related posts"
  body: `
    Markdown here. Indent it as much as you like; the common indent is removed.
  `,
};
```

Then add it to `web/content/blog/index.ts`. That is all: the index, category pages,
post page, sitemap and RSS feed (`/blog/rss.xml`) pick it up. Posts are compiled into
the build, so every page is generated statically and nothing reads the filesystem at
runtime on Workers.

The author is always shown as "Webinar Liv team". Reading time, the table of contents
(posts with 4 or more `##` sections), previous/next (within the category) and related
posts (shared tags first) are worked out for you.

`make test-web` runs `web/lib/blog.test.mts`, which validates every post: slug format,
description length, dates, lowercase tags, alt text on every image, known diagram
names, and links between posts that point at real posts. A broken post fails the build.

## The Markdown you can use

The body is a small Markdown subset (`web/lib/blog-markdown.ts`). No raw HTML.

| Write | Get |
|---|---|
| `## Heading` / `### Subheading` | Sections; `##` ones go in the table of contents |
| `**bold**`, `*italic*`, `` `code` `` | Inline styles |
| `[text](/blog/other-post)` | A link; internal links stay in the site, external ones open a new tab |
| `- item` / `1. item` | Lists (one level; indent a line to continue an item) |
| `~~~ts` … `~~~` | A code block with a language label |
| `> [!NOTE] Title`, `> [!TIP] Title`, `> [!WARNING] Title` + `> body` lines | Callouts |
| `> text` | A quote |
| `![Alt text](/blog/<slug>/file.png "Caption")` | An image on its own line |
| `::diagram[name] Caption` | One of the hand-drawn SVG diagrams |
| `\| a \| b \|` then `\|---\|---\|` | A table (an all-blank header row means no header) |
| `---` | A divider |

Because the body is a template string, write a backtick as `` \` `` and `${` as `\${`.
Use `~~~` for code fences so you do not have to escape them.

### Images

- Put files in `web/public/blog/<slug>/`, named for what they show (`schedule-form.png`).
- Every image needs alt text that says what the image shows, not "screenshot".
- Prefer PNG for UI, at 2× the size it is shown (a full-width image: about 1400 px wide).
  Keep each under 300 KB.
- Crop to what the step is about. Blur or replace any real names, emails, phone numbers
  and webinar titles that are not ours. Use the dev preview (`NEXT_PUBLIC_DEV_BYPASS_AUTH=1`)
  for fake data.
- Screenshots go stale. Only add one when it saves the reader real effort.

### Diagrams

Diagrams are small React components in `web/components/blog/diagrams.tsx`, registered by
name in `DIAGRAM_NAMES` (`web/lib/blog.ts`). They use the `.dg-*` classes in
`app/globals.css`, so they follow light and dark mode. Keep the viewBox no wider than
about 600 units and labels at 15–18 units, so they stay readable on a phone. Give each
one a `title` and `desc` that say what it shows.

## Tone

- Plain, friendly English, like the app's own copy. Short sentences. "You", not "users".
- No hype: no "revolutionary", "seamless", "blazing fast". Say what it does.
- Use the real labels from the UI, in **bold**, exactly as they appear on screen. Read the
  component before you quote it; labels change.
- Every claim must be true of the code on `main` today. If a feature is behind a switch,
  say so (see below). If you are not sure how something behaves, read the code or leave
  it out.
- Tutorials: one task per post, in the order a host does it. Start with what they will
  have at the end. Finish with what to do next.
- Engineering: explain the problem before the solution, and the trade-off you accepted.
  Conceptual diagrams over configuration.

### Features behind a switch

Some features are switched on per account by our team. Never imply everyone has them.
Say "available on request" (or "if X is switched on for your account") for:

- Hosting itself ("Request to host")
- AI features: Write with AI, AI recap and insights, the Q&A assistant, AI spam check,
  knowledge-based answers, follow-up drafts. **Off by default for every host.**
- Cloud recording (and therefore the Recording tab and Record automatically)
- Simulive, and separately Simulive engagement replay; Auto mode needs AI, engagement
  replay and Simulive
- Instant webinars, joining without registration
- Zoom, WhatsApp CRM / follow-ups, clips and repurposed content, Studio
- Edge delivery as a host choice (on most video servers it is the default)

The full list, with defaults, is the feature catalogue in `api/types/types.go`.

## Security and privacy rules for engineering posts

Engineering posts are public. They must not help an attacker or expose a customer.
Do **not** include:

- IP addresses, hostnames or domains of internal servers, droplet/instance/VM names,
  regions tied to specific servers, or cloud and CDN account details
- Secret names, environment variable names, API keys, tokens, or config values
- Internal endpoints (anything under `/api/internal/*`, admin routes, webhooks)
- Exact firewall rules, open ports, or network topology between servers
- Anything about customers: names, sessions, numbers, screenshots with their data
- Exact costs, prices paid to vendors, or margins
- Commit hashes or links to private code

Do describe architecture conceptually: the components, what each one is for, the
protocols in general terms (WebRTC, LL-HLS, server-sent events), the trade-offs, and
the numbers that matter to a reader (latency ranges, resolutions, frame rates). Naming
the open-source projects we build on (LiveKit, MediaMTX, hls.js) is fine.

Ask for a second review on every engineering post before it merges.

## Backlog

One post per feature, then the engineering stories behind them. Recommended order is
top to bottom within each list; "(on request)" marks posts about switched features,
which should say so up front.

### Tutorials

1. **Run a meeting** — instant and scheduled meetings, the link-and-name lobby, the
   default cap, mic muted and camera on at entry
2. **Co-hosts and panelists** — inviting panelists by email, stage links, promoting an
   attendee, Assign host & leave
3. **Recordings and retention** — cloud vs on-this-computer recording, the Recording tab,
   chapters, how long recordings are kept and how to keep them longer (cloud: on request)
4. **Live captions** — turning captions on, what viewers see, captions on recordings
5. **Follow up by email and WhatsApp** — confirmation, reminders, replay link, the Follow
   up tab, WhatsApp consent (WhatsApp: on request)
6. **Your audience (CRM)** — the Audience tab, registrants across webinars, exports
7. **AI recap and insights** — the AI insights tab, Generate recap now, key points,
   action items, chapters, top questions (AI: on request, off by default)
8. **AI knowledge base** — adding material, how answers stay grounded, past-Q&A
   follow-ups (AI: on request)
9. **Auto mode for Simulive** — what the assistant answers, how it is signed, retracting
   an answer (on request; needs AI, engagement replay and Simulive)
10. **Spam detection** — flags, Remove person, Mute chat, auto-hide, links
11. **Highlights, reels and Studio** — starting highlights, clips, the content plan
    (on request)
12. **Repurpose your content** — turning a session into posts and emails (on request)
13. **Integrations** — Zoom meetings and webinars, Stream to YouTube, the email inbox,
    WhatsApp (Zoom and WhatsApp: on request)
14. **Install the app and get notifications** — PWA install on desktop, Android and iOS
    (16.4+, from the Home Screen), Web Push
15. **Admin features** — for operators: account switches, approvals, storage, usage

### Engineering

1. **Simulive's shared clock** — one start time, per-viewer position, late joiners,
   why attendees cannot seek, engagement replay timing
2. **On-demand video servers** — warm-up ahead of sessions, readiness checks, draining,
   retries
3. **CPU-aware quality adaptation** — the CPU ladder, why its order, AV1 demotion,
   hysteresis
4. **The recording pipeline** — from the room to a playable file, retention
5. **The captions pipeline** — speech to text, where it runs, keeping captions in sync
6. **AI that does not guess** — grounding answers in the host's own material, refusing
   when it does not know, signing assistant answers
7. **Shipping without breaking live sessions** — the deploy guard
8. **Observability** — OpenTelemetry traces, Grafana, and privacy-safe browser telemetry
