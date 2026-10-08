import { z } from 'zod';

export const resourceListingSchema = z.object({
  slug: z.string().min(1).max(100),
  name: z.string().min(1).max(240),
  summary: z.string().max(4_000).nullable(),
  iconUrl: z.string().max(2_000).nullable(),
  tags: z.array(z.string().min(1).max(40)).max(20),
  author: z.string().min(1).max(240),
}).strict();

export type ResourceListingInput = z.infer<typeof resourceListingSchema>;
