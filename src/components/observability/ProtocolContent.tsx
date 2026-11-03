"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { CopyButton } from "@/components/dashboard/CopyButton";
import type { BodyState, JsonValue } from "@/lib/observability/views/types";
import { cn } from "@/lib/utils";

function keyedValues(values: JsonValue[]) {
  const counts = new Map<string, number>();
  return values.map((value) => {
    const identity = JSON.stringify(value);
    const occurrence = counts.get(identity) ?? 0;
    counts.set(identity, occurrence + 1);
    return { value, key: `${identity}:${occurrence}` };
  });
}

/** Levels open on first render; deeper containers (for example tool input schemas) start folded. */
const OPEN_DEPTH = 3;

function JsonScalar({ value }: { value: string | number | boolean | null }) {
  return (
    <span
      className={cn(
        "whitespace-pre-wrap break-words",
        typeof value === "string"
          ? "text-emerald-700 dark:text-emerald-400"
          : typeof value === "number"
            ? "text-sky-700 dark:text-sky-400"
            : "text-violet-700 dark:text-violet-400",
      )}
    >
      {typeof value === "string" ? `"${value}"` : String(value)}
    </span>
  );
}

function JsonNode({
  name,
  value,
  depth,
  last,
}: {
  name?: string;
  value: JsonValue;
  depth: number;
  last: boolean;
}) {
  const [open, setOpen] = useState(depth < OPEN_DEPTH);
  const label =
    name === undefined ? null : (
      <>
        <span className="text-foreground">&quot;{name}&quot;</span>
        <span className="text-muted-foreground">: </span>
      </>
    );
  const comma = last ? null : <span className="text-muted-foreground">,</span>;
  if (value === null || typeof value !== "object")
    return (
      <div className="break-words pl-4">
        {label}
        <JsonScalar value={value} />
        {comma}
      </div>
    );
  const isArray = Array.isArray(value);
  const entries: [string | undefined, JsonValue][] = isArray
    ? value.map((item) => [undefined, item])
    : Object.entries(value);
  const [start, end] = isArray ? ["[", "]"] : ["{", "}"];
  if (!entries.length)
    return (
      <div className="pl-4">
        {label}
        <span className="text-muted-foreground">
          {start}
          {end}
        </span>
        {comma}
      </div>
    );
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="group relative block w-full rounded-sm pl-4 text-left hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "absolute left-0 top-1 size-3 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        {label}
        <span className="text-muted-foreground">{start}</span>
        {!open && (
          <>
            <span className="text-muted-foreground"> … {entries.length} </span>
            <span className="text-muted-foreground">{end}</span>
            {comma}
          </>
        )}
      </button>
      {open && (
        <>
          <div className="ml-1.5 border-l border-border/60 pl-2">
            {entries.map(([key, item], index) => (
              <JsonNode
                key={key ?? index}
                name={key}
                value={item}
                depth={depth + 1}
                last={index === entries.length - 1}
              />
            ))}
          </div>
          <div className="pl-4 text-muted-foreground">
            {end}
            {comma}
          </div>
        </>
      )}
    </div>
  );
}

/** Collapsible JSON tree for protocol bodies; nesting depth is unbounded. */
export function JsonTree({ value }: { value: JsonValue }) {
  return (
    <div className="min-w-0 overflow-x-auto font-mono text-xs leading-5">
      <JsonNode value={value} depth={0} last />
    </div>
  );
}

export function ContentBlocks({ blocks }: { blocks: JsonValue[] }) {
  const t = useTranslations("console.observability.viewer");
  return (
    <div className="space-y-3">
      {keyedValues(blocks).map(({ value: block, key }) => {
        if (block === null || typeof block !== "object" || Array.isArray(block))
          return <JsonTree key={key} value={block} />;
        const type = block.type ?? block.kind;
        if (type === "text" && typeof block.text === "string")
          return (
            <div
              key={key}
              className="whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 text-sm"
            >
              {block.text}
            </div>
          );
        const file =
          block.file !== null &&
          typeof block.file === "object" &&
          !Array.isArray(block.file)
            ? block.file
            : block;
        const mime = typeof file.mimeType === "string" ? file.mimeType : "";
        const bytes =
          typeof file.bytes === "string"
            ? file.bytes
            : typeof file.data === "string"
              ? file.data
              : null;
        if (
          (type === "image" || type === "file") &&
          bytes &&
          /^image\/(png|jpeg|gif|webp)$/.test(mime)
        ) {
          return (
            // biome-ignore lint/performance/noImgElement: Authorized protocol base64 images have unknown dimensions and must not use an external optimizer.
            <img
              key={key}
              src={`data:${mime};base64,${bytes}`}
              alt={typeof file.name === "string" ? file.name : t("image")}
              className="max-h-96 max-w-full rounded-md object-contain"
            />
          );
        }
        const resource =
          block.resource !== null &&
          typeof block.resource === "object" &&
          !Array.isArray(block.resource)
            ? block.resource
            : file;
        const uri = typeof resource.uri === "string" ? resource.uri : null;
        if (type === "resource" || type === "resource_link" || type === "file")
          return (
            <section
              key={key}
              className="space-y-2 rounded-md border border-border p-3"
            >
              <p className="text-xs font-medium text-muted-foreground">
                {typeof block.name === "string" ? block.name : t("resource")}
              </p>
              {uri &&
                (/^https?:\/\//i.test(uri) ? (
                  <a
                    href={uri}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="break-all text-sm text-primary underline"
                  >
                    {uri}
                  </a>
                ) : (
                  <code className="break-all text-xs">{uri}</code>
                ))}
              {typeof resource.text === "string" ? (
                <p className="whitespace-pre-wrap break-words text-sm">
                  {resource.text}
                </p>
              ) : (
                <JsonTree value={resource} />
              )}
            </section>
          );
        if (type === "data" && block.data !== undefined)
          return <JsonTree key={key} value={block.data} />;
        return <JsonTree key={key} value={block} />;
      })}
    </div>
  );
}

export function BodyNotice({ state }: { state: BodyState }) {
  const t = useTranslations("console.observability.viewer");
  if (state === "available") return null;
  return (
    <p
      role="status"
      className="rounded-md bg-muted p-3 text-sm text-muted-foreground"
    >
      {t(`bodyStates.${state}`)}
    </p>
  );
}

export function JsonPanel({
  title,
  value,
  children,
}: {
  title: string;
  value: JsonValue;
  children?: React.ReactNode;
}) {
  const t = useTranslations("console.observability.viewer");
  return (
    <section className="min-w-0 space-y-3 rounded-xl border border-border p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <CopyButton text={JSON.stringify(value, null, 2)} label={t("copy")} />
      </header>
      <div className="max-h-[40rem] min-w-0 overflow-auto">
        {children ?? <JsonTree value={value} />}
      </div>
    </section>
  );
}
