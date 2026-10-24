import type { Post } from "../../lib/blog.ts";

export const post: Post = {
  slug: "your-audience",
  title: "Get to know your audience",
  description:
    "Everyone who registered for any of your webinars, in one list: who keeps coming back, who is slipping away, how to message them, and how to export them.",
  date: "2026-10-24",
  category: "tutorials",
  tags: ["audience", "crm", "whatsapp", "follow-up", "exports"],
  body: `
    Every webinar brings you people. Over a few sessions, some come back again and again, and some register every time and never turn up. The **Audience** page puts everyone in one list, so you can see who is who and message the right people.

    ## Open Audience

    Choose **Audience** in the sidebar. Everyone who registers for one of your webinars appears here once, however many webinars they have registered for. People who wrote to your WhatsApp number without registering are listed too, marked **Not registered yet**.

    ## The summary

    At the top, **Across your last** 6 webinars (switch to **Last 12** or **All**) gives you four numbers:

    | | |
    |---|---|
    | **People reached** | Everyone who registered, and how many came this month |
    | **Show-up rate** | The share of those who registered who joined |
    | **Avg engagement** | The average engagement score, out of 100 |
    | **Came back** | People who joined two or more webinars |

    **Webinar by webinar** charts each session's show-up rate and engagement side by side. Click a bar to open that webinar's results.

    Two short lists sit beside it:

    - **Your best people**: they came to two or more and took part.
    - **Slipping away**: they registered for two or more and never came.

    Press **See all** on either to filter the list to them.

    ## The list

    Each row shows the **Person** (name, phone and email, and a **Replied** tag if they have ever written back on WhatsApp), their **Attendance** ("Came to 3 of 4", "Didn't come"), their average **Engagement** with a word for it (**Highly engaged**, **Engaged**, **Passive** or **At risk**), and their **Last webinar**. Click a column heading to sort by it.

    Use **Search name, email or phone** to find someone, or narrow the list:

    - The webinar menu: **All webinars**, or one webinar. With one picked, the attendance column shows whether each person came to that one and how long they watched.
    - The chips: **Everyone**, **Came**, **Didn't come**, **Replied**, and, when there is anyone in them, **Highly engaged**, **Came back**, **Slipping away** and **Hot leads**.

    The engagement score comes from how long each person watched and how much they took part. [Follow up by email and WhatsApp](/blog/follow-up-by-email-and-whatsapp) explains the groups it puts people in.

    ## Message people on WhatsApp

    If you have connected a WhatsApp Business number, you can message straight from the list. Tick the people you want and press **Message** with the number picked, or press **Message all** to message everyone the list shows. Each row also has its own **Message** button. People you cannot reach say why: **No phone number**, **Opted out** or **Not opted in**.

    Without a connected number you will see **Follow up on WhatsApp** with **Connect WhatsApp**, which takes you to your settings.

    Clicking a person's name opens your WhatsApp conversation with them.

    > [!NOTE] Available on request
    > WhatsApp messaging, broadcasts and saved lists are part of WhatsApp CRM, which is switched on per account. The Audience list, its summary and the exports below work for every host.

    ### Broadcasts and saved lists

    For a message to many people at once, choose **WhatsApp** under **Integrations** in the sidebar (it appears once your number is connected), open the **Broadcasts** tab, then **New broadcast**. You choose **Who** (for example everyone who opted in, the people who came or did not come, or those registered for one webinar), the **Message** from your approved templates, and **When**: **Send now** or **Schedule**. A broadcast only reaches people who opted in.

    To message people from outside Webinar Liv, upload a CSV with a phone number per person under **Saved lists** on the Audience page. You can then send a broadcast to that list.

    ## Export your people

    The Audience page itself does not export. Each webinar does:

    - **Before and during a webinar**: the **People** tab has **Export CSV**, with each registrant's name, email, phone, company, job title, when they registered and their answers to your registration questions.
    - **After a webinar**: the **Results** tab has an **Attendee list** card. Choose **Attended only** or **All registrants** and press **Export attendees (CSV)**. Along with their details, you get when each person joined and left, how many minutes they watched, and how many questions, chat messages and poll answers they gave.
    - **With AI switched on**: the **AI insights** tab's **Hot leads** card has **Export CSV**, ranked by lead score, with a short reason for each.

    ## Next

    - Send each group the right follow-up: [Follow up by email and WhatsApp](/blog/follow-up-by-email-and-whatsapp).
    - Bring people back with your next session: [Schedule and run your first webinar](/blog/schedule-and-run-your-first-webinar).
  `,
};
