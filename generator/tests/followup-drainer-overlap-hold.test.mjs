// Gemello node:test di tests/followup-drainer-overlap-hold.test.ts del sito
// (valerielinc-ops/frontaliere-si-o-no#10714), più le PR ferme di #10708.
//
// Un `overlap-skip` del fixer non è un tentativo fallito. Sul sito
// #10586/#10587 sono arrivate a `fu-attempt:3` e `fu-parked` in tre ore: il
// fixer rinviava per un file «in volo» in una PR, il pre-flight del drainer non
// vedeva quel path (fuori da CODE_PATH_RE), ri-promuoveva, e il rescue contava
// ogni rinvio come run morta. E la PR che bloccava era a sua volta in
// conflitto: una PR ferma non mergerà da sola, aspettarla chiude un cerchio.
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { expect } from './lib/expect-shim.mjs';
import {
  findOverlapFile,
  isStalledPr,
  openPrFilesScanDecision,
  overlapBlockerActive,
  overlapSkipBlocker,
  STALLED_PR_LABELS,
} from '../../scripts/ci/followup-drainer.mjs';

const comment = (body, createdAt) => ({ body, createdAt, author: { login: 'nanakokyobashi-rgb' } });

describe('overlapSkipBlocker: la PR nominata dall\'ultimo verdetto del fixer', () => {
  it('legge la PR dal commento overlap-skip più recente', () => {
    expect(overlapSkipBlocker([
      comment('File `generator/tests/a.test.mjs` già in volo nella PR #1955 (fix) — skip.\n<!-- FIX_OUTCOME: overlap-skip -->', '2026-09-30T16:56:00Z'),
      comment('File `x` già in volo nella PR #1996 (fix) — skip.\n<!-- FIX_OUTCOME: overlap-skip -->', '2026-09-30T18:35:00Z'),
    ])).toBe(1996);
  });

  it('in un hand-off preferisce la PR «in volo» alla PR da riapplicare citata prima', () => {
    expect(overlapSkipBlocker([
      comment('Riapplicare la PR #1969: file `t.mjs` già in volo nella PR #1955 — skip\n<!-- FIX_OUTCOME: overlap-skip -->', '2026-09-30T16:00:00Z'),
    ])).toBe(1955);
  });

  it('regge il commento malformato senza nome file (backtick eseguiti dalla shell)', () => {
    expect(overlapSkipBlocker([
      comment('File  già in volo nella PR #1955 (fix) — skip\n<!-- FIX_OUTCOME: overlap-skip -->', '2026-09-30T15:52:04Z'),
    ])).toBe(1955);
  });

  it('null senza un verdetto overlap-skip più recente con una PR nominata', () => {
    const cases = [
      [
        comment('File `a` già in volo nella PR #1955 — skip\n<!-- FIX_OUTCOME: overlap-skip -->', '2026-09-30T15:00:00Z'),
        comment('<!-- FIX_OUTCOME: max-turns -->', '2026-09-30T16:00:00Z'),
      ],
      [comment('nota qualsiasi su PR #1955', '2026-09-30T15:00:00Z')],
      [comment('padre decomposto, non promuovo\n<!-- FIX_OUTCOME: overlap-skip -->', '2026-09-30T15:00:00Z')],
      [],
    ];
    for (const comments of cases) expect(overlapSkipBlocker(comments)).toBe(null);
  });

  it('accetta anche la forma REST (created_at)', () => {
    expect(overlapSkipBlocker([
      { body: 'già in volo nella PR #1955\n<!-- FIX_OUTCOME: overlap-skip -->', created_at: '2026-09-30T15:00:00Z' },
    ])).toBe(1955);
  });
});

describe('PR ferme e PR attive', () => {
  it('le label ferme sono quelle del sito', () => {
    expect(STALLED_PR_LABELS).toEqual(['has-conflicts', 'stale-review', 'needs-human']);
    expect(isStalledPr(['has-conflicts'])).toBe(true);
    expect(isStalledPr([{ name: 'stale-review' }])).toBe(true);
    expect(isStalledPr([{ name: 'collision-risk' }, 'agent:autofix'])).toBe(false);
    expect(isStalledPr(undefined)).toBe(false);
  });

  it('solo una PR aperta e non ferma trattiene la issue', () => {
    const cases = [
      [{ state: 'OPEN', labels: [] }, true],
      [{ state: 'OPEN', labels: [{ name: 'collision-risk' }] }, true],
      [{ state: 'OPEN', labels: [{ name: 'has-conflicts' }] }, false],
      [{ state: 'OPEN', labels: [{ name: 'needs-human' }] }, false],
      [{ state: 'MERGED', labels: [] }, false],
      [{ state: 'CLOSED', labels: [] }, false],
      [null, false],
    ];
    for (const [pr, expected] of cases) expect(overlapBlockerActive(pr), JSON.stringify(pr)).toBe(expected);
  });

  it('findOverlapFile salta le PR ferme e la PR di origine di un hand-off', () => {
    const map = new Map([
      [10, { title: 'ferma', files: new Set(['a.mjs']), labels: ['has-conflicts'] }],
      [11, { title: 'origine', files: new Set(['b.mjs']), labels: [] }],
      [12, { title: 'attiva', files: new Set(['c.mjs']), labels: [] }],
    ]);
    expect(findOverlapFile(['a.mjs'], map)).toBe(null);
    expect(findOverlapFile(['b.mjs'], map, { ignorePr: 11 })).toBe(null);
    expect(findOverlapFile(['b.mjs'], map)?.prNumber).toBe(11);
    expect(findOverlapFile(['c.mjs'], map)?.prNumber).toBe(12);
    // Mappa senza label (vecchia forma): la PR resta un overlap pieno.
    expect(findOverlapFile(['a.mjs'], new Map([[10, { title: 't', files: new Set(['a.mjs']) }]]))?.prNumber).toBe(10);
  });

  it('la mappa delle PR aperte porta le label REST, assenti = nessuna', () => {
    const decision = openPrFilesScanDecision(
      [
        { number: 10, title: 'ferma', body: '', labels: [{ name: 'stale-review' }] },
        { number: 11, title: 'senza label', body: null },
      ],
      new Map([[10, 'a.mjs\n'], [11, 'b.mjs\n']]),
    );
    expect(decision.ok).toBe(true);
    expect(decision.map.get(10).labels).toEqual(['stale-review']);
    expect(decision.map.get(11).labels).toEqual([]);
  });
});

describe('wiring nel drainer del corpus', () => {
  const source = readFileSync(new URL('../../scripts/ci/followup-drainer.mjs', import.meta.url), 'utf8');

  it('il rescue ri-accoda un overlap-skip su PR attiva senza fu-attempt, prima dei rami che lo consumano', () => {
    const branch = source.indexOf("if (outcome === 'overlap-skip') {");
    const nonRetryable = source.indexOf('if (outcome && NON_RETRYABLE.has(outcome)) {', branch);
    const ageAttempts = source.indexOf('// rescue/park per età-tentativi', branch);
    expect(branch).toBeGreaterThan(-1);
    expect(nonRetryable).toBeGreaterThan(branch);
    expect(ageAttempts).toBeGreaterThan(branch);
    const body = source.slice(branch, nonRetryable);
    expect(body).toContain('overlapBlockerActive(readOverlapBlocker(blocker))');
    expect(body).toContain('edit(iss.number, { add: [LBL_QUEUED], remove: [LBL_FIX] });');
    expect(body).not.toContain('fu-attempt');
  });

  it('il drain trattiene sulla PR dichiarata subito prima del pre-flight dei path, che ignora la PR di origine', () => {
    const drain = source.slice(source.indexOf('for (const cand of queued) {'));
    const hold = drain.indexOf('const declaredBlocker = overlapSkipBlocker(issueComments(cand.number) || []);');
    const pathOverlap = drain.indexOf('const candPaths = extractCodePaths(');
    expect(hold).toBeGreaterThan(-1);
    expect(pathOverlap).toBeGreaterThan(hold);
    expect(drain.slice(pathOverlap)).toContain('ignorePr: conflictHandoffOriginPr(cand.title)');
  });
});

describe('prompt di issue-fix del corpus', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/issue-fix.yml', import.meta.url), 'utf8');

  it('il commento di overlap nomina la PR nella forma che il drainer legge, e le PR ferme non contano', () => {
    const rule = workflow.slice(workflow.indexOf('**Overlap sui file:**'));
    const line = rule.slice(0, rule.indexOf('\n'));
    expect(line).toContain('già in volo nella PR #<n>');
    expect(line).toContain('`has-conflicts`/`stale-review`/`needs-human`');
    expect(line).toContain('«riapplicare la PR #N su main»');
  });

  it('i commenti del fixer passano da --body-file con heredoc quotato', () => {
    const rule = workflow.slice(workflow.indexOf('**Telemetria (OBBLIGATORIO):**'));
    const line = rule.slice(0, rule.indexOf('\n'));
    expect(line).toContain("Commenti sempre con `--body-file` da heredoc `<<'EOF'`");
  });
});
