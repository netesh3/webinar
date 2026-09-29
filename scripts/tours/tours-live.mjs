/* Tour 4: going live. Uses a throwaway instant webinar, deleted afterwards
 * by run.mjs (see `cleanup`), and a fake camera fed from a still image. */

import { btn, link } from "./common.mjs";

export const live = {
  id: "04-go-live",
  title: "Go live",
  media: true,
  warm: ["/host"],
  cleanup: "delete from webinars w using users u where u.id=w.host_id and u.email=$EMAIL and w.topic='Instant webinar'",
  async run(t, page) {
    await t.goto("/host");
    await t.card(
      { kicker: "WebinarLiv guided tour · 4", title: "Go live", sub: "Your room, your stage, your audience" },
      "It's time. Let's go live, and look around the room.",
    );
    await t.say("For a scheduled webinar, open it and press Go live. Here, we'll start an instant one.", async () => {
      await t.point(btn(page, /Instant webinar/));
    });
    let room;
    await t.say("The room opens in its own tab, and your join link is copied, ready to share.", async () => {
      [room] = await Promise.all([
        page.context().waitForEvent("page"),
        t.click(btn(page, /Instant webinar/), { settle: 200 }),
      ]);
      await room.waitForLoadState("networkidle");
      await t.use(room);
    });
    await t.say("Before you join, check your camera and microphone, and pick a background. Blur, or a studio backdrop.", async () => {
      await t.click(btn(room, /^Studio$/), { settle: 1400 });
    });
    await t.say("Then click Join the webinar.", async () => {
      await t.click(btn(room, /^Join the webinar$/), { settle: 5000 });
    });
    await t.say("You're live. The timer at the top shows how long you've been on.", async () => {
      await t.point(btn(room, /^Meeting information$/));
    });
    await t.say("Along the bottom are your controls. Mute and camera on the left.", async () => {
      await t.point(btn(room, /^Mute/));
      await t.point(btn(room, /^Stop video/));
    });
    await t.say("Share your screen, to show slides. And record, so people who missed it can watch the replay.", async () => {
      await t.point(btn(room, /^Share$/));
      await t.point(btn(room, /^Record/));
    });
    await t.say("Chat lets everyone talk. Open it to read and reply.", async () => {
      await t.click(btn(room, /^Chat$/), { settle: 1500 });
    });
    await t.say("Q and A collects questions, with the most upvoted at the top, so you answer what matters most.", async () => {
      await t.click(btn(room, /^Q&A$/), { settle: 1500 });
    });
    await t.say("Polls let you ask a quick question, and see the answers live. Answers can even trigger WhatsApp automations later.", async () => {
      await t.click(btn(room, /^Polls$/), { settle: 1500 });
    });
    await t.say("Participants shows who's here. You can bring someone on stage, or admit people who are waiting.", async () => {
      await t.click(btn(room, /^Participants$/), { settle: 1500 });
    });
    await t.say("And More has the rest of your tools.", async () => {
      await t.click(btn(room, /^More tools$/), { settle: 1500 });
      await t.key("Escape");
    });
    await t.say("When you're done, click Leave, and choose to end the webinar for everyone. Then it's time to see how it went.", async () => {
      await t.point(btn(room, /^Leave or end/));
    });
  },
};

export { link };
