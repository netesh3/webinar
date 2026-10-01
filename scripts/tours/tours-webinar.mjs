/* Tours 3, 5, 6: before the webinar (invite), results, follow up. */

import { anchor, btn, dialog, ENDED, link, tab, UPCOMING } from "./common.mjs";

export const invite = {
  id: "03-invite",
  title: "Invite people and get ready",
  warm: [UPCOMING, `${UPCOMING}?tab=people`, `${UPCOMING}?tab=setup`],
  async run(t, page) {
    await t.goto("/host");
    await t.card(
      { kicker: "WebinarLiv guided tour · 3", title: "Invite people and get ready", sub: "Share one link — WebinarLiv does the reminding" },
      "Your webinar is scheduled. Now let's get people to register, and get ready for the day.",
    );
    await t.say("Open a webinar from the list. The title is the way in.", async () => {
      await t.click(anchor(page, "webinar-title").first(), { settle: 1800 });
    });
    await t.say("The bar at the top shows where you are: Create, Invite, Go live, and Follow up. Right now, we're inviting.", async () => {
      await t.point(page.getByText("Invite", { exact: true }).first());
    });
    await t.say("The Overview tab starts with your link. Copy it, and paste it anywhere: Instagram, email, or a WhatsApp group.", async () => {
      await t.point(page.getByRole("heading", { name: "Share this link" }));
      await t.point(btn(page, /^Copy$/));
    });
    await t.say("Or use these shortcuts, to share straight to WhatsApp, copy a ready-made invitation, or add it to a calendar.", async () => {
      await t.point(link(page, /^WhatsApp$/));
      await t.point(btn(page, /^Copy invitation$/));
      await t.point(link(page, /^Add to calendar$/));
    });
    await t.say("Preview page shows exactly what your visitors see when they open the link.", async () => {
      await t.point(link(page, /Preview page/));
    });
    await t.say("Further down, you can see the automated messages: the confirmation when someone registers, and each reminder before you start.", async () => {
      await t.point(page.getByRole("heading", { name: "Automated messages" }));
    });
    await t.say("The People tab lists everyone who has registered, with how they signed up. You can message them all, or export the list.", async () => {
      await t.click(tab(page, /^People/), { settle: 1500 });
      await t.point(btn(page, /^Message all/));
      await t.point(link(page, /^Export CSV$/));
    });
    await t.say("The Setup tab has the session settings, who's on stage with you, and a private link for your co-hosts and panelists.", async () => {
      await t.click(tab(page, /^Setup$/), { settle: 1500 });
      await t.point(page.getByRole("heading", { name: /On the stage/ }));
      await t.point(page.getByRole("heading", { name: "Host and panelist link" }));
    });
    await t.say("To change the date or the reminders, open More actions, then Edit webinar.", async () => {
      await t.click(btn(page, /^More actions$/), { settle: 1200 });
      await t.point(page.getByRole("menuitem", { name: /^Edit webinar$/ }));
      await t.key("Escape");
    });
    await t.say("And when it's time, the green Go live button takes you into the room. That's the next video.", async () => {
      await t.point(btn(page, /Go live/));
    });
  },
};

export const results = {
  id: "05-results",
  title: "See how it went",
  warm: [ENDED, "/host/beat-procrastination-21-days"],
  async run(t, page) {
    await t.goto("/host");
    await t.card(
      { kicker: "WebinarLiv guided tour · 5", title: "See how it went", sub: "Attendance, activity and engagement — worked out for you" },
      "Your webinar is over. Let's see how it went.",
    );
    await t.say("Open the Completed tab, and click See results on the webinar.", async () => {
      await t.click(tab(page, /^Completed/));
      await t.click(link(page, /^See results$/), { settle: 2200 });
    });
    await t.say("After a webinar, the tabs change to Results, Follow up, and Recording. Results opens first.", async () => {
      await t.point(tab(page, /^Results$/));
    });
    await t.say("At the top, the overview gives you the headline numbers at a glance.", async () => {
      await t.point(page.getByRole("heading", { name: "Overview" }));
    });
    await t.say("Attendance shows who stayed, and when people joined.", async () => {
      await t.scroll(420);
      await t.point(page.getByRole("heading", { name: "Who stayed" }));
    });
    await t.say("Each section below opens up. Activity shows when the room was busiest, minute by minute.", async () => {
      await t.click(btn(page, /^Activity/), { settle: 1500 });
    });
    await t.say("There's a section each for chat, Q and A, polls, reactions, and your feedback survey.", async () => {
      await t.scroll(500);
      await t.point(btn(page, /^Polls/));
    });
    await t.say("At the bottom, everyone lands in one engagement group, from highly engaged to no-show, based on how they took part.", async () => {
      await t.click(btn(page, /^Follow up/), { settle: 1500 });
    });
    await t.say("Up top, you can export everything, or recompute the scores if new data came in.", async () => {
      await t.scroll(-3000);
      await t.point(btn(page, /Export/));
      await t.point(btn(page, /Recompute/));
    });
    await t.say("Next, let's use those groups to follow up.");
  },
};

export const followup = {
  id: "06-follow-up",
  title: "Follow up after a webinar",
  warm: [`${ENDED}?tab=followup`],
  async run(t, page) {
    await t.goto(ENDED);
    await t.card(
      { kicker: "WebinarLiv guided tour · 6", title: "Follow up after a webinar", sub: "The right message to each group, on WhatsApp" },
      "The best time to follow up is right after the webinar. Here's how.",
    );
    await t.say("Open the Follow up tab.", async () => {
      await t.click(tab(page, /^Follow up$/), { settle: 1800 });
    });
    await t.say("Who to message lists each engagement group, and how many of them you can reach on WhatsApp.", async () => {
      await t.point(page.getByRole("heading", { name: "Who to message" }));
    });
    await t.say("Click Review and send on a group. Let's message the most engaged people.", async () => {
      await t.click(btn(page, /^Review & send$/).first(), { settle: 1800 });
    });
    await t.say("Pick a message. The one that suits this group is suggested first.", async () => {
      await t.point(dialog(page).getByRole("radio").first());
    });
    await t.say("Each blank is filled in for every person, like their first name, or the webinar title. The phone shows exactly what they'll get.", async () => {
      await t.point(dialog(page).getByText("Blank 1"));
    });
    await t.say("Choose when it goes out: now, tomorrow morning, or a time you pick.", async () => {
      await t.point(dialog(page).getByText("Tomorrow 9 AM"));
    });
    await t.say("Send a test to your own phone first, if you like. Then send it to the whole group in one click.", async () => {
      await t.point(dialog(page).getByRole("button", { name: /Send a test/ }));
      await t.point(dialog(page).getByRole("button", { name: /^Send to/ }));
    });
    await t.say("We'll cancel this one for now.", async () => {
      await t.click(dialog(page).getByRole("button", { name: /^Cancel$/ }));
    });
    await t.say("Want this to happen every time? Switch on automatically after every webinar, and each group gets its message automatically.", async () => {
      await t.point(page.getByRole("switch", { name: /automatically after/ }));
    });
    await t.say("Below, you'll see everything that was sent for this webinar, and replies waiting for you.", async () => {
      await t.scroll(600);
      await t.point(page.getByRole("heading", { name: /Waiting for your reply/ }));
    });
    await t.say("Click any reply, to answer it in Messages. That's the next video.");
  },
};
