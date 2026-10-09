import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { Options } from 'tsup';

function dependencyNames(manifest: string): string[] {
  const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { dependencies?: Record<string, string> };
  return Object.keys(pkg.dependencies ?? {});
}

/**
 * Bundles an app together with the @lp/* workspace packages (shipped as TypeScript source).
 * Every npm dependency of the app or of any workspace package stays external and is installed
 * in the image, so CommonJS packages such as pg are never pulled into the ESM bundle.
 */
export function appBundle(appDir: string, entry: Record<string, string>): Options {
  // Apps live at <root>/apps/<name>. (tsup bundles its config, so this file cannot use its own location.)
  const root = path.resolve(appDir, '../..');
  const manifests = [
    path.join(appDir, 'package.json'),
    ...readdirSync(path.join(root, 'packages')).map((p) => path.join(root, 'packages', p, 'package.json')),
  ];
  const external = [...new Set(manifests.flatMap(dependencyNames))].filter((d) => !d.startsWith('@lp/'));
  return {
    entry,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    noExternal: [/^@lp\//],
    // A package and its subpaths, e.g. drizzle-orm and drizzle-orm/pg-core. Package names only contain . as a regex character.
    external: external.map((d) => new RegExp(`^${d.replaceAll('.', '\\.')}(/|$)`)),
    sourcemap: true,
    clean: true,
  };
}
