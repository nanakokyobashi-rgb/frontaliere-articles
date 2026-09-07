/**
 * detect-aggregate-single-source.test.mjs — `issue-fix.yml` non ha piu' un
 * rilevatore di aggregati suo (issue #986).
 *
 * Il rilevatore vive in tre copie Node tenute identiche da
 * `aggregate-detectors-agree.test.mjs`. `issue-fix.yml` ne aveva una QUARTA, in
 * shell: «conta le righe di lista del corpo, aggregata a quattro». Non era
 * un'approssimazione della regola condivisa, era un'altra regola.
 *
 * Questo file copre il legame che AGENTS.md #6 chiede quando una logica
 * condivisa attraversa il confine fra uno script e lo YAML che lo invoca — la
 * stessa forma di `ci-check-name.test.mjs`. Due meta':
 *
 *   1. il verdetto del modulo E' quello di `isAggregate()`, sulle forme reali
 *      dove la vecchia euristica shell sbagliava (in entrambi i versi);
 *   2. il workflow chiama il modulo e non ricalcola niente per conto suo.
 *
 * La seconda meta' e' quella che non si puo' togliere senza che si veda: una
 * riga di `grep` reintrodotta nello YAML e' verde per ogni test che guardi solo
 * il modulo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectAggregate } from '../../scripts/ci/detect-aggregate.mjs';
import { isAggregate } from '../../scripts/ci/check-issue-already-resolved.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github/workflows/issue-fix.yml'), 'utf8');

/** La regola shell che questa PR rimuove, riprodotta per misurare il disaccordo. */
const oldShellRule = (body) =>
  String(body || '').split('\n').filter((l) => /^[ \t]*[-*][ \t]+/.test(l)).length >= 4;

/**
 * Le due forme su cui la copia in shell e la regola condivisa divergono. Sono
 * forme reali del corpus delle issue, non inventate.
 */
const CASES = Object.freeze({
  // #466 — 3 item come bullet con lead in grassetto. `hasEnumeratedItems` li
  // copre dal #568; la shell contava 3 < 4 e diceva `false`. E' il verso
  // pericoloso: il fixer scrive `Closes` e il tracker si chiude con gli item
  // appena deferiti dentro.
  boldLeadBullets: {
    title: 'follow-up(#450): tre item residui',
    body: [
      'Item residui:',
      '',
      '- **4 modelli del bracket 4000 restano irraggiungibili.** Testo.',
      '- **Verifica: output-token cap non controllato.** Altro testo.',
      '- **La soglia non e\' misurata.** Altro testo ancora.',
    ].join('\n'),
    shared: true,
    shell: false,
  },
  // Un item solo, con quattro path elencati nel corpo. La shell contava 4 e
  // diceva `true`: il fixer consegna 1 su 1 e poi mette `Refs`, quindi la issue
  // resta aperta e ripaga un giro di quota per scoprire che non c'era altro.
  singleItemWithBulletProse: {
    title: 'fix: il selettore del ticker non normalizza il locale',
    body: [
      'Il difetto tocca quattro file:',
      '',
      '- `scripts/build-api.mjs`',
      '- `host/shared/localeEmitFilter.ts`',
      '- `engine/ticker.ts`',
      '- `generator/tests/ticker.test.mjs`',
    ].join('\n'),
    shared: false,
    shell: true,
  },
});

test('il verdetto e\' `isAggregate()`, non una regola locale', () => {
  for (const [name, c] of Object.entries(CASES)) {
    assert.equal(
      detectAggregate({ title: c.title, body: c.body }).aggregate,
      isAggregate(c.title, c.body),
      `${name}: il modulo deve limitarsi a inoltrare il rilevatore condiviso`,
    );
    assert.equal(detectAggregate({ title: c.title, body: c.body }).aggregate, c.shared, name);
  }
});

test('la vecchia euristica shell disaccordava davvero, in entrambi i versi', () => {
  for (const [name, c] of Object.entries(CASES)) {
    assert.equal(oldShellRule(c.body), c.shell, `${name}: fixture non piu' rappresentativa`);
    assert.notEqual(
      c.shell,
      c.shared,
      `${name}: se le due regole concordano, questa fixture non misura piu' niente`,
    );
  }
});

test('issue illeggibile → aggregata, che e\' la direzione reversibile dell\'errore', () => {
  const v = detectAggregate({ readable: false });
  assert.equal(v.aggregate, true);
  assert.equal(v.fallback, true);
  // Un falso `true` costa un giro (`Refs`, issue riaperta); un falso `false`
  // chiude il tracker con gli item deferiti dentro, e non si torna indietro.
});

test('issue-fix.yml delega a scripts/ci/detect-aggregate.mjs', () => {
  assert.match(
    WORKFLOW,
    /node scripts\/ci\/detect-aggregate\.mjs/,
    'lo step `Determine fix tier` deve invocare il rilevatore condiviso',
  );
});

test('issue-fix.yml non ricalcola l\'aggregazione per conto suo', () => {
  // Le tracce della quarta copia: la variabile di conteggio, il flag shell e la
  // soglia grezza sulle righe di lista. Il commento che spiega la rimozione puo'
  // nominare il `grep`, quindi si guardano le righe di CODICE.
  const code = WORKFLOW.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  for (const trace of [/agg_count/, /is_agg=/, /grep -cE/]) {
    assert.ok(
      !trace.test(code),
      `\`${trace.source}\` e' tornata in issue-fix.yml: il verdetto si calcola in ` +
        '`detect-aggregate.mjs`, non nello YAML (AGENTS.md #6).',
    );
  }
});
