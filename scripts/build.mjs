import { cp, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
await mkdir('dist/packages/db/migrations', { recursive: true });
await cp('packages/db/migrations/001_spike.sql', 'dist/packages/db/migrations/001_spike.sql');
