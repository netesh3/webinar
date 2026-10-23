/* Tests for ending a screen share so the browser lets go of it: lib/share-stop.ts.
 *
 * Run with `make test-web` (node --experimental-strip-types, no runner — the same
 * harness as layout.test.mts).
 *
 * The bug this pins down: stopping a tab share unpublished it but left its tracks running,
 * so Chrome's "Sharing this tab" bar never went away. Fake tracks record stop() calls.
 */

import {
  browserEndedShare,
  releaseTracks,
  shareTracksToStop,
  stopScreenShare,
  SCREEN_SHARE,
  SCREEN_SHARE_AUDIO,
  type ShareParticipant,
} from "./share-stop.ts";

let failures = 0;
let checks = 0;

function ok(condition: boolean, what: string): void {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${what}`);
}

/** A LocalTrack stand-in around a MediaStreamTrack stand-in, both counting stops. */
class FakeTrack {
  stops = 0;
  detaches = 0;
  name: string;
  mediaStreamTrack: { readyState: string; stops: number; stop(): void };
  constructor(name: string, readyState = "live") {
    this.name = name;
    const mst = {
      readyState,
      stops: 0,
      stop() {
        mst.stops++;
        mst.readyState = "ended";
      },
    };
    this.mediaStreamTrack = mst;
  }
  stop() {
    this.stops++;
    this.mediaStreamTrack.stop();
  }
  detach() {
    this.detaches++;
    return [];
  }
  get stopped() {
    return this.stops > 0 && this.mediaStreamTrack.readyState === "ended";
  }
}

function fakeParticipant(pubs: { source: string; track?: FakeTrack }[], failUnpublish = false) {
  const map = new Map(pubs.map((p, i) => [String(i), p]));
  const unpublished: { track: FakeTrack; stop: boolean | undefined }[] = [];
  const participant: ShareParticipant<FakeTrack> = {
    trackPublications: map,
    async unpublishTrack(track, stopOnUnpublish) {
      if (failUnpublish) throw new Error("engine closed");
      unpublished.push({ track, stop: stopOnUnpublish });
      for (const [k, p] of map) if (p.track === track) map.delete(k);
    },
  };
  return { participant, unpublished, map };
}

async function main() {
  console.log("shareTracksToStop");
  {
    const video = new FakeTrack("video");
    const audio = new FakeTrack("audio");
    const mic = new FakeTrack("mic");
    const camera = new FakeTrack("camera");
    const pending = new FakeTrack("pending");
    const got = shareTracksToStop(
      [
        { source: "microphone", track: mic },
        { source: SCREEN_SHARE, track: video },
        { source: "camera", track: camera },
        { source: SCREEN_SHARE_AUDIO, track: audio },
        { source: SCREEN_SHARE_AUDIO },
      ],
      [video, undefined, pending],
    );
    ok(got.length === 3, "video, tab audio and the extra track — nothing else, no duplicates");
    ok(got[0] === video && got[1] === audio && got[2] === pending, "in order");
    ok(!got.includes(mic) && !got.includes(camera), "camera and mic are left alone");
    ok(shareTracksToStop([]).length === 0, "nothing shared, nothing to stop");
  }

  console.log("releaseTracks");
  {
    const a = new FakeTrack("a");
    const b = new FakeTrack("b");
    const throwing = {
      stop() {
        throw new Error("boom");
      },
    };
    releaseTracks([a, throwing, b]);
    ok(a.stopped && b.stopped, "every track stopped, even after one throws");
    ok(a.detaches === 1 && b.detaches === 1, "detached from their elements");
  }

  console.log("stopScreenShare: the tab share (video + tab audio)");
  {
    const video = new FakeTrack("video");
    const audio = new FakeTrack("audio");
    const mic = new FakeTrack("mic");
    const { participant, unpublished, map } = fakeParticipant([
      { source: SCREEN_SHARE, track: video },
      { source: SCREEN_SHARE_AUDIO, track: audio },
      { source: "microphone", track: mic },
    ]);
    await stopScreenShare(participant);
    ok(video.stopped, "video capture stopped");
    ok(audio.stopped, "tab audio stopped — the track that kept Chrome's bar up");
    ok(mic.stops === 0, "microphone untouched");
    ok(unpublished.length === 2, "both share tracks unpublished");
    ok(unpublished.every((u) => u.stop === true), "with stop-on-unpublish forced on");
    ok(map.size === 1, "only the microphone still published");
  }

  console.log("stopScreenShare: unpublish failing still stops the capture");
  {
    const video = new FakeTrack("video");
    const audio = new FakeTrack("audio");
    const { participant } = fakeParticipant(
      [
        { source: SCREEN_SHARE, track: video },
        { source: SCREEN_SHARE_AUDIO, track: audio },
      ],
      true,
    );
    let threw = false;
    try {
      await stopScreenShare(participant);
    } catch {
      threw = true;
    }
    ok(!threw, "does not throw");
    ok(video.stopped && audio.stopped, "both tracks stopped anyway");
  }

  console.log("stopScreenShare: extra (unpublished) tracks and the browser-ended case");
  {
    // Chrome's own "Stop sharing": the video is already ended and LiveKit unpublished it,
    // but the tab audio is still published and live.
    const endedVideo = new FakeTrack("video", "ended");
    const audio = new FakeTrack("audio");
    const { participant, unpublished } = fakeParticipant([
      { source: SCREEN_SHARE_AUDIO, track: audio },
    ]);
    ok(browserEndedShare(SCREEN_SHARE, endedVideo), "an ended share video is the browser ending it");
    ok(!browserEndedShare(SCREEN_SHARE, new FakeTrack("live")), "a live one is a reconnect teardown");
    ok(!browserEndedShare(SCREEN_SHARE_AUDIO, endedVideo), "only the video decides");
    ok(!browserEndedShare(SCREEN_SHARE, undefined), "no track, no decision");
    await stopScreenShare(participant, [endedVideo]);
    ok(audio.stopped, "the lingering tab audio is stopped");
    ok(endedVideo.stops === 1, "the extra track is stopped too");
    ok(
      unpublished.length === 1 && unpublished[0].track === audio,
      "only what is still published is unpublished",
    );
  }

  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
