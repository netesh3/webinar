import type { Post } from "../../lib/blog.ts";

export const post: Post = {
  slug: "how-webinar-liv-delivers-video",
  title: "How Webinar Liv delivers video: SFU for the stage, LL-HLS edge for big audiences",
  description:
    "Why the people on stage talk over WebRTC through an SFU, why the audience watches a low-latency HLS stream through a CDN, and the trade-offs between the two.",
  date: "2026-10-24",
  category: "engineering",
  tags: ["video", "webrtc", "sfu", "hls", "architecture"],
  body: `
    A webinar has two very different kinds of people in it. A handful are on stage: the host, co-hosts and panelists, talking to each other in real time. Everyone else, sometimes hundreds of people, is watching. They need smooth, reliable video, but nobody notices if it reaches them a couple of seconds after it was spoken.

    Webinar Liv gives each group the delivery that suits it. This post walks through both paths, the choices we made in each, and why.

    ::diagram[video-paths] The stage talks through the SFU; the audience watches a mixed stream delivered over LL-HLS and a CDN. Interactivity travels on its own channel.

    ## The stage: WebRTC through an SFU

    People on stage connect to a **selective forwarding unit** (SFU). We use [LiveKit](https://livekit.io), an open-source SFU. Each person sends their camera, microphone and screen once, to the SFU, and the SFU forwards those streams to everyone else who needs them. Unlike a mixing server, it does not decode and re-encode video, so it adds very little delay. Conversation stays natural, at well under a second end to end.

    The catch is that every viewer of a WebRTC stream is a live connection the SFU has to serve, each with its own network conditions. That is fine for a stage of a few people, and for meetings. The work is in making each of those connections as efficient as possible.

    ### Simulcast: several sizes of the same camera

    A camera does not send one stream; it sends three copies at different sizes, called **simulcast layers**:

    | Layer | Size | Frame rate |
    |---|---|---|
    | Low | 320×180 | 15 fps |
    | Middle | 640×360 | 20 fps |
    | Top | 1920×1080 (1280×720 on phones and smaller machines) | 30 fps |

    The SFU forwards each viewer the layer that fits. A large tile gets the top layer, a thumbnail gets the middle one, and someone on a weak connection gets the low one. Nobody downloads 1080p to show a postage stamp.

    ::diagram[simulcast-layers] One camera, three layers; the SFU picks per viewer.

    Two features in the LiveKit client make this automatic:

    - **Adaptive stream** has each viewer's browser tell the SFU how big each video actually is on screen, and pause video that is hidden or scrolled away. We measure in device pixels rather than CSS pixels, so a high-density laptop screen asks for a sharp enough layer. Measuring in CSS pixels made shared slides look soft on those screens.
    - **Dynacast** works the other way: if no viewer currently wants a layer, the sender stops encoding it. That saves the sender's CPU and upload, which matters most for presenters on laptops and home internet.

    The layers are kept close enough together that a viewer who has to step down never falls through a big gap in quality.

    ### Picking a codec per device

    Newer codecs squeeze more quality out of each bit, but cost more to encode, and not every browser handles them well. So the codec is chosen per device:

    - **Cameras** use VP8 by default, and **AV1** where the device can clearly afford it: the browser must offer an AV1 encoder, the device must report that it can encode AV1 smoothly at the size we need, and it needs enough CPU cores (or a hardware encoder). We send AV1 cameras at about 30% less bitrate than VP8.
    - **Screen shares** use **VP9** on desktop Chromium browsers, upgraded to AV1 when the same checks pass. On a still slide at the same bitrate, VP9 was clearly sharper than H.264 in our measurements.
    - **Safari, every iOS browser and Firefox** never publish AV1. Safari advertises AV1 support that does not hold up in practice, and Firefox cannot publish AV1 the way we send it. These browsers, and phones, share their screen with H.264 instead.

    Every AV1 or VP9 stream also carries a **backup codec** (VP8 for cameras, H.264 for shares). A viewer who cannot decode the main codec, or a small device that should not have to, automatically receives the backup. The sender does not have to know who is watching.

    If a device turns out to be struggling, an AV1 camera falls back to VP8 for the rest of the session. More on that below.

    ### Screen shares keep their resolution

    For a camera, a slightly blurrier face is better than a choppy one, so cameras are set to keep their frame rate and drop resolution under pressure.

    Screen shares are the opposite. Text that turns to mush is useless, while a slide that updates a little less often is fine. So shares are sent at full resolution (up to 1080p) with the **maintain-resolution** preference. When the network or CPU is tight, the share loses frames per second and bitrate, never pixels.

    Shares also switch between two modes on their own. **Sharp** mode, at up to 15 fps, is for slides and documents. When the share shows sustained motion or plays audio, such as a video clip, it moves to **video** mode at up to 30 fps. Sharing a video file always uses video mode.

    ### Adapting to the network and the CPU

    Each publisher runs a small set of quality ladders. The network ladders step cameras and shares down when the connection is under strain, and back up after a clean spell, with a cool-down so they do not flip back and forth.

    A separate **CPU ladder** watches for the browser reporting that its encoder is limited by the CPU. When that persists, it steps down in a fixed order, from least to most noticeable:

    1. a slightly lower frame rate,
    2. pausing background blur or virtual backgrounds (with a message saying so),
    3. switching an AV1 camera to VP8,
    4. holding the camera below its top layer.

    Shares keep their resolution at every step. Rungs that do nothing on a given device are skipped.

    ## The audience: one stream, delivered like a broadcast

    For a big audience, sending every viewer their own set of WebRTC streams stops making sense. The SFU's work grows with each viewer, and each viewer's browser has to receive and decode several videos.

    So for webinars with edge delivery, the audience gets a broadcast instead:

    1. A **mixer** joins the room like a viewer and renders the stage layout, everyone on stage arranged as the audience would see them, into a single video stream (H.264 video at 720p by default, with AAC audio).
    2. That stream goes to an origin running [MediaMTX](https://github.com/bluenviron/mediamtx), which packages it as **Low-Latency HLS** (LL-HLS): one-second segments, each split into smaller parts that can be fetched as soon as they are written.
    3. A **CDN** sits in front of the origin. Playlists are passed through fresh so viewers learn about new parts immediately, while the parts and segments themselves are cached. Viewers are served from the CDN's edge, so the origin is not asked for the same part once per viewer.

    Audience members do not join the SFU at all. They load a playlist and play it with [hls.js](https://github.com/video-dev/hls.js) (or natively on Safari), exactly like any other web video. That makes playback very forgiving of poor networks, and very cheap to scale.

    ### Interactivity has its own channel

    Chat, Q&A, polls, reactions and raised hands do not ride along with the video. They reach the audience over a lightweight server-sent event stream, carrying the same messages the stage receives. The room's interface works the same way in both modes.

    ### Moving from the audience to the stage

    When a viewer raises their hand and the host invites them to speak, the invite arrives on that event stream. Accepting it gives them a stage pass: their browser joins the SFU over WebRTC and swaps the HLS player for the live room. When they leave the stage, they go back to the feed.

    ### When edge delivery is used

    Edge delivery is a setting per webinar, chosen when it is saved, not something that switches on when an audience passes a certain size. On most of our video servers webinars use it by default. Meetings always stay on the SFU, since everyone in a meeting is a participant. Simulive sessions do too, since they play a recording rather than a live stage. A webinar that is already live never switches mode.

    In standard mode, without edge delivery, the audience joins the SFU directly, as viewers. That is the lowest-latency option, and a good fit for smaller audiences.

    ## The trade-off: seconds of latency for scale

    ::diagram[latency-scale] Roughly how far behind the stage each path runs.

    The cost of edge delivery is latency. WebRTC through the SFU is well under a second. LL-HLS is typically about one and a half to three seconds behind the stage when the CDN is close to the viewer, and standard HLS three to four seconds. For an audience that is watching, asking questions and voting in polls, a couple of seconds is hardly noticeable. For people talking to each other, it would make conversation impossible. That is why the stage stays on WebRTC.

    The player picks between the two HLS styles on its own. It starts with the more forgiving standard mode, unless playback is coming from a nearby CDN. It moves up to low latency when early requests come back quickly, and drops back if playback stalls more than a couple of times in a short window. If a viewer drifts too far behind, the player jumps forward within what it has already buffered. It never speeds playback up to catch up, because sped-up audio sounds wrong. If playback stalls, the last frame stays on screen with a "Reconnecting" badge instead of going black.

    We learned the hard way that low latency is not always the better choice. Viewers far from the origin, with slow round trips, fell further behind on LL-HLS than on standard HLS, and stuttered as well. Choosing the mode per viewer, from measured request times, fixed that.

    ## Video servers that start when they are needed

    Video servers cost money whether anyone is using them or not, and most of the day there is no session running. So our video servers are on-demand.

    ::diagram[server-lifecycle] A video server's day: off between sessions, started ahead of the next one.

    A scheduler looks ahead at the calendar and starts a server about 15 minutes before a scheduled session, the same moment the host's **Go live** button unlocks and attendees can start arriving. A server only counts as ready once its services actually answer, not just once the machine has booted. If somebody joins when no server is running, for an instant meeting for example, that starts one too, and they see a short **Starting servers…** screen until it is up.

    When nothing is live, nothing is due soon, and nobody has been connected for a while, the server drains and shuts down. A machine that fails to come up is retried, and if it keeps failing, our team is alerted and the host is offered a way to try again.

    ## In short

    - **The stage** uses WebRTC through an SFU for sub-second conversation, with simulcast, adaptive stream and dynacast so every connection carries only what it needs.
    - **Codecs** are chosen per device: AV1 only where it is safe, VP9 for desktop shares, H.264 for Safari, iOS and Firefox, and backup codecs for viewers who need them.
    - **Shares** keep their resolution and give up frames instead.
    - **Large audiences** watch a single mixed LL-HLS stream through a CDN: a couple of seconds behind, in exchange for scale and resilience.
    - **Servers** start ahead of sessions and stop when idle.

    In future posts we will look more closely at the CPU-aware quality ladder, the recording pipeline, and how a Simulive keeps every viewer on the same moment.
  `,
};
