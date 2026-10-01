/* Tours 7–9: WhatsApp chats, the WhatsApp page, your audience. */

import { anchor, btn, dialog } from "./common.mjs";

export const messages = {
  id: "07-messages",
  title: "Reply to messages",
  warm: ["/host/messages"],
  async run(t, page) {
    await t.goto("/host");
    await t.card(
      { kicker: "WebinarLiv guided tour · 7", title: "Reply to messages", sub: "Every WhatsApp reply, in one inbox" },
      "When people reply on WhatsApp, their messages land in Chats. Let's answer a few.",
    );
    await t.say("Open WhatsApp in the sidebar.", async () => {
      await t.click(anchor(page, "nav-whatsapp"), { settle: 1800 });
    });
    await t.say("Chats is the inbox. The number is how many people are waiting for a reply.", async () => {
      await t.click(anchor(page, "whatsapp-chats"), { settle: 2000 });
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
    await t.say("That's the inbox. Next, metrics, templates and automations.");
  },
};

export const whatsapp = {
  id: "08-whatsapp",
  title: "WhatsApp",
  warm: ["/host/crm", "/host/crm?view=templates", "/host/crm?view=automations"],
  async run(t, page) {
    await t.goto("/host");
    await t.card(
      { kicker: "WebinarLiv guided tour · 8", title: "WhatsApp", sub: "What went out, the wording, and what sends itself" },
      "In this video, we'll look at Metrics, Templates and Automations. Chats was the last one.",
    );
    await t.say("Open WhatsApp from the sidebar. Metrics opens first.", async () => {
      await t.click(anchor(page, "nav-whatsapp"), { settle: 2000 });
      await t.point(page.getByRole("heading", { name: "WhatsApp", exact: true }));
    });
    await t.say("The tiles are what went out: sent, delivered, read, failed, and the cost.", async () => {
      await t.point(page.getByText("Sent", { exact: true }).first());
      await t.point(page.getByText("Delivered", { exact: true }).first());
    });
    await t.say("Search finds a webinar. The date range limits the totals, and which webinars are listed.", async () => {
      await t.point(page.getByRole("searchbox", { name: "Search webinars" }));
      await t.point(btn(page, "Metrics date range"));
    });
    await t.say("Each row is one webinar, with its own sent, delivered, read, failed and cost.", async () => {
      await t.point(btn(page, /^Webinar$/).first());
    });
    await t.say("Templates are the messages Meta has approved. Search the list, or start a new one.", async () => {
      await t.click(anchor(page, "whatsapp-templates"), { settle: 1600 });
      await t.point(page.getByRole("searchbox", { name: "Search templates" }));
    });
    await t.say("New template opens Create Template. Type the wording here. Meta reviews it before it can be sent.", async () => {
      await t.click(btn(page, /^New template$/), { settle: 1400 });
      await t.point(dialog(page).getByRole("heading", { name: "Create Template" }));
    });
    await t.say("We'll close this one without submitting.", async () => {
      await t.click(dialog(page).getByRole("button", { name: /^Close$/ }));
    });
    await t.say("Automations are the messages that go out before a webinar, and after it.", async () => {
      await t.click(anchor(page, "whatsapp-automations"), { settle: 1600 });
      await t.point(page.getByText("Before", { exact: true }));
      await t.point(page.getByText("After", { exact: true }));
    });
    await t.say("Open a message, like the reminder, to change when it sends and what it says.", async () => {
      await t.click(btn(page, /^Reminder/), { settle: 1200 });
    });
    await t.say("That's WhatsApp. Next, your audience.");
  },
};

export const audience = {
  id: "09-audience",
  title: "Your audience",
  warm: ["/host/audience"],
  async run(t, page) {
    await t.goto("/host");
    await t.card(
      { kicker: "WebinarLiv guided tour · 9", title: "Your audience", sub: "Everyone who's come, across every webinar" },
      "Your audience is everyone who has registered for any of your webinars. Let's see who they are.",
    );
    await t.say("Open Audience in the sidebar.", async () => {
      await t.click(anchor(page, "nav-audience"), { settle: 2200 });
    });
    await t.say("The numbers at the top show how many people you've reached, and how many keep coming back.", async () => {
      await t.point(page.getByText("People reached", { exact: true }));
      await t.point(page.getByText("Came back", { exact: true }).first());
    });
    await t.say("The chart compares your webinars side by side, so you can see which topics drew the best crowd.", async () => {
      await t.point(page.getByRole("heading", { name: "Webinar by webinar" }));
    });
    await t.say("Your best people are the ones who come often, and take part. Slipping away shows regulars who have stopped coming.", async () => {
      await t.point(page.getByRole("heading", { name: "Your best people" }));
      await t.point(page.getByRole("heading", { name: "Slipping away" }));
    });
    await t.say("Search by name, email or phone, or narrow the list to one webinar.", async () => {
      await t.point(page.getByRole("searchbox", { name: "Search people" }));
      await t.point(page.getByRole("combobox", { name: "Webinar" }));
    });
    await t.say("Everyone is the full list. Came and Didn't come split who showed up.", async () => {
      await t.point(btn(page, /^Everyone/));
      await t.point(btn(page, /^Came \d/));
      await t.point(btn(page, /^Didn't come/));
    });
    await t.say("Pick people, and message them on WhatsApp in one go. Next, your email inbox.");
  },
};
