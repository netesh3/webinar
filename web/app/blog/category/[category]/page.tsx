import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BlogHeader, BlogShell, PostList } from "@/components/blog/blog-shell";
import { POSTS } from "@/content/blog";
import { CATEGORIES, CATEGORY_IDS, isCategory, postsInCategory } from "@/lib/blog";
import { RSS_ALTERNATE } from "@/lib/seo";

// Every category is known at build time; anything else is a 404, not a render.
export const dynamicParams = false;

export function generateStaticParams() {
  return CATEGORY_IDS.map((category) => ({ category }));
}

export async function generateMetadata({
  params,
}: PageProps<"/blog/category/[category]">): Promise<Metadata> {
  const { category } = await params;
  if (!isCategory(category)) return {};
  const { label, blurb } = CATEGORIES[category];
  return {
    title: `${label} — Webinar Liv blog`,
    description: blurb,
    alternates: { canonical: `/blog/category/${category}`, types: RSS_ALTERNATE },
    openGraph: { title: `${label} — Webinar Liv blog`, description: blurb, url: `/blog/category/${category}` },
  };
}

export default async function CategoryPage({ params }: PageProps<"/blog/category/[category]">) {
  const { category } = await params;
  if (!isCategory(category)) notFound();
  const { label, blurb } = CATEGORIES[category];
  return (
    <BlogShell>
      <div className="blog-inner">
        <BlogHeader title={label} intro={blurb} active={category} />
        <PostList posts={postsInCategory(POSTS, category)} />
      </div>
    </BlogShell>
  );
}
