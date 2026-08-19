/**
 * ── IL THINKING E' IL TERMINE DOMINANTE, E IL DATO LO DICE ──────────────────
 *
 * La riga 🐢 del giro precedente ha risposto alla domanda che tre tentativi
 * alla cieca non avevano potuto porre. Tre chiamate reali di
 * `claude-cli/haiku`, dai log di produzione del 2026-08-19:
 *
 *   run 32261707656   wall 230s   ttft 111s   3 giri   21.166 out,  9.955 thinking
 *   run 32260372210   wall 181s   ttft 103s   2 giri   17.017 out,  9.430 thinking
 *   run 32260372210   wall  90s   ttft  85s   1 giro    8.147 out,  7.601 thinking
 *
 * Il rapporto thinking/ttft e' 89,7 · 91,6 · 89,4 token al secondo: la stessa
 * costante a tre cifre su tre chiamate indipendenti. Quindi `ttft_ms` non e'
 * attesa in coda — e' il tempo speso a PENSARE prima del primo token di
 * risposta — e vale il 48%, 57% e 94% dell'intera chiamata.
 *
 * E non e' coda: il `rate_limit_event` compare in tutte e tre ma dice
 * `status=allowed`. Il candidato causale piu' forte (la quota Max condivisa con
 * `pr-review-loop` e `issue-fix`) e' SCARTATO dal dato, non dall'opinione.
 *
 * PERCHE' I TEST SONO SULL'AMBIENTE E NON SU UNA CHIAMATA VERA: far scattare il
 * percorso vorrebbe dire spawnare `claude` e aspettare minuti. `claudeCliChildEnv`
 * e' esportata apposta; che il processo la usi davvero e' fissato
 * dall'asserzione sul sorgente in fondo.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { claudeCliChildEnv } from '../scripts/lib/ai-models.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.resolve(HERE, '../scripts/lib/ai-models.mjs'), 'utf-8');

describe('il tetto al thinking arriva al processo claude', () => {
  it('lo imposta quando l\'ambiente non ce l\'ha', () => {
    const env = claudeCliChildEnv({ PATH: '/usr/bin' });
    assert.equal(env.MAX_THINKING_TOKENS, '2048');
    assert.equal(env.PATH, '/usr/bin', 'il resto dell\'ambiente non deve cambiare');
  });

  it('NON sovrascrive un valore gia\' impostato', () => {
    // Stessa regola del ponte Remote Config, e per la stessa ragione: chi lo
    // imposta in un workflow lo sta facendo apposta, e una costante di
    // libreria che glielo cancella e' un override invisibile.
    assert.equal(claudeCliChildEnv({ MAX_THINKING_TOKENS: '512' }).MAX_THINKING_TOKENS, '512');
    assert.equal(claudeCliChildEnv({ MAX_THINKING_TOKENS: '0' }).MAX_THINKING_TOKENS, '0');
  });

  it('una stringa vuota nell\'ambiente NON conta come «impostato»', () => {
    // `env: {MAX_THINKING_TOKENS: ''}` e' cio' che produce un `env:` di GitHub
    // Actions con un valore non risolto: trattarlo come una scelta esplicita
    // spegnerebbe il tetto in silenzio proprio in CI, cioe' dove serve.
    assert.equal(claudeCliChildEnv({ MAX_THINKING_TOKENS: '' }).MAX_THINKING_TOKENS, '2048');
    assert.equal(claudeCliChildEnv({ MAX_THINKING_TOKENS: '   ' }).MAX_THINKING_TOKENS, '2048');
  });

  it('non muta l\'oggetto che riceve', () => {
    const base = { PATH: '/usr/bin' };
    claudeCliChildEnv(base);
    assert.equal(base.MAX_THINKING_TOKENS, undefined, 'ha scritto su process.env del padre');
  });
});

describe('la costante e le sue vie di fuga', () => {
  /** Il corpo dell'IIFE che risolve la costante. */
  const blocco = () => {
    const a = SRC.indexOf('const CLAUDE_CLI_MAX_THINKING_TOKENS = (() => {');
    assert.notEqual(a, -1, 'la costante non c\'e\' piu\' — aggiornare questo test');
    return SRC.slice(a, SRC.indexOf('})();', a));
  };

  it('il default e\' 2048, cioe\' sotto il thinking osservato in produzione', () => {
    // 2048 non e' un numero tondo scelto a caso: e' ampiamente sotto il minimo
    // misurato (7.601) e sopra il minimo interno che la CLI sembra applicare
    // (~1.024, dedotto da un tetto a 256 che ha comunque prodotto 1.058 token).
    // Un tetto SOPRA il thinking osservato non morderebbe e sarebbe un no-op
    // travestito da fix.
    assert.match(blocco(), /return 2048;/);
    assert.ok(2048 < 7601, 'il tetto deve stare sotto il minimo osservato, o non morde');
  });

  it('si puo\' spegnere senza un deploy di codice', () => {
    assert.match(blocco(), /process\.env\.CLAUDE_CLI_MAX_THINKING_TOKENS/);
    assert.match(blocco(), /off\|none\|no/, 'manca l\'interruttore che torna al comportamento di prima');
  });

  it('un valore assurdo ricade sul default invece di rompere la generazione', () => {
    assert.match(blocco(), /Number\.isInteger/);
    assert.match(blocco(), /n >= 0/, 'un negativo passerebbe al CLI');
  });
});

describe('il processo riceve davvero quell\'ambiente', () => {
  it('lo spawn usa claudeCliChildEnv(), non process.env nudo', () => {
    const riga = /child = spawn\(CLAUDE_CLI_BIN, args, \{[^}]*env: ([^}]+)\}\)/.exec(SRC);
    assert.notEqual(riga, null, 'lo spawn non e\' piu\' quello — aggiornare questo test');
    assert.match(riga[1], /claudeCliChildEnv\(\)/, 'il tetto non raggiunge il processo');
  });

  it('non tocca nessuna delle tre leve gia\' spese alla cieca', () => {
    // Come per la riga 🐢: il valore di questo cambiamento e' che agisce su un
    // termine MISURATO invece che sulle tre leve gia' provate senza dati.
    assert.match(SRC, /const CLAUDE_CLI_MIN_TIMEOUT_MS = 180_000;/, 'il floor e\' cambiato in questo giro');
    assert.match(SRC, /const CLAUDE_CLI_MAX_CONCURRENCY = 2;/, 'il semaforo e\' cambiato in questo giro');
    assert.match(SRC, /const CLAUDE_CLI_TIMEOUT_STORM_THRESHOLD = 3;/, 'la soglia del breaker e\' cambiata in questo giro');
  });

  it('la riga 🐢 continua a riportare il thinking: e\' il criterio di successo', () => {
    // Senza questo numero nel log, l\'effetto del tetto non e' osservabile e il
    // cambiamento tornerebbe a essere una leva alla cieca.
    assert.match(SRC, /di thinking/, 'il riepilogo di costo non riporta piu\' il thinking');
  });
});
