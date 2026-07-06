import type { JSX } from "react";

/**
 * A small, dependency-free markdown renderer for KB and harness content —
 * enough structure (headings, lists, code, quotes, bold/italic/code spans,
 * links) to read a document like a wiki, without pulling a parser into the
 * bundle. Everything is escaped by React; no raw HTML is ever injected.
 *
 * Keys come from a monotonic counter, not array indices: the source is parsed
 * wholesale on every render into a fixed token sequence that never reorders, so
 * a per-render running id is both unique and stable enough for React here.
 */

function renderInline(text: string, key: string): (string | JSX.Element)[] {
  // Order matters: code spans first (their contents are literal), then links,
  // then bold, then italic. Each pass splits on the first matching token.
  const nodes: (string | JSX.Element)[] = [];
  let n = 0;
  for (const chunk of text.split(/(`[^`]+`)/g)) {
    if (/^`[^`]+`$/.test(chunk)) {
      nodes.push(
        <code
          key={`${key}-c${n++}`}
          className="rounded-[2px] bg-(--card) px-1 py-0.5 font-mono text-[0.92em] text-(--code)"
        >
          {chunk.slice(1, -1)}
        </code>,
      );
      continue;
    }
    nodes.push(...renderLinks(chunk, `${key}-c${n++}`));
  }
  return nodes;
}

function renderLinks(text: string, key: string): (string | JSX.Element)[] {
  const out: (string | JSX.Element)[] = [];
  let n = 0;
  for (const part of text.split(/(\[[^\]]+\]\((?:https?:\/\/|\/)[^)]+\))/g)) {
    const match = part.match(/^\[([^\]]+)\]\(((?:https?:\/\/|\/)[^)]+)\)$/);
    if (match?.[1] && match[2]) {
      out.push(
        <a
          key={`${key}-l${n++}`}
          href={match[2]}
          target={match[2].startsWith("http") ? "_blank" : undefined}
          rel="noreferrer"
          className="text-(--info) underline underline-offset-4"
        >
          {match[1]}
        </a>,
      );
      continue;
    }
    out.push(...renderEmphasis(part, `${key}-l${n++}`));
  }
  return out;
}

function renderEmphasis(text: string, key: string): (string | JSX.Element)[] {
  const out: (string | JSX.Element)[] = [];
  let n = 0;
  for (const part of text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_)/g)) {
    if (/^\*\*[^*]+\*\*$/.test(part)) {
      out.push(
        <strong key={`${key}-b${n++}`} className="font-semibold text-(--ink)">
          {part.slice(2, -2)}
        </strong>,
      );
    } else if (/^\*[^*]+\*$/.test(part) || /^_[^_]+_$/.test(part)) {
      out.push(
        <em key={`${key}-i${n++}`} className="italic">
          {part.slice(1, -1)}
        </em>,
      );
    } else if (part) {
      out.push(part);
    }
  }
  return out;
}

export function Markdown({ source }: { source: string }) {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const blocks: JSX.Element[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let code: string[] | null = null;

  const flushList = () => {
    if (!list) return;
    let n = 0;
    const items = list.items.map((item) => {
      const key = `li-${blocks.length}-${n++}`;
      return (
        <li key={key} className="leading-relaxed">
          {renderInline(item, key)}
        </li>
      );
    });
    blocks.push(
      list.ordered ? (
        <ol key={`ol-${blocks.length}`} className="ml-5 list-decimal space-y-1 text-(--mut)">
          {items}
        </ol>
      ) : (
        <ul key={`ul-${blocks.length}`} className="ml-5 list-disc space-y-1 text-(--mut)">
          {items}
        </ul>
      ),
    );
    list = null;
  };

  for (const raw of lines) {
    if (raw.trim().startsWith("```")) {
      if (code) {
        blocks.push(
          <pre
            key={`pre-${blocks.length}`}
            className="overflow-auto border border-(--line) bg-(--card) p-3 font-mono text-[12px] text-(--mut)"
          >
            {code.join("\n")}
          </pre>,
        );
        code = null;
      } else {
        flushList();
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(raw);
      continue;
    }

    const heading = raw.match(/^(#{1,4})\s+(.*)$/);
    if (heading?.[2]) {
      flushList();
      const level = heading[1]?.length ?? 1;
      const size = level === 1 ? "text-[17px]" : level === 2 ? "text-[15px]" : "text-[13.5px]";
      blocks.push(
        <p
          key={`h-${blocks.length}`}
          className={`mt-2 font-semibold tracking-tight text-(--ink) ${size}`}
        >
          {renderInline(heading[2], `h-${blocks.length}`)}
        </p>,
      );
      continue;
    }

    const ordered = raw.match(/^\s*\d+\.\s+(.*)$/);
    const bullet = raw.match(/^\s*[-*]\s+(.*)$/);
    if (ordered?.[1] !== undefined) {
      if (!list?.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(ordered[1]);
      continue;
    }
    if (bullet?.[1] !== undefined) {
      if (list?.ordered) flushList();
      if (!list) list = { ordered: false, items: [] };
      list.items.push(bullet[1]);
      continue;
    }

    if (raw.trim().startsWith(">")) {
      flushList();
      blocks.push(
        <blockquote
          key={`q-${blocks.length}`}
          className="border-l-2 border-(--line-strong) pl-3 text-(--mut) italic"
        >
          {renderInline(raw.replace(/^\s*>\s?/, ""), `q-${blocks.length}`)}
        </blockquote>,
      );
      continue;
    }

    if (raw.trim() === "") {
      flushList();
      continue;
    }

    flushList();
    blocks.push(
      <p key={`p-${blocks.length}`} className="leading-relaxed text-(--mut)">
        {renderInline(raw, `p-${blocks.length}`)}
      </p>,
    );
  }
  flushList();
  if (code) {
    blocks.push(
      <pre
        key={`pre-${blocks.length}`}
        className="overflow-auto border border-(--line) bg-(--card) p-3 font-mono text-[12px] text-(--mut)"
      >
        {code.join("\n")}
      </pre>,
    );
  }

  return <div className="flex flex-col gap-2 text-[13px]">{blocks}</div>;
}
