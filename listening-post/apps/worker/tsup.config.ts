import { defineConfig } from 'tsup';
import { appBundle } from '../../tsup.preset';

export default defineConfig(appBundle(import.meta.dirname, { index: 'src/index.ts' }));
