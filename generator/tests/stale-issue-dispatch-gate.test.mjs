/**
 * stale-issue-dispatch-gate.test.mjs — la seconda run sulla stessa issue non
 * deve piu' eseguire su un payload superato.
 *
 * ## Perche' questo gate esiste (#918, item 3 del follow-up di #908)
 *
 * La chiave di concorrenza per-issue ha risolto lo sfratto delle pending, e
 * cosi' facendo ha aperto una finestra nuova: prima il secondo evento `labeled`
 * sulla stessa issue moriva `cancelled` PRIMA di ogni step, ora aspetta il
 * primo e poi **esegue**. Il payload pero' e' quello dell'evento, congelato:
 * `github.event.label.name` resta `agent:fix` anche se la prima run ha gia'
 * aperto la PR, e resta `agent:decompose` anche se la prima run ha gia' creato
 * le sub-issue.
 *
 * Le difese esistenti rispondono ad altre domande, verificato una per una:
 * `claim-issue-in-flight.mjs` rilascia il mutex a fine run (quindi la seconda
 * lo trova libero — e' proprio la serializzazione a garantirlo), e il ramo
 * in-flight di `check-issue-already-resolved.mjs` fa **PROCEED** su una PR
 * aperta, correttamente: «PR aperta» significa lavoro in corso, non concluso.
 * L'unica cosa che restava era l'istruzione di prompt «PR gia' in volo: skip»,
 * cioe' una run Claude intera sulla quota condivisa col sito per leggere due
 * chiamate `gh`.
 *
 * ## Cosa inchioda questo file
 *
 * Le due meta' che possono regredire separatamente: la REGOLA (un predicato
 * puro, con i suoi controesempi — il criterio stretto sul branch e' cio' che
 * impedisce a una PR organica che cita `#N` di far cadere un bug vero) e il
 * CABLAGGIO (un gate che nessuno step consulta e' arredamento: `if:` e' il modo
 * silenzioso in cui questi guard si spengono).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { staleDispatchReason, STAGE_TELEMETRY } from '../../scripts/ci/check-stale-issue-dispatch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const openPr = (n, head) => ({ number: n, headRefName: head });

test('fix: una PR APERTA sul branch del fixer e\' un dispatch stantio', () => {
  const r = staleDispatchReason({
    stage: 'fix',
    issueNumber: 918,
    dispatchLabel: 'agent:fix',
    labels: ['agent:fix', 'follow-up'],
    openPrs: [openPr(991, 'fix/issue-918')],
  });
  assert.ok(r, 'PR aperta su `fix/issue-918` e la run parte lo stesso: e\' la run che #918 esiste per evitare.');
  assert.equal(r.code, 'pr-in-flight');
  assert.match(r.detail, /#991/);
});

test('fix: una PR organica che cita solo #N NON corto-circuita', () => {
  // Criterio stretto di proposito: qui un falso positivo non spreca una run,
  // lascia cadere un bug vero. Stesso criterio di SIGNAL 1b in
  // check-issue-already-resolved.mjs (head ESATTO, non un `includes`).
  const r = staleDispatchReason({
    stage: 'fix',
    issueNumber: 918,
    dispatchLabel: 'agent:fix',
    labels: ['agent:fix'],
    openPrs: [openPr(994, 'fix/retranslate-blocking-bodies'), openPr(995, 'feat/issue-9181')],
  });
  assert.equal(r, null, 'una PR che non e\' sul branch `fix/issue-918` non prova che il lavoro sia in volo.');
});

test('la label di dispatch consumata dalla run precedente e\' un dispatch stantio', () => {
  for (const [stage, label] of [['fix', 'agent:fix'], ['decompose', 'agent:decompose']]) {
    const r = staleDispatchReason({
      stage,
      issueNumber: 918,
      dispatchLabel: label,
      labels: ['follow-up', 'fu-parked'],
      openPrs: [],
    });
    assert.ok(r, `${stage}: la label \`${label}\` non c'e' piu' e la run gira comunque.`);
    assert.equal(r.code, 'dispatch-label-gone');
  }
});

test('decompose: `decomposed:1` gia\' presente ferma la ri-decomposizione', () => {
  const r = staleDispatchReason({
    stage: 'decompose',
    issueNumber: 918,
    dispatchLabel: 'agent:decompose',
    labels: ['agent:decompose', 'decomposed:1'],
  });
  assert.ok(r, 'ri-decomporre non ri-fa lavoro: CREA un secondo set di sub-issue duplicate.');
  assert.equal(r.code, 'already-decomposed');
});

test('bias a PROCEDERE: dubbio, stato illeggibile o fase ignota non corto-circuitano mai', () => {
  const base = { stage: 'fix', issueNumber: 918, dispatchLabel: 'agent:fix' };
  // Un falso corto-circuito lascia cadere un fix vero; una run in piu' costa
  // solo quota. La direzione dell'errore e' asimmetrica e va tenuta.
  assert.equal(staleDispatchReason({ ...base, labels: null, openPrs: null }), null, 'stato illeggibile');
  assert.equal(staleDispatchReason({ ...base, labels: ['agent:fix'], openPrs: null }), null, 'lista PR illeggibile');
  assert.equal(
    staleDispatchReason({ ...base, dispatchLabel: '', labels: [], openPrs: [] }),
    null,
    'label di dispatch assente dal payload → nessun giudizio possibile',
  );
  assert.equal(
    staleDispatchReason({ stage: 'triage', issueNumber: 918, labels: [], openPrs: [] }),
    null,
    'fase non prevista',
  );
  assert.equal(
    staleDispatchReason({ ...base, issueNumber: '', labels: [], openPrs: [] }),
    null,
    'numero issue mancante',
  );
});

test('la telemetria parla il vocabolario di chi la legge', () => {
  // `pr-already-open` e' gia' classificato transiente-ritentabile in
  // followup-drainer.mjs (NON_RETRYABLE lo esclude apposta: la PR bloccante puo'
  // mergiare), e `already-resolved` e' fra i verdetti che lo step «Classify
  // outcome» di issue-decompose.yml conta come lavoro fatto → job verde.
  assert.match(STAGE_TELEMETRY.fix, /<!-- FIX_OUTCOME: pr-already-open -->/);
  assert.match(STAGE_TELEMETRY.decompose, /<!-- DECOMPOSE_OUTCOME: already-resolved -->/);
});

/** Il blocco di uno step: dal suo `- name:` al `- name:` successivo. */
function steps(src) {
  return src.split(/\n(?=      - name: )/).slice(1);
}

for (const wf of ['issue-fix.yml', 'issue-decompose.yml']) {
  test(`${wf}: il gate e' cablato e ogni step che costa lo consulta`, () => {
    const src = fs.readFileSync(path.join(ROOT, '.github/workflows', wf), 'utf8');
    const all = steps(src);

    const gate = all.find((s) => /id: stale\b/.test(s));
    assert.ok(gate, `${wf}: nessuno step con \`id: stale\` — il pre-flight non esiste.`);
    assert.match(gate, /run: node scripts\/ci\/check-stale-issue-dispatch\.mjs/);
    assert.match(gate, /DISPATCH_LABEL: \$\{\{ github\.event\.label\.name \}\}/,
      `${wf}: il gate non riceve la label dell'evento, cioe' proprio il pezzo di payload che puo' essere stantio.`);
    assert.doesNotMatch(gate, /continue-on-error: true/,
      `${wf}: il gate e' \`continue-on-error\` — un errore lo renderebbe muto invece che permissivo.\n` +
        'Il fail-open sta DENTRO lo script (emette stale_dispatch=false ed esce 0), dove si vede.');

    // Il cablaggio: ogni step che invoca Claude deve saltare sul corto-circuito.
    // Senza, il gate gira, stampa, e la run costosa parte lo stesso.
    const claudeSteps = all.filter((s) => /anthropics\/claude-code-action/.test(s));
    assert.ok(claudeSteps.length > 0, `${wf}: nessuno step Claude trovato — il parser degli step e' andato fuori sincrono.`);
    for (const s of claudeSteps) {
      const name = (s.match(/- name: (.+)/) || [])[1];
      assert.match(
        s,
        /steps\.stale\.outputs\.stale_dispatch != 'true'/,
        `${wf} → «${name}»: lo step Claude non e' gated sul dispatch stantio. Il gate diventa arredamento\n` +
          'e la seconda run spende la quota condivisa per rifare lavoro gia' + "' consegnato.",
      );
    }
  });
}
