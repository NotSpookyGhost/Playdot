import { defineConfig } from 'vitest/config';
export default defineConfig({ cacheDir: process.env.HOME === '/tmp' ? '/tmp/playdot-vite' : undefined, test: { testTimeout: 20000, hookTimeout: 30000, fileParallelism: false } });
