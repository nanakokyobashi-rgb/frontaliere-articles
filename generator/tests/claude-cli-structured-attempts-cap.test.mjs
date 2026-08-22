/**
 * ── IL TETTO AI GIRI DI STRUCTUREDOUTPUT (#505) ─────────────────────────────
 *
 * `#487`/`#6080` avevano dichiarato questo `blocked:` «in attesa di una
 * finestra di run post-merge su `structuredAttempts`» — la diagnostica che
 * `#491` ha aggiunto (`describeCost()`) ma che da sola non decide niente: dice
 * solo quanti giri sono successi, non se vale la pena limitarli.
 *
 * La finestra e' ora aperta: 223 chiamate `claude-cli/haiku` sopra la soglia
 * 🐢 fra il 2026-08-20T22:56Z e il 2026-08-22T00:06Z. `structuredAttempts`:
 * 1 giro 178/223, 2 giri 39/223, 3 giri 3/223, 4 giri 2/223, 5 giri 1/223 — la
 * coda oltre 2 giri e' il 2,7% dei casi ma ognuno costa altri ~3m30s (vedi il
 * commento sopra `CLAUDE_CLI_STRUCTURED_OUTPUT_TOOL`) per un guadagno
 * marginale: un tentativo rifiutato e' gia' un articolo pubblicabile via
 * `trace.salvage()`.
 *
 * Il CLI non ha `--max-turns` (verificato su 2.1.235): l'anello non e'
 * limitabile passando un flag. Cio' che QUESTO modulo puo' fare — e ora fa —
 * e' troncare il PROCESSO quando i giri superano il tetto, riusando lo stesso
 * `trace.salvage()` che gia' serviva al ramo di timeout.
 *
 * PERCHE' I TEST SONO SUL RITAGLIO DI SORGENTE E NON SU `_runClaudeCliProcess`:
 * la funzione non e' esportata, e farla scattare per davvero vorrebbe dire
 * spawnare `claude` — vedi lo stesso vincolo in
 * `claude-cli-timeout-diagnosticabile.test.mjs`.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.resolve(HERE, '../scripts/lib/ai-models.mjs'), 'utf-8');

/** Il ramo del tetto ai giri dentro `_runClaudeCliProcess`, ritagliato dal sorgente. */
function ramoTetto() {
  const a = SRC.indexOf("child.stdout.on('data', (d) => {");
  assert.notEqual(a, -1, 'ancora iniziale non trovata — aggiornare questo test');
  const b = SRC.indexOf("child.stderr.on('data', (d) => { stderr += d; });", a);
  assert.notEqual(b, -1, 'ancora finale non trovata — aggiornare questo test');
  const blocco = SRC.slice(a, b);
  assert.ok(blocco.length > 200, `ritaglio troppo corto (${blocco.length}) — ancore sbagliate`);
  return blocco;
}

describe('il tetto ai giri di StructuredOutput tronca il processo, non il CLI', () => {
  it('la costante del tetto esiste ed e configurabile da env', () => {
    assert.ok(
      SRC.includes('const CLAUDE_CLI_MAX_STRUCTURED_ATTEMPTS'),
      'CLAUDE_CLI_MAX_STRUCTURED_ATTEMPTS non c e piu: il tetto e sparito',
    );
    assert.ok(
      SRC.includes("process.env.CLAUDE_CLI_MAX_STRUCTURED_ATTEMPTS"),
      'il tetto non e piu override-abile da env, come tutte le altre soglie del file',
    );
  });

  it('il controllo confronta structuredAttempts col tetto, non un altro campo', () => {
    const blocco = ramoTetto();
    assert.match(
      blocco,
      /trace\.state\.structuredAttempts > CLAUDE_CLI_MAX_STRUCTURED_ATTEMPTS/,
      'il ramo non confronta piu structuredAttempts col tetto',
    );
  });

  it('non scatta finche non e settled — niente doppio kill/reject sullo stesso processo', () => {
    const blocco = ramoTetto();
    assert.match(blocco, /!settled\s*&&\s*trace\.state\.structuredAttempts/,
      'manca la guardia su settled: un secondo trigger dopo il timeout rilancerebbe reject() su una promise gia decisa');
  });

  it('uccide il processo e ferma il timer di sezione, non lascia entrambi vivi', () => {
    const blocco = ramoTetto();
    assert.match(blocco, /clearTimeout\(timer\)/, 'il timer di timeout resta attivo dopo il taglio anticipato');
    assert.match(blocco, /child\.kill\('SIGKILL'\)/, 'il processo non viene ucciso quando si supera il tetto');
  });

  it('allega trace.salvage(): il taglio non deve buttare il tentativo gia arrivato', () => {
    const blocco = ramoTetto();
    assert.match(blocco, /err\.claudeCliSalvage = trace\.salvage\(\)/,
      'senza salvage il taglio anticipato perde un articolo gia completo, esattamente il guasto che il timeout aveva');
  });

  it('e un giudizio sul NOSTRO tetto, non sul modello: transportFault resta true', () => {
    const blocco = ramoTetto();
    assert.match(blocco, /err\.transportFault = true/,
      'senza questo flag il taglio anticipato abbasserebbe lo score del modello per una decisione nostra, non sua');
  });

  it('il messaggio riporta quanti tentativi e il tetto — e cio su cui si grep-a in produzione', () => {
    const blocco = ramoTetto();
    assert.match(blocco, /tetto di \$\{CLAUDE_CLI_MAX_STRUCTURED_ATTEMPTS\} giri-schema superato/);
    assert.match(blocco, /\$\{trace\.state\.structuredAttempts\} tentativi/);
  });
});
