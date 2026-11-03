import { z } from "zod";

const Mime = z.enum([
  "text/plain",
  "text/markdown",
  "text/x-diff",
  "application/json",
  "application/octet-stream",
]);
const ArtifactPart = z
  .object({
    text: z.string().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
    raw: z.string().optional(),
    mediaType: Mime.optional(),
    filename: z.string().min(1).max(100).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine(
    (part) =>
      [part.text, part.data, part.raw].filter((value) => value !== undefined)
        .length === 1,
  );
/** A task-owned handle or a sandbox workspace path; resolved only by the authorized runtime. */
export const LocalFileInput = z
  .object({
    fileId: z.string().min(1).max(200).optional(),
    path: z.string().min(1).max(1024).optional(),
    filename: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[^\p{Cc}/\\]+$/u)
      .optional(),
    mediaType: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/)
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      Number(value.fileId !== undefined) + Number(value.path !== undefined) ===
      1,
    "Provide exactly one fileId or workspace path.",
  );
export const LocalArtifactInput = z
  .object({
    artifactId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[\w.:-]+$/),
    name: z
      .string()
      .min(1)
      .max(100)
      .regex(/^(?![\s\S]*[\x7f/\\])[\x20-\uFFFF]+$/),
    description: z.string().max(1000).optional(),
    parts: z
      .array(z.union([ArtifactPart, LocalFileInput]))
      .min(1)
      .max(8),
  })
  .strict();
