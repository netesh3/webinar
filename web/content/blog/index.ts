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

export const POSTS: readonly Post[] = sortPosts([
  firstWebinar,
  engage,
  simulive,
  videoDelivery,
  meeting,
  coHosts,
  recordings,
  captions,
]);

export function getPost(slug: string): Post | undefined {
  return POSTS.find((p) => p.slug === slug);
}
