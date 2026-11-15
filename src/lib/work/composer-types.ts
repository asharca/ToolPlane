import { z } from "zod";

export const ComposerReferenceSchema = z
  .object({
    kind: z.enum(["file", "session", "resource", "skill", "agent"]),
    id: z.string().min(1).max(4000),
    deploymentId: z.string().min(1).max(200).optional(),
    targetKind: z.enum(["local", "remote"]).optional(),
    label: z.string().min(1).max(1000),
    text: z.string().min(1).max(20_000),
  })
  .strict()
  .refine(
    (item) => (item.kind === "agent") === (item.targetKind !== undefined),
    {
      message: "Agent references require a target kind.",
    },
  );

export const ComposerReferencesSchema = z
  .array(ComposerReferenceSchema)
  .max(10)
  .default([])
  .refine(
    (items) =>
      items.reduce((total, item) => total + item.text.length, 0) <= 60_000,
  );

export type ComposerReference = z.infer<typeof ComposerReferenceSchema>;
export type ComposerItem = {
  kind: ComposerReference["kind"] | "folder";
  id: string;
  label: string;
  description?: string;
  deploymentId?: string;
  targetKind?: "local" | "remote";
};

export function composerTrigger(text: string, start: number, end = start) {
  if (start !== end) return null;
  const match = text.slice(0, start).match(/(?:^|\s)([/@])([^\s]*)$/);
  if (!match || (match[1] === "/" && match[2].includes("/"))) return null;
  return {
    symbol: match[1] as "/" | "@",
    query: match[2],
    start: start - match[2].length - 1,
    end: start,
  };
}
