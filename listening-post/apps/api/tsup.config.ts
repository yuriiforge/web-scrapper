import { defineConfig } from 'tsup';
import { appBundle } from '../../tsup.preset';

// emitDecoratorMetadata in tsconfig makes tsup compile with SWC, which keeps the metadata NestJS needs.
export default defineConfig(
  appBundle(import.meta.dirname, { index: 'src/main.ts', migrate: '../../packages/db/src/migrate-cli.ts', seed: '../../packages/db/src/seed-cli.ts' }),
);
