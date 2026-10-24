/* Every published post. Add the import and the array entry for a new post here;
 * docs/content-guide.md covers the rest. Order does not matter — pages sort by date. */

import type { Post } from "../../lib/blog.ts";
import { sortPosts } from "../../lib/blog.ts";
import { post as firstWebinar } from "./schedule-and-run-your-first-webinar.ts";
import { post as engage } from "./engage-your-audience.ts";
import { post as simulive } from "./turn-a-recording-into-a-simulive.ts";
import { post as videoDelivery } from "./how-webinar-liv-delivers-video.ts";
import { post as meeting } from "./run-a-meeting.ts";
import { post as coHosts } from "./co-hosts-and-panelists.ts";
import { post as recordings } from "./recordings-and-retention.ts";
import { post as captions } from "./live-captions.ts";
import { post as followUps } from "./follow-up-by-email-and-whatsapp.ts";
import { post as audience } from "./your-audience.ts";
import { post as aiRecap } from "./ai-recap-and-insights.ts";
import { post as knowledge } from "./ai-knowledge-base.ts";
import { post as highlights } from "./highlights-reels-and-studio.ts";
import { post as simuliveClock } from "./simulive-keeping-every-viewer-on-the-same-moment.ts";
import { post as videoServer } from "./running-a-video-server-only-when-you-need-it.ts";

export const POSTS: readonly Post[] = sortPosts([
  firstWebinar,
  engage,
  simulive,
  videoDelivery,
  meeting,
  coHosts,
  recordings,
  captions,
  followUps,
  audience,
  aiRecap,
  knowledge,
  highlights,
  simuliveClock,
  videoServer,
]);

export function getPost(slug: string): Post | undefined {
  return POSTS.find((p) => p.slug === slug);
}
