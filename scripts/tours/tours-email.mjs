/* Tours 10–11: the email inbox, and the host's @webinarliv.com address. */

import { anchor, btn } from "./common.mjs";

export const email = {
  id: "10-email",
  title: "Email inbox",
  warm: ["/host/email"],
  async run(t, page) {
    await t.goto("/host");
    await t.card(
      { kicker: "WebinarLiv guided tour · 10", title: "Email inbox", sub: "Replies, and mail sent for you" },
      "Email sits next to WhatsApp. Replies land here, and so does mail sent on your behalf.",
    );
    await t.say("Open Email in the sidebar.", async () => {
      await t.click(anchor(page, "nav-email"), { settle: 1800 });
    });
    await t.say("Each row is marked Sent or Received, so you can tell what went out from what came in.", async () => {
      await t.point(anchor(page, "email-inbox"));
      await t.point(anchor(page, "email-message").first());
    });
    await t.say("Open a message to read it.", async () => {
      await t.click(anchor(page, "email-message").first(), { settle: 1200 });
    });
    await t.say("Reply at the bottom. It goes out with your webinar address as Reply-To.", async () => {
      await t.point(anchor(page, "email-reply"));
      await t.point(btn(page, /^Send reply$/));
    });
    await t.say("The address itself lives in Settings, under Integrations. That's the last video.");
  },
};

export const emailAddress = {
  id: "11-email-address",
  title: "Your email address",
  warm: ["/settings"],
  async run(t, page) {
    await t.goto("/host");
    await t.card(
      {
        kicker: "WebinarLiv guided tour · 11",
        title: "Your email address",
        sub: "One @webinarliv.com address, yours",
      },
      "Every host has an email address on webinarliv.com. Replies to your webinars arrive there.",
    );
    await t.say("Open Settings at the bottom of the sidebar.", async () => {
      await t.click(anchor(page, "nav-settings"), { settle: 1600 });
    });
    await t.say("Profile is your name and photo. Account is the sign-in. Appearance is light or dark, saved in this browser.", async () => {
      await t.point(anchor(page, "settings-profile"));
      await t.point(anchor(page, "settings-account"));
      await t.point(anchor(page, "settings-appearance"));
    });
    await t.say("Integrations is where the apps live, including Email.", async () => {
      await t.click(anchor(page, "settings-integrations"), { settle: 1400 });
      await t.point(anchor(page, "email-address"));
    });
    await t.say("This is your address. You can change the name once. After that it locks, and support has to change it.", async () => {
      await t.point(page.getByLabel("Address"));
    });
    await t.say("If you do change it, the previous address stays as an alias. Mail to the old one still reaches you.", async () => {
      await t.point(page.getByText("@webinarliv.com").first());
    });
    await t.say("Sign out is at the bottom of this list. That's the tour. Happy hosting.", async () => {
      await t.point(anchor(page, "settings-sign-out"));
    });
  },
};
