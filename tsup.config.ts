import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/cli/index.ts' },
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  clean: true,
  splitting: true,
  sourcemap: true,
  treeshake: true,
});
