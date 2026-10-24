import type { Post } from "../../lib/blog.ts";

export const post: Post = {
  slug: "schedule-and-run-your-first-webinar",
  title: "Schedule and run your first webinar",
  description:
    "From a blank form to the end of the session: schedule a webinar, share the registration page, go live 15 minutes before the start, and wrap up.",
  date: "2026-10-24",
  category: "tutorials",
  tags: ["getting-started", "scheduling", "registration", "host-room"],
  body: `
    This guide takes you through one complete webinar on Webinar Liv: scheduling it, getting people registered, going live, running the room and ending it. It takes about ten minutes to set up, and you can change almost everything later.

    ::diagram[webinar-timeline] The life of a webinar, from scheduling to follow-up.

    > [!NOTE] Before you start
    > Hosting is switched on per account. If your account page says **Hosting isn't enabled for this account**, press **Request to host** and we will switch it on for you.

    ## Create the webinar

    Open **Your webinars** and choose the card **Schedule a webinar** ("Pick a date and invite people"). The form has two steps, shown as tabs at the top: **The webinar** and **Messages & follow-ups**. You can press **Save as draft** at any point and come back later.

    ### The basics

    - **Topic** is the only required field. It is the title people see everywhere.
    - **One-line summary** appears on cards and lists.
    - **Description (optional)** is the full story on the registration page: what you will cover, who it is for and what people will take away.
    - **Topic tag** is a short label such as "Productivity".
    - **Type** is **Live webinar** for a single session, or **Recurring series** for a run of sessions.
    - **Webinar Image** is optional. Drag an image in, or pick one. It is the cover on the registration page.

    > [!TIP] Let AI write the first draft
    > If AI is switched on for your account, the **Write with AI** panel turns a sentence about your webinar into a title, summary and description. AI features are off by default and available on request.

    ### When

    Pick when it **Starts**, how long it runs (**Duration**, from 15 minutes to 4 hours; 60 minutes by default) and the **Time zone**. The form shows the start in your local time underneath, so you can double-check it.

    A new webinar has to start at least 15 minutes from now. If you need something sooner, schedule it for 15 minutes ahead.

    ### Who can join

    Under **Registration** you decide how people get in:

    - **Approval**: **Automatically approve** lets everyone in straight away. **Manually approve each one** puts registrations in a queue for you to accept.
    - **Attendee limit** is how many people can be in the session at once. The hint under it shows the most your plan allows.
    - **Passcode (optional)** adds a code people must enter to register.
    - **Registration questions**: name and email are always asked. Press **Add a question** to ask anything else, such as a company name or what people hope to learn.

    ### In the room

    **How the session starts** sets the defaults for the room: **Attendee chat**, **Q&A**, **Reactions**, **Raise hand**, and whether to **Hide attendees from each other**. You can change all of these live from the host controls, so do not overthink them.

    Under **Who is on the stage**, add **Panelist emails** for anyone presenting with you. Each panelist gets an email with their own stage link, and needs a Webinar Liv account to use it.

    **Recording and extras** has **Live captions** and **Stream to YouTube** (connect your channel, or paste a stream key from YouTube Studio). If cloud recording is switched on for your account, **Record automatically** records the session without you having to press Record. Cloud recording is available on request; without it you can still record to your own computer from the room.

    ### Messages and follow-ups

    Press **Next: Messages & follow-ups →** to review what registrants receive: the confirmation email with their personal join link and a calendar invite, and reminders before the start (24 hours and 1 hour before, unless you change them). When it looks right, press **Schedule**.

    You will see **Webinar scheduled.** and land on the webinar's own page. That page is your home base for this session.

    ## Share the registration page

    Every webinar has a public registration page. On the webinar's **Overview** tab, the **Share this link** card has the address ready to copy, plus:

    - **WhatsApp** to send it in a chat,
    - **Copy invitation** for a ready-written invite you can paste into an email or post,
    - **Add to calendar** to block the time in your own calendar,
    - **Preview page ↗** to see exactly what your audience sees.

    You can also copy the link from **Share link** in the **⋯** menu, or **Copy link** in your webinars list.

    ### What registrants see

    The registration form asks for **Full name**, **Email Id** and **Mobile number**, plus any questions you added (and the passcode, if you set one). They press **Register & Join** and see **You're registered**, with buttons for **Google Calendar** and **Download .ics**. A confirmation email with their join link and a calendar file follows.

    Before the start, the registration page counts down to when the doors open. When it is time, the countdown turns into a **Join now** button by itself; nobody needs to reload the page.

    ## Go live

    Fifteen minutes before the start time, two things happen together:

    1. The **▶ Go live** button on your webinar page unlocks. Until then it is greyed out, with a note saying when it opens.
    2. Registrants can come in. Anyone who arrives before you start sees **Waiting for the host to start**, and the stage appears as soon as somebody turns on a camera or shares a screen.

    Press **▶ Go live**. The room opens in a new tab and you land on a device check: choose your **Camera** and **Microphone**, try a **Virtual background** if you like, then press **Join the webinar**.

    > [!WARNING] Go live means live
    > Pressing Go live marks the webinar as live for everyone straight away. If you want a minute to settle, join, keep your camera off and mic muted, and turn them on when you are ready.

    If you close the room tab by accident, go back to the webinar page and press **Rejoin room**.

    ## Find your way around the room

    The bar along the bottom of the room is split into three parts.

    - **On the left**: your microphone (**Mute** / **Unmute**) and camera (**Stop video** / **Start video**).
    - **In the middle**: **Share** to share your screen, **Record**, **Chat**, **Q&A**, **Polls**, **Participants** and **React**, then **More**. **Invite**, **Layout**, **Settings**, **Host tools** and **Captions** start under **More**. Drag any of them onto the bar to keep it there.
    - **On the right**: **Leave**.

    On a phone the bar keeps only **Chat** and **React** next to your mic, camera and **Leave**. Everything else, Share and Record included, is under **More**.

    Chat, Q&A, Polls and Participants open in a panel on the right. **Host tools**, under **More**, has the switches for what attendees can do (chat, Q&A, raise hand, reactions, polls), which you can flip at any time.

    Our next guide, [Engage your audience](/blog/engage-your-audience), covers chat, Q&A, polls, quizzes and reactions in detail.

    ## End the webinar

    When you are done, press **Leave**. As the host you get two choices:

    - **Assign host & leave** hands the room to someone else and lets the session carry on.
    - **End webinar for everyone** disconnects everyone and marks the webinar as ended.

    Ending asks you to confirm (**End this webinar for everyone?**), and reminds you that registrations and the attendance record are kept but nobody can rejoin. If you prepared a feedback survey and have not sent it yet, you are offered **Send survey now** first.

    ### After the session

    You are taken to the webinar's **Results** tab, with who registered and who attended. Depending on what is switched on for your account, you will also find:

    - **Recording**, once a cloud recording has finished processing,
    - **AI insights**, with a recap of key points, action items, chapters and top questions (AI is available on request),
    - **Follow up**, to message attendees on WhatsApp (available on request).

    That is a whole webinar. Next time, **Copy webinar** in the **⋯** menu starts a new one with the same settings.
  `,
};
