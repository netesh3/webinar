import type { Post } from "../../lib/blog.ts";

export const post: Post = {
  slug: "highlights-reels-and-studio",
  title: "Turn a session into highlights, reels and posts",
  description:
    "Find a recording's best moments, make captioned vertical, square or wide clips and reels, plan where they go in Studio, and draft posts from a session.",
  date: "2026-10-24",
  category: "tutorials",
  tags: ["clips", "studio", "recordings", "ai", "repurpose"],
  body: `
    A one-hour session usually has a few moments worth sharing on their own. By the end of this guide you will have found them, made them into short captioned videos ready for Reels, Shorts, TikTok, LinkedIn or YouTube, and planned when each one goes out.

    > [!NOTE] Available on request
    > Highlights, clips and Studio are switched on per account as **Highlight clips**. They need AI and cloud recording switched on too. AI features are off by default for every host, so ask us to turn these on. Repurposing a session into written drafts is a separate switch, also on request.

    ## Find the highlights

    You need a session that has ended, with a recording that is ready. Open the webinar, go to its **Recording** tab and click the recording to open the player. Under it you will see **Highlights · by AI**.

    Press **Find highlights**. It takes up to a minute. Opening the page does not use AI; only pressing the button does, and it counts toward your monthly AI allowance.

    The highlights are picked from two things:

    - **What was said**, from the session's captions. If nothing was captioned there is nothing to pick from, so keep the room's AI switch on. Anything said while AI was paused is left out.
    - **Where the audience reacted**: reactions, chat, questions and polls around each moment. These are counted, not guessed.

    You get up to six highlights, each 20 to 90 seconds long and cut at the ends of sentences. Each shows its time, a title, why it was picked, a quote and what the audience did then, such as "3 reactions" or "1 question". Press **Find them again** for a fresh list.

    ### Preview and adjust

    **Preview** plays just that part. To change where it starts or ends, press **Adjust start and end**, type the times (like 12:05) or nudge them with **−1 s** and **+1 s**, and press **Done**. A clip is 20 to 90 seconds long. **Back to the suggestion** undoes your changes.

    ## Or let it suggest reels

    A reel stitches a few short moments on one theme into a 30 to 60 second vertical video. Under **Suggested reels · by AI**, press **Suggest reels**. You get up to three (four for a long session), each with a hook and the moments it uses. **Preview** plays them back to back.

    Reels are planned from the whole recording, so you do not need to find highlights first.

    ## Make the video

    Press **Make a clip** on a highlight, or **Make this reel** on a reel.

    **Formats**: tick one or more. Each format is made as a separate video.

    | Format | For |
    |---|---|
    | **9:16 vertical** (the default) | Reels, Shorts, TikTok |
    | **1:1 square** | LinkedIn, Instagram feed |
    | **16:9 wide** | YouTube, LinkedIn |

    **Framing for vertical and square**: **Whole picture** (the default) shows the full frame over a blurred copy of itself, which keeps slides readable. **Fill: middle**, **Fill: left side** and **Fill: right side** crop to that part instead. The speaker is not tracked, so pick the side they are on.

    **Hook title**: a line shown big at the top for the first few seconds, to stop people scrolling. Up to 70 characters, or leave it empty.

    **Captions**: on by default. Big captions are burned into the video a few words at a time, with the word being said lit up. Most people watch with the sound off.

    **Name**: for your list and the file name. It is not shown in the video.

    Press **Create** (or **Create 2 videos**, and so on, for several formats).

    ### When it is ready

    Videos are made on the video server between sessions, and they count toward your recording storage. Our video server only runs around sessions, so a clip can wait as **Waiting** until it is next up, usually around your next session. It also waits while a session is live. [Running a video server only when you need it](/blog/running-a-video-server-only-when-you-need-it) explains why.

    Once it shows **Ready**, press **Download** for the MP4. Under **What to post with it** there is suggested text for Instagram Reels, YouTube Shorts, TikTok, LinkedIn and YouTube, each with **Copy**. Nothing is posted for you.

    Up to 12 clips of one recording can wait to be made at once. Clips are deleted with their recording; see [Recordings and retention](/blog/recordings-and-retention).

    ## Plan it in Studio

    **Studio** in the sidebar brings everything together: "Turn your recordings into short clips, and plan where they go." It has three tabs.

    - **Recordings**: your sessions, with how far each has got ("Not analysed yet", or how many highlights, reels and clips it has). **Find highlights** works from here; **Make clips** takes you to that session's Recording tab, where clips are made.
    - **Clips**: every clip and reel, filtered by **All**, **Ready**, **On the way** or **Failed**, with **Download** and **Copy post**.
    - **Plan**: your ready clips grouped by the week you mean to post them (**This week**, **Next week**, **Later**, **Unplanned**). Tap a clip's status to move it from **Idea** to **Scheduled** to **Posted**. Open a clip to set **Where** it goes, **When**, and a **Note (just for you)**.

    Studio is a plan, not a publisher: it keeps track of what goes where, and you post it yourself. It lists the sessions you host; co-hosts make clips from the session's Recording tab.

    ## Write posts from the session

    If repurposing is switched on for your account, the webinar's **AI insights** tab has **Repurpose this session**. Pick what to write (**Blog post**, **Newsletter**, **Whitepaper draft**, **LinkedIn post**, **X thread** or **Instagram caption**) and press **Write drafts**. Each draft takes up to a minute.

    Drafts are marked **AI draft, not reviewed**. Read and edit each one, then press **Mark as reviewed**; only then can you **Copy** it or **Download .md**. **Set your brand voice** once (your tone, who you write for, words to use and avoid, and a sample of your writing) and every draft follows it.

    ## Next

    - Get the session's [AI recap](/blog/ai-recap-and-insights), with chapters for the recording.
    - Run the recording again for a new audience as a [Simulive](/blog/turn-a-recording-into-a-simulive).
  `,
};
