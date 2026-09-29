/* Tours 7–9: replying on WhatsApp, automations, your audience. */

import { btn, dialog, link, tab } from "./common.mjs";

export const messages = {
  id: "07-messages",
  title: "Reply to messages",
  warm: ["/host?tab=messages"],
  async run(t, page) {
    await t.goto("/host");
    await t.card(
      { kicker: "WebinarLiv guided tour · 7", title: "Reply to messages", sub: "Every WhatsApp reply, in one inbox" },
      "When people reply on WhatsApp, their messages land here. Let's answer a few.",
    );
    await t.say("Click the chat icon at the top. The number is how many people are waiting for a reply.", async () => {
      await t.click(link(page, /^Messages/), { settle: 2000 });
    });
    await t.say("Needs reply shows only the conversations waiting on you. Hot leads are people who asked about price or your program.", async () => {
      await t.point(btn(page, /^Needs reply/));
      await t.point(btn(page, /^Hot leads/));
    });
    await t.say("Open a conversation to read it.", async () => {
      await t.click(btn(page, /Rahul Verma/), { settle: 1600 });
    });
    await t.say("Type your reply at the bottom, and press Send. Saved quick replies sit just above, for answers you give often.", async () => {
      await t.point(btn(page, /^Send$/));
    });
    await t.say("On the side, you can tag people, like Hot lead, and keep private notes about them.", async () => {
      await t.point(btn(page, /^Add a tag$/));
      await t.point(page.getByLabel("New note"));
    });
    await t.say("Not ready to answer? Snooze it, and it comes back later. When you're finished, mark it Done.", async () => {
      await t.point(btn(page, /^Snooze$/));
      await t.point(btn(page, /^Done$/));
    });
    await t.say("And if you like the keyboard, press the question mark to see shortcuts: J and K to move, E for done, S to snooze.", async () => {
      await t.click(btn(page, /Keyboard shortcuts/), { settle: 1800 });
      await t.key("Escape");
    });
    await t.say("That's the inbox. Next, let's set up automations.");
  },
};

export const whatsapp = {
  id: "08-whatsapp",
  title: "WhatsApp and automations",
  warm: ["/host/crm"],
  async run(t, page) {
    await t.goto("/host");
    await t.card(
      { kicker: "WebinarLiv guided tour · 8", title: "WhatsApp and automations", sub: "Reminders, replays and automations that run for you" },
      "In this video, we'll look at your WhatsApp page, and set up an automation.",
    );
    await t.say("Open Settings, then Integrations. WhatsApp is one of the apps.", async () => {
      await t.goto("/settings#integrations");
      await t.point(page.getByRole("heading", { name: "Integrations" }));
      await t.point(page.getByRole("heading", { name: "WhatsApp Business" }).or(page.getByText("WhatsApp Business").first()));
    });
    await t.say("Manage opens the WhatsApp page. Messages come from your own business number.", async () => {
      await t.click(link(page, /^Manage$/).or(page.getByRole("link", { name: /WhatsApp/ })).first(), { settle: 2000 });
      await t.point(page.getByRole("heading", { name: "WhatsApp", exact: true }));
      await t.point(page.getByText(/^Connected/).or(page.getByText("Not connected")).first());
    });
    await t.say("The numbers at the top are what went out: sent, delivered, read, failed, and what Meta charged.", async () => {
      await t.point(page.getByRole("group", { name: "Period" }));
    });
    await t.say("What goes out automatically is split into before the webinar and after it. Confirmation, the reminder, the replay, and each follow-up.", async () => {
      await t.point(page.getByRole("heading", { name: "What goes out automatically" }));
      await t.point(page.getByText("Before the webinar", { exact: true }));
    });
    await t.say("Click Edit to change the wording. Pick a message, and see it before you save.", async () => {
      await t.click(btn(page, /^Edit$/).first(), { settle: 1800 });
      await t.point(dialog(page).getByRole("heading", { name: /^Edit / }));
      await t.click(dialog(page).getByRole("button", { name: /^Cancel$/ }));
    });
    await t.say("Settings on this page goes back to Integrations.", async () => {
      await t.point(link(page, /^Settings$/));
    });
    await t.say("Automatic replies run when someone writes back. Each one is a sentence with a switch.", async () => {
      await t.point(page.getByRole("heading", { name: "Automatic replies" }));
    });
    await t.say("Add an automatic reply to write your own.", async () => {
      await t.click(btn(page, /Add an automatic reply/), { settle: 1600 });
    });
    await t.say("First, pick the When. Let's say, when someone answers a poll.", async () => {
      await t.click(dialog(page).getByRole("button", { name: "answers a poll" }));
    });
    await t.say("Type the poll question, and the answer to look for.", async () => {
      await t.type(dialog(page).getByPlaceholder(/poll's question/), "Want 1:1 coaching?");
      await t.type(dialog(page).getByPlaceholder(/^Answer/), "Yes");
    });
    await t.say("Then add what should happen. Wait, send a message, tag them, or tell you. Let's tag them.", async () => {
      await t.click(dialog(page).getByRole("button", { name: /^Tag them$/ }), { settle: 1200 });
    });
    await t.say("Click Turn on, and it runs for every webinar from now on. We'll cancel this one.", async () => {
      await t.point(dialog(page).getByRole("button", { name: /^Turn on$/ }));
      await t.click(dialog(page).getByRole("button", { name: /^Cancel$/ }));
    });
    await t.say("That's WhatsApp. Last up, your audience.");
  },
};

export const audience = {
  id: "09-audience",
  title: "Your audience",
  warm: ["/host"],
  async run(t, page) {
    await t.goto("/host");
    await t.card(
      { kicker: "WebinarLiv guided tour · 9", title: "Your audience", sub: "Everyone who's come, across every webinar" },
      "Your audience is everyone who has registered for any of your webinars. Let's see who they are.",
    );
    await t.say("On your home page, open the Audience tab.", async () => {
      await t.click(tab(page, /^Audience/), { settle: 2200 });
    });
    await t.say("The numbers at the top show how many people you've reached, and how many keep coming back.", async () => {
      await t.wait(600);
    });
    await t.say("The chart compares your webinars side by side, so you can see which topics drew the best crowd.", async () => {
      await t.scroll(350);
    });
    await t.say("Your best people are the ones who come often, and take part. Slipping away shows regulars who have stopped coming.", async () => {
      await t.scroll(350);
    });
    await t.say("Below is everyone, with how many webinars they came to, and how engaged they were. Filter it to find exactly who you need.", async () => {
      await t.scroll(500);
    });
    await t.say("Pick people, and message them on WhatsApp in one go. Thanks for watching, and happy hosting with WebinarLiv.", async () => {
      await t.wait(400);
    });
  },
};
