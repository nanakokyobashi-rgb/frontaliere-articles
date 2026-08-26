/**
 * ── L'ORDINE PREMIAVA L'INUTILIZZO, NON L'AFFIDABILITA' (#435) ──────────────
 *
 * `sortChainByScore` ordinava sulla somma additiva `_modelScores`, decaduta
 * per tempo trascorso da `_decayScore` AL LOAD e poi ripersistita come nuovo
 * valore assoluto: il decadimento composto a ogni tocco invece che una volta
 * per intervallo reale. Un modello chiamato di continuo resta sempre nella
 * fascia "meno di un'ora dall'ultimo uso" e non riceve mai sollievo (somma
 * senza limite), mentre un modello rotto ma raggiunto di rado viene
 * ripetutamente riportato verso zero a ogni load: nel ledger di produzione
 * (2026-08-18) questo mandava `gemini-2.0-flash` (0 successi / 1.122
 * fallimenti, score -41) PRIMA di `gpt-4.1` (2.585/3.585 = 72%, score -46).
 *
 * La fix ordina su un TASSO di successo Laplace-smoothed calcolato dai
 * contatori affidabili `successes`/`failures` (increment atomico, vedi
 * score-ledger-persistence.test.mjs) invece che sulla somma che decade. Un
 * tasso non dipende dal volume: un modello 0/N non puo' mai superare un
 * modello con un tasso di successo reale, qualunque sia N.
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';

import {
  AI_MODELS,
  getPreferredModel,
  recordModelSuccess,
  recordModelFailure,
  resetState,
} from '../scripts/lib/ai-models.mjs';

const BROKEN = AI_MODELS.CLAUDE_CLI_HAIKU;
// Un secondo id di catena con provider key finta disponibile — stesso
// espediente di ai-models-prefer-per-call.test.mjs.
const RELIABLE = 'nvidia/meta/llama-3.1-8b-instruct';

const ENV_KEYS = ['NVIDIA_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ENABLE_HAIKU_ARTICLE_FALLBACK'];
let _envBackup = {};

beforeEach(() => {
  _envBackup = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  resetState();
  process.env.NVIDIA_API_KEY = 'dummy-per-test';
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'dummy-per-test';
  process.env.ENABLE_HAIKU_ARTICLE_FALLBACK = 'true';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (_envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = _envBackup[k];
  }
  resetState();
});

describe('sortChainByScore ordina per tasso di successo, non per somma che decade', () => {
  it('0 successi su molti tentativi non batte mai un 70% affidabile, a qualunque volume', () => {
    // Rispecchia la misura del ledger: 0/1.122 contro un modello al 72%.
    for (let i = 0; i < 1122; i++) recordModelFailure(BROKEN);
    for (let i = 0; i < 2585; i++) recordModelSuccess(RELIABLE);
    for (let i = 0; i < 1000; i++) recordModelFailure(RELIABLE);

    assert.equal(
      getPreferredModel({ chain: [BROKEN, RELIABLE] }),
      RELIABLE,
      'un modello a 0 successi assoluti e\' uscito prima di uno al 72%: la formula premia ancora la recenza, non l\'affidabilita\'',
    );
  });

  it('resta vero anche quando il modello rotto ha ordini di grandezza in piu\' di tentativi', () => {
    // Volume fortemente sbilanciato a favore del modello rotto: se
    // l'ordinamento fosse ancora una somma additiva, il volume da solo
    // potrebbe far pendere il confronto. Un tasso non ci cade.
    for (let i = 0; i < 50_000; i++) recordModelFailure(BROKEN);
    for (let i = 0; i < 7; i++) recordModelSuccess(RELIABLE);
    for (let i = 0; i < 3; i++) recordModelFailure(RELIABLE); // 7/10 = 70%

    assert.equal(
      getPreferredModel({ chain: [BROKEN, RELIABLE] }),
      RELIABLE,
      '50.000 fallimenti non devono mai pesare quanto un tasso di successo reale, per quanto pochi siano i tentativi che lo misurano',
    );
  });

  it('un modello mai chiamato (nessuno storico) e\' considerato neutro, non peggiore di uno rotto', () => {
    // Nessun successo/fallimento registrato per nessuno dei due: a parita' di
    // tasso (il prior neutro 0.5 di entrambi) l'ordine originale decide.
    assert.equal(
      getPreferredModel({ chain: [BROKEN, RELIABLE] }),
      BROKEN,
      'senza storico i due modelli sono alla pari: vince il primo della catena, non uno dei due per costruzione',
    );
  });
});
