import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { createSourceSchema, updateSourceSchema, type CreateSource, type UpdateSource } from '@lp/shared';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { SourcesService } from './sources.service';

const listQuery = z.object({ clientId: z.uuid().optional() });

@Controller('sources')
export class SourcesController {
  constructor(private readonly sources: SourcesService) {}

  @Get()
  list(@Query(new ZodValidationPipe(listQuery)) query: z.infer<typeof listQuery>) {
    return this.sources.list(query.clientId);
  }

  @Post()
  create(@Body(new ZodValidationPipe(createSourceSchema)) body: CreateSource) {
    return this.sources.create(body);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.sources.get(id);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(updateSourceSchema)) body: UpdateSource) {
    return this.sources.update(id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.sources.remove(id);
  }

  /** "Run now": 202, because the run happens later in the worker. */
  @Post(':id/runs')
  @HttpCode(202)
  run(@Param('id', ParseUUIDPipe) id: string) {
    return this.sources.runNow(id);
  }

  /** Re-parse stored raw responses (202): recovers data after a parser fix, without new requests. */
  @Post(':id/reparse')
  @HttpCode(202)
  reparse(@Param('id', ParseUUIDPipe) id: string) {
    return this.sources.reparse(id);
  }

  @Get(':id/stats')
  stats(@Param('id', ParseUUIDPipe) id: string) {
    return this.sources.runStats(id);
  }
}
