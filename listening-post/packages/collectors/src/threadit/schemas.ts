import { z } from 'zod';

// The layout-1 shapes this collector understands. Anything else is a parse error, which is
// how a layout change on the site shows up: as a failed run with the raw response kept.

export const tokenResponse = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
  expires_in: z.number().positive(),
});

export const post = z.object({
  kind: z.literal('t3'),
  data: z.object({
    id: z.string().startsWith('t3_'),
    community: z.string(),
    title: z.string(),
    selftext: z.string(),
    author: z.string(),
    created_utc: z.number(),
    score: z.number(),
    num_comments: z.number().int().nonnegative(),
    permalink: z.string(),
  }),
});
export type Post = z.infer<typeof post>['data'];

export const comment = z.object({
  kind: z.literal('t1'),
  data: z.object({
    id: z.string().startsWith('t1_'),
    post_id: z.string(),
    body: z.string(),
    author: z.string(),
    created_utc: z.number(),
    score: z.number(),
  }),
});

export const listing = <T extends z.ZodType>(child: T) =>
  z.object({ data: z.object({ children: z.array(child), after: z.string().nullable() }) });
