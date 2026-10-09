import type { apiEnv } from '@lp/shared';
import type { z } from 'zod';

export type ApiEnv = z.infer<typeof apiEnv>;
