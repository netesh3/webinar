import type { Post } from "../../lib/blog.ts";

export const post: Post = {
  slug: "follow-up-by-email-and-whatsapp",
  title: "Follow up by email and WhatsApp",
  description:
    "The confirmation, reminders and replay link your registrants get, how WhatsApp consent works, and how to send each group the right follow-up after a webinar.",
  date: "2026-10-24",
  category: "tutorials",
  tags: ["follow-up", "whatsapp", "email", "reminders", "audience"],
  body: `
    Most of the work of a webinar happens around it: making sure people turn up, and following up while they still remember you. This guide covers the messages that go out on their own, and the follow-ups you send yourself after the session.

    > [!NOTE] What is switched on per account
    > Confirmation and reminder emails work for every host. WhatsApp messaging, the replay message and AI follow-up drafts are switched on per account by our team, so ask us if you need them. AI features are off by default for every host.

    ## Before the session: confirmation and reminders

    When you schedule a webinar, its **Messages & follow-ups** step lists every message it sends. You can change them later from the webinar's **Setup** tab, under **Messages & follow-ups**; changes there apply to that webinar only.

    - **Confirmation** goes when someone registers. The email has their personal join link (with a reminder not to forward it) and a calendar file.
    - **Reminder** goes before the start, at the times you choose. It has the join link and the calendar file again.

    Both are on, by email, from the start. Each message has an **Email** and a **WhatsApp** tab, with **Send on Email** and **Send on WhatsApp** switches and a preview of how it will look. Tick **Use this for all my webinars** to make your wording the default.

    ### Reminder times

    Under **Reminder times** the default is one day and one hour before the start. You can have up to three. Each one is an amount and minutes, hours or days **before it starts**, from one minute to 30 days. Press **+ Add a reminder** for another.

    The same times are used for email and WhatsApp. Someone who registers after a reminder's time does not get that one; everyone still gets their confirmation.

    > [!TIP] Approval
    > If you approve registrations by hand, people get **Registration approved** or **Registration declined** emails instead of going straight to a confirmation. See [Schedule and run your first webinar](/blog/schedule-and-run-your-first-webinar).

    ## WhatsApp: consent comes first

    WhatsApp messages go from your own WhatsApp Business number, which you connect in your account settings. They use templates approved by Meta and are billed to your Meta account.

    Nobody gets WhatsApp messages without agreeing to them. When WhatsApp is set up, the registration form has a checkbox: "Send me updates on WhatsApp: a confirmation, a reminder before it starts with a one-tap Join, and the replay if I miss it. Reply STOP at any time." It only counts if they also give a phone number.

    A WhatsApp confirmation, reminder or replay goes to someone only when all of these are true: your number is connected, that message's WhatsApp channel is on with an approved template picked, and they opted in with a phone number.

    Anyone can reply **STOP** (or UNSUBSCRIBE, STOP ALL, OPT OUT) at any time. They are marked as opted out straight away, and nothing more goes to them on WhatsApp.

    ## After the session: the replay

    When the recording is ready, open the webinar's **Recording** tab and choose to share it. In **Share Recording**, switch on **Enable public viewing** and press **Save Settings**. Before you save, a note tells you what will happen: everyone who registered gets an email with a link to watch it back, and those who opted in on WhatsApp get a WhatsApp message too. That includes people who did not turn up.

    It happens once per person. Making the recording private and public again sends nothing new. [Recordings and retention](/blog/recordings-and-retention) covers sharing and passcodes.

    > [!NOTE] Available on request
    > The replay message is part of the WhatsApp CRM tools, which are switched on per account. Without them, publishing a recording does not send anything.

    ## The Follow up tab: a message for each group

    If WhatsApp is set up, an ended webinar has a **Follow up** tab (meetings do not). Under **Who to message**, everyone who registered lands in one group by how they took part:

    | Group | Engagement score | Suggested |
    |---|---|---|
    | **Highly engaged** | 75 and up | Send the offer while interest is hot |
    | **Engaged** | 50 to 74 | Thank them and share the replay and your offer |
    | **Passive** | 25 to 49 | Share the replay with the moment worth rewatching |
    | **At risk** | Under 25 | They left early: send the replay from where they dropped |
    | **No-shows** | Never joined | "We missed you" with the replay link |

    The engagement score is out of 100, from how long each person watched and how much they took part: polls, quizzes, chat, questions, reactions, raised hands and the survey.

    Each card shows how many people are in the group and how many of them you can reach on WhatsApp. Press **Review & send** to open the message:

    1. **Who gets it** shows the count, including anyone who opted out.
    2. **Message** lets you pick one of your approved templates.
    3. **When**: **Now**, **Tomorrow 9 AM** or **Pick a time**.
    4. Step through the preview to see each person's message, and use **Send a test to my phone** if you want to see it for real.
    5. Press **Send to** followed by the number of people.

    Switch on **After every webinar** on a card to send that group the same follow-up automatically after each session, an hour, two hours or a day after it ends.

    Replies land in your WhatsApp chats, and **What was sent, and replies** at the bottom of the tab shows how each message did.

    ## AI follow-ups, by email or WhatsApp

    If AI is switched on for your account, the **AI insights** tab has a **Follow-up writer**. It sits under **Hot leads**, the people who stayed, asked and chatted the most, and drafts a message for each of four groups: **Hot leads**, **Attended**, **Left early** and **Didn't join**, in English or Hinglish. Each draft has an **Email subject**, an **Email** and a **WhatsApp** version, and you can use \`{{first_name}}\` and \`{{replay_link}}\` in them. Edit them and press **Save draft**.

    You can always copy a draft or download the group as a CSV and send it from your own tools. If sending follow-ups is also switched on for your account, you can send from here:

    1. Pick the people in the group, or **Select all**, and press **Send to selected**.
    2. **Review and send follow-ups** lists every message. Edit any of them, switch a person between **Email** and **WhatsApp**, or remove them. Nothing goes until you press Send.
    3. Press **Send** followed by the number of messages.

    Emails are sent from your name, and replies come to you. An unsubscribe line is added at the end, and someone who unsubscribes gets no more follow-up emails from you. WhatsApp follow-ups go only to people who opted in. People who have already had a message are skipped unless you tick **Send again to people who already had it**.

    Only the webinar's own host can send from here, not co-hosts.

    ## Next

    - See who keeps coming back in [Your audience](/blog/your-audience).
    - Read the session's [AI recap](/blog/ai-recap-and-insights) before you write your follow-up.
  `,
};
