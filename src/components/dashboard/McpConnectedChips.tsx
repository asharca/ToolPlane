import Link from "next/link";
import { Bot, MessageSquare } from "lucide-react";

export type McpConnectedObject = {
  id: string;
  name: string;
  href: string;
  kind: "agent" | "assistant";
};

/** Agents and Assistants bound to an MCP deployment, linking to their settings. */
export function McpConnectedChips({
  objects,
}: {
  objects: McpConnectedObject[];
}) {
  return (
    <ul className="flex min-w-0 flex-wrap gap-1.5">
      {objects.map((object) => {
        const Icon = object.kind === "agent" ? Bot : MessageSquare;
        return (
          <li key={`${object.kind}:${object.id}`} className="min-w-0">
            <Link
              href={object.href}
              title={object.name}
              className="inline-flex h-7 max-w-[16rem] items-center gap-1.5 rounded-full border border-border bg-card px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
            >
              <Icon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{object.name}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
