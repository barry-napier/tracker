import { createElement, useMemo, type ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "./markdown.ts";

/**
 * Agent-authored markdown (the Dogfood Report) rendered as React elements —
 * escaped by construction, no raw HTML path exists.
 */
export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <div className="markdown">{blocks.map(renderBlock)}</div>;
}

function renderInlines(inlines: Inline[]): ReactNode[] {
  return inlines.map((inline, i) => {
    switch (inline.kind) {
      case "code":
        return <code key={i}>{inline.text}</code>;
      case "strong":
        return <strong key={i}>{renderInlines(inline.inlines)}</strong>;
      case "em":
        return <em key={i}>{renderInlines(inline.inlines)}</em>;
      case "link":
        return (
          <a key={i} href={inline.href} target="_blank" rel="noreferrer">
            {inline.text}
          </a>
        );
      default:
        return inline.text;
    }
  });
}

function renderBlock(block: Block, i: number): ReactNode {
  switch (block.kind) {
    case "heading":
      return createElement(`h${block.level}`, { key: i }, ...renderInlines(block.inlines));
    case "code":
      return (
        <pre key={i}>
          <code>{block.text}</code>
        </pre>
      );
    case "list": {
      const items = block.items.map((item, j) => <li key={j}>{renderInlines(item)}</li>);
      return block.ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
    }
    case "table":
      return (
        <table key={i}>
          <thead>
            <tr>
              {block.header.map((cell, j) => (
                <th key={j}>{renderInlines(cell)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, j) => (
              <tr key={j}>
                {row.map((cell, k) => (
                  <td key={k}>{renderInlines(cell)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    default:
      return <p key={i}>{renderInlines(block.inlines)}</p>;
  }
}
