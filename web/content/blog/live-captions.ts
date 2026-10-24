import type { Post } from "../../lib/blog.ts";

export const post: Post = {
  slug: "live-captions",
  title: "Live captions",
  description:
    "Turn on live English captions for everyone in the room, see what your audience sees, and download the transcript after the session.",
  date: "2026-10-24",
  category: "tutorials",
  tags: ["captions", "accessibility", "host-room", "recordings"],
  body: `
    Live captions put what is being said on screen as it is said, for everyone in the room. They help people watching without sound, people who are hard of hearing, and anyone following in a second language. After the session you can download the whole thing as a transcript.

    Captions are **English only** for now.

    ## Turn captions on when you schedule

    1. In the schedule form, open **In the room** and find **Recording and extras**.
    2. Turn on **Live captions**.

    Captions are then on from the moment the session starts. They are off by default.

    ## Turn captions on or off in the room

    You can switch captions on or off at any time during the session.

    1. Open **More** on the bar.
    2. Press **Captions**. On a phone it is in the **Present** section.

    The tile shows **On** while captions are running, and its tooltip says **Captions are on for everyone**. Press it again to turn them off. On a computer, if you use captions a lot, you can drag **Captions** out of **More** and onto the bar.

    Only you and your co-hosts have this switch. It applies to the whole room: people who join late get captions too, and they stay on if you reload the page.

    ## What your audience sees

    Captions appear in a dark box near the bottom of the video, centred, in white text. Words appear as they are spoken and settle into a finished line a moment later. Each line stays up for a few seconds, longer for longer lines.

    Attendees cannot turn captions off for themselves during the live session. If you want them gone, turn them off for everyone.

    ## Whose voice is captioned

    Captions follow whoever is talking on the stage: you, your panelists and anyone you bring up to speak. Attendees in the audience are not on the microphone, so there is nothing of theirs to caption.

    A few tips for clearer captions:

    - One person at a time works best. When several people talk over each other, some words can be missed.
    - A headset or a decent microphone helps more than anything else.
    - Captions appear a second or two after the words are spoken, so expect a short delay.

    Captions normally run on our servers. If they cannot, each speaker's own browser makes them instead, and the first time you may see **Loading captions on this device. The first time takes a moment; after that it stays on the machine.**

    ## After the session

    ### Download the transcript

    Open the webinar's **Results** tab and press **Export**. Choose **Captions transcript (TXT)** ("What was said, from live captions") to download everything that was captioned as a text file.

    ### Captions on the recording

    If cloud recording is switched on for your account, captions carry over to the recording (cloud recording is available on request). Open the recording's **Share** settings on the **Recording** tab and use **Show captions on replays**: "Viewers can turn on this session's captions (CC) on the replay and on simulives of it." Viewers then get a **CC** button on the player. Captions on replays name who is speaking.

    It is on by default when captions were shown during the session. [Recordings and retention](/blog/recordings-and-retention) covers sharing a replay, and [Turn a recording into a Simulive](/blog/turn-a-recording-into-a-simulive) covers playing it again.

    A Simulive shows the captions from the original session; you cannot start new live captions in one, because there is nothing live to caption.
  `,
};
