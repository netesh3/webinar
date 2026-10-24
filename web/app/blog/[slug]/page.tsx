import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BlogShell, PostMeta } from "@/components/blog/blog-shell";
import { Blocks } from "@/components/blog/markdown";
import { getPost, POSTS } from "@/content/blog";
import {
  BLOG_AUTHOR,
  CATEGORIES,
  prevNext,
  relatedPosts,
  tableOfContents,
  TOC_MIN_HEADINGS,
  type TocEntry,
} from "@/lib/blog";
import { parseMarkdown } from "@/lib/blog-markdown";

// Posts are compiled in: every slug is known at build time, anything else is a 404.
export const dynamicParams = false;

export function generateStaticParams() {
  return POSTS.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: PageProps<"/blog/[slug]">): Promise<Metadata> {
  const post = getPost((await params).slug);
  if (!post) return {};
  const url = `/blog/${post.slug}`;
  return {
    title: `${post.title} — Webinar Liv`,
    description: post.description,
    alternates: { canonical: url },
    authors: [{ name: BLOG_AUTHOR }],
    keywords: post.tags,
    openGraph: {
      title: post.title,
      description: post.description,
      type: "article",
      url,
      publishedTime: post.date,
      modifiedTime: post.updated ?? post.date,
      authors: [BLOG_AUTHOR],
      section: CATEGORIES[post.category].label,
      tags: post.tags,
    },
    twitter: { card: "summary", title: post.title, description: post.description },
  };
}

function Toc({ entries }: { entries: TocEntry[] }) {
  return (
    <ol className="blog-toc-list">
      {entries.map((e) => (
        <li key={e.id} className={e.level === 3 ? "blog-toc-sub" : undefined}>
          <a href={`#${e.id}`}>{e.text}</a>
        </li>
      ))}
    </ol>
  );
}

export default async function PostPage({ params }: PageProps<"/blog/[slug]">) {
  const post = getPost((await params).slug);
  if (!post) notFound();

  const blocks = parseMarkdown(post.body);
  const toc = tableOfContents(blocks).filter((e) => e.level === 2);
  const showToc = toc.length >= TOC_MIN_HEADINGS;
  const { prev, next } = prevNext(POSTS, post.slug);
  const related = relatedPosts(POSTS, post.slug, 3);
  const category = CATEGORIES[post.category];

  /* Structured data for search engines. Built from our own constants and post fields,
   * serialised with JSON.stringify and "<" escaped, so nothing can close the script. */
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": post.category === "engineering" ? "TechArticle" : "BlogPosting",
    headline: post.title,
    name: post.title,
    description: post.description,
    datePublished: post.date,
    dateModified: post.updated ?? post.date,
    author: { "@type": "Organization", name: BLOG_AUTHOR },
    publisher: { "@type": "Organization", name: "Webinar Liv" },
  }).replace(/</g, "\\u003c");

  return (
    <BlogShell>
      <article className={showToc ? "blog-post blog-post-toc" : "blog-post"}>
        <header className="blog-post-head">
          <p className="legal-kicker">
            <Link href="/blog">Blog</Link>
            <span aria-hidden> / </span>
            <Link href={`/blog/category/${post.category}`}>{category.label}</Link>
          </p>
          <h1 className="legal-title">{post.title}</h1>
          <p className="blog-intro">{post.description}</p>
          <PostMeta post={post} />
        </header>

        {showToc && (
          <>
            <details className="blog-toc blog-toc-mobile">
              <summary>On this page</summary>
              <Toc entries={toc} />
            </details>
            <nav className="blog-toc blog-toc-side" aria-label="On this page">
              <p className="blog-toc-title">On this page</p>
              <Toc entries={toc} />
            </nav>
          </>
        )}

        <div className="legal-body blog-body">
          <Blocks blocks={blocks} />
        </div>

        <footer className="blog-post-foot">
          {(prev || next) && (
            <nav className="blog-prevnext" aria-label={`More ${category.label.toLowerCase()}`}>
              {prev ? (
                <Link href={`/blog/${prev.slug}`} className="blog-prevnext-link" rel="prev">
                  <span className="blog-prevnext-dir">← Previous</span>
                  <span>{prev.title}</span>
                </Link>
              ) : (
                <span />
              )}
              {next && (
                <Link href={`/blog/${next.slug}`} className="blog-prevnext-link blog-prevnext-next" rel="next">
                  <span className="blog-prevnext-dir">Next →</span>
                  <span>{next.title}</span>
                </Link>
              )}
            </nav>
          )}

          {related.length > 0 && (
            <section className="blog-related" aria-labelledby="related-heading">
              <h2 id="related-heading">Related posts</h2>
              <ul>
                {related.map((r) => (
                  <li key={r.slug}>
                    <Link href={`/blog/${r.slug}`}>{r.title}</Link>
                    <span className="blog-related-cat">{CATEGORIES[r.category].label}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </footer>
      </article>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />
    </BlogShell>
  );
}
