import type { Post } from "../../lib/blog.ts";

export const post: Post = {
  slug: "turn-a-recording-into-a-simulive",
  title: "Turn a recording into a Simulive",
  description:
    "Replay a past recording, or a video you upload, as a scheduled live session: pick the source, choose how it starts, curate the replayed chat, and go live after.",
  date: "2026-10-24",
  category: "tutorials",
  tags: ["simulive", "recordings", "scheduling", "engagement"],
  body: `
    A Simulive is a past recording run again as a scheduled live session. People register and join as usual, and everyone watches the same moment together. You do not have to present it again, but you can drop in to answer questions, and even go live on camera when the recording ends.

    > [!NOTE] Available on request
    > Simulive is switched on per account. If you see **Simulive isn't switched on for this account**, ask us to turn it on. Replaying the original chat, Q&A and polls (engagement replay) is a separate switch, also available on request.

    ## Pick what to play

    There are three ways in:

    - On **Your webinars**, choose the **Simulive** card ("Replay a past recording as a scheduled live session").
    - In a past webinar's **Recording** tab, press **Replay as Simulive** on a ready recording.
    - On an ended webinar's results, the **Run this again on autopilot** card has **Schedule a Simulive**.

    The **Schedule a Simulive** page lists your ready recordings, newest first. Each has **Replay as Simulive** and **Preview**.

    ### Or upload a video

    You can also play a video you made elsewhere. Under **Upload a video**, drag a file in or click to choose one.

    | | |
    |---|---|
    | Formats | MP4 or MOV, with H.264 video and AAC audio |
    | Size | Up to 4 GB |
    | Length | Up to 24 hours |
    | Kept for | 30 days, and you can **Keep 3 more months** at a time |

    Uploads count toward your recording storage. Keep the page open while it uploads. If the upload stops, choose the same file again and it carries on from where it left off. Afterwards the video is checked to make sure it plays in every browser.

    > [!WARNING] WebM and MKV will not work
    > These do not play in every browser. Export your video as an MP4 with H.264 video and AAC audio, then upload that.

    ## Schedule it

    Choosing a recording opens the usual scheduling form with the type locked to **Simulive**. The title, summary and description are copied from the original webinar, and the duration is set to the length of the recording. Change whatever you like.

    In **The recording** section you can switch between **Use a recording** and **Upload a video**, preview it with **Play**, or press **Change recording**.

    ### How it starts

    Under **How it starts** pick one of two modes:

    - **Start automatically at the scheduled time**: it plays for everyone at the start, whether or not you are there. This is the default.
    - **I'll start it**: you or a co-host start it yourselves. It does not start on its own, and if nobody starts it, it lapses at its scheduled end.

    **Doors open** sets how early people can come in to wait and chat: at the start, or 5, 10, 15 or 30 minutes before. If you want to run it soon, the quick buttons next to **Start in** (5, 10, 15 or 30 minutes from now) fill in the time for you.

    A Simulive is never recorded again; it already is a recording. Press **Schedule** and you will see **Simulive scheduled.**

    ## Curate the replayed engagement

    With engagement replay switched on, the original session's chat, questions and answers appear at the same moment in the video as they did the first time, and its reactions float up again. Polls and quizzes open and close at their original times. Your new audience votes and sees its own results; the original votes are never shown.

    Names from the original session are shortened (for example "Priya S."), and phone numbers and emails are removed.

    To choose what replays, open the webinar's **Setup** tab and find **Engagement replay**:

    - Filter by **All**, **Chat**, **Q&A**, **Polls & quizzes** or **Reactions**.
    - **Search the replay**, or type a time such as 12:30 and press **Jump**.
    - Press **Hide** on anything you would rather not replay. Hiding a question also hides its answer.
    - **Hide all** and **Show all** work on the current filter, and the counter tells you how many items will be replayed.

    > [!NOTE] Uploaded videos
    > An uploaded video has no original session, so only the video plays. New attendees can still chat and ask questions live.

    ## On the day

    Your webinar page has an **Enter room** button. You can go in any time before the start without starting it, and wait with the early arrivals.

    In the room, a host bar shows the state: when it starts, how many people are waiting, and whether the doors are open. Before the start you can:

    - **▶ Start now**, or start **In 2 min**, **In 5 min** or **In 10 min**,
    - **Delay 5 min** or **Cancel start**,
    - **Open doors now** to let people in early.

    For an **I'll start it** Simulive you can also press **▶ Start Simulive** on the webinar page.

    ### What your audience sees

    Before the start, attendees see a countdown and **Everyone starts together. Say hello in the chat while you wait.** Once it plays, there is no pause, seek or speed control; everyone stays on the same moment. Someone who joins 20 minutes late lands 20 minutes in, with the replayed chat and questions up to that point already showing.

    ::diagram[simulive-clock] Every viewer's position comes from the same start time, so a late joiner lands where everyone else is.

    ### Drop in while it plays

    You and your co-hosts can join at any time to chat and answer new questions as they come in. Your camera and mic are not added over the recording, and nobody is brought on stage while it plays.

    > [!TIP] Let the assistant answer
    > With AI, engagement replay and Simulive all switched on, the Setup tab has **✨ Auto mode**. The assistant answers new questions from your knowledge, and every answer is clearly signed as your assistant, never as you. Questions it cannot answer from your knowledge wait for you. It is off for each webinar until you turn it on.

    ## Go live after the replay

    Many hosts like to finish with a live Q&A. In the room, press **After the replay: go live with your camera** to check your camera and mic privately (nothing is sent while the replay plays), then **Use these when I go live**.

    When the recording ends:

    - If you or a co-host are in the room, the session carries on live. You get the stage with your camera and mic off at first, and the audience moves to the live room. Attendees see **That's the end of the recording** and **Stay a moment — the host may join you live.**
    - If nobody from the host team is there, the session ends.

    Want to finish the replay early? **End replay early and go live** stops the recording for everyone and takes you straight to the live part. The live part is not recorded. It ends when you choose **End webinar for everyone**, or shortly after the last of the host team leaves.

    To stop a Simulive without going live, press **End Simulive** and confirm.
  `,
};
