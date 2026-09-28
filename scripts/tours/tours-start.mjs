/* Tours 1–2: getting around, and scheduling a webinar. */

import { btn, link, tab } from "./common.mjs";

export const home = {
  id: "01-home",
  title: "Your home page",
  warm: ["/host"],
  async run(t, page) {
    await t.goto("/host");
    await t.card(
      { kicker: "WebinarLiv guided tour · 1", title: "Your home page", sub: "Everything you host, in one place" },
      "Welcome to WebinarLiv. Let's start with your home page, where every webinar you host lives.",
    );
    await t.say("Up top are the two ways to start. Instant webinar takes you live right now, with no form to fill in.", async () => {
      await t.point(btn(page, /Instant webinar/));
    });
    await t.say("Schedule a webinar lets you pick a date, and invite people ahead of time. We'll cover that in the next video.", async () => {
      await t.point(link(page, /Schedule a webinar/));
    });
    await t.say("Below that, your webinars are grouped into tabs. Upcoming shows what's on the calendar.", async () => {
      await t.click(tab(page, /^Upcoming/));
    });
    await t.say("Every card has the two things you need most. Copy link, to share it anywhere, and Manage, to open the webinar.", async () => {
      await t.point(btn(page, /^Copy link$/));
      await t.point(link(page, /^Manage$/));
    });
    await t.say("Everything else, like duplicating or cancelling, sits behind the three dots.", async () => {
      await t.click(btn(page, /^More for/), { settle: 1400 });
      await t.key("Escape");
    });
    await t.say("Completed holds webinars that have already happened, with their results and recordings.", async () => {
      await t.click(tab(page, /^Completed/));
    });
    await t.say("Drafts are webinars you started, but haven't scheduled yet.", async () => {
      await t.click(tab(page, /^Drafts/));
    });
    await t.say("Audience shows everyone who has ever registered, across all your webinars. It has its own video.", async () => {
      await t.click(tab(page, /^Audience/), { settle: 1500 });
    });
    await t.say("When a webinar ends, a Follow up card appears here, so you never forget to message the people who came.", async () => {
      await t.click(tab(page, /^Upcoming/));
      await t.point(link(page, /^Follow up$/));
    });
    await t.say("The chat icon opens your WhatsApp messages, and shows how many replies are waiting.", async () => {
      await t.point(link(page, /^Messages/));
    });
    await t.say("The bell shows new registrations and other updates.", async () => {
      await t.click(btn(page, /^Notifications/), { settle: 1500 });
      await t.key("Escape");
    });
    await t.say("And your account menu has your settings.", async () => {
      await t.click(btn(page, /^Your account/), { settle: 1500 });
      await t.key("Escape");
    });
    await t.say("That's the home page. Next, let's schedule a webinar.");
  },
};

export const create = {
  id: "02-schedule",
  title: "Schedule a webinar",
  warm: ["/host", "/host/new"],
  async run(t, page) {
    await t.goto("/host");
    await t.card(
      { kicker: "WebinarLiv guided tour · 2", title: "Schedule a webinar", sub: "Title, date, cover — and you're done" },
      "In this video, we'll schedule a webinar. It takes about a minute.",
    );
    await t.say("From your home page, click Schedule a webinar.", async () => {
      await t.click(link(page, /Schedule a webinar/), { settle: 1800 });
    });
    await t.say("Start with the topic. This is the title people see on the invite and the registration page.", async () => {
      await t.type(page.getByPlaceholder("What is this webinar called?"), "Stress-free mornings in 30 days");
    });
    await t.say("Add a one-line summary, to tell people why they should come.", async () => {
      await t.type(page.getByLabel("One-line summary"), "A simple routine you can start tomorrow");
    });
    await t.say("Then add a cover image. Drag one in, or click to upload. It shows on your page, and on WhatsApp messages.", async () => {
      await t.point(btn(page, /Upload a webinar cover image/));
      await page.locator('input[type=file]').first().setInputFiles("web/public/backgrounds/sage.jpg");
      await t.wait(1200);
    });
    await t.say("Now pick the date, the start time, and how long it runs. The time zone is filled in for you.", async () => {
      await t.point(page.getByLabel("Date"));
      await t.point(page.getByLabel("Start time"));
      await t.point(page.getByLabel("Duration"));
    });
    await t.say("That's all you need. Registration, reminders and the room are already set up for you, summarised here.", async () => {
      await t.point(page.getByRole("heading", { name: "Registration, reminders and the room" }));
    });
    await t.say("Click any of them to change it, or click Show all settings to see everything.", async () => {
      await t.click(btn(page, /^Show all settings/), { settle: 1200 });
    });
    await t.say("Registration decides who can join. You can require approval, cap the number of seats, or add your own questions.", async () => {
      await t.point(page.getByRole("heading", { name: "Who can join" }));
    });
    await t.say("Reminders go out by email, and by WhatsApp if it's connected. You can add, remove or change each reminder time.", async () => {
      await t.point(page.getByRole("heading", { name: "Reminders", exact: true }).last());
    });
    await t.say("In the room, you choose chat, Q and A, reactions, and whether to record automatically.", async () => {
      await t.point(page.getByRole("heading", { name: "How the session starts" }));
    });
    await t.say("And you can ask for feedback, with a short survey that pops up when the webinar ends.", async () => {
      await t.point(page.getByRole("heading", { name: "Feedback survey" }));
    });
    await t.say("When you're ready, click Schedule. Or save it as a draft and finish later.", async () => {
      await t.point(btn(page, /^Save as draft$/));
      await t.point(btn(page, /^Schedule$/));
    });
    await t.say("Your webinar is now live on its own page, ready to share. Next, we'll invite people.");
  },
};
