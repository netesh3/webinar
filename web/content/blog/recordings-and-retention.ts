import type { Post } from "../../lib/blog.ts";

export const post: Post = {
  slug: "recordings-and-retention",
  title: "Recordings and retention",
  description:
    "Record a session to the cloud or to your own computer, find it afterwards, share a replay, and keep it past the standard 30 days.",
  date: "2026-10-24",
  category: "tutorials",
  tags: ["recordings", "replay", "host-room", "storage"],
  body: `
    This guide covers recording a session, where the recording ends up, how to share it as a replay, and how long it is kept. At the end you will have a recording you can play, download and share.

    > [!NOTE] Cloud recording is available on request
    > Cloud recording, and with it the **Recording** tab and **Record automatically**, is switched on per account by our team. Without it you can still record to your own computer from the room.

    ## Two places to record to

    In the room, the **Record** button has a small arrow next to it. Press it to choose where the recording goes:

    | Option | What happens |
    |---|---|
    | **Record to the Cloud** | "Stored for 30 days. Download a copy if you need it longer." It appears on the webinar's **Recording** tab. |
    | **Record on this Computer** | "Saved as a local file. Attendees aren't notified." It goes straight to a file you choose, and never leaves your computer. |

    You only see **Record to the Cloud** if cloud recording is switched on for your account. Both options record the same view: the stage as your audience sees it, not just your own screen.

    ## Record a session

    1. Go live and join the room.
    2. Press the arrow next to **Record** and choose **Record to the Cloud** or **Record on this Computer**.
    3. For a local recording, your browser asks where to save the file. Pick a folder.
    4. When you are done, press **Stop**.

    You can record before you start the session, too, which is handy for a practice run.

    While a recording runs, a red **REC** pill shows the time. You, your co-hosts and anyone on the stage see it. People watching in the audience do not, so if you are recording to the cloud, they are told when they register instead.

    > [!WARNING] Keep the tab open
    > Both kinds of recording need the room tab to stay open until you press Stop. A local recording works in Chrome or Edge on a computer.

    ### Record automatically

    If cloud recording is switched on for your account, the schedule form has **Record automatically** under **Recording and extras**. With it on, registrants are told the session is recorded: the webinar page shows a **Recorded** badge and the registration form says so. When you are in the room, check for the **REC** pill, and press **Record** if it is not there.

    ### Stopping and starting again

    Each time you stop and start, you add another take to the same recording. The takes stay together on one card on the **Recording** tab.

    ## Find your recording

    A local recording is the file you saved; it does not appear in Webinar Liv.

    A cloud recording appears on the webinar's **Recording** tab once the session has ended. While it uploads, the card shows **Uploading** with a percentage, and the player appears as soon as the file is ready. The card then has:

    - **Play** to watch it here,
    - **Share** to set up a replay link (below),
    - **Download** to save a copy to your computer,
    - the bin to delete it (**Delete this recording?** It cannot be undone).

    If AI is switched on for your account, the player also shows **Chapters · by AI**, usually within 20 minutes of the end; click one to jump to it. AI features are off by default and available on request.

    A recording can also become a Simulive with **Replay as Simulive**; see [Turn a recording into a Simulive](/blog/turn-a-recording-into-a-simulive).

    ## Share a replay

    Recordings start **Private**. To share one:

    1. Press **Share** on the recording.
    2. Turn on **Enable public viewing**. Anyone with the **Public share link** can now watch it.
    3. Optionally, add a passcode under **Passcode protection (optional)**. Leave it blank to use the webinar's own passcode, if it has one.
    4. Press **Save Settings**.

    Copy the link and send it wherever you like. The replay page has the video, your name, the webinar details and a download button.

    If follow-ups are switched on for your account, saving a recording as public also emails everyone who registered a link to watch it, once per person. The share window warns you before it does. Follow-ups are available on request.

    If the session had [live captions](/blog/live-captions), **Show captions on replays** lets viewers turn them on with the **CC** button.

    ## How long recordings are kept

    Cloud recordings are kept for **30 days** from when the recording stopped, then deleted automatically. The banner at the top of the **Recording** tab says how long yours are kept, and each card shows the date it will be deleted and how many days are left. The countdown turns amber in the last week.

    ### Keep one longer

    Press **Keep 3 more months** on the recording. The card now says **Kept until** with the new date, and the card gets a **Kept longer** badge. You can press it again whenever you like, for another 3 months each time, as long as you have storage to spare.

    If you change your mind, **Let it expire** puts it back to the standard 30 days and stops the reminders.

    ### Reminders before deletion

    We email you **7 days** and **1 day** before a recording is deleted. The email has a **Keep 3 more months** link, which keeps it straight away after you sign in, and a link to open or download it. If you do nothing, it is deleted on the date shown.

    To keep a recording for good, download it.

    ## Storage

    Your plan comes with an amount of recording storage. The **Recording storage** meter on the **Recording** tab shows how much you are using, for example "6.2 of 10 GB". Recordings you keep longer, uploaded videos and highlight clips all count.

    - At 90% the meter says **Almost full.**
    - When it is full, new recordings are still made, but they are kept for the standard 30 days and cannot be kept longer. Delete recordings you do not need, let others expire, or upgrade for more space.

    Nothing is deleted when you go over; it only stops you keeping more.
  `,
};
