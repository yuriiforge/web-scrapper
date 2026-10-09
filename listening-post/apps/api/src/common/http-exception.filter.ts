import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';

const CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  422: 'unprocessable',
  429: 'rate_limited',
};

/**
 * Every error leaves the API as `{ "error": "<code>", ... }`. Exceptions thrown with a body that
 * already has an `error` string keep it; Nest's built-in ones are mapped by status code.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly log = new Logger('HttpExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const own =
        typeof body === 'object' &&
        body !== null &&
        typeof (body as { error?: unknown }).error === 'string' &&
        !('statusCode' in body);
      res.status(status).json(own ? body : { error: CODES[status] ?? (status >= 500 ? 'internal' : 'error') });
      return;
    }
    this.log.error(exception);
    res.status(500).json({ error: 'internal' });
  }
}
