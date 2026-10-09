import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

/** Validates and parses a body, query or param with a Zod schema: `@Body(new ZodValidationPipe(Schema))`. */
export class ZodValidationPipe<S extends z.ZodType> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    const issue = result.error.issues[0];
    throw new BadRequestException({
      error: 'bad_request',
      field: issue?.path.join('.') || undefined,
      message: issue?.message,
    });
  }
}
