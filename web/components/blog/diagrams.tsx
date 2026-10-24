import type { ReactElement, ReactNode } from "react";
import type { DiagramName } from "@/lib/blog";

/* Hand-drawn diagrams for blog posts, placed with `::diagram[name]` in a post body.
 *
 * Colours come from classes in globals.css (.dg-*), which read the marketing tokens, so
 * every diagram follows light and dark mode. Labels are real <text>, sized for a phone:
 * the viewBoxes are kept narrow (≤ 600 units) so 16-unit text never drops below ~10px.
 * Each <svg> carries role="img" and a <title>/<desc> pair for screen readers. */

type Svg = { title: string; desc: string; viewBox: string; children: ReactNode };

function Frame({ title, desc, viewBox, children }: Svg) {
  const id = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return (
    <svg
      viewBox={viewBox}
      role="img"
      aria-labelledby={`${id}-t ${id}-d`}
      className="dg"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title id={`${id}-t`}>{title}</title>
      <desc id={`${id}-d`}>{desc}</desc>
      <defs>
        <marker id={`${id}-arrow`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" className="dg-arrowhead" />
        </marker>
      </defs>
      <g style={{ ["--dg-arrow" as string]: `url(#${id}-arrow)` }}>{children}</g>
    </svg>
  );
}

function Box({
  x,
  y,
  w,
  h,
  label,
  sub,
  tone = "plain",
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  sub?: string;
  tone?: "plain" | "accent" | "muted";
}) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={12} className={`dg-box dg-box-${tone}`} />
      <text x={x + w / 2} y={sub ? y + h / 2 - 4 : y + h / 2 + 6} className="dg-label" textAnchor="middle">
        {label}
      </text>
      {sub && (
        <text x={x + w / 2} y={y + h / 2 + 18} className="dg-sub" textAnchor="middle">
          {sub}
        </text>
      )}
    </g>
  );
}

function Arrow({ d, dashed }: { d: string; dashed?: boolean }) {
  return (
    <path
      d={d}
      className={dashed ? "dg-line dg-line-dashed" : "dg-line"}
      style={{ markerEnd: "var(--dg-arrow)" }}
    />
  );
}

function Note({ x, y, children, anchor = "middle" }: { x: number; y: number; children: string; anchor?: "start" | "middle" | "end" }) {
  return (
    <text x={x} y={y} className="dg-note" textAnchor={anchor}>
      {children}
    </text>
  );
}

/* ------------------------------------------------------------------ engineering */

function VideoPaths() {
  return (
    <Frame
      title="Two paths for video"
      desc="The host and panelists talk to each other through the SFU over WebRTC. A mixer turns the stage into one stream, which an LL-HLS origin and a CDN deliver to the audience. Chat, Q&A and polls reach the audience over a separate event stream."
      viewBox="0 0 600 470"
    >
      <Box x={20} y={20} w={260} h={70} label="Stage" sub="host, co-hosts, panelists" tone="accent" />
      <Box x={320} y={20} w={260} h={70} label="SFU" sub="WebRTC, sub-second" />
      <Arrow d="M280 46 L318 46" />
      <Arrow d="M320 66 L282 66" />

      <Box x={320} y={140} w={260} h={70} label="Mixer" sub="stage layout → one stream" tone="muted" />
      <Arrow d="M450 90 L450 138" />

      <Box x={320} y={260} w={260} h={70} label="LL-HLS origin" sub="short segments and parts" tone="muted" />
      <Arrow d="M450 210 L450 258" />

      <Box x={320} y={380} w={260} h={70} label="CDN" sub="cached close to viewers" tone="muted" />
      <Arrow d="M450 330 L450 378" />

      <Box x={20} y={380} w={260} h={70} label="Audience" sub="hundreds of viewers" tone="accent" />
      <Arrow d="M320 415 L282 415" />

      <Arrow d="M150 92 L150 378" dashed />
      <Arrow d="M130 378 L130 92" dashed />
      <Note x={160} y={225} anchor="start">chat, Q&amp;A,</Note>
      <Note x={160} y={247} anchor="start">polls, hands</Note>
    </Frame>
  );
}

function SimulcastLayers() {
  return (
    <Frame
      title="Simulcast and per-viewer layers"
      desc="A camera sends three copies at different sizes. The SFU forwards each viewer only the copy that fits the tile they are watching, and stops sending a copy nobody watches."
      viewBox="0 0 600 340"
    >
      <Box x={20} y={115} w={140} h={90} label="Camera" sub="sends 3 layers" tone="accent" />
      <Arrow d="M160 135 L228 135" />
      <Arrow d="M160 160 L228 160" />
      <Arrow d="M160 185 L228 185" />
      <Box x={230} y={115} w={150} h={90} label="SFU" sub="picks per viewer" />

      <Box x={420} y={20} w={160} h={70} label="Big tile" sub="top layer" tone="muted" />
      <Box x={420} y={135} w={160} h={70} label="Small tile" sub="middle layer" tone="muted" />
      <Box x={420} y={250} w={160} h={70} label="Weak network" sub="low layer" tone="muted" />
      <Arrow d="M380 135 L418 60" />
      <Arrow d="M380 160 L418 170" />
      <Arrow d="M380 185 L418 280" />
      <Note x={90} y={240}>top · middle · low</Note>
    </Frame>
  );
}

function LatencyScale() {
  const x = (s: number) => 40 + s * 120; // 0–4.5 s across the width
  return (
    <Frame
      title="How far behind the stage each path runs"
      desc="WebRTC through the SFU is under a second. Low-latency HLS is about one and a half to three seconds where the CDN is close. Standard HLS runs about three to four seconds behind."
      viewBox="0 0 600 230"
    >
      <path d={`M${x(0)} 170 L${x(4.5)} 170`} className="dg-line" />
      {[0, 1, 2, 3, 4].map((s) => (
        <g key={s}>
          <path d={`M${x(s)} 164 L${x(s)} 176`} className="dg-line" />
          <Note x={x(s)} y={200}>{`${s} s`}</Note>
        </g>
      ))}
      <rect x={x(0.1)} y={30} width={x(0.8) - x(0.1)} height={34} rx={8} className="dg-box dg-box-accent" />
      <text x={x(0.9)} y={53} className="dg-label">
        Stage (WebRTC)
      </text>
      <rect x={x(1.5)} y={78} width={x(3) - x(1.5)} height={34} rx={8} className="dg-box dg-box-muted" />
      <text x={x(3.1)} y={101} className="dg-label">
        Low-latency HLS
      </text>
      <rect x={x(3)} y={126} width={x(4) - x(3)} height={30} rx={8} className="dg-box dg-box-plain" />
      <text x={x(2.9)} y={147} className="dg-label" textAnchor="end">
        Standard HLS
      </text>
    </Frame>
  );
}

function ServerLifecycle() {
  return (
    <Frame
      title="An on-demand video server"
      desc="The video server is off between sessions. It starts about fifteen minutes before a scheduled session, or when somebody joins and finds it off, serves the session, and shuts down after it has been idle for a while."
      viewBox="0 0 600 300"
    >
      <Box x={20} y={30} w={160} h={70} label="Off" sub="nothing scheduled" tone="muted" />
      <Box x={220} y={30} w={160} h={70} label="Starting" sub="boot + checks" />
      <Box x={420} y={30} w={160} h={70} label="Ready" sub="sessions run" tone="accent" />
      <Box x={420} y={200} w={160} h={70} label="Idle" sub="nothing live" />
      <Box x={220} y={200} w={160} h={70} label="Shutting down" sub="after idle time" tone="muted" />
      <Arrow d="M180 65 L218 65" />
      <Arrow d="M380 65 L418 65" />
      <Arrow d="M500 100 L500 198" />
      <Arrow d="M420 235 L382 235" />
      <Arrow d="M220 235 L100 235 L100 102" />
      <Note x={200} y={130} anchor="start">~15 min before a session,</Note>
      <Note x={200} y={152} anchor="start">or on the first join</Note>
    </Frame>
  );
}

/* ------------------------------------------------------------------ tutorials */

function WebinarTimeline() {
  const steps = [
    { label: "Schedule", sub: "at least 15 min ahead" },
    { label: "Share", sub: "the registration link" },
    { label: "Doors open", sub: "15 min before the start" },
    { label: "Go live", sub: "you press ▶ Go live" },
    { label: "End", sub: "End webinar for everyone" },
  ];
  return (
    <Frame
      title="A webinar from start to finish"
      desc="Schedule the webinar at least fifteen minutes ahead and share its registration link. Fifteen minutes before the start, attendees can come in and the Go live button unlocks. Press Go live, and end the webinar for everyone when you are done."
      viewBox="0 0 600 420"
    >
      {steps.map((s, i) => (
        <g key={s.label}>
          <Box x={140} y={10 + i * 82} w={320} h={62} label={s.label} sub={s.sub} tone={i === 3 ? "accent" : "plain"} />
          {i < steps.length - 1 && <Arrow d={`M300 ${72 + i * 82} L300 ${90 + i * 82}`} />}
        </g>
      ))}
    </Frame>
  );
}

function SimuliveClock() {
  return (
    <Frame
      title="One clock for every viewer"
      desc="A simulive plays from a start time the server knows. Each browser works out how far into the video it should be from that start time, so a late joiner lands at the same moment as everybody else, and chat, polls and questions from the original session appear at the moment they happened."
      viewBox="0 0 600 300"
    >
      <path d="M40 80 L560 80" className="dg-line" />
      <Note x={40} y={115} anchor="start">start time</Note>
      <Note x={560} y={115} anchor="end">end of video</Note>
      <circle cx={40} cy={80} r={7} className="dg-dot" />
      <circle cx={560} cy={80} r={7} className="dg-dot" />
      <circle cx={330} cy={80} r={10} className="dg-dot dg-dot-accent" />
      <Note x={330} y={52}>now = start + elapsed</Note>

      <Box x={30} y={170} w={170} h={70} label="Viewer A" sub="joined on time" tone="muted" />
      <Box x={215} y={170} w={170} h={70} label="Viewer B" sub="joined 20 min late" tone="muted" />
      <Box x={400} y={170} w={170} h={70} label="Replayed chat" sub="at its moment" tone="accent" />
      <Arrow d="M115 168 L320 92" dashed />
      <Arrow d="M300 168 L328 94" dashed />
      <Arrow d="M485 168 L340 94" dashed />
    </Frame>
  );
}

export const DIAGRAMS: Record<DiagramName, () => ReactElement> = {
  "video-paths": VideoPaths,
  "simulcast-layers": SimulcastLayers,
  "latency-scale": LatencyScale,
  "server-lifecycle": ServerLifecycle,
  "webinar-timeline": WebinarTimeline,
  "simulive-clock": SimuliveClock,
};
