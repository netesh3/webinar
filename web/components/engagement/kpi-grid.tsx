import type { EngagementKPIs } from "@/lib/api-types";
import { Card } from "@/components/ui";
import { formatCount } from "@/lib/format";
import { minuteLabel } from "@/lib/engagement/viz";
import { Icon } from "./primitives";

interface Tile {
  key: string;
  icon: string;
  label: string;
  value: string;
  note?: string;
}

/** -1 means the tool never ran; that tile says so rather than showing 0%. `approved` comes
 *  from the host screen's registrant list (already loaded), for manual-approval webinars. */
function tiles(k: EngagementKPIs, approved?: number): Tile[] {
  const perAttendee = k.attended ? (k.reactions / k.attended).toFixed(1) : "0";
  const registeredNote = [
    approved !== undefined && approved !== k.registered ? `${formatCount(approved)} approved` : "",
    `${formatCount(k.noShows)} didn't join`,
  ]
    .filter(Boolean)
    .join(" · ");
  const voters = k.pollVoters !== undefined ? ` · ${formatCount(k.pollVoters)} voted` : "";
  return [
    { key: "registered", icon: "how_to_reg", label: "Registered", value: formatCount(k.registered), note: registeredNote },
    { key: "attended", icon: "groups", label: "Attended", value: formatCount(k.attended), note: `${k.attendanceRatePct}% show-up rate` },
    { key: "watch", icon: "schedule", label: "Avg watch time", value: `${k.avgWatchMin} min`, note: `${k.avgWatchPct}% of session · median ${k.medianWatchMin}m` },
    { key: "peak", icon: "sensors", label: "Peak live", value: formatCount(k.peakLive), note: `at ${minuteLabel(k.peakMinute)}` },
    { key: "chat", icon: "chat", label: "Chat messages", value: formatCount(k.chatMessages), note: `from ${formatCount(k.chatters)} people` },
    { key: "questions", icon: "help", label: "Questions", value: formatCount(k.questions), note: `${k.answeredQuestions} answered live` },
    k.pollResponsePct < 0
      ? { key: "polls", icon: "bar_chart", label: "Poll response", value: "—", note: "No polls were run" }
      : { key: "polls", icon: "bar_chart", label: "Poll response", value: `${k.pollResponsePct}%`, note: `of people live at launch${voters}` },
    k.quizAccuracyPct < 0
      ? { key: "quiz", icon: "quiz", label: "Quiz avg score", value: "—", note: "No quizzes were run" }
      : { key: "quiz", icon: "quiz", label: "Quiz avg score", value: `${k.quizAccuracyPct}%`, note: "correct answers" },
    { key: "reactions", icon: "favorite", label: "Reactions", value: formatCount(k.reactions), note: `${perAttendee} per attendee` },
    { key: "hands", icon: "back_hand", label: "Raised hands", value: formatCount(k.handRaises), note: "during the session" },
  ];
}

export function KpiGrid({ kpis, approved }: { kpis: EngagementKPIs; approved?: number }) {
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5" aria-label="Key numbers">
      {tiles(kpis, approved).map((t) => (
        <li key={t.key}>
          <Card className="h-full p-3.5">
            <div className="flex items-center gap-1.5 text-[12px] text-ink-2">
              <Icon name={t.icon} className="text-ink-3" />
              {t.label}
            </div>
            <div className="mt-1 text-[21px] font-semibold tracking-[-0.02em] tabular-nums">{t.value}</div>
            {t.note && <div className="text-[11.5px] text-ink-3">{t.note}</div>}
          </Card>
        </li>
      ))}
    </ul>
  );
}
