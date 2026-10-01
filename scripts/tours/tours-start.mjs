/* Tours 1–2: getting around, and scheduling a webinar. */

import { anchor, btn, link, tab } from "./common.mjs";

export const home = {
  id: "01-home",
  title: "Your webinars",
  warm: ["/host"],
  async run(t, page) {
    await t.goto("/host");
    await t.card(
      {
        kicker: "WebinarLiv guided tour · 1",
        title: "Your webinars",
        sub: "The sidebar, then the list",
      },
      "Welcome to WebinarLiv. The sidebar is how you move around. Webinars is where every session you host lives.",
    );
    await t.say("Webinars is this page.", async () => {
      await t.point(anchor(page, "nav-webinars"));
    });
    await t.say("Audience is everyone who has registered, on its own page. It has its own video.", async () => {
      await t.point(anchor(page, "nav-audience"));
    });
    await t.say(
      "Integrations folds open. WhatsApp is your number, chats, templates and automations.",
      async () => {
        await t.point(anchor(page, "nav-whatsapp"));
      },
    );
    await t.say("Email is replies, and mail sent on your behalf.", async () => {
      await t.point(anchor(page, "nav-email"));
    });
    await t.say(
      "Up top are the two ways to start. Instant webinar takes you live right now, with no form to fill in.",
      async () => {
        await t.point(btn(page, /Instant webinar/));
      },
    );
    await t.say(
      "Schedule a webinar lets you pick a date, and invite people ahead of time. We'll cover that in the next video.",
      async () => {
        await t.point(link(page, /Schedule a webinar/));
      },
    );
    await t.say("Below that, webinars are grouped into tabs. Upcoming shows what's on the calendar.", async () => {
      await t.click(tab(page, /^Upcoming/));
    });
    await t.say(
      "Copy link shares it. The title opens the webinar.",
      async () => {
        await t.point(btn(page, /^Copy link$/));
        await t.point(anchor(page, "webinar-title").first());
      },
    );
    await t.say("Everything else, like editing or deleting, sits behind the three dots.", async () => {
      await t.click(btn(page, /^More for/), { settle: 1400 });
      await t.key("Escape");
    });
    await t.say("Completed holds webinars that have already happened, with their results and recordings.", async () => {
      await t.click(tab(page, /^Completed/));
    });
    await t.say("Drafts are webinars you started, but haven't scheduled yet.", async () => {
      await t.click(tab(page, /^Drafts/));
    });
    await t.say(
      "Attending joins this row only when you've registered for a webinar someone else is hosting.",
      async () => {
        await t.point(page.getByRole("tablist"));
      },
    );
    await t.say(
      "When a webinar ends, a Follow up card appears on Upcoming, so you don't forget to message the people who came.",
      async () => {
        await t.click(tab(page, /^Upcoming/));
        await t.point(link(page, /^Follow up$/));
      },
    );
    await t.say("Notifications sit at the bottom of the sidebar. New registrations show up there.", async () => {
      await t.click(btn(page, /^Notifications/), { settle: 1200 });
      await t.click(btn(page, /^Notifications/), { settle: 400 });
    });
    await t.say(
      "Your account menu is there too. Settings holds your profile, appearance and integrations.",
      async () => {
        await t.click(btn(page, /^Your account/), { settle: 1400 });
        await t.point(page.getByRole("menuitem", { name: /^Settings$/ }));
        await t.key("Escape");
      },
    );
    await t.say("That's your webinars. Next, let's schedule one.");
  },
};

export const create = {
  id: "02-schedule",
  title: "Schedule a webinar",
  warm: ["/host", "/host/new"],
  async run(t, page) {
    await t.goto("/host");
    await t.card(
      {
        kicker: "WebinarLiv guided tour · 2",
        title: "Schedule a webinar",
        sub: "Title, date, cover — and you're done",
      },
      "In this video, we'll schedule a webinar. It takes about a minute.",
    );
    await t.say("From your webinars, click Schedule a webinar.", async () => {
      await t.click(link(page, /Schedule a webinar/), { settle: 1800 });
    });
    await t.say(
      "Start with the topic. This is the title people see on the invite and the registration page.",
      async () => {
        await t.type(
          page.getByPlaceholder("What is this webinar called?"),
          "Stress-free mornings in 30 days",
        );
      },
    );
    await t.say("Add a one-line summary, to tell people why they should come.", async () => {
      await t.type(
        page.getByLabel("One-line summary"),
        "A simple routine you can start tomorrow",
      );
    });
    await t.say(
      "Add a description if you want the full story on the registration page. It's optional.",
      async () => {
        await t.point(page.getByLabel(/^Description/));
      },
    );
    await t.say(
      "Then add a cover image. Drag one in, or click to upload. It shows on your page, and on WhatsApp messages.",
      async () => {
        await t.point(btn(page, /Upload a webinar cover image/));
        await page
          .locator("input[type=file]")
          .first()
          .setInputFiles("web/public/backgrounds/sage.jpg");
        await t.wait(1200);
      },
    );
    await t.say("Now pick when it starts, how long it runs, and the time zone. The zone is filled in for you.", async () => {
      await t.point(page.getByLabel("Date and start time"));
      await t.point(page.getByLabel("Duration"));
      await t.point(page.getByLabel("Time zone"));
    });
    await t.say(
      "Registration, the room and feedback are all on this step. Registration decides who can join — approval, a seat cap, or your own questions.",
      async () => {
        await t.point(page.getByRole("heading", { name: "Who can join" }));
      },
    );
    await t.say("In the room, you choose chat, Q and A, reactions, and whether to record automatically.", async () => {
      await t.point(page.getByRole("heading", { name: "How the session starts" }));
    });
    await t.say(
      "And further down, you can ask for feedback, with a short survey that pops up when you put it on screen.",
      async () => {
        await t.point(page.getByRole("heading", { name: "Feedback survey" }));
      },
    );
    await t.say(
      "Then click Next for step two, messages and follow-ups. Each message — confirmation, reminder, replay, follow-up — has its own channels and time.",
      async () => {
        await t.click(btn(page, /^Next: Messages & follow-ups/), { settle: 1200 });
        await t.point(page.getByText("Reminder", { exact: true }));
        await t.point(page.getByText("Before", { exact: true }));
      },
    );
    await t.say("When you're ready, click Schedule. Or save it as a draft and finish later.", async () => {
      await t.point(btn(page, /^Save as draft$/));
      await t.point(btn(page, /^Schedule$/));
    });
    await t.say("Your webinar is now live on its own page, ready to share. Next, we'll invite people.");
  },
};
