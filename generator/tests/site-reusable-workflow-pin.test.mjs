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
 *   3. Il VERDETTO sul commit pinnato che `main` del sito non raggiunge piu'.
 *
 * ## 2026-10-08: allineato nei contenuti, e non partiva (issue 2517)
 *
 * Il 7 ottobre la storia del sito e' stata riscritta. Il commit pinnato qui
 * ha continuato a esistere su GitHub, orfano, con lo stesso identico workflow
 * di `main`: il confronto fra i contenuti diceva «allineato». Actions pero' non
 * risolve un workflow riusabile a un commit che nessun ramo raggiunge, e le run
 * 37771757158 (pianificata) e 37834218606 (a mano) sono finite in
 * `startup_failure`, zero job, zero log. La manutenzione quotidiana e' rimasta
 * ferma senza che nessun controllo lo dicesse.
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

// ── Il commit pinnato deve essere raggiungibile, non solo leggibile ──────────

/** I due SHA veri dell'8 ottobre 2026: lo stesso commit prima e dopo la riscrittura. */
const ORPHAN = '2c27327f0b381e7a868468620e099f54e7a72ebc';
const REWRITTEN = '8395e120789ed745f9d698d70853c18b0a6e0cb6';

test('reusablePinVerdict: un commit che main non raggiunge e\' un verdetto, anche a contenuti identici', () => {
  const orphan = reusablePinVerdict({ sitePath: LOGIC, ref: ORPHAN, pinnedHash: 'a', headHash: 'a', reachable: false });
  assert.equal(orphan.state, REUSABLE_PIN_STATE);
  assert.equal(orphan.actionable, true);
  assert.match(orphan.headline, /2c27327f0b38/);
  assert.match(orphan.headline, /non e' piu' raggiungibile da `main`/);
  assert.match(orphan.detail, /startup_failure/);
  assert.match(orphan.detail, /git log origin\/main -1 --format=%H -- \.github\/workflows\/housekeeping-jobs-logic\.yml/);

  // Raggiungibile e identico: nessun verdetto, come prima.
  assert.equal(reusablePinVerdict({ sitePath: LOGIC, ref: REWRITTEN, pinnedHash: 'a', headHash: 'a', reachable: true }).actionable, false);
  // Chi non passa `reachable` non cambia verdetto: e' il comportamento di prima.
  assert.equal(reusablePinVerdict({ sitePath: LOGIC, ref: REWRITTEN, pinnedHash: 'a', headHash: 'a' }).actionable, false);
  // Il file sparito da main resta il messaggio piu' utile, anche su un commit orfano.
  assert.match(
    reusablePinVerdict({ sitePath: LOGIC, ref: ORPHAN, pinnedHash: 'a', headHash: null, reachable: false }).headline,
    /non esiste piu'/,
  );
});

test('reusablePinResults: il caso dell\'8 ottobre, commit orfano con il workflow identico a main', async () => {
  const sameWorkflow = Buffer.from('sparse-checkout: |\n  scripts\n  packages/articles/engine/shared\n');
  const readSite = async () => sameWorkflow;
  const asked = [];
  const isReachable = async (ref) => {
    asked.push(ref);
    return ref === REWRITTEN;
  };
  const run = (ref, extra = {}) => reusablePinResults({
    workflows: [{ path: '.github/workflows/housekeeping-jobs.yml', source: caller(ref) }],
    readSite,
    isReachable,
    siteRepo: SITE,
    siteRef: 'main',
    ...extra,
  });

  const [orphan] = await run(ORPHAN);
  assert.equal(orphan.state, REUSABLE_PIN_STATE);
  assert.equal(orphan.actionable, true);
  assert.equal(orphan.reachable, false);
  assert.match(orphan.headline, /non e' piu' raggiungibile/);
  // I contenuti da soli dicevano «allineato»: e' il verdetto che il cron dava.
  const [contentOnly] = await run(ORPHAN, { isReachable: null });
  assert.equal(contentOnly.state, 'stable');

  const [fixed] = await run(REWRITTEN);
  assert.equal(fixed.state, 'stable');
  assert.equal(fixed.actionable, false);
  assert.equal(fixed.reachable, true);

  // Un ref flottante e' gia' un verdetto: non costa nemmeno questa lettura.
  asked.length = 0;
  await run('main');
  assert.deepEqual(asked, []);
});

test('reusablePinResults: la raggiungibilita\' si chiede una volta per commit, e una lettura fallita non e\' un verdetto', async () => {
  const readSite = async () => Buffer.from('x');
  let calls = 0;
  const twoCallers = [
    { path: '.github/workflows/a.yml', source: caller(REWRITTEN) },
    { path: '.github/workflows/b.yml', source: caller(REWRITTEN) },
  ];
  const rows = await reusablePinResults({
    workflows: twoCallers,
    readSite,
    isReachable: async () => {
      calls += 1;
      return true;
    },
    siteRepo: SITE,
    siteRef: 'main',
  });
  assert.deepEqual(rows.map((row) => row.state), ['stable', 'stable']);
  assert.equal(calls, 1);

  const [failed] = await reusablePinResults({
    workflows: [twoCallers[0]],
    readSite,
    isReachable: async () => {
      throw new Error('compare → HTTP 403');
    },
    siteRepo: SITE,
    siteRef: 'main',
  });
  assert.equal(failed.state, 'check-failed');
  assert.equal(failed.actionable, false);
});

test('il pin di housekeeping non e\' il commit rimasto orfano', () => {
  // Offline non si puo' sapere se un commit e' raggiungibile; questo, pero', si
  // sa che non lo e'. Riportarlo qui vuol dire fermare di nuovo la manutenzione.
  const pins = localWorkflowSources().flatMap((wf) => siteReusablePins(wf.source));
  assert.ok(pins.length > 0);
  assert.deepEqual(pins.filter((pin) => pin.ref === ORPHAN), []);
});
