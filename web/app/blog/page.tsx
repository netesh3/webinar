import type { Metadata } from "next";
import { BlogHeader, BlogShell, PostList } from "@/components/blog/blog-shell";
import { POSTS } from "@/content/blog";

const DESCRIPTION =
  "Step-by-step tutorials for hosting webinars with Webinar Liv, and engineering notes on how the platform is built.";

export const metadata: Metadata = {
  title: "Blog — Webinar Liv",
  description: DESCRIPTION,
  alternates: {
    canonical: "/blog",
    types: { "application/rss+xml": [{ url: "/blog/rss.xml", title: "Webinar Liv blog" }] },
  },
  openGraph: { title: "Webinar Liv blog", description: DESCRIPTION, type: "website", url: "/blog" },
};

export default function BlogIndex() {
  return (
    <BlogShell>
      <div className="blog-inner">
        <BlogHeader
          title="Tutorials and engineering notes"
          intro="How to get the most out of each feature, and how the platform underneath works."
          active={null}
        />
        <PostList posts={POSTS} />
      </div>
    </BlogShell>
  );
}
