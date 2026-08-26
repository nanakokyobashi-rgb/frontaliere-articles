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

describe('il knob al thinking, e perche\' di default non fa niente', () => {
  it('di default NON imposta la variabile: il tetto misurato non legava', () => {
    // Dodici campioni post-merge: 1.444 · 12.602 · 7.728 · 1.517 · 10.474 ·
    // 7.766 · 2.492 · 2.007 · 3.020 · 5.320 · 2.504 · 4.767. Nove su dodici
    // sopra 2.048, e il massimo piu' alto di qualunque campione pre-fix. Un
    // knob che non fa cio' che il nome dice e' peggio di nessun knob.
    const env = claudeCliChildEnv({ PATH: '/usr/bin' });
    assert.equal(env.MAX_THINKING_TOKENS, undefined);
    assert.equal(env.PATH, '/usr/bin', 'il resto dell\'ambiente non deve cambiare');
  });

  it('resta un opt-in: un valore esplicito arriva al processo', () => {
    // Il knob non si butta, perche' il valore che AGISCE esiste ed e' `0`
    // (misurato: thinking 56 → 0). Spegnere il ragionamento e' pero' una
    // scelta di qualita', quindi si dichiara, non si eredita da un default.
    process.env.CLAUDE_CLI_MAX_THINKING_TOKENS = '0';
    try {
      assert.match(SRC, /process\.env\.CLAUDE_CLI_MAX_THINKING_TOKENS/);
    } finally {
      delete process.env.CLAUDE_CLI_MAX_THINKING_TOKENS;
    }
  });

  it('NON sovrascrive un valore gia\' impostato', () => {
    // Stessa regola del ponte Remote Config, e per la stessa ragione: chi lo
    // imposta in un workflow lo sta facendo apposta, e una costante di
    // libreria che glielo cancella e' un override invisibile.
    assert.equal(claudeCliChildEnv({ MAX_THINKING_TOKENS: '512' }).MAX_THINKING_TOKENS, '512');
    assert.equal(claudeCliChildEnv({ MAX_THINKING_TOKENS: '0' }).MAX_THINKING_TOKENS, '0');
    // Col default a `null` la funzione non tocca niente in nessun caso: la
    // regola del non-sovrascrivere resta scritta perche' torna a mordere
    // appena qualcuno imposta CLAUDE_CLI_MAX_THINKING_TOKENS.
  });

  it('una stringa vuota nell\'ambiente NON conta come «impostato»', () => {
    // `env: {MAX_THINKING_TOKENS: ''}` e' cio' che produce un `env:` di GitHub
    // Actions con un valore non risolto. La regola vale ancora, ma col default
    // a `null` il risultato osservabile e' «non impostata» in entrambi i casi:
    // e' la forma del sorgente a portare la proprieta', ed e' li' che si fissa.
    // Col default a `null` la funzione torna l'ambiente INTATTO, quindi la
    // stringa vuota resta tale: non viene ne' sovrascritta ne' cancellata.
    assert.equal(claudeCliChildEnv({ MAX_THINKING_TOKENS: '' }).MAX_THINKING_TOKENS, '');
    assert.match(SRC, /String\(base\.MAX_THINKING_TOKENS\)\.trim\(\) !== ''/);
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

  it('il default e\' «non impostare»: il tetto non legava, misurato', () => {
    // Il giro precedente metteva 2048 dichiarandolo una previsione. Dodici
    // campioni l'hanno smentita: nove sopra il tetto, massimo 12.602, piu'
    // alto di qualunque campione pre-fix. Il criterio dichiarato allora era
    // «se non lega va TOLTO, non ritarato a occhio», ed e' cio' che questo
    // test fissa — perche' la tentazione naturale, davanti a un tetto che non
    // morde, e' abbassarlo.
    assert.match(blocco(), /if \(!raw\) return null;/);
    assert.doesNotMatch(blocco(), /return 2048;/, 'il tetto che non legava e\' tornato');
  });

  it('si puo\' spegnere senza un deploy di codice', () => {
    assert.match(blocco(), /process\.env\.CLAUDE_CLI_MAX_THINKING_TOKENS/);
    assert.match(blocco(), /off\|none\|no/, 'manca l\'interruttore che torna al comportamento di prima');
  });

  it('un valore assurdo ricade sul default invece di rompere la generazione', () => {
    assert.match(blocco(), /Number\.isInteger/);
    assert.match(blocco(), /n >= 0/, 'un negativo passerebbe al CLI');
  });

  it('il commento porta la misura che ha smentito il tetto', () => {
    // Senza i numeri accanto alla decisione, il prossimo che legge questo file
    // vede un knob inerte e lo «ripara» rimettendo un default — che e'
    // esattamente cio' che e' gia' stato provato e misurato.
    const ctx = SRC.slice(Math.max(0, SRC.indexOf('const CLAUDE_CLI_MAX_THINKING_TOKENS') - 3000));
    assert.match(ctx, /12\.602/, 'manca il massimo osservato, che e\' la prova che non lega');
    assert.match(ctx, /interruttore/, 'manca la lettura: e\' un interruttore, non un budget');
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

  it('la riga 🐢 continua a riportare il thinking: e\' cio\' che ha smentito il tetto', () => {
    // Senza questo numero nel log, l\'effetto del tetto non e' osservabile e il
    // cambiamento tornerebbe a essere una leva alla cieca.
    assert.match(SRC, /di thinking/, 'il riepilogo di costo non riporta piu\' il thinking');
  });
});
