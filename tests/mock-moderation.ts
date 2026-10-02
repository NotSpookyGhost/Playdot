import type { ModerationAdapter } from '../packages/domain/src/moderation.js';

/** MOCK ONLY: scripted outcomes, not a classifier, safety filter or real provider. */
export class MockModeration implements ModerationAdapter {
  readonly source = 'mock';
  result: unknown = 'allow';
  calls = 0;
  fail = false;
  hang = false;
  async evaluate(): Promise<unknown> {
    this.calls++;
    if (this.fail) throw new Error('MOCK filter exception; never reveal provider diagnostics');
    if (this.hang) return new Promise(() => {});
    return this.result;
  }
}
