/** Postgres error codes the API turns into 4xx responses. */
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FOREIGN_KEY_VIOLATION = '23503';

export function pgCode(err: unknown): string | undefined {
  // drizzle wraps driver errors; the pg error is the cause.
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code ?? e.cause?.code;
}
