/**
 * Naive markdown for the wizard's Dogfood Report step (ticket 12: "naive
 * markdown rendering proved out"). Parses to plain data — the component maps
 * blocks to React elements, so agent-authored text is always escaped by
 * construction and the parser stays unit-testable without a DOM.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; inlines: Inline[] }
  | { kind: "em"; inlines: Inline[] }
  | { kind: "link"; text: string; href: string };

export type Block =
  | { kind: "heading"; level: number; inlines: Inline[] }
  | { kind: "paragraph"; inlines: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "code"; text: string }
  | { kind: "table"; header: Inline[][]; rows: Inline[][][] };

const INLINE_TOKEN =
  /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^()\s]+)\)/g;

export function parseInlines(text: string): Inline[] {
  const inlines: Inline[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_TOKEN)) {
    if (match.index > last) inlines.push({ kind: "text", text: text.slice(last, match.index) });
    const [, code, strong, em, linkText, href] = match;
    // Strong/em recurse so code spans render inside them ("**Tokens in
    // `globals.css`**"); their content can't contain `*`, so this terminates.
    if (code !== undefined) inlines.push({ kind: "code", text: code });
    else if (strong !== undefined) inlines.push({ kind: "strong", inlines: parseInlines(strong) });
    else if (em !== undefined) inlines.push({ kind: "em", inlines: parseInlines(em) });
    else inlines.push({ kind: "link", text: linkText!, href: href! });
    last = match.index + match[0].length;
  }
  if (last < text.length) inlines.push({ kind: "text", text: text.slice(last) });
  return inlines;
}

const TABLE_SEPARATOR_CELL = /^:?-+:?$/;

function tableCells(line: string): string[] {
  const cells = line.split("|").map((cell) => cell.trim());
  if (cells[0] === "") cells.shift();
  if (cells.at(-1) === "") cells.pop();
  return cells;
}

export function parseMarkdown(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: "paragraph", inlines: parseInlines(paragraph.join(" ")) });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === "") {
      flushParagraph();
      continue;
    }

    if (line.trimStart().startsWith("```")) {
      flushParagraph();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trimStart().startsWith("```")) {
        body.push(lines[i]!);
        i += 1;
      }
      // An unclosed fence still captures its tail (minus a trailing blank).
      while (body.at(-1)?.trim() === "") body.pop();
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: "heading", level: heading[1]!.length, inlines: parseInlines(heading[2]!) });
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = bullet === null;
      const pattern = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*]\s+(.*)$/;
      const items: Inline[][] = [];
      let item = lines[i]!.match(pattern);
      while (item) {
        items.push(parseInlines(item[1]!));
        item = i + 1 < lines.length ? (lines[i + 1]!.match(pattern) ?? null) : null;
        if (item) i += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    if (line.trimStart().startsWith("|")) {
      flushParagraph();
      const tableLines: string[] = [line];
      while (i + 1 < lines.length && lines[i + 1]!.trimStart().startsWith("|")) {
        i += 1;
        tableLines.push(lines[i]!);
      }
      const parsed = tableLines.map(tableCells);
      const header = parsed[0]!.map(parseInlines);
      const body = parsed
        .slice(1)
        .filter((cells) => !cells.every((cell) => TABLE_SEPARATOR_CELL.test(cell)));
      blocks.push({ kind: "table", header, rows: body.map((cells) => cells.map(parseInlines)) });
      continue;
    }

    paragraph.push(line.trim());
  }
  flushParagraph();
  return blocks;
}
