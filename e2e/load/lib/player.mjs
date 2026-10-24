/* A playback model for one simulated viewer: what a real player's buffer would do given when
 * media actually arrived. Nothing is decoded; the model answers "would this viewer have
 * stalled, and how far behind live would they be".
 *
 * Playback starts when the first media is appended and runs at real time. If the playhead
 * catches up with the end of the buffer, that is a stall, lasting until the next media
 * arrives (hls.js waits, it does not skip; maxLiveSyncPlaybackRate is 1 in edgeHlsConfig, so it
 * never speeds up to catch up either). */
export class PlayerModel {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.startedAt = null; // wall ms playback began
    this.bufferEnd = 0; // media seconds appended
    this.stalledSec = 0; // total stall time
    this.stalls = 0;
    this.stalling = false;
  }

  /** Media position of the playhead now (seconds), ignoring buffer end. */
  rawPlayhead(at = this.now()) {
    if (this.startedAt === null) return 0;
    return (at - this.startedAt) / 1000 - this.stalledSec;
  }

  /** Playhead clamped to the buffer. */
  playhead(at = this.now()) {
    return Math.min(this.rawPlayhead(at), this.bufferEnd);
  }

  /* append(durationSec, pdtStartMs|null) -> { stalledMs, latencyMs|null }: media arrived now.
   * The stall it ends (if the buffer had run dry) is returned, and the live latency (wall clock
   * minus the program date time at the playhead) when the media carries a PDT. */
  append(duration, pdt = null, at = this.now()) {
    let stalledMs = 0;
    if (this.startedAt === null) {
      this.startedAt = at;
    } else {
      const over = this.rawPlayhead(at) - this.bufferEnd;
      if (over > 0) {
        this.stalledSec += over;
        this.stalls++;
        stalledMs = over * 1000;
      }
    }
    this.stalling = false;
    this.bufferEnd += duration;
    let latencyMs = null;
    if (pdt !== null && Number.isFinite(pdt)) {
      const endPdt = pdt + duration * 1000;
      const ahead = this.bufferEnd - this.playhead(at); // seconds buffered past the playhead
      latencyMs = at - endPdt + ahead * 1000;
    }
    return { stalledMs, latencyMs };
  }

  /** Whether the buffer is empty right now (a stall in progress). */
  isStalled(at = this.now()) {
    return this.startedAt !== null && this.rawPlayhead(at) > this.bufferEnd;
  }

  /** Seconds buffered ahead of the playhead. */
  bufferAhead(at = this.now()) {
    return Math.max(0, this.bufferEnd - this.playhead(at));
  }
}
