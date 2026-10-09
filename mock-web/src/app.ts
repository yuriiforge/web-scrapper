import express, { type ErrorRequestHandler, type Express } from 'express';
import { adminRouter } from './admin.js';
import type { Config } from './config.js';
import { createContext, type Ctx } from './context.js';
import { HttpError } from './lib/http.js';
import { requestLog } from './middleware/requestLog.js';
import { itemCounts } from './seed/generate.js';
import { agoraRouter } from './sites/agora.js';
import { chirpRouter } from './sites/chirp.js';
import { passgateRouter } from './sites/passgate.js';
import { ratewellRouter } from './sites/ratewell.js';
import { threaditRouter } from './sites/threadit.js';

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>mock-web</title></head>
<body>
<h1>mock-web</h1>
<ul>
<li><a href="/threadit/">Threadit</a> &mdash; OAuth JSON API</li>
<li><a href="/agora/">Agora</a> &mdash; forum</li>
<li><a href="/ratewell/">Ratewell</a> &mdash; reviews</li>
<li><a href="/passgate/">PassGate</a> &mdash; unblocker API</li>
<li><a href="/chirp/">Chirp</a> &mdash; paid posts API</li>
<li><a href="/_admin/state">Admin state</a></li>
</ul>
</body>
</html>
`;

export function createApp(config: Config): { app: Express; ctx: Ctx } {
  const ctx = createContext(config);
  const app = express();
  app.disable('x-powered-by');
  // Agora sets its own strong ETags; nothing else should get one implicitly.
  app.set('etag', false);

  // Middleware order for sites: request log, chaos, authentication, rate limit, handler.
  app.use(requestLog(ctx));

  app.get('/_health', (_req, res) => {
    const counts = itemCounts(ctx.corpus);
    res.json({ status: 'ok', seed: config.seed, items: Object.values(counts).reduce((a, b) => a + b, 0) });
  });
  app.get('/', (_req, res) => {
    res.type('html').send(INDEX_HTML);
  });

  app.use('/_admin', adminRouter(ctx));
  app.use('/threadit', threaditRouter(ctx));
  app.use('/agora', agoraRouter(ctx));
  app.use('/ratewell', ratewellRouter(ctx));
  app.use('/passgate', passgateRouter(ctx));
  app.use('/chirp', chirpRouter(ctx));

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (res.headersSent) return;
    if (err instanceof HttpError) return void res.status(err.status).json(err.body);
    const e = err as { type?: string; status?: number };
    if (e.type === 'entity.parse.failed') return void res.status(400).json({ error: 'bad_request', field: 'body' });
    ctx.log.error({ err }, 'unhandled error');
    res.status(500).json({ error: 'internal' });
  };
  app.use(onError);

  return { app, ctx };
}
