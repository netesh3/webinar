import type { Post } from "../../lib/blog.ts";

export const post: Post = {
  slug: "co-hosts-and-panelists",
  title: "Co-hosts and panelists",
  description:
    "Invite panelists to present with you, bring attendees onto the stage, make a co-host, and hand the webinar to someone else before you leave.",
  date: "2026-10-24",
  category: "tutorials",
  tags: ["panelists", "co-hosts", "host-room", "stage"],
  body: `
    You do not have to run a webinar alone. Panelists present with you on the stage, a co-host can run the room alongside you, and you can hand the whole session to someone else if you need to leave. This guide covers each of those, in the order you would set them up.

    ## Who is who

    | Role | What they can do |
    |---|---|
    | **Host** | Everything. You created the webinar. |
    | **Co-host** | A panelist you have given the host controls for this session. |
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

    > [!WARNING] Addresses without an account are skipped
    > If someone does not have an account yet, their address is left out without a message. Ask them to sign up first, then add them.

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

    For everyone at once, **Host tools** has **Allow everyone to speak**, **Bring everyone on stage** and **Remove everyone's speaking permission**. That last one leaves your scheduled panelists where they are.

    ## Make a co-host

    A co-host gets the host controls for this session: muting, the stage, polls, Q&A, the lobby, removing people and the room settings. It is handy when you want someone else to watch the chat and the hands while you present.

    1. Open **Participants**.
    2. Open the menu next to one of your panelists.
    3. Choose **Make co-host**.

    You see a note that they can now control the webinar like you can. To undo it, choose **Remove co-host**, and they go back to being an ordinary panelist.

    Only scheduled panelists can be co-hosts, so invite someone as a panelist first. A few things stay with you as the host: deleting or copying the webinar, handing over the host role, sending follow-ups, and deleting recordings.

    ## Remove someone

    From anyone's menu in **Participants**, **Remove from webinar** takes them out of the room. If their page reloads or reconnects, they are not let back in automatically, and they see **You were removed from this session**.

    ## Hand over and leave

    If you need to leave but the session should carry on, give it to one of your panelists.

    1. Press **Leave**.
    2. Choose **Assign host & leave** ("Hand the session to another panelist, then exit.").
    3. Pick the panelist who will take over. The first one is already selected.
    4. Press **Assign & leave**. You see **Host assigned. Leaving…**

    A few things to know:

    - You can only hand over while the webinar is live, and only to a scheduled panelist who is in the room. Attendees you brought on stage cannot take over.
    - If no panelist is in the room, the option says **No eligible panelist is in the room right now.**
    - The change is permanent. The panelist becomes the webinar's host, with its results, recording and follow-ups, and you become a panelist on it.

    If you would rather close the session, choose **End webinar for everyone** instead. [Schedule and run your first webinar](/blog/schedule-and-run-your-first-webinar) walks through ending a session and what happens after.
  `,
};
