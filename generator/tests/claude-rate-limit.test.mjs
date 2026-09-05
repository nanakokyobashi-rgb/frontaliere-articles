import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { detectClaudeRateLimit } from '../../scripts/ci/claude-rate-limit.mjs';
import { formatDeliveredDespiteMaxTurnsComment } from '../../scripts/ci/mark-claude-terminal-outcome.mjs';

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

// Morte al cap DOPO la consegna: il verdetto segue il lavoro, non l'exit della CLI.
// Su 124 issue con marker `max-turns` in 5 giorni (sito, 2026-09-05) 74 avevano una PR
// e tutte e 74 erano MERGED. Il marker sbagliato non e' cosmetico: `max-turns` sta in
// `PREPASS_VERDICT_BEATS_FAMILY` del drainer e manda la issue in `needs-human`.
describe('marker della consegna nonostante error_max_turns', () => {
  it('e\' `pr-created` e porta il numero della PR', () => {
    const body = formatDeliveredDespiteMaxTurnsComment(7441);
    assert.ok(body.includes('<!-- FIX_OUTCOME: pr-created -->'));
    assert.ok(body.includes('#7441'));
    assert.ok(!body.includes('<!-- FIX_OUTCOME: max-turns -->'));
  });

  it('non contiene BACKSTOP_MARKER, altrimenti il drainer lo scarta', () => {
    // `latestFixOutcomeFromComments` salta i commenti con 'post-step deterministico':
    // un marker che la contenesse sarebbe invisibile e la issue tornerebbe
    // «run morta, ri-tentabile».
    assert.ok(!formatDeliveredDespiteMaxTurnsComment(1).includes('post-step deterministico'));
  });
});
