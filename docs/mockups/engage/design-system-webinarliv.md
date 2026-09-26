---
name: Webinar Automation Engine
colors:
  surface: '#faf8ff'
  surface-dim: '#d2d9f4'
  surface-bright: '#faf8ff'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f2f3ff'
  surface-container: '#eaedff'
  surface-container-high: '#e2e7ff'
  surface-container-highest: '#dae2fd'
  on-surface: '#131b2e'
  on-surface-variant: '#464555'
  inverse-surface: '#283044'
  inverse-on-surface: '#eef0ff'
  outline: '#777587'
  outline-variant: '#c7c4d8'
  surface-tint: '#4d44e3'
  primary: '#3525cd'
  on-primary: '#ffffff'
  primary-container: '#4f46e5'
  on-primary-container: '#dad7ff'
  inverse-primary: '#c3c0ff'
  secondary: '#006c4a'
  on-secondary: '#ffffff'
  secondary-container: '#82f5c1'
  on-secondary-container: '#00714e'
  tertiary: '#684000'
  on-tertiary: '#ffffff'
  tertiary-container: '#885500'
  on-tertiary-container: '#ffd4a4'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#e2dfff'
  primary-fixed-dim: '#c3c0ff'
  on-primary-fixed: '#0f0069'
  on-primary-fixed-variant: '#3323cc'
  secondary-fixed: '#85f8c4'
  secondary-fixed-dim: '#68dba9'
  on-secondary-fixed: '#002114'
  on-secondary-fixed-variant: '#005137'
  tertiary-fixed: '#ffddb8'
  tertiary-fixed-dim: '#ffb95f'
  on-tertiary-fixed: '#2a1700'
  on-tertiary-fixed-variant: '#653e00'
  background: '#faf8ff'
  on-background: '#131b2e'
  surface-variant: '#dae2fd'
typography:
  headline-xl:
    fontFamily: Plus Jakarta Sans
    fontSize: 36px
    fontWeight: '700'
    lineHeight: 44px
    letterSpacing: -0.02em
  headline-xl-mobile:
    fontFamily: Plus Jakarta Sans
    fontSize: 28px
    fontWeight: '700'
    lineHeight: 36px
    letterSpacing: -0.015em
  headline-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 28px
    fontWeight: '600'
    lineHeight: 36px
    letterSpacing: -0.015em
  headline-lg-mobile:
    fontFamily: Plus Jakarta Sans
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.01em
  headline-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
    letterSpacing: -0.01em
  headline-sm:
    fontFamily: Plus Jakarta Sans
    fontSize: 16px
    fontWeight: '600'
    lineHeight: 24px
    letterSpacing: -0.005em
  body-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  body-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
  label-md:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: '500'
    lineHeight: 18px
  label-sm:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: '600'
    lineHeight: 14px
    letterSpacing: 0.02em
  code-sm:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
  code-xs:
    fontFamily: JetBrains Mono
    fontSize: 10px
    fontWeight: '500'
    lineHeight: 14px
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  gutter: 1rem
  gutter-desktop: 1.5rem
  margin: 1rem
  margin-desktop: 2rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 1rem
  space-lg: 1.5rem
  space-xl: 2rem
---

## Brand & Style

The design system is engineered for operational clarity, technical precision, and frictionless workflow orchestration. Serving growth engineers, technical event marketers, and enterprise operations teams, it bridges high-throughput automation with mission-critical messaging reliability.

The visual language follows a **Technical Modern SaaS** paradigm with high information density:
- **Precision Canvas:** Clean, structural grid foundations that frame complex multi-branch automation sequences without visual clutter.
- **Operational Confidence:** Critical delivery states, webhook triggers, and automated logic paths are communicated through crisp chromatic distinctions—neutral slate governance paired with vibrant messaging indicators.
- **Instrumented Density:** Interfaces prioritize scanning speed, data legibility, and high-frequency telemetry over decorative volume. Data-driven workflows present clear status nodes, dynamic branching rails, and tactile verification states.

## Colors

The palette establishes strict functional separation between system orchestration, messaging pipeline states, and structural chrome.

### Palette Architecture
- **Primary Indigo (`#4F46E5` / `#6366F1`):** Represents execution architecture, triggers, system nodes, logic branches, active connections, and primary CTAs.
- **Secondary Emerald (`#059669` / `#10B981`):** Represents WhatsApp dispatch, delivered message nodes, successful API handshakes, and optimal conversion rates.
- **Tertiary Amber & Rose (`#F59E0B`, `#E11D48`):** Reserves amber for wait conditions, rate-limiting warnings, and draft sequences; rose flags fallback paths, dropped webhooks, or opt-out threshold spikes.
- **Slate Neutrals (`#0F172A`, `#1E293B`, `#334155`, `#64748B`, `#E2E8F0`, `#F8FAFC`):** Ground the workflow builder. `#F8FAFC` provides the infinite node canvas; `#E2E8F0` defines structural node boundaries; `#0F172A` delivers high-legibility typographic contrast.

### Surface Roles
- **Canvas Base:** `#F8FAFC` with a subtle dot grid pattern in `#CBD5E1`.
- **Card/Node Surface:** `#FFFFFF` with static boundary lines in `#E2E8F0`.
- **Selected Node Highlight:** Outline `#4F46E5` with `rgba(99, 102, 241, 0.08)` focus ring.
- **Sidebar & Utility Bars:** `#FFFFFF` background with border-right/border-bottom in `#E2E8F0`.

## Typography

The typographic hierarchy distinguishes high-level orchestration headers, operational payload parameters, and telemetry readouts.

- **Plus Jakarta Sans** delivers authoritative, contemporary weight for cockpit navigation, workflow names, stage milestones, and metric integers.
- **Inter** ensures uniform scanning across high-density table rows, configuration forms, condition logic builders, and message draft fields.
- **JetBrains Mono** serves system tokens, payload parameters (`{{attendee.first_name}}`), HTTP webhook methods (`POST`, `200 OK`), runtime latency figures, and execution timestamps.

## Layout & Spacing

The system implements a dual-mode layout architecture:
1. **Application Shell & Analytics:** A 12-column responsive fluid grid with 24px desktop gutters and 32px canvas margins, adapting to 8 columns on tablet and 4 columns on mobile.
2. **Orchestrator Canvas:** A freeform Cartesian grid with 16px snap intervals. Nodes snap to 16px increments, maintaining consistent 48px horizontal separation between sequential stages and 32px vertical separation across branch conditions.

### Breakpoints & Adaptive Behaviors
- **Desktop (≥1280px):** Three-pane layout: permanent collapsible left engine sidebar (260px), central orchestration canvas or telemetry grid (auto), and expandable right node inspector/payload debugger (380px).
- **Tablet (768px – 1279px):** Node inspector transitions to a slide-over panel. Builder toolbar converts to a floating bottom controller.
- **Mobile (<768px):** Workflow canvas locks into execution-only timeline view. Metrics shift to a single-column telemetry card stack.

## Elevation & Depth

Visual hierarchy uses crisp boundary lines and subtle ambient shadows to preserve clarity in dense flow diagrams.

- **Level 0 (Canvas Base):** Flat `#F8FAFC` surface with an SVG dot matrix (`#CBD5E1`, 1px radius on 20px pitch). Zero elevation.
- **Level 1 (Docked Containers & Tables):** Surface `#FFFFFF`, border `1px solid #E2E8F0`, no shadow. Used for table wrappers, side rails, and top toolbars.
- **Level 2 (Workflow Nodes & Metrics Cards):** Surface `#FFFFFF`, border `1px solid #CBD5E1`, shadow `0 1px 3px 0 rgba(15, 23, 42, 0.05), 0 1px 2px -1px rgba(15, 23, 42, 0.05)`. Hovering a node raises shadow to `0 4px 6px -1px rgba(15, 23, 42, 0.08), 0 2px 4px -2px rgba(15, 23, 42, 0.06)`.
- **Level 3 (Node Config Drawer & Flyouts):** Surface `#FFFFFF`, border `1px solid #CBD5E1`, shadow `0 10px 15px -3px rgba(15, 23, 42, 0.08), 0 4px 6px -4px rgba(15, 23, 42, 0.04)`.
- **Level 4 (Modals, Payload Overlays, Critical Dialogs):** Surface `#FFFFFF`, border `1px solid #94A3B8`, shadow `0 20px 25px -5px rgba(15, 23, 42, 0.12), 0 8px 10px -6px rgba(15, 23, 42, 0.08)`.

## Shapes

The design system employs **Soft (Level 1)** geometry to reinforce an engineered, high-precision instrument feel:
- **Base Components (Inputs, Buttons, Badges):** `4px` (`0.25rem`) border radius, preserving sharp corner definition and clean alignments.
- **Canvas Nodes & Cards:** `8px` (`0.5rem`) border radius, separating individual logic units from connecting line vectors.
- **Overlays, Drawers, & Modals:** `12px` (`0.75rem`) border radius for larger framed surfaces.
- **Status Pills & Execution Indicators:** Fully rounded (`9999px`) to create an immediate shape-level contrast against rectangular node cards.

## Components

### Buttons
- **Primary:** Solid `#4F46E5` background, white text, 4px corner radius, 1px border of `#4338CA`. Hover: `#4338CA`. Focus: 2px offset ring of `rgba(99, 102, 241, 0.4)`. Height: 36px (default), 30px (compact canvas mode).
- **Secondary:** Surface `#FFFFFF`, text `#1E293B`, border `1px solid #CBD5E1`. Hover: `#F8FAFC` and border `#94A3B8`.
- **Destructive:** Surface `#FFF1F2`, text `#BE123C`, border `1px solid #FECDD3`. Hover: `#FFE4E6`.
- **WhatsApp Direct Action:** Solid `#059669` background, white text. Used for live template pushes and test sends. Hover: `#047857`.

### Automation Nodes (Builder Canvas)
- **Dimensions & Container:** Fixed width 280px, auto-height. Background `#FFFFFF`, border `1px solid #CBD5E1`, border-radius 8px.
- **Node Header:** 32px height, flex row. Left: 16px icon box with distinct background tint (e.g., `#EEF2FF` for Trigger, `#ECFDF5` for WhatsApp Message, `#FFFBEB` for Wait Delay). Title: `headline-sm` in `#0F172A`. Right: execution counter badge or status indicator.
- **Node Content:** Padding 12px. Shows dynamic parameters (`Template: Webinar Reminder - 1hr`), fallback switches, and output branch counts.
- **Port Anchors:** 10px circular connectors positioned at center-top (input) and center-bottom/right (output). Fill `#FFFFFF`, border `2px solid #6366F1`. On connector hover: scales to 14px with `#4F46E5` fill.

### Interactive Connectors (Diagram Lines)
- SVG Bezier curves with 2px stroke width.
- **Idle State:** `#94A3B8` stroke.
- **Active / Animated Run:** `#10B981` stroke with animated SVG stroke-dasharray (running marching ants) indicating live message transit.
- **Failed / Error Flow:** `#F43F5E` stroke.

### Input Fields & Parameter Chips
- **Inputs:** 34px height, background `#FFFFFF`, border `1px solid #CBD5E1`, border-radius 4px, font `body-md`. Focus: `#4F46E5` border with `0 0 0 1px #4F46E5`.
- **Variable Chips (`{{variable}}`):** Embedded within text areas. Background `#EEF2FF`, border `1px solid #C7D2FE`, text `#3730A3`, font `code-xs`, padding 2px 6px, border-radius 3px.

### Status Badges & Timeline Pills
- **Success / Sent / Delivered:** Background `#ECFDF5`, text `#047857`, border `1px solid #A7F3D0`, leading 6px pulsing dot.
- **Queued / Scheduled:** Background `#FFFBEB`, text `#B45309`, border `1px solid #FDE68A`.
- **Active Trigger:** Background `#EEF2FF`, text `#4338CA`, border `1px solid #C7D2FE`.
- **Failed / Dropped:** Background `#FFF1F2`, text `#BE123C`, border `1px solid #FECDD3`.

### Real-Time Telemetry Cards
- Compact data components for builder top bar and reporting dashboard.
- Displays metric value (`headline-lg` in Plus Jakarta Sans), micro sparkline, percentage comparison chip, and monospace operational details (`code-xs`).
