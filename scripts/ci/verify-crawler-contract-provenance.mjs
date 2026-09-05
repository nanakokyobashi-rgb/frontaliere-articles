/**
 * verify-crawler-contract-provenance.mjs — i digest del contratto cross-repo
 * vengono CONFRONTATI con i byte del sito, non solo scritti.
 *
 * ## Il buco che chiude (issue #916)
 *
 * `generator/data/crawler-cross-repo-contract.json` porta tre famiglie di
 * hash, e fino a qui una sola era load-bearing:
 *
 *   · `artifactSha256` — confrontato coi 24 workflow locali da
 *     `generator/tests/crawler-cross-repo-artifacts.test.mjs`. Dimostra che i
 *     byte QUI non sono stati toccati a mano, e nient'altro.
 *   · `sourceSha256` — l'hash del `*-logic.yml` da cui il generatore del sito
 *     ha emesso l'artifact. Quei file non esistono in questo checkout: nessuna
 *     riga di codice lo leggeva.
 *   · `generatorSha256` — l'hash del generatore stesso, sul sito. Idem.
 *
 * Un dato che nessuno legge non intercetta niente. Se il generatore cambia
 * lato sito, i 24 artifact qui diventano stantii e **il contratto resta
 * verde**: e' la stessa forma di guasto della `ghost-baseline` di
 * `loop-drift-check.mjs` — il canale smette di trasportare mentre il
 * semaforo resta acceso.
 *
 * La stessa cieca fiducia vale per `baseline.site` dei 24 gemelli in
 * `scripts/ci/loop-sync-manifest.json`: il test la pretende uguale ad
 * `artifactSha256`, cioe' a un hash calcolato dai byte LOCALI. E' l'invariante
 * giusta per un `identical`, ma nessuno l'aveva mai vista sul lato sito.
 * Verificare `artifactSha256` contro `.github/corpus-workflows/<file>` del
 * sito e' esattamente l'osservazione che mancava: se passa, quella
 * `baseline.site` non e' piu' fabbricata.
 *
 * ## Perche' non e' un test offline
 *
 * La domanda «questi byte esistono davvero sul sito?» ha bisogno del sito.
 * Come per il censimento di `loop-sync-manifest-scope.test.mjs`, la parte di
 * rete vive in uno script da schedule e non in `node --test`: un guard che
 * dipende dai 60 fetch/ora anonimi e' un flake, e un flake finisce spento.
 * Le funzioni pure qui sotto (`planProvenanceChecks`, `evaluateProvenance`)
 * sono invece testate offline in
 * `generator/tests/crawler-contract-provenance.test.mjs`.
 *
 * ## Le classi del verdetto
 *
 *   verified    l'hash dichiarato e' quello servito dal sito ORA.
 *   drifted     il sito serve altri byte: l'artifact qui e' stantio. ROSSO.
 *   absent      il path dichiarato non esiste piu' sul sito (404). ROSSO: un
 *               digest che punta al nulla non e' verificabile per definizione.
 *   undeclared  la voce di contratto non porta il digest o il suo sorgente —
 *               il caso dell'artifact riordinato a mano invece che
 *               rigenerato. ROSSO.
 *   unobserved  errore di rete. NON rosso da solo (proceed-safe, come il resto
 *               del ciclo), ma se lo sono TUTTE il report non significa piu'
 *               niente e si esce rossi lo stesso — stessa regola di
 *               `transport-identical-twins.mjs`.
 *
 * Uso:
 *   node scripts/ci/verify-crawler-contract-provenance.mjs           # report, exit 0
 *   node scripts/ci/verify-crawler-contract-provenance.mjs --strict  # exit 1 se rosso
 *   node scripts/ci/verify-crawler-contract-provenance.mjs --json
 *
 * Env: SITE_REPO, SITE_REF, GH_TOKEN (opzionale) — gli stessi di
 * `loop-drift-check.mjs`, cosi' i due girano nello stesso workflow.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONTRACT_PATH = path.join(ROOT, 'generator/data/crawler-cross-repo-contract.json');
const MANIFEST_PATH = path.join(ROOT, 'scripts/ci/loop-sync-manifest.json');
const SITE_REPO = process.env.SITE_REPO || 'valerielinc-ops/frontaliere-si-o-no';
const SITE_REF = process.env.SITE_REF || 'main';

/**
 * Dove vivono i `*-logic.yml` sul sito. E' l'unica coordinata che il contratto
 * NON dichiara (porta il solo basename in `sourceLogic`), e non puo' essere
 * dedotta dal manifest perche' quei file non hanno un gemello qui. Se il sito
 * li sposta, il verdetto diventa `absent` — rumoroso e corretto, non silenzioso.
 */
export const SITE_LOGIC_DIR = '.github/workflows';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Il path del generatore sul sito, ricavato da `generatedBy` togliendo il
 * prefisso del repo. Il contratto lo scrive col solo NOME del repo
 * (`frontaliere-si-o-no/scripts/…`) mentre `sourceRepository` porta
 * `owner/repo`: si accettano entrambe le forme, perche' e' il generatore del
 * sito a decidere quale usare e questo lato non puo' imporgliela.
 * Se il prefisso non e' nessuna delle due il contratto e' incoerente e si
 * lancia: e' un dato emesso da uno strumento, non un input dell'utente.
 */
export function siteGeneratorPath(contract) {
  const repo = contract.sourceRepository;
  const declared = contract.generatedBy;
  if (!repo || !declared) throw new Error('contratto senza `sourceRepository` o `generatedBy`');
  for (const prefix of [repo, repo.split('/').pop()]) {
    if (declared.startsWith(`${prefix}/`)) return declared.slice(prefix.length + 1);
  }
  throw new Error(`\`generatedBy\` (${declared}) non appartiene a \`sourceRepository\` (${repo})`);
}

/**
 * L'elenco dei confronti da fare, uno per digest dichiarato dal contratto.
 * Puro: non tocca rete ne' filesystem. `sitePath` null significa che il
 * contratto non dice CONTRO COSA confrontare — gia' un difetto, e
 * `evaluateProvenance` lo rende rosso senza bisogno di un fetch.
 */
export function planProvenanceChecks(contract, manifest) {
  const bySitePath = new Map(
    (manifest?.files || []).map((entry) => [entry.path, entry.sitePath || null]),
  );
  const checks = [
    {
      field: 'generatorSha256',
      sitePath: siteGeneratorPath(contract),
      expected: contract.generatorSha256 || null,
    },
  ];

  for (const artifact of contract.artifacts || []) {
    checks.push({
      field: `${artifact.file}#sourceSha256`,
      sitePath: artifact.sourceLogic ? `${SITE_LOGIC_DIR}/${artifact.sourceLogic}` : null,
      expected: artifact.sourceSha256 || null,
    });
    checks.push({
      field: `${artifact.file}#artifactSha256`,
      // Il lato sito del gemello lo dichiara gia' il manifest: leggerlo di la'
      // invece di ricostruirlo qui tiene una sola sorgente per quel path
      // (AGENTS.md #6), e un `sitePath` sbagliato esce rosso una volta sola.
      sitePath: bySitePath.get(`.github/workflows/${artifact.file}`) || null,
      expected: artifact.artifactSha256 || null,
    });
  }

  return checks;
}

/**
 * Confronta il piano con quanto osservato. Puro.
 *
 *   observed  Map field -> { sha256 } | { sha256: null } (404) | { error }
 */
export function evaluateProvenance(checks, observed) {
  const results = [];
  for (const check of checks) {
    const seen = observed instanceof Map ? observed.get(check.field) : observed?.[check.field];
    let state;
    let detail = '';
    if (!check.expected || !check.sitePath) {
      state = 'undeclared';
      detail = !check.expected
        ? 'il contratto non porta il digest'
        : 'il contratto non dice quale path del sito verificare';
    } else if (!seen || seen.error) {
      state = 'unobserved';
      detail = seen?.error ? String(seen.error).slice(0, 120) : 'nessuna osservazione';
    } else if (seen.sha256 === null) {
      state = 'absent';
      detail = `${check.sitePath} non esiste su ${SITE_REPO}@${SITE_REF}`;
    } else if (seen.sha256 === check.expected) {
      state = 'verified';
    } else {
      state = 'drifted';
      detail = `dichiarato ${check.expected.slice(0, 16)}, il sito serve ${seen.sha256.slice(0, 16)}`;
    }
    results.push({ ...check, state, detail });
  }

  const counts = {};
  for (const r of results) counts[r.state] = (counts[r.state] || 0) + 1;
  const broken = results.filter((r) => r.state === 'drifted' || r.state === 'absent' || r.state === 'undeclared');
  const unobserved = counts.unobserved || 0;

  let red = false;
  let reason = null;
  if (broken.length) {
    red = true;
    reason =
      `${broken.length}/${results.length} digest del contratto non corrispondono ai byte del sito: ` +
      'i 24 artifact qui sono stantii finche\' non vengono rigenerati dal sorgente.';
  } else if (results.length > 0 && unobserved === results.length) {
    red = true;
    reason =
      `${unobserved}/${results.length} voci non osservate: il verdetto «tutto verificato» non significa ` +
      'piu\' niente, quindi non viene dato.';
  }

  return { results, counts, red, reason };
}

export function formatReport({ results, counts, red, reason }) {
  const lines = [`# Provenienza del contratto cross-repo — ${SITE_REPO}@${SITE_REF}`, ''];
  const order = ['drifted', 'absent', 'undeclared', 'unobserved', 'verified'];
  for (const state of order) {
    const rows = results.filter((r) => r.state === state);
    if (!rows.length) continue;
    lines.push(`## ${state} (${rows.length})`);
    for (const r of rows.slice(0, state === 'verified' ? 3 : rows.length)) {
      lines.push(`- \`${r.field}\` → \`${r.sitePath ?? '—'}\`${r.detail ? ` — ${r.detail}` : ''}`);
    }
    if (state === 'verified' && rows.length > 3) lines.push(`- …e altre ${rows.length - 3}`);
    lines.push('');
  }
  lines.push(`Totale: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ') || 'nessun controllo'}`);
  if (red) lines.push('', `🔴 ${reason}`);
  return lines.join('\n');
}

/** Byte del file dal sito al ref dato; null su 404. */
async function siteFile(rel) {
  const url = `https://raw.githubusercontent.com/${SITE_REPO}/${SITE_REF}/${rel}`;
  const headers = { 'User-Agent': 'verify-crawler-contract-provenance' };
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  const res = await fetch(url, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${rel} → HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const checks = planProvenanceChecks(contract, manifest);

  // Un fetch per path DISTINTO: i 24 `sourceSha256` puntano a 24 file diversi,
  // ma un contratto malformato potrebbe ripetere lo stesso path.
  const cache = new Map();
  const observed = new Map();
  for (const check of checks) {
    if (!check.sitePath) continue;
    if (!cache.has(check.sitePath)) {
      try {
        const bytes = await siteFile(check.sitePath);
        cache.set(check.sitePath, { sha256: bytes === null ? null : sha256(bytes) });
      } catch (e) {
        cache.set(check.sitePath, { error: String(e.message || e) });
      }
    }
    observed.set(check.field, cache.get(check.sitePath));
  }

  const verdict = evaluateProvenance(checks, observed);
  console.log(args.has('--json') ? JSON.stringify(verdict, null, 2) : formatReport(verdict));
  if (verdict.red && args.has('--strict')) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
