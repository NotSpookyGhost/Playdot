// Offline filter only: no requests, environment inspection or credential reads.
import { createInterface } from 'node:readline';
import { sanitizedDiagnostic } from '../dist/apps/server/src/diagnostics.js';
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const safe = sanitizedDiagnostic(line);
  if (safe) console.log(safe);
}
