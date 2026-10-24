import Link from "next/link";
import type { ReactNode } from "react";
import type { Block, Inline } from "@/lib/blog-markdown";
import { DIAGRAMS } from "./diagrams";

/* Renders the tree from lib/blog-markdown.ts. Server-only: no state, no effects, and
 * every string goes through React, so a post cannot inject markup. */

function isInternal(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//");
}

function InlineNodes({ nodes }: { nodes: Inline[] }) {
  return nodes.map((n, i) => {
    switch (n.t) {
      case "text":
        return n.v;
      case "code":
        return <code key={i}>{n.v}</code>;
      case "strong":
        return (
          <strong key={i}>
            <InlineNodes nodes={n.c} />
          </strong>
        );
      case "em":
        return (
          <em key={i}>
            <InlineNodes nodes={n.c} />
          </em>
        );
      case "link":
        return isInternal(n.href) || n.href.startsWith("#") ? (
          <Link key={i} href={n.href}>
            <InlineNodes nodes={n.c} />
          </Link>
        ) : (
          <a key={i} href={n.href} rel="noopener noreferrer" target="_blank">
            <InlineNodes nodes={n.c} />
          </a>
        );
    }
  });
}

const CALLOUT_LABEL = { note: "Note", tip: "Tip", warning: "Heads up" } as const;

function BlockNode({ b }: { b: Block }): ReactNode {
  switch (b.t) {
    case "h": {
      const Tag = b.level === 2 ? "h2" : "h3";
      return (
        <Tag id={b.id}>
          <a href={`#${b.id}`} className="blog-anchor">
            <InlineNodes nodes={b.c} />
          </a>
        </Tag>
      );
    }
    case "p":
      return (
        <p>
          <InlineNodes nodes={b.c} />
        </p>
      );
    case "ul":
      return (
        <ul>
          {b.items.map((item, i) => (
            <li key={i}>
              <InlineNodes nodes={item} />
            </li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol start={b.start === 1 ? undefined : b.start}>
          {b.items.map((item, i) => (
            <li key={i}>
              <InlineNodes nodes={item} />
            </li>
          ))}
        </ol>
      );
    case "code":
      return (
        <figure className="blog-code">
          {b.lang && <figcaption>{b.lang}</figcaption>}
          <pre tabIndex={0}>
            <code>{b.v}</code>
          </pre>
        </figure>
      );
    case "callout":
      return (
        <aside className={`blog-callout blog-callout-${b.kind}`}>
          <p className="blog-callout-title">{b.title || CALLOUT_LABEL[b.kind]}</p>
          <Blocks blocks={b.blocks} />
        </aside>
      );
    case "quote":
      return (
        <blockquote>
          <Blocks blocks={b.blocks} />
        </blockquote>
      );
    case "img":
      return (
        <figure className="blog-figure">
          {/* eslint-disable-next-line @next/next/no-img-element -- static files under
              public/blog; Workers has no image optimizer configured. */}
          <img src={b.src} alt={b.alt} loading="lazy" decoding="async" />
          {b.caption && <figcaption>{b.caption}</figcaption>}
        </figure>
      );
    case "diagram": {
      const Diagram = DIAGRAMS[b.name as keyof typeof DIAGRAMS];
      if (!Diagram) return null;
      return (
        <figure className="blog-figure blog-diagram">
          <Diagram />
          {b.caption && <figcaption>{b.caption}</figcaption>}
        </figure>
      );
    }
    case "table":
      return (
        <div className="blog-table" tabIndex={0}>
          <table>
            {b.head.length > 0 && (
              <thead>
                <tr>
                  {b.head.map((c, i) => (
                    <th key={i} scope="col">
                      <InlineNodes nodes={c} />
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {b.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((c, i) => (
                    <td key={i}>
                      <InlineNodes nodes={c} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "hr":
      return <hr />;
  }
}

export function Blocks({ blocks }: { blocks: Block[] }) {
  return blocks.map((b, i) => <BlockNode key={i} b={b} />);
}
