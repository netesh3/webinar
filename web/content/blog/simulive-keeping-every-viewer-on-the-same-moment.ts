import type { Post } from "../../lib/blog.ts";

export const post: Post = {
  slug: "simulive-keeping-every-viewer-on-the-same-moment",
  title: "Simulive: keeping every viewer on the same moment",
  description:
    "How a replayed recording behaves like a live session: one start time, a borrowed server clock, a player that puts itself back, and replayed chat timed to the video.",
  date: "2026-10-24",
  category: "engineering",
  tags: ["simulive", "engineering", "video", "engagement", "architecture"],
  body: `
    A [Simulive](/blog/turn-a-recording-into-a-simulive) is a recording played as a scheduled live session. To the audience it should feel live: everyone sees the same moment, a late joiner lands where everyone else is, and the chat, questions and polls from the original session appear when they happened the first time.

    The video itself is ordinary. It is a file, or an HLS stream of that file, played in each viewer's browser. Nobody is broadcasting. So "live" has to come from somewhere else. This post explains where.

    ## One start time, no broadcaster

    Every viewer works out where they should be from one number: when the session started. Their position is simply *now minus the start*, so two viewers who agree on the start and on the time agree on the position. A viewer who joins twenty minutes late gets a position twenty minutes in, without asking anyone.

    ::diagram[simulive-clock] Every viewer's position comes from the same start time, so a late joiner lands where everyone else is.

    For a session that starts automatically, the start is the **scheduled** time, not the moment the server first noticed it was due. That matters because of how the API runs. It is serverless: it only has CPU while it is answering a request, so there is no process sitting there waiting for 10:00 to arrive. Instead, every request that touches a Simulive (its page, a join, a chat message, a poll) first brings it up to date, and a background tick does the same. Whichever request comes first moves the session from waiting to playing, and it writes the scheduled start, not its own arrival time. A session that was first noticed at 10:00:07 still started at 10:00:00 for everyone.

    Each change of state is a single guarded update in the database, so it happens exactly once even when several requests race to make it. When the host presses **Start now** instead, the start is that moment.

    Until there is a start, nothing plays. A player with no start time would begin at 0:00 by its own clock, and every viewer would be at a different place. So the room shows a waiting screen and asks the server how things stand: every few seconds once the start is due, less often while it is still far off. When the session starts, the room's state changes, and every waiting player starts together.

    ## Borrowing the server's clock

    *Now minus the start* only works if everyone's *now* is the same. It is not. Device clocks are often a few seconds out, and occasionally minutes out. A laptop 40 seconds fast would play 40 seconds ahead of everyone else, and see the end of the recording 40 seconds early.

    So the room measures how far the device's clock is from the server's, using the simplest form of the idea behind NTP. The browser notes when it sends a request and when the reply comes back. The reply carries the server's time. Assuming the server read its clock halfway through the round trip, the offset is the server's time minus that halfway point.

    ::diagram[server-clock] The browser assumes the server read its clock halfway between sending and receiving.

    The guess about "halfway" is wrong by at most half the round trip, so a fast round trip gives a better answer than a slow one. The room takes five samples, one after another, and keeps the one with the shortest round trip. Over a reasonable connection that puts every viewer within a few tens of milliseconds of the server's clock, which is far better than the tolerance the player works to.

    The offset is measured once per page and shared by everything that needs the time: the position, the countdown on the waiting screen, the host's countdown and the moment the recording ends. If the measurement fails, the device's own clock is used, which is how things worked before. Until the measurement arrives, a second or so after the page loads, the device clock stands in, and the next check moves the player if it needs to.

    > [!NOTE] The trade-off
    > We measure once rather than continuously. That keeps the page quiet, but if a device's clock jumps in the middle of a session (waking from sleep, or the operating system correcting itself), the offset goes stale until the page is reloaded. In practice the drift check below absorbs small changes; a big jump is rare.

    ## A player that puts itself back

    Knowing where you should be is half of it. The other half is staying there.

    Once a second, and on every event that could move it (seeking, pausing, changing speed, ending), the player compares its position with the shared one. Within two seconds, it is left alone: small differences are normal and a correction would be more noticeable than the drift. Beyond two seconds, it seeks to the shared position. If it was paused, it plays again.

    Two details make this behave:

    - **Buffering is not drifting.** While the player is waiting for data, it is behind for a reason, and seeking would only make it wait again. The once-a-second check skips a player that is buffering.
    - **Speed never changes.** The player could close a gap by playing slightly fast, as some live players do. We chose not to: sped-up speech sounds wrong, and a two-second gap is not worth that. Playback speed is held at normal on every check, and the only correction is a seek.

    A late joiner is handled the same way. If the shared position is more than a few seconds in, the player starts there. For the last half second of the video it holds rather than seeking into the very end.

    ## Why attendees cannot seek

    A Simulive is a broadcast, so the player looks like one. There is no play and pause button, no scrubber, no time display, no speed control and no skip buttons: just volume, captions, fullscreen and a live badge. The keyboard shortcuts that would move it (space, the arrow keys, Home and End, the media keys) are swallowed. On the operating system's media controls, pause does nothing and seeking is hidden. On an iPhone, fullscreen is done within the page, so the native player and its scrubber never appear.

    We did not try to block every way a browser can move a video. Picture-in-picture windows, developer tools and throttled background tabs can all do it. Instead, the player checks against the clock and puts itself back. Hiding the controls is about making the experience honest, not about enforcement; the clock is the enforcement.

    ## When the recording ends

    The session's length is the shorter of the recording's length and how long the original session ran after recording started. If the original ended before the file does, the replay ends with it.

    At the start plus that length, measured on the server's clock, the player is removed for everyone at the same moment and the room says the recording has ended. The server then decides what happens next, after a short grace:

    - If the host or a co-host is in the room, the session carries on **live**, as an ordinary Q&A. Everyone joins the live room; the host team starts with microphones and cameras off.
    - Otherwise the session ends.

    The host can also end the replay early and go live from the host bar.

    ## Two ways to start

    A Simulive either **starts automatically at the scheduled time** or waits for the host (**I'll start it**). Entering the room never starts an automatic session early; the host can join before the start and wait with the audience. From the host bar, the host can also start it in a few minutes or delay it by five, and that new time is used by everyone. Doors open ahead of the start so people can arrive and chat; until then the room belongs to the host team. A session nobody starts lapses at the end of its scheduled time.

    The automatic start also checks that the recording would not already be over. A session that was due yesterday, and is noticed only today, does not start.

    ## Replaying the original engagement

    With engagement replay, the original session's chat, questions, answers, reactions and polls appear again at their moment in the video. Each item's place is its original time minus the moment recording started. Anything from before the recording (the pre-show chat) or after it is dropped. An answer is never placed before its question.

    ### Pulled, not pushed

    The obvious design is for the server to push each item to everyone at the right time. We did the opposite. The server builds the whole timeline once, and each browser fetches it and plays it against **its own video's position**. A push can only ever be roughly in step with any one viewer, because each viewer's video is slightly ahead or behind. A timeline played against the video is exactly in step with every viewer, and it can be cached.

    The browser checks the timeline as the video plays, and fetches it again every minute and a half, so items the host hides during the session drop out.

    A late joiner sees everything up to their position at once, as history, rather than having it all play at them. Only items from the last few seconds are "played": reactions float up and polls are re-read. Replayed reactions are spread out and capped, so a burst in the original does not bury the screen.

    Replayed chat sits among the new audience's live messages. Each replayed line is given the time it would have been said in this session, and merged with live chat by that time. That anchor is only moved if it changes by more than two seconds, so lines do not jitter.

    ### Polls are real polls

    Polls are the exception to "the browser plays it". A poll needs votes, and votes need one source of truth. So the Simulive gets its own copy of each poll, and the **server** opens and closes those copies by its own clock, at the moments the originals opened and closed. The original votes are never read: the new audience votes and sees its own results. If the original was never closed by hand, it closes when the next poll opened, or at the end of the recording.

    The browser re-reads polls when its video passes a poll moment, and again a few seconds later in case it is slightly ahead of the server.

    ### Privacy in the replay

    The replay is meant to recreate the atmosphere, not to republish people. The host and panelists keep their names. Everyone else is shortened to a first name and an initial, like "Priya S.", and a name that looks like an email or phone number becomes "Attendee". Emails and phone numbers are removed from the text of every message. The timeline the audience downloads carries no identities: items are numbered, not linked to accounts, and each replayed line gets its own avatar so two lines cannot be matched to one person.

    Hosts can hide anything before or during the session. Hidden items are left out of the audience's timeline entirely; hiding a question hides its answer, and hiding a poll that is open closes it.

    > [!NOTE] Available on request
    > Simulive and engagement replay are switched on per account. [Turn a recording into a Simulive](/blog/turn-a-recording-into-a-simulive) covers setting one up.

    ## In short

    - **One number** decides every viewer's position: the start time, which is the scheduled time, written exactly once.
    - **The server's clock**, measured NTP-style from the shortest of five round trips, replaces each device's own.
    - **The player** checks once a second, leaves small drift alone, seeks past two seconds and never changes speed.
    - **No seeking**: the controls are hidden, but the clock is what keeps people in place.
    - **Engagement replay** is a timeline each browser plays against its own video; only polls are driven by the server, because votes need one source of truth.

    For how the video itself reaches people, see [How Webinar Liv delivers video](/blog/how-webinar-liv-delivers-video).
  `,
};
