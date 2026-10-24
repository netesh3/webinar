import type { Post } from "../../lib/blog.ts";

export const post: Post = {
  slug: "engage-your-audience",
  title: "Engage your audience: chat, Q&A, polls, quizzes and reactions",
  description:
    "How to use chat, Q&A, polls, quizzes, reactions and raised hands in a Webinar Liv room, from the host's side and the attendee's.",
  date: "2026-10-24",
  category: "tutorials",
  tags: ["engagement", "chat", "qa", "polls", "host-room"],
  body: `
    A webinar is more fun, and more useful, when the audience takes part. Webinar Liv rooms come with chat, Q&A, polls, quizzes, reactions and raised hands. This guide shows how each one works, what you can control as the host, and what your attendees see.

    ## Where the tools are

    Everything is on the bar at the bottom of the room: **Chat**, **Q&A**, **Polls**, **Participants**, **React** and **Raise hand**. On a phone only **Chat** and **React** stay on the bar, and the rest move under **More**.

    Chat, Q&A, Polls and Participants open in a panel on the right of the video. You can pop the panel out into its own window (handy for a second screen), float it over the video, or close it with Esc.

    ### Turning things on and off

    You choose the starting point when you schedule the webinar, under **In the room** → **How the session starts**: **Attendee chat**, **Q&A**, **Reactions** and **Raise hand**. All of them are on by default.

    During the session, open **Host tools** → **More options**. Under **What attendees can do** you can switch **Chat**, **Q&A**, **Raise hand**, **Reactions** and **Polls and quizzes** on or off at any moment. Turning something off never deletes what is already there; for example, existing questions stay visible when Q&A is closed.

    ## Chat

    Anyone can type in **Chat**, paste a screenshot or attach an image, and @mention someone. Messages can be up to 2,000 characters, and links are clickable.

    ### Who can chat with whom

    At the top of the chat panel, the host sees an **Attendee chat** control with three settings:

    | Setting | What it means |
    |---|---|
    | **Everyone** | Attendees can message everyone in the webinar. |
    | **Panelists** | Attendees can only message you and the panelists. |
    | **Off** | Chat is off for attendees. You and panelists can still chat. |

    When chat is off, attendees see **Chat is off** and can still read earlier messages.

    As the host or a panelist, you can also choose who your own message goes to. Set **To** to **Panelists** for a backstage note that attendees will not see, or **Everyone** for the whole room.

    ### Removing messages

    Next to each attendee message, the host and panelists have a bin icon (**Delete message**). It is removed for everyone, including people who join later, and it cannot be undone.

    > [!TIP] Spam is caught for you
    > Possible spam is flagged in the chat panel for you and your co-hosts only. From a flag you can **Delete** the message, **Remove person**, **Mute chat** for that person, or mark it **Not spam**. You can also auto-hide high-confidence spam and choose whether attendees may post links. The basic rules always run; the extra AI check only runs when AI is switched on for your account (available on request).

    ## Q&A

    Q&A keeps questions separate from the chatter, so none get lost.

    ### For attendees

    Attendees type in **Ask a question…** and press Enter. They can tick **Ask anonymously**, in which case the question shows as **Anonymous** to everyone, including you. Everyone can upvote a question once, and the most-voted open questions rise to the top.

    ### For the host

    Questions are split into **Open** and **Answered**. For each one you can:

    - **Write an answer** and press **Send answer** to reply in text,
    - **Mark answered** if you answered it out loud,
    - **Pin** it to keep it at the top,
    - **Hide** it from attendees (you still see it, tagged **Hidden**).

    > [!NOTE] AI help with questions
    > With AI switched on for your account, the host team also gets **Top questions**, similar questions grouped together, and **Suggest an answer**, which drafts a reply only hosts can see until you post it. AI features are off by default and available on request.

    ## Polls

    A poll asks the room a question with a set of answers. It pops up in the middle of every attendee's screen, which makes it the quickest way to get everyone involved.

    ### Prepare polls before the session

    When you schedule or edit the webinar, the **Live polls** section lets you write polls ahead of time with **Add poll** or **Add quiz**. In the room you only press **Launch**, with no typing mid-session.

    ### Create and launch one live

    Open **Polls** and press **New poll or quiz**. Choose **Poll**, write the question, and add between 2 and 10 options. Then press **Launch now**, or **Save as draft** to launch later.

    Only one question is live at a time; launching a new one closes the current one. The panel groups your polls into **Live**, **Drafts** and **Closed**. While a poll is live, you see the results update every few seconds.

    When you have enough answers, press **Close voting**. You can **Reopen** a closed poll (earlier votes are kept) or **Duplicate** it.

    ### What attendees see

    Attendees get a pop-up with the question, choose one answer, and press **Submit answer**, or **Answer later** to deal with it from the Polls panel. Each person answers once and cannot change their answer.

    > [!WARNING] Results stay with you
    > Attendees never see the vote counts, so nobody is swayed by which way the room is going. If you want to share the results, read them out or share your screen. Polls are single choice: each person picks one answer.

    ## Quizzes

    A quiz is a poll with a right answer. In the composer choose **Quiz**, write the question and options, then tap a letter to mark the correct answer.

    While voting is open, attendees see **Your answer is in. The right answer is revealed when voting closes.** When you press **Close voting**, each person sees whether they got it right, and you see what share of the room did ("N% got it right"). Quizzes have no scores or leaderboard; each one stands on its own.

    ## Reactions

    Press **React** and pick one of six emoji: 👏 👍 ❤️ 😂 🎉 😮. Reactions are anonymous and float up the right-hand side of the video, so you can feel the room without anyone being singled out. For people who prefer reduced motion, they fade in place instead.

    To keep a big room calm, each tap shows a short burst rather than an endless stream, and there is a cap on how many can be on screen at once.

    ## Raised hands

    When **Raise hand** is on, attendees can press it to ask to speak. You get a notice ("wants to speak") with **Allow to speak**, **Lower hand** or **View**. The **Raised hands** list shows everyone waiting, with **Invite to speak**, **Lower hand** and **Message** for each person, and **Lower all** to clear the list.

    Inviting someone sends them a request; they join the stage once they accept.

    ## A simple plan for your first session

    1. Before the session, write two or three polls and one quiz under **Live polls**.
    2. In the first five minutes, launch a quick poll ("Where are you joining from?") to get everyone clicking.
    3. Keep **Q&A** open throughout, and spend the last ten minutes on the top-voted questions.
    4. Use a quiz near the end to check what stuck.
    5. Ask a co-host or panelist to keep an eye on chat, so you can focus on presenting.

    Want to run the same session again without presenting it live? See [Turn a recording into a Simulive](/blog/turn-a-recording-into-a-simulive).
  `,
};
