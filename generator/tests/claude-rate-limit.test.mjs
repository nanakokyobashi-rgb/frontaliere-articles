import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { detectClaudeRateLimit } from '../../scripts/ci/claude-rate-limit.mjs';

describe('detectClaudeRateLimit', () => {
  it('non confonde overage rifiutato con quota primaria esaurita quando status è allowed', () => {
    const raw = JSON.stringify([
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed',
          rateLimitType: 'five_hour',
          resetsAt: Math.floor(Date.now() / 1000) + 5 * 60 * 60,
          overageStatus: 'rejected',
          overageDisabledReason: 'out_of_credits',
          isUsingOverage: false,
        },
      },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 38,
        total_cost_usd: 0.6,
        api_error_status: null,
      },
    ]);

    assert.deepEqual(detectClaudeRateLimit(raw), {
      rateLimited: false,
      resetsAt: null,
      rateLimitType: null,
    });
  });

  it('continua a riconoscere il rifiuto della quota primaria', () => {
    const resetSeconds = Math.floor(Date.now() / 1000) + 5 * 60 * 60;
    const raw = JSON.stringify([
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'rejected',
          rateLimitType: 'five_hour',
          resetsAt: resetSeconds,
          overageStatus: 'allowed',
        },
      },
    ]);

    assert.deepEqual(detectClaudeRateLimit(raw), {
      rateLimited: true,
      resetsAt: resetSeconds,
      rateLimitType: 'five_hour',
    });
  });
});
