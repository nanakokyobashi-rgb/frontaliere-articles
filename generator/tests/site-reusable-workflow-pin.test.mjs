/**
 * site-reusable-workflow-pin.test.mjs — il pin di un workflow riusabile del
 * sito deve essere uno SHA completo, e quando resta indietro deve ESSERE DETTO
 * (issue #1926).
 *
 * ## Il buco che chiude
 *
 * `.github/workflows/housekeeping-jobs.yml` chiama
 * `valerielinc-ops/frontaliere-si-o-no/.github/workflows/housekeeping-jobs-logic.yml@<sha>`.
 * Il pin congela lo YAML, non il codice: quel workflow fa checkout sparse del
 * sito a `main`, con la lista sparse dello SHA pinnato. Il 2026-10-02 il sito
 * ha aggiunto un import da `packages/articles/engine/shared` e il path alla
 * lista, ma solo nello YAML di main: qui e' rimasto lo YAML del 30-09 e le run
 * 36997521307 e 37115405583 sono uscite con `ERR_MODULE_NOT_FOUND`, 0 slice su
 * 8, in entrambe le lane. Niente lo segnalava: il workflow del sito non ha una
 * copia locale, quindi il manifest dei gemelli non lo vede.
 *
 * ## Cosa e' testato qui, e cosa no
 *
 *   1. La FORMA, offline, su ogni workflow di questo checkout: `@<40 hex>`.
 *      Un ref flottante (`@main`) e' una scelta gia' scartata.
 *   2. Il VERDETTO di `loop-drift-check.mjs` sul pin rimasto indietro, con la
 *      lettura del sito iniettata. La meta' che fa rete gira nel cron del drift
 *      check: un guard che dipende da raw.githubusercontent e' un flake.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REUSABLE_PIN_STATE,
  localWorkflowSources,
  reusablePinResults,
  reusablePinVerdict,
  siteReusablePins,
} from '../../scripts/ci/loop-drift-check.mjs';

const SITE = 'valerielinc-ops/frontaliere-si-o-no';
const LOGIC = '.github/workflows/housekeeping-jobs-logic.yml';
const OLD = '9b5f5d564150b3124e0c0dc3745696eee5ce6aca';
const NEW = '3243ef9ce00be86f2aca8c6084ff19a944273c1d';
const caller = (ref, comment = '') =>
  `jobs:\n  housekeeping:\n    uses: ${SITE}/${LOGIC}${ref === null ? '' : `@${ref}`}${comment}\n    with:\n      lane: rest\n`;

test('ogni workflow riusabile del sito e\' pinnato con uno SHA completo', () => {
  const pins = localWorkflowSources().flatMap((wf) =>
    siteReusablePins(wf.source).map((pin) => ({ workflow: wf.path, ...pin })));
  // Senza questo il test sarebbe verde anche se il parser non riconoscesse piu'
  // la riga: il caller di housekeeping e' il caso che lo ha fatto nascere.
  const housekeeping = pins.filter((p) => p.workflow === '.github/workflows/housekeeping-jobs.yml');
  assert.deepEqual(housekeeping.map((p) => p.sitePath), [LOGIC]);
  for (const pin of pins) {
    assert.match(
      pin.ref,
      /^[0-9a-f]{40}$/,
      `${pin.workflow}:${pin.line} chiama ${pin.sitePath}@${pin.ref || '(nessun ref)'}: serve lo SHA completo di un commit del sito`,
    );
  }
});

test('siteReusablePins: legge il ref, ignora commenti e action di altri repo', () => {
  assert.deepEqual(siteReusablePins(caller(NEW, ' # sito #10753')), [{ sitePath: LOGIC, ref: NEW, line: 3 }]);
  assert.deepEqual(siteReusablePins(caller('main')), [{ sitePath: LOGIC, ref: 'main', line: 3 }]);
  assert.deepEqual(siteReusablePins(caller(null)), [{ sitePath: LOGIC, ref: '', line: 3 }]);
  assert.deepEqual(siteReusablePins(`    uses: "${SITE.toUpperCase()}/${LOGIC}@${NEW}"\n`).map((p) => p.ref), [NEW]);
  assert.deepEqual(
    siteReusablePins([
      `    # uses: ${SITE}/${LOGIC}@main`,
      '      - uses: actions/checkout@v7',
      '    uses: ./.github/workflows/local.yml',
      `      - uses: ${SITE}/.github/actions/setup@main`,
      `    uses: ${SITE}-fork/${LOGIC}@main`,
    ].join('\n')),
    [],
  );
});

test('reusablePinVerdict: allineato, indietro, flottante, sparito', () => {
  const base = { sitePath: LOGIC, ref: OLD };
  assert.equal(reusablePinVerdict({ ...base, pinnedHash: 'a', headHash: 'a' }).actionable, false);

  const behind = reusablePinVerdict({ ...base, pinnedHash: 'a', headHash: 'b' });
  assert.equal(behind.state, REUSABLE_PIN_STATE);
  assert.equal(behind.actionable, true);
  assert.match(behind.headline, /9b5f5d564150/);
  assert.match(behind.detail, /git log origin\/main -1 --format=%H -- \.github\/workflows\/housekeeping-jobs-logic\.yml/);

  for (const ref of ['main', '', OLD.slice(0, 12), OLD.toUpperCase()]) {
    const floating = reusablePinVerdict({ ...base, ref, pinnedHash: 'a', headHash: 'a' });
    assert.equal(floating.actionable, true, `ref «${ref}» non e' uno SHA completo`);
    assert.equal(floating.state, REUSABLE_PIN_STATE);
  }

  assert.match(reusablePinVerdict({ ...base, pinnedHash: 'a', headHash: null }).headline, /non esiste piu'/);
  assert.match(reusablePinVerdict({ ...base, pinnedHash: null, headHash: 'a' }).headline, /commit pinnato/);
});

test('reusablePinResults: il caso della #1926, prima e dopo il bump', async () => {
  const site = {
    [`${OLD}:${LOGIC}`]: 'sparse-checkout: |\n  scripts\n',
    [`${NEW}:${LOGIC}`]: 'sparse-checkout: |\n  scripts\n  packages/articles/engine/shared\n',
  };
  site[`main:${LOGIC}`] = site[`${NEW}:${LOGIC}`];
  const reads = [];
  const readSite = async (sitePath, ref) => {
    reads.push(`${ref}:${sitePath}`);
    const body = site[`${ref}:${sitePath}`];
    return body === undefined ? null : Buffer.from(body);
  };
  const run = (ref) => reusablePinResults({
    workflows: [{ path: '.github/workflows/housekeeping-jobs.yml', source: caller(ref) }],
    readSite,
    siteRepo: SITE,
    siteRef: 'main',
  });

  const [before] = await run(OLD);
  assert.equal(before.state, REUSABLE_PIN_STATE);
  assert.equal(before.actionable, true);
  assert.equal(before.path, '.github/workflows/housekeeping-jobs.yml');

  const [after] = await run(NEW);
  assert.equal(after.state, 'stable');
  assert.equal(after.actionable, false);

  // Un ref flottante e' gia' un verdetto: non costa una lettura.
  reads.length = 0;
  const [floating] = await run('main');
  assert.equal(floating.actionable, true);
  assert.deepEqual(reads, []);
});

test('reusablePinResults: una lettura fallita non e\' un verdetto', async () => {
  const [row] = await reusablePinResults({
    workflows: [{ path: '.github/workflows/housekeeping-jobs.yml', source: caller(NEW) }],
    readSite: async () => {
      throw new Error('GET → HTTP 503');
    },
    siteRepo: SITE,
    siteRef: 'main',
  });
  assert.equal(row.state, 'check-failed');
  assert.equal(row.actionable, false);
});
