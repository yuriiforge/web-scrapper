import { Body, ConflictException, Controller, Get, Inject, Post } from '@nestjs/common';
import { clients, type Db } from '@lp/db';
import { createClientSchema } from '@lp/shared';
import { asc } from 'drizzle-orm';
import type { z } from 'zod';
import { PG_UNIQUE_VIOLATION, pgCode } from '../common/pg-errors';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { DB } from '../tokens';

@Controller('clients')
export class ClientsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  list() {
    return this.db.select().from(clients).orderBy(asc(clients.name));
  }

  @Post()
  async create(@Body(new ZodValidationPipe(createClientSchema)) body: z.infer<typeof createClientSchema>) {
    try {
      const [row] = await this.db.insert(clients).values(body).returning();
      return row;
    } catch (err) {
      if (pgCode(err) === PG_UNIQUE_VIOLATION) throw new ConflictException({ error: 'conflict', field: 'name' });
      throw err;
    }
  }
}
