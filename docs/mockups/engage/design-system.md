---
name: Precision Enterprise Comms
colors:
  surface: '#f8f9ff'
  surface-dim: '#cbdbf5'
  surface-bright: '#f8f9ff'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#eff4ff'
  surface-container: '#e5eeff'
  surface-container-high: '#dce9ff'
  surface-container-highest: '#d3e4fe'
  on-surface: '#0b1c30'
  on-surface-variant: '#464555'
  inverse-surface: '#213145'
  inverse-on-surface: '#eaf1ff'
  outline: '#777587'
  outline-variant: '#c7c4d8'
  surface-tint: '#4d44e3'
  primary: '#3525cd'
  on-primary: '#ffffff'
  primary-container: '#4f46e5'
  on-primary-container: '#dad7ff'
  inverse-primary: '#c3c0ff'
  secondary: '#565e74'
  on-secondary: '#ffffff'
  secondary-container: '#dae2fd'
  on-secondary-container: '#5c647a'
  tertiary: '#005338'
  on-tertiary: '#ffffff'
  tertiary-container: '#006e4b'
  on-tertiary-container: '#67f4b7'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#e2dfff'
  primary-fixed-dim: '#c3c0ff'
  on-primary-fixed: '#0f0069'
  on-primary-fixed-variant: '#3323cc'
  secondary-fixed: '#dae2fd'
  secondary-fixed-dim: '#bec6e0'
  on-secondary-fixed: '#131b2e'
  on-secondary-fixed-variant: '#3f465c'
  tertiary-fixed: '#6ffbbe'
  tertiary-fixed-dim: '#4edea3'
  on-tertiary-fixed: '#002113'
  on-tertiary-fixed-variant: '#005236'
  background: '#f8f9ff'
  on-background: '#0b1c30'
  surface-variant: '#d3e4fe'
typography:
  display-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 32px
    fontWeight: '700'
    lineHeight: 40px
    letterSpacing: -0.02em
  display-sm:
    fontFamily: Plus Jakarta Sans
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.015em
  headline-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
    letterSpacing: -0.01em
  headline-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 16px
    fontWeight: '600'
    lineHeight: 24px
    letterSpacing: -0.005em
  body-lg:
    fontFamily: Inter
    fontSize: 15px
    fontWeight: '400'
    lineHeight: 22px
    letterSpacing: -0.005em
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  body-sm:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18px
  label-md:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '600'
    lineHeight: 16px
    letterSpacing: 0.01em
  label-sm:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: '600'
    lineHeight: 14px
    letterSpacing: 0.02em
  code-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  gutter: 1rem
  gutter-compact: 0.5rem
  margin: 1.5rem
  margin-compact: 1rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 0.75rem
  space-lg: 1rem
  space-xl: 1.5rem
---

## Brand & Style

This design system embodies high-throughput enterprise communication management: calm, architectural, uncompromisingly precise, and reliable under scale. It is tailored for revenue operations, retention teams, and customer experience architects who orchestrate millions of real-time conversational touchpoints.

The visual style blends **Corporate Modernism** with **Analytical Minimalism**:
- Surfaces prioritize immediate data legibility over decorative embellishment.
- Visual weight is distributed through crisp hairline divisions and deliberate tonal contrast rather than heavy fills or dramatic elevation.
- The interface feels like an engineered diagnostic instrument: sharp, deterministic, and devoid of frivolous animations, oversized marketing padding, or playful rounded shapes.

## Colors

The palette leverages high-contrast functional foundations to sustain long operational sessions without visual fatigue:

- **Canvas & Surfaces:** Primary application canvas utilizes `#f8fafc` (Slate 50) for structural grounding, while active operational panels, table containers, and data grids sit on `#ffffff` (Pure White). Hairline border tokens resolve strictly to `#e2e8f0` (Slate 200).
- **Typography Scale:** Direct data labels and primary headlines anchor on `#0f172a` (Slate 900). Secondary metadata and descriptive copy map to `#334155` (Slate 700) and `#64748b` (Slate 500).
- **Interactive Primary:** Royal Indigo (`#4f46e5`) serves as the primary actionable anchor for high-intent actions, primary triggers, and active navigation indicators, shifting to `#4338ca` on hover.
- **Operational Statuses:**
  - *Delivered / Active / Verified:* Emerald `#10b981` typography and glyphs over a muted `#ecfdf5` background, reinforced by `#a7f3d0` border strokes.
  - *Pending / Queued / Review:* Amber `#f59e0b` typography over `#fffbeb` with `#fde68a` borders.
  - *Failed / Blocked / Opted-Out:* Rose `#ef4444` typography over `#fef2f2` with `#fecaca` borders.
  - *Draft / Neutral:* Slate `#64748b` over `#f1f5f9` with `#cbd5e1` borders.

## Typography

Typography prioritizes high information density and structural hierarchy:

- **Headlines (Plus Jakarta Sans):** Applied to view titles, metric counter values, and high-level card headers. Delivers modern, geometric authority without excessive display quirks.
- **Body & Data Grid (Inter):** Applied across all data tables, key-value panels, interactive forms, and navigation anchors. Its tall x-height and uniform tabular figures ensure high legibility in numeric data columns (delivery rates, timestamps, session counts).
- **Labels & Microcopy:** Form labels, status indicators, and column headers use condensed weights (600) with slight positive tracking for scannability at small sizes.

## Layout & Spacing

The layout is built on a structured **docked-shell architecture**:

- **Sidebar Anchor:** Fixed width of 240px (collapsible to 64px icon-rail), pinning navigation paths: Dashboard, Contacts, Journeys, Campaigns, Templates, Analytics, Integrations, and Settings.
- **Header Topbar:** Persistent 56px height hairline-bordered panel housing workspace selection, status telemetry, search, and user profile management.
- **Data Workspaces:** Main view conforms to a 12-column fluid grid system with a fixed outer section margin of 24px (`margin`) and internal column gutters of 16px (`gutter`).
- **High-Density Reflow:** Data tables and campaign orchestration canvases contract spacing tokens down to `space-xs` (4px) and `space-sm` (8px) between contiguous interactive cells.
- **Mobile/Narrow Screen Adaptations:** Below 1024px, the primary sidebar collapses into a drawer, and split-pane views (such as the WhatsApp Live Preview) transition into an on-demand slide-over sheet.

## Elevation & Depth

Visual separation relies on **structural boundaries** rather than heavy drop shadows:

- **Tonal Layers & Hairline Outlines:** Surfaces sit on a 1px solid border (`#e2e8f0`) to establish spatial bounds against the `#f8fafc` canvas. Zero elevation is the default state for workspace panels, tables, and inspection panes.
- **Hover & Focus States:** Cards and interactive rows avoid elevation lifts; instead, they transition their border token to `#cbd5e1` or `#4f46e5` with a subtle background shift to `#f1f5f9`.
- **Flyouts & Overlays:** Popovers, contextual dropdown menus, and modal dialogs use an ambient, ultra-diffused shadow: `0 4px 12px -2px rgba(15, 23, 42, 0.08), 0 2px 6px -1px rgba(15, 23, 42, 0.04)` combined with an explicit `#e2e8f0` border to maintain edge fidelity.

## Shapes

The design uses tight, controlled geometric rounding (`roundedness: 1`):

- Standard inputs, buttons, table cell selections, and small badges utilize a 4px corner radius (`0.25rem`), preserving an architectural, technical feel.
- Larger container cards, dialogs, and the WhatsApp phone simulator viewport utilize 8px (`0.5rem` / `rounded-lg`).
- Pill-shaped radii are forbidden except for live status dots or numeric count badges embedded inside tab headers.

## Components

### Buttons
- **Primary:** Solid `#4f46e5` fill, white text, 4px radius. Height: 36px (default) or 32px (compact data-grid actions). Subtle inset highlight: `box-shadow: inset 0 1px 0 0 rgba(255, 255, 255, 0.2)`.
- **Secondary:** White background, `#e2e8f0` hairline border, `#334155` text. Hover shifts border to `#cbd5e1` and background to `#f8fafc`.
- **Destructive:** White background, `#ef4444` border and text; active hover fills with `#fef2f2`.

### Inputs & Form Controls
- **Text Inputs & Selects:** 36px height, pure white surface, `#e2e8f0` border, `#0f172a` text. Focus state employs a razor-sharp 1px border shift to `#4f46e5` accompanied by a 2px outer ring in `rgba(79, 70, 229, 0.15)`. No rounded pills.
- **Checkboxes & Radios:** 16px square/circle with a crisp 1px border. Checked state uses solid `#4f46e5` with crisp white vector marks.

### Data Tables
- Header row height: 36px, background `#f8fafc`, text `#64748b` in `label-sm` (uppercase, tracked).
- Body rows: 44px height, hairline bottom border (`#f1f5f9`), font `body-sm`. Tabular alignment: text left, numbers right, status badges centered. Hover row background: `#f8fafc`.

### Status Badges
- 20px height, 4px radius, inline-flex with 6px horizontal padding.
- Structure: 6px solid circular dot followed by `label-sm` copy. Colors strictly adhere to the semantic palette (Emerald, Amber, Rose, Slate).

### Cards & Analytical Panels
- White background, 1px border in `#e2e8f0`, 8px corner radius.
- Padding follows strict 16px (`space-lg`) bounds. Internal header sections feature a 1px border-bottom divider separating controls from chart or grid payloads.

### WhatsApp Preview Simulator
- Fixed-width viewport container (320px or 360px), light sage patterned background (`#efeae2`).
- Renders authentic WhatsApp chat bubbles: incoming messages in white (`#ffffff`) with subtle shadow, outgoing business broadcasts in light green (`#d9fdd3`). Includes variable tag pill badges (`{{first_name}}`) highlighted in `#dbeafe` with indigo borders.
