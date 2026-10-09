import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { itemCounts } from './seed/generate.js';

const config = loadConfig(process.env);
const { app, ctx } = createApp(config);

const server = app.listen(config.port, () => {
  ctx.log.info(
    { port: config.port, seed: config.seed, mockNow: new Date(ctx.corpus.now).toISOString(), items: itemCounts(ctx.corpus) },
    'mock-web listening',
  );
});

const shutdown = (signal: string) => {
  ctx.log.info({ signal }, 'shutting down');
  server.close(() => process.exit(0));
  // Chaos timeouts can hold sockets for 30 s; don't wait for them.
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
