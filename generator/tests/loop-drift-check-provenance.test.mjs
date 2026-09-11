/**
 * loop-drift-check-provenance.test.mjs — pinna l'invariante «ogni baseline
 * non-null deve corrispondere a un blob esistente» (issue #148).
 *
 * ## Il buco che chiude
 *
 * Il manifest registrava per `scripts/lib/control-char-publish-gate.mjs` una
 * `baseline.site` presa dal ramo di valerielinc-ops#5488 — una PR del sito
 * CHIUSA e mai mergiata. Quell'hash non ha mai corrisposto a niente su `main`
 * del sito, ma `classify()` confronta solo `now` contro `base`: un `base`
 * fabbricato produce comunque un verdetto (qui `not-ported-changed`, già
 * `actionable: false` per costruzione), e la voce restava verde per sempre.
 *
 * `ghostVerdict()` è il pezzo puro di quella verifica: decide se una baseline
 * è "fantasma" dati i fatti già raccolti (hash attuale, e se/come la storia
 * è stata cercata), senza fare fetch. La parte che FA fetch —
 * `checkBaselineProvenance()`, dentro `main()` — non è testata qui per la
 * stessa ragione per cui `loop-sync-manifest-scope.test.mjs` tiene il
 * censimento di rete offline dai test veloci: dipende dall'API di GitHub
 * (commits + contents), che per IP anonimo vale 60 richieste l'ora condivise
 * fra tutti i runner. Un guard che dipende da quella quota non è un guard, è
 * un flake che qualcuno finirà per spegnere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ghostVerdict, provenanceRateLimitVerdict, repoHistoryMatch, sha256 } from '../../scripts/ci/loop-drift-check.mjs';

test('baseline null: niente da verificare, mai ghost', () => {
  const v = ghostVerdict({ baselineHash: null, currentHash: 'abc123', historyMatch: undefined, historyExhausted: undefined });
  assert.equal(v.checked, false);
  assert.equal(v.ghost, false);
});

test('baseline == attuale: verificata dal presente, nessuna ricerca storica necessaria', () => {
  const v = ghostVerdict({ baselineHash: 'abc123', currentHash: 'abc123', historyMatch: undefined, historyExhausted: undefined });
  assert.equal(v.checked, true);
  assert.equal(v.ghost, false);
  assert.equal(v.matchedAt, 'current');
});

test('baseline diversa dall\'attuale ma trovata nella storia: legittimo site-ahead/corpus-ahead, non un ghost', () => {
  const v = ghostVerdict({ baselineHash: 'old111', currentHash: 'new222', historyMatch: true, historyExhausted: true });
  assert.equal(v.ghost, false);
  assert.equal(v.matchedAt, 'history');
});

test('IL CASO #148: baseline diversa, storia intera esaminata, nessun match → ghost confermato', () => {
  // `fbe142331dc24c6c` (il ramo #5488, mai mergiato) contro `7f2f150f67a45918`
  // (il vero stato dopo #5518): la storia intera del path su main è stata
  // cercata (`historyExhausted: true`, sole poche revisioni) e non lo trova.
  const v = ghostVerdict({ baselineHash: 'fbe142331dc24c6c', currentHash: '7f2f150f67a45918', historyMatch: false, historyExhausted: true });
  assert.equal(v.checked, true);
  assert.equal(v.ghost, true, 'una baseline mai vista in tutta la storia disponibile deve essere un ghost confermato');
});

test('mancato match ma storia NON esaurita (oltre il cap): non verificato, mai un falso rosso', () => {
  // Un file con più storia di quanta ne sia stata cercata: il mancato match
  // non prova niente, quindi non deve diventare un ghost. Meglio un falso
  // negativo raro di un falso rosso ricorrente su file con molte revisioni.
  const v = ghostVerdict({ baselineHash: 'abc123', currentHash: 'def456', historyMatch: false, historyExhausted: false });
  assert.equal(v.ghost, false);
  assert.equal(v.unresolved, true);
});

test('storia esaurita ma tutte le revisioni hanno risposto 404: non è prova di ghost', () => {
  const v = ghostVerdict({
    baselineHash: 'abc123',
    currentHash: 'def456',
    historyMatch: false,
    historyExhausted: true,
    historyReadable: false,
  });
  assert.equal(v.ghost, false, 'un path rinominato non deve fabbricare un ghost');
  assert.equal(v.unresolved, true);
  assert.equal(v.historyUnreadable, true);
});

test('ricerca storica non eseguita (es. fetch fallito): non verificato, non un falso positivo di rete', () => {
  const v = ghostVerdict({ baselineHash: 'abc123', currentHash: 'def456', historyMatch: undefined, historyExhausted: undefined });
  assert.equal(v.checked, false);
  assert.equal(v.ghost, false, 'un errore di rete non deve mai produrre un ghost: PROCEED-SAFE come il resto dello script');
});

test('rate limit di provenienza rende actionable la entry e dichiara il resto non verificato', () => {
  const verdict = provenanceRateLimitVerdict(
    { path: 'scripts/example.mjs', mode: 'identical', baseline: { site: 'old', corpus: 'old' } },
    { site: 'new-site', corpus: 'new-corpus' },
    'GET commits → rate limit anonimo',
  );
  assert.equal(verdict.state, 'provenance-rate-limited');
  assert.equal(verdict.actionable, true);
  assert.match(verdict.detail, /entry successive.*non verificate/i);
});

test('rate limit di provenienza conserva il verdetto locale e lo annota nel detail', () => {
  const verdict = provenanceRateLimitVerdict(
    { path: 'scripts/example.mjs', mode: 'identical', baseline: { site: 'old', corpus: 'old' } },
    { site: 'new-site', corpus: 'new-corpus' },
    'GET commits → rate limit anonimo',
    { state: 'site-ahead', actionable: true, headline: 'il sito è avanti', detail: 'hash locali già confrontati' },
  );
  assert.equal(verdict.state, 'site-ahead');
  assert.equal(verdict.provenanceState, 'provenance-rate-limited');
  assert.equal(verdict.actionable, true);
  assert.match(verdict.detail, /hash locali già confrontati/);
  assert.match(verdict.detail, /entry successive.*non verificate/i);
});

test('la passata di provenienza si ferma al rate limit invece di accumulare note verdi', async () => {
  const fs = await import('node:fs');
  const url = await import('node:url');
  const path = await import('node:path');
  const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..');
  const source = fs.readFileSync(path.join(root, 'scripts/ci/loop-drift-check.mjs'), 'utf8');
  assert.match(source, /const provenancePass = \{ rateLimited: false/);
  assert.match(source, /if \(provenancePass\.rateLimited\)/);
  assert.match(source, /provenanceRateLimitVerdict\(entry, now/);
  assert.match(source, /section\('provenance-rate-limited'/);
  assert.ok(
    source.indexOf('if (provenance.ghosts.length)') < source.indexOf('else if (provenance.rateLimited)'),
    'i ghost devono restare prioritari rispetto alla nota di rate limit',
  );
  assert.match(source, /e instanceof CrossRepoRateLimitError/);
});

test('importare il modulo non esegue loop-drift-check: nessun fetch, nessun process.exit', () => {
  // Stessa guardia CLI pinnata in loop-drift-check-classify.test.mjs: se
  // l'import avesse eseguito main(), il processo sarebbe già uscito.
  assert.equal(typeof ghostVerdict, 'function');
});

test('il walk storico legge i blob in batch bounded e conserva il primo match in ordine', async () => {
  const commits = Array.from({ length: 20 }, (_, index) => ({
    sha: `commit-${index}`,
    commit: { committer: { date: `2026-09-${String(index + 1).padStart(2, '0')}T00:00:00Z` } },
  }));
  const targetHash = sha256(Buffer.from('baseline'));
  let inFlight = 0;
  let maxInFlight = 0;
  const rawCalls = [];

  const fetcher = async (url) => {
    if (url.includes('/commits?')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => commits,
      };
    }
    const match = url.match(/\/commit-(\d+)\//);
    assert.ok(match, `blob URL inatteso: ${url}`);
    const index = Number(match[1]);
    rawCalls.push(index);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 2));
    inFlight -= 1;
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from(index === 1 ? 'baseline' : `other-${index}`),
    };
  };

  const result = await repoHistoryMatch({
    repo: 'owner/repo',
    ref: 'main',
    filePath: 'scripts/example.mjs',
    targetHash,
    fetcher,
  });

  assert.equal(result.match, true);
  assert.equal(result.checked, 8, 'il conteggio deve riflettere la finestra realmente hashata');
  assert.equal(result.readable, 8);
  assert.equal(result.matchedDate, commits[1].commit.committer.date);
  assert.ok(maxInFlight > 1, 'le letture indipendenti devono poter avanzare insieme');
  assert.ok(maxInFlight <= 8, 'la concorrenza deve avere un tetto');
  assert.ok(rawCalls.length < commits.length, 'un match nel primo batch non deve scaricare tutta la storia');
});
