import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Unit tests: no database or network. Integration tests live in vitest.integration.config.ts.
export default defineConfig({
  // SWC instead of esbuild, so NestJS decorator metadata exists in tests too.
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
    include: ['apps/*/test/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'apps/web/**', '**/*.int.test.ts'],
  },
});
