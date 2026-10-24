import type { Post } from "../../lib/blog.ts";

export const post: Post = {
  slug: "co-hosts-and-panelists",
  title: "Co-hosts and panelists",
  description:
    "Invite panelists to present with you, bring attendees onto the stage, make a co-host, and hand the session to a co-host before you leave.",
  date: "2026-10-24",
  category: "tutorials",
  tags: ["panelists", "co-hosts", "host-room", "stage"],
  body: `
    You do not have to run a webinar alone. Panelists present with you on the stage, a co-host can run the room alongside you, and you can hand the whole session to a co-host if you need to leave. This guide covers each of those, in the order you would set them up.

    ## Who is who

    | Role | What they can do |
    |---|---|
    | **Host** | Everything. You created the webinar, or a host handed it to you. There is one host at a time. |
    | **Co-host** | Someone on the stage you have given the host controls for this session. Only the host makes co-hosts. |
    | **Panelist** | On the stage with camera, microphone and screen share. Attendees you bring on stage show this badge too. |
    | **Speaker** | On the stage with sound only: microphone and screen share, no camera. |

    These are the badges you see next to names in **Participants**.

    ## Invite panelists

    Panelists are people you invite by email before the session. Each one needs a Webinar Liv account, because their stage link only works when they are signed in.

    ### When you schedule

    1. In the schedule form, find **Who is on the stage** under **In the room**.
    2. Type their addresses in **Panelist emails**, separated by commas or on separate lines.
    3. Schedule the webinar as usual.

    Each panelist gets an email titled **You're a panelist:** followed by your topic, with a **Join the stage** button and a calendar file. If you move the webinar they are told the new time, and if you delete it they are told it is cancelled.

    > [!WARNING] Every panelist needs an account
    > If someone does not have an account yet, the form names their address under **Panelist emails** and does not save until you take it out. Ask them to sign up first, then add them.

    When you edit the webinar later, the box already lists your panelists. Leave it alone and they stay on the stage. To take someone off, delete their address; you are asked to confirm before the change is saved.

    ### After scheduling

    Open the webinar and go to **Setup**. The **On the stage** card lists you and your panelists.

    1. Type an address in **Invite a panelist**.
    2. Press **Add**. You see a note that they can now present, and they get the invite email.

    If nobody has an account with that address, you see **Nobody with that address has an account yet. Ask them to sign up first.** You can add panelists while the webinar is live, too.

    To take someone off the panel, press the bin next to their name (**Remove … from the stage**).

    ### The stage link

    On the same tab, **Host and panelist link** shows the address you and your panelists use to join the stage. Only you and the panelists on this webinar can use it, so sharing it by mistake does not put anyone else on stage. A panelist who is not signed in is asked to sign in first.

    ### How many people fit on the stage

    Your plan sets how many people can be on stage at once, and that number includes you, your co-hosts, panelists and anyone you bring up. If you go over it, the form tells you how many panelists you can have, and in the room you see **The stage is full: your plan allows … people on stage at once. Move someone back to the audience first.**

    ## Bring an attendee onto the stage

    During the session you can invite anyone in the audience up. Open **Participants**, find them under **Attendees**, and open the menu next to their name:

    - **Allow to speak** gives them a microphone and screen share.
    - **Bring on stage** gives them a camera, microphone and screen share.

    This sends them an invitation, not a command. They see **The host invited you on stage** (or **…to speak**) with **Join stage** and **Not now**, and have a minute to answer. You see **Waiting for … to accept** until they do.

    If someone raises their hand, they appear under **Raised hands** in **Participants**, and you can press **Allow to Speak** or **Lower Hand** right there. Our guide to [engaging your audience](/blog/engage-your-audience) has more on raised hands.

    To send someone back, open their menu and choose **Remove speaker permission**. They are muted and return to the audience.

    Scheduled panelists are not offered **Audio only** or **Remove speaker permission**, because their seat comes from the panel. Mute them from **Participants**, or take them off the panel in **Setup**.

    For everyone at once, **Host tools** has **Allow everyone to speak**, **Bring everyone on stage** and **Remove everyone's speaking permission**. That last one leaves your scheduled panelists where they are.

    ## Make a co-host

    A co-host gets the host controls for this session: muting, the stage, polls, Q&A, the lobby, removing people and the room settings. It is handy when you want someone else to watch the chat and the hands while you present. It is also who you can hand the session to when you leave.

    1. Open **Participants**.
    2. Open the menu next to someone on the stage: a panelist, an attendee you brought on stage, or a guest in a meeting.
    3. Choose **Make co-host**.

    You see a note listing what they can now do, and what stays with you. To undo it, choose **Remove co-host**, and they go back to being an ordinary panelist.

    An attendee or meeting guest needs to be signed in to a Webinar Liv account with a confirmed email to be a co-host. If they are not, you see **… needs to sign in to be a co-host**, so ask them to sign in with the same email and rejoin.

    Only you, the host, can make or remove a co-host. Co-hosts do not see **Make co-host** or **Remove co-host**, and cannot change anyone's co-host status, including their own. A few other things also stay with you: deleting or copying the webinar, handing over the host role, sending follow-ups, and deleting recordings.

    When a co-host presses **Leave**, they get **Leave webinar** (the session carries on with you) and **End webinar for everyone**. They cannot hand over the host role, because only you can.

    ## Remove someone

    From anyone's menu in **Participants**, **Remove from webinar** takes them out of the room. If their page reloads or reconnects, they are not let back in automatically, and they see **You were removed from this session**.

    ## Hand over and leave

    If you need to leave but the session should carry on, give it to one of your co-hosts. This works the same way in webinars and meetings.

    1. Make the person a co-host first, if they are not one already (see above).
    2. Press **Leave**. Each co-host in the room is listed as **Make … the host and leave**.
    3. Choose the co-host who will take over. You see **… is now the host. Leaving…**

    A few things to know:

    - You can only hand over while the session is live, and only to a co-host who is in the room. Panelists and guests who are not co-hosts cannot take over.
    - There is only ever one host. The co-host you choose becomes the host and is no longer a co-host. You become an ordinary panelist and leave. If you rejoin, you are on the stage as a panelist, not as the host.
    - The change is permanent. The new host gets the session with its results, recording and follow-ups.
    - If there are no co-hosts in the room, the menu offers **Leave webinar** (or **Leave meeting**) and **End … for everyone**, with a reminder that making someone a co-host first is what lets you hand over. If you leave a webinar this way, the stage carries on without a host and you can rejoin while it is live. If you leave a meeting this way, everyone else stays, but nobody can be let in from the lobby until you or a co-host are back.
    - If your tab closes or your connection drops, nothing is handed over. The session carries on, nobody becomes host automatically, and you can rejoin as the host.

    If you would rather close the session, choose **End webinar for everyone** (or **End meeting for everyone**) instead. [Schedule and run your first webinar](/blog/schedule-and-run-your-first-webinar) walks through ending a session and what happens after.
  `,
};
