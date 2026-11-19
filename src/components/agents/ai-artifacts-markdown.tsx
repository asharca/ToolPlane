"use client";
// asharca.github.io/ui/components/agents/ai-artifacts

import { Check, Copy } from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type AgentCodeLanguage,
  AgentCodeLine,
  useAgentCodeTokens,
} from "@/components/agents/agent-code";
import { cn } from "@/lib/utils";

/**
 * Markdown for artifact documents. Content becomes React elements only: raw HTML
 * stays text, images stay links, and only http(s), mailto and relative links are
 * clickable.
 */
export type ArtifactBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: "paragraph"; text: string }
  | { type: "code"; language: string; code: string }
  | { type: "list"; ordered: boolean; start: number; items: ArtifactListItem[] }
  | { type: "quote"; blocks: ArtifactBlock[] }
  | {
      type: "table";
      align: ArtifactTableAlign[];
      header: string[];
      rows: string[][];
    }
  | { type: "rule" };
export interface ArtifactListItem {
  checked: boolean | null;
  blocks: ArtifactBlock[];
}
export type ArtifactTableAlign = "left" | "center" | "right" | null;

export interface ArtifactMarkdownLabels {
  copyCode: string;
  codeCopied: string;
  copyFailed: string;
  plainText: string;
  taskDone: string;
  taskOpen: string;
}

const FENCE = /^( {0,3})(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST = /^( *)([-*+]|\d{1,9}[.)])([ \t]+|$)(.*)$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const DELIMITER =
  /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

const indentOf = (line: string) => line.length - line.trimStart().length;
const dedent = (line: string, width: number) =>
  line.slice(Math.min(width, indentOf(line)));

function splitRow(line: string) {
  const cells: string[] = [];
  let cell = "";
  const row = line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "");
  for (let index = 0; index < row.length; index++) {
    if (row[index] === "\\" && row[index + 1] === "|") {
      cell += "|";
      index++;
    } else if (row[index] === "|") {
      cells.push(cell.trim());
      cell = "";
    } else cell += row[index];
  }
  cells.push(cell.trim());
  return cells;
}

const isTableStart = (lines: string[], index: number) =>
  lines[index].includes("|") &&
  index + 1 < lines.length &&
  DELIMITER.test(lines[index + 1]) &&
  lines[index + 1].includes("-");

function startsBlock(lines: string[], index: number) {
  const line = lines[index];
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    LIST.test(line) ||
    isTableStart(lines, index)
  );
}

export function parseArtifactMarkdown(source: string): ArtifactBlock[] {
  return parseBlocks(source.replace(/\r\n?/g, "\n").split("\n"));
}

function parseBlocks(lines: string[]): ArtifactBlock[] {
  const blocks: ArtifactBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index++;
      continue;
    }

    const fence = line.match(FENCE);
    if (fence) {
      const indent = fence[1].length;
      const close = new RegExp(
        `^ {0,3}${fence[2][0] === "`" ? "`" : "~"}{${fence[2].length},}[ \\t]*$`,
      );
      const code: string[] = [];
      index++;
      while (index < lines.length && !close.test(lines[index]))
        code.push(dedent(lines[index++], indent));
      index++;
      blocks.push({
        type: "code",
        language: fence[3].toLowerCase(),
        code: code.join("\n"),
      });
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        text: heading[2] ?? "",
      });
      index++;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      index++;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && lines[index].trim()) {
        const match = lines[index].match(QUOTE);
        if (!match && startsBlock(lines, index)) break;
        quoted.push(match ? match[1] : lines[index]);
        index++;
      }
      blocks.push({ type: "quote", blocks: parseBlocks(quoted) });
      continue;
    }

    if (isTableStart(lines, index)) {
      const header = splitRow(line);
      const align = splitRow(lines[index + 1]).map(
        (cell): ArtifactTableAlign =>
          cell.startsWith(":") && cell.endsWith(":")
            ? "center"
            : cell.endsWith(":")
              ? "right"
              : cell.startsWith(":")
                ? "left"
                : null,
      );
      const rows: string[][] = [];
      index += 2;
      while (
        index < lines.length &&
        lines[index].trim() &&
        lines[index].includes("|")
      ) {
        const cells = splitRow(lines[index++]);
        rows.push(header.map((_, column) => cells[column] ?? ""));
      }
      blocks.push({
        type: "table",
        align: header.map((_, column) => align[column] ?? null),
        header,
        rows,
      });
      continue;
    }

    const list = line.match(LIST);
    if (list) {
      const baseIndent = list[1].length;
      const ordered = /\d/.test(list[2]);
      const items: ArtifactListItem[] = [];
      while (index < lines.length) {
        const item = lines[index].match(LIST);
        if (
          !item ||
          item[1].length > baseIndent + 3 ||
          /\d/.test(item[2]) !== ordered
        )
          break;
        const gap =
          item[3].length === 0 || item[3].length > 4 ? 1 : item[3].length;
        const contentIndent = item[1].length + item[2].length + gap;
        const body = [item[4]];
        index++;
        while (index < lines.length) {
          const next = lines[index];
          if (!next.trim()) {
            const after = lines[index + 1];
            if (after?.trim() && indentOf(after) >= contentIndent) {
              body.push("");
              index++;
              continue;
            }
            break;
          }
          if (
            indentOf(next) >= contentIndent ||
            (LIST.test(next) && indentOf(next) > item[1].length)
          ) {
            body.push(dedent(next, contentIndent));
            index++;
            continue;
          }
          if (startsBlock(lines, index)) break;
          body.push(next.trim());
          index++;
        }
        const task = body[0].match(/^\[([ xX])\][ \t]+(.*)$/);
        if (task) body[0] = task[2];
        items.push({
          checked: task ? task[1] !== " " : null,
          blocks: parseBlocks(body),
        });
        let next = index;
        while (next < lines.length && !lines[next].trim()) next++;
        const sibling = lines[next]?.match(LIST);
        if (next === index) continue;
        if (
          sibling &&
          /\d/.test(sibling[2]) === ordered &&
          sibling[1].length <= baseIndent + 3
        )
          index = next;
        else break;
      }
      blocks.push({
        type: "list",
        ordered,
        start: ordered ? Number.parseInt(list[2], 10) : 1,
        items,
      });
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      (paragraph.length === 0 || !startsBlock(lines, index))
    ) {
      paragraph.push(lines[index].trim());
      index++;
    }
    blocks.push({ type: "paragraph", text: paragraph.join("\n") });
  }
  return blocks;
}

/** Returns a clickable href, or null when the scheme could run code or leave the web. */
export function safeArtifactHref(raw: string): string | null {
  const href = raw.trim();
  // Browsers drop ASCII whitespace and controls inside a scheme, e.g. "java\tscript:".
  const compact = [...href]
    .filter((char) => char > " " && char !== "\u007f")
    .join("");
  const scheme = compact.match(/^([a-z][a-z0-9+.-]*):/i)?.[1].toLowerCase();
  if (!href || (scheme && !["http", "https", "mailto"].includes(scheme)))
    return null;
  return href;
}

const linkClass =
  "font-medium text-foreground underline decoration-foreground/40 underline-offset-[3px] transition-colors hover:decoration-foreground";

function link(href: string, children: ReactNode, key: string, title?: string) {
  const safe = safeArtifactHref(href);
  if (!safe) return <span key={key}>{children}</span>;
  const external = /^(https?:)?\/\//i.test(safe);
  return (
    <a
      key={key}
      href={safe}
      title={title}
      className={linkClass}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    >
      {children}
    </a>
  );
}

function closingRun(text: string, from: number, run: string) {
  for (let index = from; index < text.length; index++) {
    if (text[index] === "\\") {
      index++;
      continue;
    }
    if (text[index] === "`") {
      const ticks = text.slice(index).match(/^`+/)?.[0] ?? "`";
      const end = text.indexOf(ticks, index + ticks.length);
      if (end > 0) {
        index = end + ticks.length - 1;
        continue;
      }
    }
    if (text.startsWith(run, index)) {
      if (run.length === 1 && text[index + 1] === run) {
        index++;
        continue;
      }
      if (text[index - 1] !== " ") return index;
    }
  }
  return -1;
}

function bracketEnd(text: string, open: number) {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === "\\") {
      index++;
      continue;
    }
    if (text[index] === "[") depth++;
    else if (text[index] === "]" && --depth === 0) return index;
  }
  return -1;
}

const DESTINATION =
  /^\(\s*(<[^>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+(?:"([^"]*)"|'([^']*)'))?\s*\)/;
const BARE_URL = /^https?:\/\/[^\s<]*[^\s<.,:;"')\]!?*_~]/;

/** Inline Markdown: escapes, code, links, autolinks, strong, emphasis and strikethrough. */
export function renderArtifactInline(text: string, prefix = "i"): ReactNode[] {
  const nodes: ReactNode[] = [];
  let plain = "";
  const flush = () => {
    if (plain) {
      nodes.push(plain);
      plain = "";
    }
  };
  const push = (node: ReactNode) => {
    flush();
    nodes.push(node);
  };
  let index = 0;
  while (index < text.length) {
    const key = `${prefix}-${index}`;
    const char = text[index];
    const rest = text.slice(index);

    if (char === "\\" && /[!-/:-@[-`{-~]/.test(text[index + 1] ?? "")) {
      plain += text[index + 1];
      index += 2;
      continue;
    }
    if (char === "\\" && text[index + 1] === "\n") {
      push(<br key={key} />);
      index += 2;
      continue;
    }
    if (char === "\n") {
      push(<br key={key} />);
      index++;
      continue;
    }

    if (char === "`") {
      const ticks = rest.match(/^`+/)?.[0] ?? "`";
      const end = text.indexOf(ticks, index + ticks.length);
      if (end > 0) {
        let code = text.slice(index + ticks.length, end).replace(/\n/g, " ");
        if (/^ .* $/.test(code) && code.trim()) code = code.slice(1, -1);
        push(
          <code
            key={key}
            className="rounded-md border border-border/60 bg-muted/60 px-1.5 py-px font-mono text-[0.85em] text-foreground"
          >
            {code}
          </code>,
        );
        index = end + ticks.length;
        continue;
      }
      plain += ticks;
      index += ticks.length;
      continue;
    }

    const image = char === "!" && text[index + 1] === "[";
    if (char === "[" || image) {
      const open = index + (image ? 1 : 0);
      const close = bracketEnd(text, open);
      const destination =
        close > 0 ? text.slice(close + 1).match(DESTINATION) : null;
      if (destination) {
        const label = text.slice(open + 1, close);
        const href = destination[1].replace(/^<|>$/g, "");
        const title = destination[2] ?? destination[3];
        push(
          link(
            href,
            image ? label || href : renderArtifactInline(label, key),
            key,
            title,
          ),
        );
        index = close + 1 + destination[0].length;
        continue;
      }
    }

    const autolink = rest.match(/^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i);
    if (autolink) {
      push(link(autolink[1], autolink[1], key));
      index += autolink[0].length;
      continue;
    }
    const bare = /[A-Za-z0-9]/.test(text[index - 1] ?? "")
      ? null
      : rest.match(BARE_URL);
    if (bare) {
      push(link(bare[0], bare[0], key));
      index += bare[0].length;
      continue;
    }

    const run = rest.startsWith("**")
      ? "**"
      : rest.startsWith("__")
        ? "__"
        : rest.startsWith("~~")
          ? "~~"
          : char === "*" || char === "_"
            ? char
            : "";
    const intraword =
      run.startsWith("_") && /[A-Za-z0-9]/.test(text[index - 1] ?? "");
    if (
      run &&
      !intraword &&
      text[index + run.length] &&
      text[index + run.length] !== " "
    ) {
      const end = closingRun(text, index + run.length, run);
      const after = text[end + run.length] ?? "";
      if (
        end > index + run.length &&
        !(run.startsWith("_") && /[A-Za-z0-9]/.test(after))
      ) {
        const inner = renderArtifactInline(
          text.slice(index + run.length, end),
          key,
        );
        push(
          run === "~~" ? (
            <del key={key} className="text-muted-foreground">
              {inner}
            </del>
          ) : run.length === 2 ? (
            <strong key={key} className="font-semibold text-foreground">
              {inner}
            </strong>
          ) : (
            <em key={key}>{inner}</em>
          ),
        );
        index = end + run.length;
        continue;
      }
    }

    plain += char;
    index++;
  }
  flush();
  return nodes;
}

const CODE_LANGUAGES: Record<string, AgentCodeLanguage> = {
  bash: "bash",
  console: "bash",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  diff: "diff",
  patch: "diff",
  json: "json",
  json5: "json",
  jsonc: "json",
  cjs: "typescript",
  javascript: "typescript",
  js: "typescript",
  mjs: "typescript",
  ts: "typescript",
  typescript: "typescript",
  jsx: "tsx",
  tsx: "tsx",
};
export const artifactCodeLanguage = (language: string): AgentCodeLanguage =>
  CODE_LANGUAGES[language.toLowerCase()] ?? "text";

function codeLines(code: string) {
  let offset = 0;
  return code.split("\n").map((content) => {
    const line = { content, offset };
    offset += content.length + 1;
    return line;
  });
}

/** Full-file code surface: quiet line-number gutter, no nested chrome. */
export function ArtifactCodeView({
  code,
  language,
  className,
}: {
  code: string;
  language: AgentCodeLanguage;
  className?: string;
}) {
  // A file's final newline ends the last line; it does not start an empty one.
  const source = code.endsWith("\n") ? code.slice(0, -1) : code;
  const tokens = useAgentCodeTokens(source, language);
  const lines = codeLines(source);
  const gutter = {
    gridTemplateColumns: `${String(lines.length).length + 3}ch minmax(0,1fr)`,
  } as CSSProperties;
  return (
    <pre
      className={cn(
        "m-0 min-w-max py-4 font-mono text-[13px] leading-6 text-foreground/90",
        className,
      )}
    >
      <code>
        {lines.map((line, index) => (
          <span key={line.offset} className="grid" style={gutter}>
            <span
              aria-hidden="true"
              className="select-none pr-4 text-right tabular-nums text-muted-foreground/40"
            >
              {index + 1}
            </span>
            <AgentCodeLine
              code={line.content}
              tokens={tokens?.[index]}
              className="whitespace-pre pr-6"
            />
          </span>
        ))}
      </code>
    </pre>
  );
}

function MarkdownCodeBlock({
  code,
  language,
  labels,
}: {
  code: string;
  language: string;
  labels: ArtifactMarkdownLabels;
}) {
  const tokens = useAgentCodeTokens(code, artifactCodeLanguage(language));
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(code);
      setState("copied");
    } catch {
      setState("failed");
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1600);
  };
  const lines = codeLines(code);
  const status =
    state === "copied"
      ? labels.codeCopied
      : state === "failed"
        ? labels.copyFailed
        : labels.copyCode;
  return (
    <figure className="m-0 overflow-hidden rounded-xl border border-border bg-muted/50">
      <figcaption className="flex h-9 items-center justify-between gap-3 pl-4 pr-1.5 text-xs text-muted-foreground">
        <span className="truncate font-mono">
          {language || labels.plainText}
        </span>
        <button
          type="button"
          onClick={copy}
          aria-label={status}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 outline-none transition-colors hover:bg-background/80 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {state === "copied" ? (
            <Check aria-hidden="true" className="size-3.5" />
          ) : (
            <Copy aria-hidden="true" className="size-3.5" />
          )}
          <span>{status}</span>
        </button>
      </figcaption>
      <pre className="m-0 overflow-x-auto px-4 pb-4 pt-0.5 font-mono text-[13px] leading-6 text-foreground/90">
        <code>
          {lines.map((line, index) => (
            <span key={line.offset}>
              <AgentCodeLine code={line.content} tokens={tokens?.[index]} />
              {index < lines.length - 1 ? "\n" : null}
            </span>
          ))}
        </code>
      </pre>
    </figure>
  );
}

const HEADING_CLASS = [
  "mt-8 text-2xl font-semibold tracking-tight",
  "mt-8 text-xl font-semibold tracking-tight",
  "mt-6 text-lg font-semibold",
  "mt-6 text-base font-semibold",
  "mt-4 text-sm font-semibold",
  "mt-4 text-sm font-semibold text-muted-foreground",
];
const ALIGN_CLASS = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
} as const;

// Parsed Markdown is immutable for a given content string, so a node's position is its identity.
function Blocks({
  blocks,
  labels,
  prefix,
}: {
  blocks: ArtifactBlock[];
  labels: ArtifactMarkdownLabels;
  prefix: string;
}) {
  return blocks.map((block, index) => {
    const key = `${prefix}.${index}`;
    switch (block.type) {
      case "heading": {
        const Tag = `h${block.level}` as const;
        return (
          <Tag
            key={key}
            className={cn(
              "text-foreground first:mt-0",
              HEADING_CLASS[block.level - 1],
            )}
          >
            {renderArtifactInline(block.text, key)}
          </Tag>
        );
      }
      case "paragraph":
        return <p key={key}>{renderArtifactInline(block.text, key)}</p>;
      case "code":
        return (
          <MarkdownCodeBlock
            key={key}
            code={block.code}
            language={block.language}
            labels={labels}
          />
        );
      case "rule":
        return <hr key={key} className="my-6 border-border" />;
      case "quote":
        return (
          <blockquote
            key={key}
            className="space-y-3 border-l-2 border-border pl-4 text-muted-foreground"
          >
            <Blocks blocks={block.blocks} labels={labels} prefix={key} />
          </blockquote>
        );
      case "table":
        return <ArtifactTable key={key} table={block} prefix={key} />;
      case "list":
        return (
          <ArtifactList key={key} list={block} labels={labels} prefix={key} />
        );
      default:
        return null;
    }
  });
}

function ArtifactTable({
  table,
  prefix,
}: {
  table: Extract<ArtifactBlock, { type: "table" }>;
  prefix: string;
}) {
  const align = (column: number) =>
    table.align[column] && ALIGN_CLASS[table.align[column]];
  const cells = (row: string[], rowKey: string, header: boolean) =>
    row.map((cell, column) => {
      const key = `${rowKey}.${column}`;
      if (header) {
        return (
          <th
            key={key}
            scope="col"
            className={cn(
              "whitespace-nowrap px-3 py-2 font-medium text-foreground",
              align(column),
            )}
          >
            {renderArtifactInline(cell, key)}
          </th>
        );
      }
      return (
        <td key={key} className={cn("px-3 py-2 align-top", align(column))}>
          {renderArtifactInline(cell, key)}
        </td>
      );
    });
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full border-collapse text-left text-sm">
        <thead className="bg-muted/50">
          <tr>{cells(table.header, `${prefix}.h`, true)}</tr>
        </thead>
        <tbody>
          {table.rows.map((row, rowIndex) => {
            const key = `${prefix}.r${rowIndex}`;
            return (
              <tr key={key} className="border-t border-border">
                {cells(row, key, false)}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ArtifactList({
  list,
  labels,
  prefix,
}: {
  list: Extract<ArtifactBlock, { type: "list" }>;
  labels: ArtifactMarkdownLabels;
  prefix: string;
}) {
  const items = list.items.map((item, itemIndex) => {
    const key = `${prefix}.${itemIndex}`;
    // A task checkbox takes the marker's place so its text lines up with sibling items.
    return (
      <li
        key={key}
        className={cn(
          "space-y-2 pl-1 marker:text-muted-foreground",
          item.checked !== null &&
            "-ml-5 flex list-none items-start gap-2 pl-0",
        )}
      >
        {item.checked !== null && (
          <span
            className={cn(
              "mt-1.5 grid size-4 shrink-0 place-items-center rounded border",
              item.checked
                ? "border-foreground bg-foreground text-background"
                : "border-muted-foreground/50",
            )}
          >
            {item.checked && <Check aria-hidden="true" className="size-3" />}
            <span className="sr-only">
              {item.checked ? labels.taskDone : labels.taskOpen}
            </span>
          </span>
        )}
        <div className="min-w-0 space-y-2">
          <Blocks blocks={item.blocks} labels={labels} prefix={key} />
        </div>
      </li>
    );
  });
  const className = cn(
    "space-y-1.5 pl-6",
    list.ordered ? "list-decimal" : "list-disc",
  );
  return list.ordered ? (
    <ol start={list.start} className={className}>
      {items}
    </ol>
  ) : (
    <ul className={className}>{items}</ul>
  );
}

export function ArtifactMarkdown({
  content,
  labels,
  className,
}: {
  content: string;
  labels: ArtifactMarkdownLabels;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "space-y-4 break-words text-sm leading-7 text-foreground/90",
        className,
      )}
    >
      <Blocks
        blocks={parseArtifactMarkdown(content)}
        labels={labels}
        prefix="b"
      />
    </div>
  );
}
