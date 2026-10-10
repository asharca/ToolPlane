"use client";

import { useMemo } from "react";
import { mermaid } from "@streamdown/mermaid";
import { SafeStreamdown } from "@/components/dashboard/SafeStreamdown";
import { assistantCodeRenderers } from "@/components/dashboard/ConversationMessage";

export default function MermaidAssistantMarkdown({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  const renderers = useMemo(() => assistantCodeRenderers(text), [text]);
  return (
    <SafeStreamdown
      assistant
      mode={streaming ? "streaming" : "static"}
      parseIncompleteMarkdown={streaming}
      isAnimating={streaming}
      plugins={{ mermaid, renderers }}
      mermaid={{ config: { securityLevel: "strict" } }}
      preserveSoftBreaks
      linkSafety={{ enabled: true }}
    >
      {text}
    </SafeStreamdown>
  );
}
