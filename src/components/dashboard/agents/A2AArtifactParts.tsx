"use client";

import { ConversationContentBlocks } from "@/components/dashboard/ConversationContentBlocks";
import {
  a2aWireContentParts,
  type A2AWirePart,
} from "@/lib/conversation/a2a-parts";

export function A2AArtifactParts({
  taskId,
  name,
  parts,
  producer,
}: {
  taskId: string;
  name: string;
  parts: A2AWirePart[];
  producer?: string;
}) {
  return (
    <ConversationContentBlocks
      messageId={`${taskId}:${name}`}
      parts={a2aWireContentParts(parts, { taskId, producer })}
      streaming={false}
    />
  );
}
