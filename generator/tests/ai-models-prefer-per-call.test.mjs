/**
 * ── LA PREFERENZA CHE IL SORT CANCELLAVA ────────────────────────────────────
 *
 * Il proprietario ha deciso (issue #379, chiusa il 2026-08-15): «Porta Haiku al
 * primo livello — lo paghiamo e funziona.» Il meccanismo e' stato costruito, e
 * non funzionava.
 *
 * `DEFAULT_MODELS_PREFER` / `AI_MODELS_PREFER` passano da `applyModelsPrefer`,
 * che gira PRIMA di `sortChainByScore`. Spostare un id in testa prima del sort
 * cambia solo il TIEBREAK D'INDICE, cioe' conta unicamente a parita' di tier e
 * di punteggio. Nel ledger Firestore `ai_model_scores/_all`, letto il
 * 2026-08-18, la parita' non c'e' nemmeno per sbaglio:
 *
 *     claude-cli/haiku                      35 successi /  41 fallimenti →   -666
 *     nvidia/meta/llama-3.1-8b-instruct 171.181 successi / 3.276 fall.   → +35.315
 *
 * Contro 35.981 punti di deficit il tiebreak e' rumore: il sort rimandava haiku
 * in coda a ogni giro. Misurato su 6 run su 6 di `generate-article.yml`:
 * «last-resort: omniroute/local/claude-cli not reached this run», con il
 * binario presente sul runner, il token presente e zero ENOENT nei log.
 * Raggiungibile e sano, mai chiamato.
 *
 * ── COSA BLOCCA QUESTO FILE ─────────────────────────────────────────────────
 *
 * I due versi insieme, perche' uno solo non dimostra niente:
 *
 *   1. con la sola variabile d'ambiente il modello affondato NON esce primo
 *      — cioe' il difetto e' reale e non e' stato «riparato» rendendo globale
 *        la preferenza dura, che brucerebbe la quota Max condivisa;
 *   2. con `opts.prefer` esce primo lo stesso, malgrado il punteggio.
 *
 * Il test passa da `getPreferredModel`, non da una funzione di ordinamento
 * isolata: e' quella a rispecchiare l'ordine REALE di callLLM (morbida → sort →
 * dura) e quindi l'unica che si accorge se un giorno le due righe vengono
 * rimesse nell'ordine sbagliato.
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';

import {
  AI_MODELS,
  DEFAULT_MODELS_PREFER,
  applyModelsPrefer,
  getPreferredModel,
  getDeclaredRequestTokenLimit,
  isPerRunCallCapReached,
  recordModelSuccess,
  recordModelFailure,
  resetState,
} from '../scripts/lib/ai-models.mjs';

const HAIKU = AI_MODELS.CLAUDE_CLI_HAIKU;
// Il rivale del ledger vero. Serve solo che sia un id della catena con una
// provider key finta disponibile: il punteggio glielo diamo qui sotto.
const RIVALE = 'nvidia/meta/llama-3.1-8b-instruct';

const ENV_KEYS = [
  'AI_MODELS_PREFER',
  'AI_MODELS_FORCE_CHAIN',
  'NVIDIA_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ENABLE_HAIKU_ARTICLE_FALLBACK',
  'CLAUDE_CLI_MAX_CALLS_PER_RUN',
];
let _envBackup = {};

/** Porta il divario del ledger reale su una scala che il test puo' costruire. */
function seminaIlDivario() {
  // haiku affondato: 40 fallimenti non-retryable = -400
  for (let i = 0; i < 40; i++) recordModelFailure(HAIKU, { nonRetryable: true });
  // il rivale in cima: 200 successi = +400
  for (let i = 0; i < 200; i++) recordModelSuccess(RIVALE);
}

beforeEach(() => {
  _envBackup = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  resetState();
  // Entrambi i modelli devono risultare DISPONIBILI, altrimenti
  // getPreferredModel li salta e il test misurerebbe la disponibilita', non
  // l'ordinamento.
  process.env.NVIDIA_API_KEY = 'dummy-per-test';
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'dummy-per-test';
  process.env.ENABLE_HAIKU_ARTICLE_FALLBACK = 'true';
  delete process.env.AI_MODELS_FORCE_CHAIN;
  delete process.env.CLAUDE_CLI_MAX_CALLS_PER_RUN;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (_envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = _envBackup[k];
  }
  resetState();
});

describe('preferenza per-chiamata — sopravvive al sort per punteggio', () => {
  it('la sola variabile d\'ambiente NON recupera un modello affondato (il difetto)', () => {
    delete process.env.AI_MODELS_PREFER;
    assert.deepEqual(
      DEFAULT_MODELS_PREFER, [],
      'il default e\' tornato non vuoto: dirotta OGNI chiamata di OGNI processo '
      + 'sul modello a pagamento appena lo score store non e\' raggiungibile',
    );
    seminaIlDivario();

    // Nessuna preferenza esplicita: decide il punteggio, e haiku e' affondato.
    // E' esattamente cio' che succedeva in produzione con il default pre-sort:
    // preferenza dichiarata, effetto zero.
    assert.equal(
      getPreferredModel({ chain: [RIVALE, HAIKU] }),
      RIVALE,
      'un modello a -666 esce primo senza che nessuno lo abbia chiesto: '
      + 'la preferenza e\' tornata globale e brucia la quota Max condivisa con '
      + 'pr-review-loop.yml/issue-fix.yml',
    );
  });

  it('opts.prefer lo porta primo lo stesso, malgrado il punteggio (la fix)', () => {
    delete process.env.AI_MODELS_PREFER;
    seminaIlDivario();

    assert.equal(
      getPreferredModel({ chain: [RIVALE, HAIKU], prefer: [HAIKU] }),
      HAIKU,
      'opts.prefer viene applicata PRIMA del sort invece che dopo: '
      + 'e\' il difetto che questa PR chiude',
    );
  });

  it('la preferenza riordina e non tronca: il fallback resta intero dietro', () => {
    const catena = ['a', 'b', 'c', HAIKU, 'd'];
    assert.deepEqual(
      applyModelsPrefer(catena, [HAIKU]),
      [HAIKU, 'a', 'b', 'c', 'd'],
      'un preferito che fallisce deve cadere sulla catena che si sarebbe usata comunque',
    );
  });

  it('accetta CSV oltre all\'array, e degrada a no-op invece di lanciare', () => {
    assert.deepEqual(applyModelsPrefer(['a', 'b'], []), ['a', 'b']);
    assert.deepEqual(applyModelsPrefer(['a', 'b'], undefined), ['a', 'b']);
    // La CSV passa dalla stessa normalizzazione di opts.prefer.
    delete process.env.AI_MODELS_PREFER;
    seminaIlDivario();
    assert.equal(getPreferredModel({ chain: [RIVALE, HAIKU], prefer: `  ${HAIKU} , , ` }), HAIKU);
  });

  it('senza preferenza esplicita la catena resta quella di prima', () => {
    delete process.env.AI_MODELS_PREFER;
    seminaIlDivario();
    // Nessun opts.prefer, nessun opt-in via env → vince il punteggio. E' il
    // presidio che tiene la preferenza dura fuori da ogni chiamata che non la
    // chiede: traduzioni, meta, FAQ, classificazione.
    assert.equal(getPreferredModel({ chain: [RIVALE, HAIKU] }), RIVALE);
  });

  it('l\'opt-in esplicito via AI_MODELS_PREFER resta duro (translate-pending.yml)', () => {
    // Il sito lo usa cosi' in translate-pending.yml, e ha un gate dedicato
    // (tests/relocalize-traffic-priority.test.ts) che lo pretende efficace: se
    // questa riga tornasse pre-sort, quel workflow perderebbe Haiku in silenzio
    // con il suo gate ancora verde, perche' il gate legge lo YAML, non l'ordine.
    process.env.AI_MODELS_PREFER = HAIKU;
    seminaIlDivario();
    assert.equal(getPreferredModel({ chain: [RIVALE, HAIKU] }), HAIKU);
  });

  it('AI_MODELS_PREFER="" resta la leva di rollback istantaneo', () => {
    process.env.AI_MODELS_PREFER = '';
    seminaIlDivario();
    assert.deepEqual(applyModelsPrefer([RIVALE, HAIKU]), [RIVALE, HAIKU]);
    assert.equal(getPreferredModel({ chain: [RIVALE, HAIKU] }), RIVALE);
  });

  it('AI_MODELS_PREFER="" spegne ANCHE il prefer per-chiamata — il percorso di produzione', () => {
    // ── PERCHE' IL TEST QUI SOPRA NON BASTAVA ────────────────────────────────
    //
    // Quello chiama `applyModelsPrefer([RIVALE, HAIKU])` SENZA secondo
    // argomento, cioe' esercita il ramo env-only. In produzione quel ramo non
    // viene mai preso: `create-article.mjs` passa `prefer:
    // PREFERRED_GENERATION_MODELS` su ENTRAMBE le chiamate che generano il
    // corpo dell'articolo (la principale e il retry repair-aware). Un verde su
    // un ramo che nessuno percorre e' piu' pericoloso di un test assente,
    // perche' fa credere coperta la leva di spesa su un modello a pagamento.
    //
    // Misurato prima della fix, con AI_MODELS_PREFER="" nell'ambiente:
    //   applyModelsPrefer(['a','b'], ['claude-cli/haiku'])
    //     → ['claude-cli/haiku','a','b']
    // cioe' la leva documentata come «rollback istantaneo» non fermava nulla.
    process.env.AI_MODELS_PREFER = '';
    seminaIlDivario();

    // La forma minima, senza catena reale: e' quella che il commento della
    // funzione documenta, ed e' quella che tornava sbagliata.
    assert.deepEqual(
      applyModelsPrefer(['a', 'b'], [HAIKU]),
      ['a', 'b'],
      'la leva di rollback non spegne il prefer per-chiamata: e\' l\'unica forma '
      + 'che la produzione usa, quindi la leva non spegne NIENTE',
    );

    // E lo stesso attraverso la funzione che rispecchia l'ordine reale di
    // callLLM (morbida → sort → dura), con il divario di punteggio vero.
    assert.equal(
      getPreferredModel({ chain: [RIVALE, HAIKU], prefer: [HAIKU] }),
      RIVALE,
      'con la leva tirata callLLM sceglierebbe ancora il modello a pagamento',
    );

    // Anche in forma CSV, che e' l'altra forma accettata da `opts.prefer`.
    assert.equal(getPreferredModel({ chain: [RIVALE, HAIKU], prefer: HAIKU }), RIVALE);
  });

  it('la leva vuota non e\' «env batte per-call»: un valore NON vuoto perde ancora', () => {
    // Il contro-verso, che tiene onesta l'inversione: solo la stringa VUOTA —
    // un atto deliberato — vince sul per-call. Un `AI_MODELS_PREFER` valorizzato
    // resta l'opt-in di processo, meno specifico della preferenza per-chiamata,
    // esattamente come prima. Senza questa riga la fix del rollback potrebbe
    // degenerare in «l'ambiente comanda sempre», che romperebbe la ragione
    // stessa per cui `opts.prefer` esiste.
    process.env.AI_MODELS_PREFER = RIVALE;
    seminaIlDivario();
    assert.equal(getPreferredModel({ chain: [RIVALE, HAIKU], prefer: [HAIKU] }), HAIKU);
  });
});

describe('cap di input dichiarato — la domanda che il prompt deve poter fare', () => {
  it('haiku e\' l\'unico senza cap dichiarato: undefined, non un numero', () => {
    assert.equal(
      getDeclaredRequestTokenLimit(HAIKU),
      undefined,
      'se haiku acquisisce un cap dichiarato, create-article.mjs deve tornare '
      + 'ad accorciare il prompt al primo tentativo — vedi _preferisceModelloSenzaCap',
    );
  });

  it('un modello free il cap ce l\'ha, e vale 8000', () => {
    assert.equal(getDeclaredRequestTokenLimit(RIVALE), 8000);
  });
});

describe('cap di chiamate per-run — la domanda che la guardia del prompt deve poter fare', () => {
  it('e\' interrogabile PRIMA di costruire il prompt, e riguarda solo claude-cli', () => {
    // A inizio run nessuna chiamata e' stata spesa: il cap non e' raggiunto.
    assert.equal(isPerRunCallCapReached(HAIKU), false);
    // E per un provider senza cap per-run la risposta e' sempre false, anche
    // con la variabile impostata: il cap e' di claude-cli, non globale.
    process.env.CLAUDE_CLI_MAX_CALLS_PER_RUN = '1';
    assert.equal(isPerRunCallCapReached(RIVALE), false);
  });

  it('CLAUDE_CLI_MAX_CALLS_PER_RUN=0 NON e\' un kill switch: 0 = illimitato', () => {
    // ── LA TRAPPOLA, SCRITTA COME TEST ───────────────────────────────────────
    //
    // La lettura naturale di «cap = 0» su un modello a pagamento e' «zero
    // chiamate». La semantica reale e' l'opposto esatto: cap disattivato. Chi
    // la usa per spegnere Haiku in fretta toglie l'unico tetto che c'era, e non
    // se ne accorge — il comportamento e' identico a quello nominale finche' la
    // run non supera le 40 chiamate.
    //
    // La convenzione NON e' stata invertita (vedi `_getClaudeCliMaxCallsPerRun`:
    // e' condivisa col gemello `mode: identical` del sito e con gli altri cap
    // del file). Al suo posto c'e' un warn-once, e questa riga che impedisce a
    // un futuro «sistemiamo 0 = spento» di passare per una svista.
    process.env.CLAUDE_CLI_MAX_CALLS_PER_RUN = '0';
    assert.equal(
      isPerRunCallCapReached(HAIKU), false,
      'con "0" il cap deve risultare DISATTIVATO. Se questa riga diventa true, '
      + 'la semantica e\' stata invertita qui e non sul gemello del sito: i due '
      + 'lati di un file `identical` sarebbero d\'accordo sul testo e in '
      + 'disaccordo sui fatti.',
    );
    // La leva che spegne davvero e' un'altra, ed e' quella sopra.
    process.env.AI_MODELS_PREFER = '';
    assert.deepEqual(applyModelsPrefer(['a', 'b'], [HAIKU]), ['a', 'b']);
  });

  it('un valore malformato non spegne il cap: si torna al default', () => {
    process.env.CLAUDE_CLI_MAX_CALLS_PER_RUN = 'spento';
    assert.equal(isPerRunCallCapReached(HAIKU), false); // default 40, 0 chiamate spese
  });
});
