import { describe, it } from 'node:test';
import { expect } from './lib/expect-shim.mjs';
import { newsUrlKey } from '../scripts/lib/source-url-ledger.mjs';

describe('stats-astra synthetic source keys', () => {
  it('keeps cadence, period and section distinct while normalizing case', () => {
    expect(newsUrlKey('stats-astra://weekly/2026-W38/frontaliere'))
      .toBe('stats-astra://weekly/2026-w38/frontaliere');
    expect(newsUrlKey('stats-astra://monthly/2026-09/svizzera'))
      .toBe('stats-astra://monthly/2026-09/svizzera');
    expect(newsUrlKey('stats-astra://monthly/2026-09/frontaliere'))
      .not.toBe(newsUrlKey('stats-astra://monthly/2026-09/svizzera'));
  });
});
