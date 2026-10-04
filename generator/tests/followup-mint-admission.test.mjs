/**
 * Ammissione al conio (`scripts/ci/lib/followup-mint-admission.mjs`, copia
 * `identical` del sito): gli stessi casi di `tests/followup-mint-admission.test.ts`
 * del sito, in `node:test`, eseguiti contro il `followup-resolution-match.mjs`
 * ADATTATO di questo repository. Se l'adattamento diverge da cio' che il modulo
 * si aspetta (simboli, firma di `detectAlreadyResolved`, campi di
 * `parseFollowupItems`), questo file fallisce qui e non in produzione.
 *
 * Titolo di fallimento: «Conio follow-up (corpus): bucket sigillato senza i
 * controlli di ammissione».
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { describe } from 'node:test';

import {
  DEMOTE_BORN_SATISFIED,
  MINT_OBSERVATIONS,
  acceptanceAlreadySatisfied,
  acceptanceIsDeclaration,
  closedStateBullet,
  contentsApiIo,
  isSchedaOnlyItem,
  mintAdmission,
  originalTextOf,
  rewriteTargetFileField,
  targetResolves,
} from '../../scripts/ci/lib/followup-mint-admission.mjs';
import { parseFollowupItems } from '../../scripts/ci/followup-resolution-match.mjs';

const DAY = '2026-10-04';
const TARGET = 'scripts/example.mjs';

const itemText = (token = 'firstGuard()', extra = []) => [
  `### FU-${DAY}-001 — Proteggi il comportamento`,
  '- State: open',
  '- Sources: PR #8101',
  `- Target file: \`${TARGET}\``,
  `- Suggested action: aggiungi \`${token}\` in \`${TARGET}\``,
  `- Acceptance token: \`${token}\``,
  ...extra,
  '',
].join('\n');

const parsed = (text) => parseFollowupItems(text)[0];

/** `io` finto: file noti presenti, il resto assente; conta le letture. */
function fakeIo(files) {
  const calls = [];
  return {
    calls,
    fileExists: (path) => { calls.push(`exists:${path}`); return path in files; },
    readFile: (path) => { calls.push(`read:${path}`); return files[path] ?? null; },
  };
}

describe('ammissione al conio — osservazione del referente', () => {
  // Nessun pin sul VALORE: il modulo è `identical` e il sito può girare
  // l'interruttore; il trasporto aggiorna il modulo ma non questo test.
  test('l\'interruttore della demozione esiste ed è un booleano (valore deciso dal sito)', () => {
    assert.equal(typeof DEMOTE_BORN_SATISFIED, 'boolean');
  });

  test('token già invocato nel file → acceptance-already-true, ma ammesso', () => {
    const item = parsed(itemText());
    const io = fakeIo({ [TARGET]: 'export function firstGuard(x) { return x; }\nfirstGuard(value);\n' });
    assert.equal(acceptanceAlreadySatisfied(item, io), true);
    const verdict = mintAdmission(item, io);
    assert.equal(verdict.admit, true);
    assert.deepEqual(verdict.observed, [MINT_OBSERVATIONS.bornSatisfied]);
  });

  test('token `nome()` solo dichiarato → token-is-declaration, ammesso; aggiungere la chiamata lo fa combaciare', () => {
    const item = parsed(itemText());
    const declared = fakeIo({ [TARGET]: 'export function firstGuard(input) {\n  return input;\n}\n' });
    assert.equal(acceptanceAlreadySatisfied(item, declared), false);
    assert.equal(acceptanceIsDeclaration(item, declared), true);
    const verdict = mintAdmission(item, declared);
    assert.equal(verdict.admit, true);
    assert.deepEqual(verdict.observed, [MINT_OBSERVATIONS.declaration]);

    const fixed = fakeIo({ [TARGET]: 'export function firstGuard(input) {\n  return input;\n}\nfirstGuard(data);\n' });
    assert.deepEqual(mintAdmission(item, fixed).observed, [MINT_OBSERVATIONS.bornSatisfied]);
  });

  test('token assente dal file → nessuna osservazione', () => {
    const item = parsed(itemText());
    const io = fakeIo({ [TARGET]: 'export const unrelated = 1;\n' });
    assert.deepEqual(mintAdmission(item, io), { admit: true, observed: [], skipped: null });
  });

  test('file assente (404) → nessuna osservazione, non unknown', () => {
    const item = parsed(itemText());
    assert.deepEqual(mintAdmission(item, fakeIo({})).observed, []);
  });

  test('item ammesso con la sola scheda COMANDO → controlli non applicati, io mai letto', () => {
    const text = [
      `### FU-${DAY}-002 — Misura il drift`,
      '- State: open',
      '- Sources: PR #8102',
      '- METRICA: prima=3 atteso=0 | COMANDO: node scripts/ci/measure-drift.mjs',
      '',
    ].join('\n');
    const item = parsed(text);
    const io = fakeIo({ 'scripts/ci/measure-drift.mjs': 'measure()' });
    assert.equal(isSchedaOnlyItem(item), true);
    assert.deepEqual(mintAdmission(item, io), { admit: true, observed: [], skipped: 'scheda-only' });
    assert.deepEqual(io.calls, []);
  });

  test('io che non sa rispondere → admission-unknown, ammesso, mai un «no» inventato', () => {
    const item = parsed(itemText());
    const throwing = {
      fileExists: () => { throw new Error('rete giù'); },
      readFile: () => { throw new Error('rete giù'); },
    };
    assert.equal(acceptanceAlreadySatisfied(item, throwing), 'unknown');
    assert.deepEqual(mintAdmission(item, throwing), { admit: true, observed: [MINT_OBSERVATIONS.unknown], skipped: null });
    const statusUnknown = { status: () => 'unknown', fileExists: () => false, readFile: () => null };
    assert.deepEqual(mintAdmission(item, statusUnknown).observed, [MINT_OBSERVATIONS.unknown]);
  });

  test('l\'oracolo è iniettabile e riceve il token esplicito', () => {
    const item = parsed(itemText());
    const seen = [];
    const detect = (text, _io, options) => {
      seen.push([text.includes('firstGuard'), options]);
      return { resolved: true };
    };
    assert.equal(acceptanceAlreadySatisfied(item, fakeIo({}), { detect }), true);
    assert.deepEqual(seen, [[true, { acceptanceToken: 'firstGuard()' }]]);
  });
});

describe('contentsApiIo — il main del repository del bucket, non il disco', () => {
  const fail = (stderr) => () => {
    const error = new Error('Command failed');
    error.stderr = stderr;
    throw error;
  };

  test('legge dall\'API contents (raw) del repository e del ref dati, una chiamata per path', () => {
    const calls = [];
    const io = contentsApiIo({
      repo: 'owner/corpus',
      ref: 'main',
      gh: (args) => { calls.push(args); return 'firstGuard(x)'; },
      cap: 10,
    });
    assert.equal(io.status(TARGET), 'present');
    assert.equal(io.fileExists(TARGET), true);
    assert.equal(io.readFile(TARGET), 'firstGuard(x)');
    assert.equal(io.readFile(`\`${TARGET}\``), 'firstGuard(x)');
    assert.deepEqual(calls, [[
      'api', '-H', 'Accept: application/vnd.github.raw',
      `repos/owner/corpus/contents/${TARGET}?ref=main`,
    ]]);
    assert.deepEqual(io.stats(), { reads: 1, cap: 10, capped: 0, errors: 0 });
  });

  // Un 404 sul file vale `missing` solo se il repository si legge con QUESTO
  // token: l'API risponde 404 anche a un token senza accesso (review di questo
  // repo #2097, contratto del gemello `identical` cambiato dal sito #11408).
  // La prova è UNA lettura del ref (`repos/<repo>/commits/<ref>`), per run.
  const readableRepo = (stderr) => (args) => {
    if (args[1] === 'repos/o/r/commits/main') return '0123456789abcdef0123456789abcdef01234567\n';
    return fail(stderr)();
  };

  test('404 su un repository leggibile → missing; ogni altro errore → unknown e contato', () => {
    const missing = contentsApiIo({ repo: 'o/r', gh: readableRepo('gh: Not Found (HTTP 404)'), cap: 5 });
    assert.equal(missing.status(TARGET), 'missing');
    assert.equal(missing.stats().errors, 0);
    const broken = contentsApiIo({ repo: 'o/r', gh: fail('HTTP 502: Bad Gateway'), cap: 5 });
    assert.equal(broken.status(TARGET), 'unknown');
    assert.equal(broken.readFile(TARGET), null);
    assert.equal(broken.stats().errors, 1);
  });

  test('404 con repository non leggibile da questo token (404, 403 o rete sul ref) → unknown, mai missing', () => {
    for (const probeError of ['gh: Not Found (HTTP 404)', 'gh: Resource not accessible (HTTP 403)', 'dial tcp: i/o timeout']) {
      const io = contentsApiIo({ repo: 'o/r', gh: (args) => {
        if (args[1] === 'repos/o/r/commits/main') return fail(probeError)();
        return fail('gh: Not Found (HTTP 404)')();
      }, cap: 5 });
      assert.equal(io.status(TARGET), 'unknown', probeError);
      assert.equal(io.fileExists(TARGET), false, probeError);
      assert.equal(io.stats().errors, 1, probeError);
      assert.deepEqual(mintAdmission(parsed(itemText()), io).observed, [MINT_OBSERVATIONS.unknown], probeError);
    }
  });

  test('la prova di leggibilità è una sola per run, e solo dopo un 404', () => {
    const calls = [];
    const io = contentsApiIo({ repo: 'o/r', gh: (args) => {
      calls.push(args);
      if (args[1] === 'repos/o/r/commits/main') return 'sha\n';
      if (args[3]?.includes('present.mjs')) return 'x';
      return fail('HTTP 404')();
    }, cap: 10 });
    const probes = () => calls.filter((args) => args[1] === 'repos/o/r/commits/main').length;
    assert.equal(io.status('scripts/present.mjs'), 'present');
    assert.equal(probes(), 0);
    assert.equal(io.status('scripts/a.mjs'), 'missing');
    assert.equal(io.status('scripts/b.mjs'), 'missing');
    assert.equal(probes(), 1);
  });

  test('il tetto è rispettato e dichiarato: oltre il tetto un path nuovo è unknown, senza chiamate', () => {
    let calls = 0;
    const io = contentsApiIo({ repo: 'o/r', gh: () => { calls += 1; return 'x'; }, cap: 1 });
    assert.equal(io.status('scripts/a.mjs'), 'present');
    assert.equal(io.status('scripts/b.mjs'), 'unknown');
    assert.equal(io.status('scripts/a.mjs'), 'present');
    assert.equal(io.fileExists('scripts/b.mjs'), false);
    assert.equal(io.readFile('scripts/b.mjs'), null);
    assert.equal(calls, 1);
    assert.deepEqual(io.stats(), { reads: 1, cap: 1, capped: 1, errors: 0 });
  });

  test('path fuori dal repository non vengono richiesti', () => {
    let calls = 0;
    const io = contentsApiIo({ repo: 'o/r', gh: () => { calls += 1; return 'x'; } });
    assert.equal(io.status('../secret.mjs'), 'missing');
    assert.equal(io.status('/etc/passwd'), 'missing');
    assert.equal(calls, 0);
  });

  test('senza repository → unknown (non un falso «assente»)', () => {
    const io = contentsApiIo({ repo: '', gh: () => 'x' });
    assert.equal(io.status(TARGET), 'unknown');
    assert.deepEqual(mintAdmission(parsed(itemText()), io).observed, [MINT_OBSERVATIONS.unknown]);
  });

  test('end-to-end: lo stesso item dà lo stesso esito con l\'io API e con un io in memoria', () => {
    const content = 'firstGuard(value);\n';
    const item = parsed(itemText());
    const api = contentsApiIo({ repo: 'o/r', gh: (args) => {
      if (args[3].startsWith(`repos/o/r/contents/${TARGET}`)) return content;
      return fail('HTTP 404')();
    } });
    assert.deepEqual(mintAdmission(item, api), mintAdmission(item, fakeIo({ [TARGET]: content })));
  });
});

describe('ammissione al conio — bullet già chiusi e bersagli', () => {
  const FIXTURE = JSON.parse(readFileSync(
    new URL('./fixtures/followup-mint/closed-bullets-10258-10289.json', import.meta.url), 'utf-8',
  ));

  const minted = (original, { target = TARGET, extra = [] } = {}) => parsed([
    `### FU-${DAY}-003 — Item coniato da un bullet`,
    '- State: open',
    '- Sources: PR #10289; PR body `## Non implementato (ancora)`',
    `- Target file: \`${target}\``,
    '- Original text:',
    `  > ${original}`,
    `- Suggested action: aggiungi \`firstGuard()\` in \`${target}\``,
    '- Acceptance token: `firstGuard()`',
    ...extra,
    '',
  ].join('\n'));

  test('le righe reali delle PR 10258 e 10289 → zero item ammessi, anche con l\'io che non risponde', () => {
    assert.ok(FIXTURE.closed.length > 0);
    const unknownIo = { status: () => 'unknown', fileExists: () => false, readFile: () => null };
    for (const { bullet } of FIXTURE.closed) {
      const item = minted(bullet);
      assert.equal(originalTextOf(item.text), bullet);
      assert.equal(closedStateBullet(item), true, bullet);
      const verdict = mintAdmission(item, unknownIo);
      assert.equal(verdict.admit, false);
      assert.equal(verdict.demotion?.code, MINT_OBSERVATIONS.closedState);
    }
    // Controllo positivo: il bullet `blocked:` con causa tecnica resta lavoro.
    for (const { bullet } of FIXTURE.admitted) {
      assert.equal(mintAdmission(minted(bullet), fakeIo({})).admit, true, bullet);
    }
  });

  test('«non è un falso positivo, va sistemato» resta ammesso', () => {
    const item = minted(`\`${TARGET}\` — non è un falso positivo, va sistemato: il controllo manca.`);
    assert.equal(closedStateBullet(item), false);
    assert.equal(mintAdmission(item, fakeIo({})).admit, true);
  });

  test('un match lessicale hard-exclude («post-deploy», «deferred», «missing test») non è un bullet chiuso', () => {
    for (const original of [
      '🟡 the deferred import in scripts/x.mjs swallows errors',
      'post-deploy: anche fixX() in scripts/x.mjs va corretto',
      'missing test: il test tests/a.test.ts usa una data assoluta, da correggere',
    ]) {
      const item = minted(original);
      assert.equal(closedStateBullet(item), false, original);
      assert.equal(mintAdmission(item, fakeIo({})).admit, true, original);
    }
  });

  test('Original text in linea e in un fence si legge come quello citato', () => {
    const closed = 'scripts/x.mjs — falso positivo: legge solo. **Motivo:** non tocca X. **Prossimo passo:** nessuna modifica.';
    assert.equal(originalTextOf(`- Original text: > ${closed}\n- Suggested action: x`), closed);
    assert.equal(originalTextOf(`- Original text:\n\`\`\`\n${closed}\n- State: done\n\`\`\`\n- Suggested action: x`),
      `${closed} - State: done`);
    assert.equal(originalTextOf('- Suggested action: x'), '');
  });

  const manifest = [
    { path: 'host/batchWrite.ts', sitePath: 'build-plugins/batchWrite.ts', mode: 'identical' },
    { path: 'scripts/lib/corpus-floors.mjs', mode: 'corpus-only' },
    { path: '.github/workflows/crawler-group-01.yml', sitePath: '.github/corpus-workflows/crawler-group-01.yml', mode: 'identical' },
    { path: 'scripts/ci/shared.mjs', mode: 'identical' },
  ];
  const context = (here, twin = {}, files = manifest, side = 'site') => ({
    side, manifestFiles: files, twinIo: fakeIo(twin), io: fakeIo(here),
  });
  const itemFor = (target, extra = []) => parsed([
    `### FU-${DAY}-004 — Bersaglio`,
    '- State: open',
    '- Sources: PR #9508',
    `- Target file: \`${target}\``,
    `- Suggested action: aggiungi \`firstGuard()\` in \`${target}\``,
    '- Acceptance token: `firstGuard()`',
    ...extra,
    '',
  ].join('\n'));
  const admit = (target, ctx, extra = []) => {
    const { io, ...targetContext } = ctx;
    return mintAdmission(itemFor(target, extra), io, { target: targetContext });
  };

  test('host/batchWrite.ts nel bucket del sito → riscritto a build-plugins/batchWrite.ts, ammesso', () => {
    const verdict = admit('host/batchWrite.ts', context({ 'build-plugins/batchWrite.ts': 'export {}\n' }, { 'host/batchWrite.ts': 'x' }));
    assert.equal(verdict.admit, true);
    assert.equal(verdict.demotion, undefined);
    assert.ok(verdict.observed.includes(MINT_OBSERVATIONS.targetRewritten));
    assert.match(verdict.item?.text, /- Target file: `build-plugins\/batchWrite\.ts`/);
    assert.match(verdict.item?.raw, /- Target file: `build-plugins\/batchWrite\.ts`/);
    assert.match(verdict.item?.text, /- Suggested action: aggiungi `firstGuard\(\)` in `host\/batchWrite\.ts`/);
  });

  test('engine/shared/x.mjs con packages/articles/engine/shared/x.mjs presente → riscritto', () => {
    const verdict = admit('engine/shared/x.mjs', context({ 'packages/articles/engine/shared/x.mjs': 'x' }));
    assert.equal(verdict.admit, true);
    assert.match(verdict.item?.text, /- Target file: `packages\/articles\/engine\/shared\/x\.mjs`/);
  });

  test('packages/articles/engine/x nel bucket del corpus → riscritto a engine/x', () => {
    const verdict = admit('packages/articles/engine/shared/x.mjs', context({ 'engine/shared/x.mjs': 'x' }, {}, manifest, 'corpus'));
    assert.equal(verdict.admit, true);
    assert.match(verdict.item?.text, /- Target file: `engine\/shared\/x\.mjs`/);
  });

  test('file corpus-only nel bucket del sito → target-file-missing + target-in-twin, con la riga per il commento', () => {
    const verdict = admit('scripts/lib/corpus-floors.mjs', context({}, { 'scripts/lib/corpus-floors.mjs': 'x' }));
    assert.equal(verdict.admit, false);
    assert.equal(verdict.demotion?.code, MINT_OBSERVATIONS.targetMissing);
    assert.deepEqual(verdict.observed, [MINT_OBSERVATIONS.targetInTwin, MINT_OBSERVATIONS.targetMissing]);
    assert.match(verdict.demotion?.detail, /secondo il manifest va coniato in corpus come `scripts\/lib\/corpus-floors\.mjs`/);
  });

  test('manifest illeggibile → nessuna demozione per il bersaglio, admission-unknown', () => {
    const verdict = admit('scripts/lib/corpus-floors.mjs', context({}, { 'scripts/lib/corpus-floors.mjs': 'x' }, null));
    assert.equal(verdict.admit, true);
    assert.ok(verdict.observed.includes(MINT_OBSERVATIONS.unknown));
    const lazy = admit('scripts/lib/corpus-floors.mjs', context({}, {}, () => null));
    assert.equal(lazy.admit, true);
    assert.ok(lazy.observed.includes(MINT_OBSERVATIONS.unknown));
  });

  test('un workflow assente non viene mai riscritto verso .github/corpus-workflows', () => {
    const renamed = admit('.github/workflows/crawler-group-01.yml',
      context({ '.github/corpus-workflows/crawler-group-01.yml': 'on: push\n' }));
    assert.equal(renamed.admit, false);
    assert.equal(renamed.demotion?.code, MINT_OBSERVATIONS.targetMissing);
    assert.equal(renamed.item, undefined);
    const nowhere = admit('.github/workflows/x.yml', context({}));
    assert.equal(nowhere.demotion?.code, MINT_OBSERVATIONS.targetMissing);
    assert.ok(!nowhere.observed.includes(MINT_OBSERVATIONS.targetInTwin));
  });

  test('file assente ovunque ma nominato dalla scheda COMANDO come referente futuro → ammesso', () => {
    const verdict = admit('tests/new-guard.test.ts', context({}),
      ['- METRICA: prima=0 atteso=1 | COMANDO: npx vitest run tests/new-guard.test.ts']);
    assert.equal(verdict.admit, true);
    assert.equal(admit('tests/new-guard.test.ts', context({})).admit, false);
  });

  test('COMANDO con ./ nomina comunque il referente futuro', () => {
    assert.equal(admit('tests/new-guard.test.ts', context({}),
      ['- METRICA: prima=0 atteso=1 | COMANDO: `npx vitest run ./tests/new-guard.test.ts`']).admit, true);
  });

  test('segnaposto senza path (n/a) e port corpus-only-pending verso il sito → nessuna demozione', () => {
    assert.equal(admit('n/a', context({})).admit, true);
    const pending = [{ path: 'scripts/lib/ported.mjs', mode: 'corpus-only-pending' }];
    const verdict = admit('scripts/lib/ported.mjs', context({}, { 'scripts/lib/ported.mjs': 'x' }, pending));
    assert.equal(verdict.admit, true);
    assert.equal(verdict.demotion, undefined);
  });

  test('il campo Target file indentato viene riscritto davvero, non solo annunciato', () => {
    const item = parsed([
      `### FU-${DAY}-005 — Bersaglio indentato`,
      '- State: open',
      '- Sources: PR #9508',
      '  - Target file: `host/batchWrite.ts`',
      '- Suggested action: aggiungi `firstGuard()` in `host/batchWrite.ts`',
      '- Acceptance token: `firstGuard()`',
      '',
    ].join('\n'));
    const { io, ...target } = context({ 'build-plugins/batchWrite.ts': 'x' });
    const verdict = mintAdmission(item, io, { target });
    assert.ok(verdict.observed.includes(MINT_OBSERVATIONS.targetRewritten));
    assert.match(verdict.item?.text, / {2}- Target file: `build-plugins\/batchWrite\.ts`/);
    assert.doesNotMatch(verdict.item?.text, /Target file: `host\/batchWrite\.ts`/);
  });

  test('bucket del corpus su un file identical → nessuna demozione, target-identical-in-corpus', () => {
    const verdict = mintAdmission(itemFor('scripts/ci/shared.mjs'), fakeIo({ 'scripts/ci/shared.mjs': 'x' }),
      { target: { side: 'corpus', manifestFiles: manifest, twinIo: fakeIo({}) } });
    assert.equal(verdict.admit, true);
    assert.ok(verdict.observed.includes(MINT_OBSERVATIONS.targetIdenticalInCorpus));
  });

  test('la riscrittura tocca solo il campo vivo, non le copie citate o in un fence', () => {
    const text = [
      '- Target file: `host/batchWrite.ts`',
      '- Original text:',
      '  > - Target file: `host/batchWrite.ts`',
      '```',
      '- Target file: `host/batchWrite.ts`',
      '```',
    ].join('\n');
    assert.deepEqual(rewriteTargetFileField(text, 'build-plugins/batchWrite.ts').split('\n'), [
      '- Target file: `build-plugins/batchWrite.ts`',
      ...text.split('\n').slice(1),
    ]);
  });

  test('bersaglio presente nel bucket del sito → ok, senza leggere il manifest', () => {
    assert.deepEqual(targetResolves(itemFor('scripts/example.mjs'), fakeIo({ 'scripts/example.mjs': 'x' }), {
      side: 'site', manifestFiles: () => { throw new Error('non deve leggere'); },
    }), { status: 'ok', target: 'scripts/example.mjs' });
  });
});
