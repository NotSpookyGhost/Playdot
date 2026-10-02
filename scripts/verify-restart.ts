import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { postgresStore } from '../packages/db/src/store.js';
import { isolatedConfig } from '../tests/network-store.js';
import { prepareRestart, verifyRestart } from '../tests/restart-scenario.js';

try {
  const action = process.argv[2];
  const dir = process.env.PLAYDOT_EVIDENCE_DIR;
  if (!dir || !['prepare', 'verify'].includes(action ?? '')) throw new Error('Use prepare or verify with an evidence directory');
  const file = join(dir, 'restart-proof.json');
  if (action === 'prepare') {
    // Reserve once; never overwrite an earlier proof or seed existing data.
    await writeFile(file, JSON.stringify({ incomplete: true }), { flag: 'wx', mode: 0o600 });
    const { config, schema } = await isolatedConfig();
    const now = Date.now(); const store = await postgresStore(config);
    try { await prepareRestart(store, now); } finally { await store.close(); }
    await writeFile(file, JSON.stringify({ schema, now }), { mode: 0o600 });
    console.log('PREPARED synthetic restart proof. Restart test-db normally, then run verify.');
  } else {
    const evidence = JSON.parse(await readFile(file, 'utf8'));
    if (!Number.isFinite(evidence.now) || typeof evidence.schema !== 'string') throw new Error('Incomplete evidence');
    const { config } = await isolatedConfig(evidence.schema);
    const store = await postgresStore(config);
    try { await verifyRestart(store, evidence.now); } finally { await store.close(); }
    console.log('PASS: persisted permissions, revocation, suspension, encrypted review, approval/rejection, duplicate safety, pause and zero unapproved delivery. SYNTHETIC fixed-clock fixtures; not real human authentication.');
  }
} catch { console.error('Restart proof FAILED. Check isolated verification DB, evidence permissions, existing/incomplete proof and test assertions; no reset performed.'); process.exitCode = 1; }
