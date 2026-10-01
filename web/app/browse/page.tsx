import { BrowseFrame } from "@/components/browse-frame";

/* Sessions you're involved in. Not a public catalogue — the API refuses an
 * anonymous caller — and not a second host home. A signed-in host sees the
 * sidebar shell; everyone else sees the public header. The list, the filters,
 * and the links into a webinar are unchanged. */
export default function BrowsePage() {
  return <BrowseFrame />;
}
