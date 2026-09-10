"use client";

import { describeQuality } from "@/lib/network";
import { useBackgroundCost } from "@/lib/backgrounds";
import { useRoomUI } from "./context";

/* The numbers behind the connection indicator.
 *
 * Here rather than in the header because round trip time helps one person in a hundred
 * and distracts the other ninety-nine. But when somebody is troubleshooting — and during
 * a live session somebody usually is — "2.4% packet loss, 310ms" is the difference
 * between a support ticket and a fixed problem, so it is one click away rather than
 * absent.
 *
 * The reduced-quality line is the important one. Automatic degradation that happens
 * silently gets reported as a bug: the presenter sees their own preview at full quality
 * — the local preview is not the encoded stream — and has no way to know the audience is
 * watching 360p. Saying so, and saying it will recover on its own, is what stops somebody
 * reconnecting in the middle of their own talk.
 */
export function NetworkReadout() {
  const cost = useBackgroundCost();
  const { network, permissions } = useRoomUI();
  const { label, tone } = describeQuality(network);

  return (
    <section>
      <h3 className="mb-1.5 text-[11px] font-semibold tracking-[0.06em] text-ink-3 uppercase">
        Connection
      </h3>

      <div className="rounded-lg border border-line-2 px-3 py-2.5">
        <p
          className={`text-[13px] font-medium ${
            tone === "bad" ? "text-live" : tone === "warn" ? "text-warn" : "text-ok"
          }`}
        >
          {label}
        </p>

        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[12px]">
          <Metric label="Packet loss" value={`${network.lossPercent}%`} />
          <Metric label="Round trip" value={network.rttMs ? `${network.rttMs} ms` : "—"} />
          {/* The two halves of that number, separated.
              A round trip is distance plus queueing, and only the second half is a problem
              anybody can act on. Showing the floor is what stops a 280 ms figure — which is
              simply how far away the server is — being read as a broken connection and sending
              somebody to restart their router. It is also the number the publish ladder is
              judged against, so a reader can see why it did or did not step down. */}
          <Metric
            label="Best round trip"
            value={network.rttFloorMs ? `${network.rttFloorMs} ms` : "—"}
            hint="Distance to the server. The gap above this is congestion"
          />
          <Metric label="Jitter" value={network.jitterMs ? `${network.jitterMs} ms` : "—"} />
          {/* The receive buffer, which is where most of the delay in a video call lives
              and the only part of it the page can influence. Shown because "we asked for
              a low playout target" is a claim, and this is the browser answering it. */}
          <Metric
            label="Playout buffer"
            value={network.playoutMs ? `${network.playoutMs} ms` : "—"}
            hint="Delay added by the receiver before video is shown"
          />
          {/* Only when a background is running. A row reading "—" for everybody who
              has not turned one on is furniture. */}
          {cost && (
            <Metric
              label="Background"
              value={`${cost.total} ms/frame`}
              hint={`${cost.segment} ms of it segmentation`}
            />
          )}
          {/* What the ladder settled on.
              Shown because the picker is gone: a presenter who can no longer choose a
              resolution is owed a straight answer about what is being sent, and "it adapts"
              is not one. The degraded note below explains it when it is not at the top. */}
          {permissions.canPublish && (
            <Metric
              label="Sending"
              value={
                network.tier === "full"
                  ? "Best quality"
                  : network.tier === "reduced"
                    ? "Reduced"
                    : "Minimum"
              }
              hint="Chosen automatically from your upload speed, loss and latency"
            />
          )}
          {permissions.canPublish && (
            <Metric
              label="Upload headroom"
              value={
                network.availableOutgoingKbps
                  ? `${Math.round(network.availableOutgoingKbps / 100) / 10} Mbps`
                  : "—"
              }
            />
          )}
        </dl>

        {permissions.canPublish && network.degraded && (
          <p className="mt-2 text-[11.5px] leading-relaxed text-warn">
            Video quality was reduced automatically to protect your audio. Your own
            preview still looks sharp — that is the camera, not what is being sent. It
            steps back up on its own once the connection clears; there is no need to
            reconnect.
          </p>
        )}
        {permissions.canPublish && !network.degraded && (
          <p className="mt-2 text-[11.5px] leading-relaxed text-ink-3">
            Video steps down automatically if the connection struggles, and back up when
            it clears. Audio is protected first and is never reduced.
          </p>
        )}
      </div>
    </section>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-ink-3" title={hint}>
        {label}
      </dt>
      <dd className="tabular-nums text-ink" title={hint}>
        {value}
      </dd>
    </div>
  );
}
