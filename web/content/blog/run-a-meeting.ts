import type { Post } from "../../lib/blog.ts";

export const post: Post = {
  slug: "run-a-meeting",
  title: "Run a meeting",
  description:
    "Schedule a small meeting, share one link, let people in from the lobby, and end it. Plus how a meeting differs from a webinar.",
  date: "2026-10-24",
  category: "tutorials",
  tags: ["meetings", "getting-started", "host-room", "scheduling"],
  body: `
    A meeting is a small call where everyone can talk and share. You send one link, guests type their name and knock, and you let them in. By the end of this guide you will have scheduled a meeting, admitted your guests and ended it.

    > [!NOTE] Before you start
    > Meetings need a hosting account. If you see **Hosting isn't enabled for this account**, press **Request to host** and we will switch it on for you. Meetings themselves are on for every host unless we have turned them off for your account; in that case the Meetings page says **Meetings aren't switched on for this account**.

    ## Meeting or webinar?

    Both run in the same room, with the same chat, Q&A, polls, screen sharing and recording. The difference is who is on stage and how people get in.

    | | Meeting | Webinar |
    |---|---|---|
    | Who can talk and share | Everyone | You and your panelists; you can bring attendees up |
    | How people get in | Open the link, type a name, wait to be let in | Register first, then join with their own link |
    | Size | 10 people at once, you included | Hundreds, depending on your plan |
    | Reminders and follow-ups | None | Confirmation, reminders and follow-ups |

    Use a meeting for a team call, a client check-in or a small workshop. Use a webinar when you are presenting to an audience. Our guide to [scheduling your first webinar](/blog/schedule-and-run-your-first-webinar) covers that side.

    ## Schedule a meeting

    1. Open **Meetings** in the sidebar.
    2. Choose **Schedule a meeting** ("Pick a time and share the link").
    3. Give it a **Topic**. This is what the invite and the room are called.
    4. Under **When**, set when it **Starts**, the **Duration** and the **Time zone**. A meeting has to start at least 15 minutes from now, which gives the video server time to start.
    5. Press **Schedule meeting**.

    That is the whole form. There is no registration, no passcode and no reminder emails: the link is the invitation.

    A meeting cannot repeat yet, but its link keeps working, so for a regular call you can schedule one and reuse the link.

    ### Starting a meeting right now

    If instant sessions are switched on for your account, you also get **Start a meeting**. It creates the meeting, opens the room in a new tab and copies the invite link for you (**Meeting started — invite link copied.**). The video server may take a couple of minutes to start. Instant sessions are available on request.

    ## Share the link

    Copy the link with **Share link** in the meeting's **⋯** menu, and send it however you like: chat, email or a calendar invite.

    Guests do not need an account. When they open the link they see your topic, your name and the time, and a short form:

    1. **Your name**, which is how they appear to everyone (up to 60 characters).
    2. **Ask to join**.

    The form tells them: "No sign-up needed. The host will let you in. Your microphone starts muted." Someone who is already signed in to Webinar Liv skips the name and knocks with their account name.

    After knocking, guests see **Waiting for the host to let you in…** and can keep the page open until you admit them. If they reload, they keep their place.

    ## Start the meeting

    Fifteen minutes before the start time, **▶ Start meeting** unlocks on the meeting's page. Press it, check your camera and microphone, and join. Guests who knocked before you arrived see **Getting the meeting ready…** until the room opens.

    ## Let people in

    Nobody gets in until you say so. When someone knocks:

    - A toast says who it is (for example **Asha is waiting to join.**), with **Admit**, **Deny** and **View**. When several people knock together, it offers **Admit all**.
    - The header shows **Waiting (2)** (or however many are waiting). Press it to open **Participants**.
    - In **Participants**, the **Waiting to join** section lists everyone at the door, each with **Admit** and **Deny**, and **Admit all** when there is more than one.

    If you are not in the room and have notifications on, your phone gets a push saying someone is waiting.

    A guest you deny sees **The host didn't let you in**.

    ### When the meeting is full

    A meeting holds 10 people at once, and that count includes you, so you can have 9 guests. If you try to admit one more, you see **Meeting is full (10). Ask an admin to raise it.** The guest sees **This meeting is full**, with a **Try again** button for when someone leaves.

    If you regularly need more, ask us. An admin can raise the limit for your account, up to 50 people.

    ### Lock the meeting

    Once everyone is in, you can open **Host tools** and turn on **Lock the meeting**. "Nobody new can ask to join. People already here stay." Turn it off again to open the door.

    ## Microphones and cameras

    Guests join with their **microphone muted and camera on**. They see this on the device check before they enter and can change either one there, or at any time with **Unmute** and **Stop video** on the bar.

    You, as the host, keep the settings you used last time.

    In the room, everyone is on stage. There is no audience and nobody needs to be brought up to speak. You can still mute someone or remove them from the **Participants** panel (**Remove from meeting**). Someone you remove sees **You were removed from this meeting** and can knock again, and you decide whether to let them back.

    Chat in a meeting goes to everyone. Raise hand, Q&A, polls and [reactions](/blog/engage-your-audience) all work as they do in a webinar.

    ## End the meeting

    Press **Leave**. As the host you can choose **End meeting for everyone**. Confirm with **End for everyone**, and everyone is disconnected and the meeting is marked as ended. Anyone still waiting at the door is told it has ended.

    You can also end it from the meeting's page with **End for everyone** in the **⋯** menu.

    A guest who presses **Leave** can come back with the same link while the meeting is still running.

    ### After the meeting

    The meeting moves to your past meetings, with **Results** showing who came. If cloud recording is switched on for your account and you recorded, the recording appears on the **Recording** tab; see [Recordings and retention](/blog/recordings-and-retention). Cloud recording is available on request.
  `,
};
