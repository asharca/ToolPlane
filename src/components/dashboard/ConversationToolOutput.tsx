"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { CopyButton } from "@/components/dashboard/CopyButton";
import { FilePreviewDialog } from "@/components/dashboard/FilePreviewDialog";
import {
  ToolPayload,
  toolOutputText,
} from "@/components/dashboard/ConversationMessage";

function formatPayload(value: unknown): string {
  return typeof value === "string"
    ? value
    : (JSON.stringify(value, null, 2) ?? "");
}

/** Only bounded, inline JPEG/PNG bytes become image sources, never tool-provided URLs. */
function imageSource(part: Record<string, unknown>): string | undefined {
  const { data, mimeType } = part;
  if (
    (mimeType !== "image/jpeg" && mimeType !== "image/png") ||
    typeof data !== "string" ||
    !data.length ||
    data.length > 204_800 ||
    data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
  )
    return;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  if ((data.length / 4) * 3 - padding > 153_600) return;
  if (
    mimeType === "image/jpeg"
      ? !data.startsWith("/9j/")
      : !data.startsWith("iVBORw0KGgo")
  )
    return;
  return `data:${mimeType};base64,${data}`;
}

type OutputPart =
  | { kind: "text" | "json"; text: string }
  | { kind: "image"; source?: string; mimeType: string };

/** Content identity survives unrelated insertions; repeated content stays distinct. */
function keyedParts(parts: OutputPart[]): (OutputPart & { id: string })[] {
  const occurrences = new Map<string, number>();
  return parts.map((part) => {
    const content =
      part.kind === "image" ? (part.source ?? part.mimeType) : part.text;
    let hash = 2166136261;
    for (let offset = 0; offset < content.length; offset++) {
      hash = Math.imul(hash ^ content.charCodeAt(offset), 16777619);
    }
    const identity = `${part.kind}-${content.length}-${(hash >>> 0).toString(36)}`;
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return { ...part, id: `${identity}-${occurrence}` };
  });
}

function outputView(value: unknown): {
  parts: (OutputPart & { id: string })[];
  copyText: string;
  metadata?: string;
} {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      // Ordinary tool text is not required to be JSON.
    }
  }
  const record =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  if (
    record &&
    Array.isArray(record.content) &&
    record.content.some((part) => part?.type === "image")
  ) {
    const { content, ...metadata } = record;
    const parts: OutputPart[] = [];
    const copyContent = (content as unknown[]).map((part) => {
      if (part && typeof part === "object" && !Array.isArray(part)) {
        const item = part as Record<string, unknown>;
        if (item.type === "image") {
          parts.push({
            kind: "image",
            source: imageSource(item),
            mimeType: typeof item.mimeType === "string" ? item.mimeType : "",
          });
          // Invalid images are also omitted from the default text/copy view.
          return { type: "image", mimeType: item.mimeType };
        }
        if (item.type === "text" && typeof item.text === "string") {
          parts.push({ kind: "text", text: item.text });
          return item;
        }
      }
      parts.push({ kind: "json", text: formatPayload(part) });
      return part;
    });
    return {
      parts: keyedParts(parts),
      copyText: formatPayload({ content: copyContent, ...metadata }),
      metadata: Object.keys(metadata).length
        ? formatPayload(metadata)
        : undefined,
    };
  }
  const plain = toolOutputText(parsed);
  const text = plain ?? formatPayload(parsed);
  return {
    parts: keyedParts([{ kind: plain === undefined ? "json" : "text", text }]),
    copyText: text,
  };
}

function ToolImage({
  source,
  mimeType,
  index,
}: {
  source?: string;
  mimeType: string;
  index: number;
}) {
  const t = useTranslations("console.agents");
  const preview = useTranslations("filePreview");
  const [open, setOpen] = useState(false);
  const [failedSource, setFailedSource] = useState<string>();
  const name = t("toolImage", { index });
  const unavailable = t("toolImageUnavailable");
  const load = useCallback(
    async (signal: AbortSignal) => {
      if (!source) throw new Error(unavailable);
      const response = await fetch(source, { signal });
      if (!response.ok) throw new Error(unavailable);
      return response.blob();
    },
    [source, unavailable],
  );
  if (!source || failedSource === source) {
    return <p className="text-xs text-muted-foreground">{unavailable}</p>;
  }
  return (
    <>
      <button
        type="button"
        aria-label={preview("open", { name })}
        onClick={() => setOpen(true)}
        className="block max-w-full overflow-hidden rounded-lg border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {/* biome-ignore lint/performance/noImgElement: Bounded inline tool images must render directly without the external image optimizer. */}
        <img
          src={source}
          alt={name}
          loading="lazy"
          onError={() => setFailedSource(source)}
          className="max-h-64 max-w-full object-contain"
        />
      </button>
      <FilePreviewDialog
        open={open}
        onOpenChange={setOpen}
        name={`${name}.${mimeType === "image/png" ? "png" : "jpg"}`}
        mimeType={mimeType}
        load={load}
      />
    </>
  );
}

/** Shared by live/history parent tools and child activity results. */
export function ConversationToolOutput({
  value,
  label,
}: {
  value: unknown;
  label: ReactNode;
}) {
  const common = useTranslations("common");
  const view = useMemo(() => outputView(value), [value]);
  let imageIndex = 0;
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{label}</span>
        <CopyButton text={view.copyText} label={common("copy")} iconOnly />
      </div>
      {view.parts.map((part) =>
        part.kind === "image" ? (
          <ToolImage
            key={part.id}
            source={part.source}
            mimeType={part.mimeType}
            index={++imageIndex}
          />
        ) : (
          <ToolPayload key={part.id} language={part.kind}>
            {part.text}
          </ToolPayload>
        ),
      )}
      {view.metadata !== undefined ? (
        <ToolPayload language="json">{view.metadata}</ToolPayload>
      ) : null}
    </div>
  );
}
