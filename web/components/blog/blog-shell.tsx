import Link from "next/link";
import type { ReactNode } from "react";
import { HomeLegalFooter } from "@/components/marketing/legal-page";
import { TopNav } from "@/components/top-nav";
import { POSTS } from "@/content/blog";
import {
  BLOG_AUTHOR,
  CATEGORIES,
  CATEGORY_IDS,
  formatPostDate,
  readingTime,
  type BlogCategory,
  type Post,
} from "@/lib/blog";

/* The frame around /blog pages: the marketing tokens (.home), the top bar and the
 * site footer. Styles are the .blog-* rules in app/globals.css. */
export function BlogShell({ children }: { children: ReactNode }) {
  return (
    <>
      <TopNav />
      <main className="flex-1">
        <div className="home blog">
          {children}
          <HomeLegalFooter />
        </div>
      </main>
    </>
  );
}

/** Filter chips. Plain links to static pages, so they work without JavaScript. */
export function CategoryNav({ active }: { active: BlogCategory | null }) {
  const chip = (href: string, label: string, on: boolean) => (
    <Link
      key={href}
      href={href}
      aria-current={on ? "page" : undefined}
      className={on ? "blog-chip blog-chip-on" : "blog-chip"}
    >
      {label}
    </Link>
  );
  return (
    <nav className="blog-chips" aria-label="Categories">
      {chip("/blog", "All posts", active === null)}
      {/* A chip that opens onto "nothing here yet" is a dead end; list only categories with posts. */}
      {CATEGORY_IDS.filter((c) => c === active || POSTS.some((p) => p.category === c)).map((c) =>
        chip(`/blog/category/${c}`, CATEGORIES[c].label, active === c),
      )}
    </nav>
  );
}

export function PostMeta({ post }: { post: Post }) {
  return (
    <p className="blog-meta">
      <time dateTime={post.date}>{formatPostDate(post.date)}</time>
      <span aria-hidden>·</span>
      <span>{readingTime(post.body)} min read</span>
      <span aria-hidden>·</span>
      <span>{BLOG_AUTHOR}</span>
    </p>
  );
}

export function PostCard({ post }: { post: Post }) {
  return (
    <article className="blog-card">
      <p className="blog-card-cat">{CATEGORIES[post.category].label}</p>
      <h2 className="blog-card-title">
        <Link href={`/blog/${post.slug}`}>{post.title}</Link>
      </h2>
      <p className="blog-card-desc">{post.description}</p>
      <p className="blog-meta">
        <time dateTime={post.date}>{formatPostDate(post.date)}</time>
        <span aria-hidden>·</span>
        <span>{readingTime(post.body)} min read</span>
      </p>
    </article>
  );
}

export function PostList({ posts }: { posts: readonly Post[] }) {
  if (posts.length === 0) return <p className="blog-empty">Nothing here yet. Check back soon.</p>;
  return (
    <div className="blog-grid">
      {posts.map((p) => (
        <PostCard key={p.slug} post={p} />
      ))}
    </div>
  );
}

export function BlogHeader({
  title,
  intro,
  active,
}: {
  title: string;
  intro: string;
  active: BlogCategory | null;
}) {
  return (
    <header className="blog-head">
      <p className="legal-kicker">
        <Link href="/blog">Webinar Liv blog</Link>
      </p>
      <h1 className="legal-title">{title}</h1>
      <p className="blog-intro">
        {intro}{" "}
        <a href="/blog/rss.xml" className="blog-rss">
          RSS feed
        </a>
      </p>
      <CategoryNav active={active} />
    </header>
  );
}
