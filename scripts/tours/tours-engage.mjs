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
    await t.say("That's the inbox. Next, let's make WhatsApp work for you on its own.");
  },
};

export const whatsapp = {
  id: "08-whatsapp",
  title: "WhatsApp and automations",
  warm: ["/host/crm"],
  async run(t, page) {
    await t.goto("/host");
    await t.card(
      { kicker: "WebinarLiv guided tour · 8", title: "WhatsApp and automations", sub: "Reminders, replays and rules that run on their own" },
      "In this video, we'll look at your WhatsApp page, and set up an automation.",
    );
    await t.say("Open your account menu, and choose WhatsApp.", async () => {
      await t.click(btn(page, /^Your account/), { settle: 1000 });
      await t.click(page.getByRole("menuitem", { name: /WhatsApp/ }).or(link(page, /^WhatsApp/)).first(), { settle: 2000 });
    });
    await t.say("At the top, you can see your number is connected. Messages come from your own WhatsApp Business number.", async () => {
      await t.point(page.getByText(/^Connected/).first());
    });
    await t.say("Sent to everyone who registers are the messages that go out on their own: a confirmation, a reminder, and the replay.", async () => {
      await t.point(page.getByRole("heading", { name: "Sent to everyone who registers" }));
    });
    await t.say("Click Edit to change the wording. Pick a message, and see it on the phone before you save.", async () => {
      await t.click(btn(page, /^Edit$/).nth(1), { settle: 1800 });
      await t.point(dialog(page).getByRole("radio").first());
    });
    await t.say("You can even send a test to your own number.", async () => {
      await t.point(dialog(page).getByRole("button", { name: /^Test$/ }));
      await t.click(dialog(page).getByRole("button", { name: /^Cancel$/ }));
    });
    await t.say("Below are your automations. Each one reads like a sentence, and has an on and off switch.", async () => {
      await t.point(page.getByRole("heading", { name: "Automations" }));
    });
    await t.say("For example, when a reply mentions price, or your program, the person is tagged as a Hot lead.", async () => {
      await t.point(page.getByText(/mentions price/).first());
    });
    await t.say("To write your own, click New automation.", async () => {
      await t.click(btn(page, /New automation/), { settle: 1600 });
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
