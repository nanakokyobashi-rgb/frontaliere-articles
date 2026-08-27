/**
 * ── IL TIER CHE NON VENIVA MAI RAGGIUNTO (issue #379, passo 2) ──────────────
 *
 * `claude-cli/haiku` e' tier-0 (`AI_COMPETING_TIERS`, dal 2026-07-29): il suo
 * TIER compete su score reale contro ogni modello normale invece di affondare
 * in coda per costruzione. Ma competere non e' vincere.
 *
 * ── COSA E' CAMBIATO IL 2026-08-18 (issue #402) ─────────────────────────────
 *
 * Fino a quel giorno `AI_MODELS_PREFER` girava PRIMA di `sortChainByScore`,
 * con `DEFAULT_MODELS_PREFER = [claude-cli/haiku]`. Due scelte sbagliate
 * insieme, e il file le ha corrette entrambe:
 *
 *   PRIMA del sort la preferenza sposta solo il tiebreak d'INDICE, cioe' conta
 *   unicamente a parita' di tier E di punteggio. Nel ledger reale
 *   (`ai_model_scores/_all`, 2026-08-18) haiku e' a -666 e
 *   `nvidia/meta/llama-3.1-8b-instruct` a +35.315: la parita' non si presenta
 *   mai, e infatti su 6 run su 6 di `generate-article.yml` il log dice
 *   «claude-cli not reached this run». Ora la preferenza gira DOPO il sort.
 *
 *   Il DEFAULT non era solo inefficace, era attivo dove non lo si voleva: con
 *   lo score store irraggiungibile tutti i punteggi valgono 0, la parita'
 *   diventa universale e il default dirottava ogni chiamata di ogni processo
 *   su un modello a pagamento. Il sito lo aveva gia' scritto come gate
 *   (`ai-models-competing-tiers.test.ts`). Ora il default e' vuoto.
 *
 * La decisione del proprietario («porta Haiku al primo livello») vive dove
 * serve: `opts.prefer` sulla chiamata che genera il corpo dell'articolo, in
 * `create-article.mjs`. Vedi `ai-models-prefer-per-call.test.mjs`.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  AI_MODELS,
  DEFAULT_CHAIN,
  DEFAULT_MODELS_PREFER,
  applyModelsPrefer,
  resetState,
} from '../scripts/lib/ai-models.mjs';

/** Esegue `fn` con AI_MODELS_PREFER impostata a `value` (undefined = cancellata). */
function conEnv(value, fn) {
  const orig = process.env.AI_MODELS_PREFER;
  if (value === undefined) delete process.env.AI_MODELS_PREFER;
  else process.env.AI_MODELS_PREFER = value;
  try {
    return fn();
  } finally {
    if (orig === undefined) delete process.env.AI_MODELS_PREFER;
    else process.env.AI_MODELS_PREFER = orig;
  }
}

describe('AI_MODELS_PREFER — riordina senza troncare', () => {
  it('il default e\' VUOTO: nessuna preferenza spedita a ogni processo', () => {
    assert.deepEqual(
      DEFAULT_MODELS_PREFER,
      [],
      'un default non vuoto torna a dirottare OGNI chiamata di OGNI processo sul '
      + 'modello elencato appena lo score store non e\' raggiungibile (tutti i punteggi '
      + 'a 0 → parita\' universale), e la quota del piano Max e\' condivisa con '
      + 'pr-review-loop.yml e issue-fix.yml. La preferenza va messa per-chiamata '
      + 'con opts.prefer, non qui.',
    );
  });

  it('senza env la catena reale resta esattamente quella di prima', () => {
    conEnv(undefined, () => {
      const chain = applyModelsPrefer([...DEFAULT_CHAIN]);
      assert.deepEqual(chain, DEFAULT_CHAIN);
    });
  });

  it('riordina senza troncare: nessun modello sparisce e nessuno si duplica', () => {
    const chain = ['a', 'b', 'c', 'd', 'e'];
    conEnv('d,b', () => {
      const out = applyModelsPrefer(chain);
      assert.deepEqual(out, ['d', 'b', 'a', 'c', 'e']);
      assert.equal(out.length, chain.length);
      assert.deepEqual([...out].sort(), [...chain].sort());
    });
  });

  it('stringa vuota esplicita ("") e\' la leva di rollback: nessuna preferenza', () => {
    const chain = ['a', 'b', 'c'];
    conEnv('', () => assert.deepEqual(applyModelsPrefer(chain), chain));
  });

  it('un id assente dalla catena viene ANTEPOSTO, non scartato', () => {
    // Cambio deliberato rispetto al vecchio comportamento del corpus, che lo
    // scartava: vince la scelta del sito, perche' e' l'unica che garantisce che
    // il modello preferito venga davvero tentato. Stessa semantica di
    // `opts.model` per un id sconosciuto — una preferenza per un modello che
    // questa catena non elenca e' una preferenza, non un refuso.
    const chain = ['a', 'b', 'c'];
    conEnv('not-in-chain,b', () => {
      assert.deepEqual(applyModelsPrefer(chain), ['not-in-chain', 'b', 'a', 'c']);
    });
  });

  it('opts.prefer vince sulla variabile d\'ambiente', () => {
    // Il per-chiamata e' piu' specifico del per-processo: se il chiamante ha
    // dichiarato un preferito per QUESTA chiamata, e' quello che conta.
    const chain = ['a', 'b', 'c'];
    conEnv('c', () => assert.deepEqual(applyModelsPrefer(chain, ['b']), ['b', 'a', 'c']));
  });

  it('prefer whitespace-only ("   ") avvisa invece di sparire in silenzio (issue #626)', () => {
    // `'   '` e' truthy al guard `!prefer` (il chiamante ha mandato QUALCOSA),
    // ma `.trim()` la riduceva a stringa vuota e sopprimeva il warning proprio
    // nel caso peggiore: nessuna voce utilizzabile, nessun segnale. Il guard
    // deve leggere `.length`, non `.trim()`.
    resetState();
    const chain = ['a', 'b', 'c'];
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      const out = applyModelsPrefer(chain, '   ');
      assert.deepEqual(out, chain, 'nessuna voce utilizzabile: la catena non deve cambiare');
      assert.equal(warnings.length, 1, 'il prefer whitespace-only deve produrre esattamente un warning');
      assert.match(warnings[0], /non ha voci utilizzabili/);
    } finally {
      console.warn = origWarn;
      resetState();
    }
  });
});
