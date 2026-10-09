import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Integration tests: need Postgres (docker compose up -d postgres) and the sibling ../mock-web
// folder with its dependencies installed. They share one test database, so files run one at a time.
export default defineConfig({
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: 'es2022',
      },
    }),
  ],
  test: {
    include: ['**/*.int.test.ts'],
    exclude: ['**/node_modules/**'],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
