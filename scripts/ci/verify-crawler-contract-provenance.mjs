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
 * SITE_LOGIC_DIR (opzionale) fissa la directory dei `*-logic.yml` sul sito
 * quando la si SA: senza, viene risolta provando le candidate.
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
 * dedotta dal manifest perche' quei file non hanno un gemello qui.
 *
 * ## Perche' non e' una costante sola (issue #982)
 *
 * Una directory INVENTATA da questo lato non e' un'osservazione: se il sito
 * sposta i `*-logic.yml`, tutti e 24 i `sourceSha256` diventano `absent` e lo
 * schedule esce rosso ogni notte per un difetto del verificatore, non del
 * contratto — e il fixer viene mandato a rigenerare artifact che stanno
 * benissimo. Il piano offline pinnava che il `sitePath` non fosse null, cosa
 * che una coordinata sbagliata soddisfa comunque.
 *
 * Quindi la coordinata si RISOLVE invece di essere assunta: si prova ogni
 * candidata e vince la prima che il sito serve davvero. `absent` torna a
 * significare «quel file non esiste da nessuna parte», che e' l'unico caso in
 * cui il rosso e' del contratto. Con `SITE_LOGIC_DIR` in ambiente la lista si
 * riduce a quella sola directory: un override esplicito e' una dichiarazione,
 * non una supposizione, e va creduto anche quando fallisce.
 */
export const SITE_LOGIC_DIR = '.github/workflows';

/**
 * Le altre directory in cui il sito ha gia' tenuto file di questo ciclo: i 24
 * artifact vivono sotto `.github/corpus-workflows/` (vedi i `sitePath` del
 * manifest), quindi e' il primo posto plausibile se la logica li segue.
 */
export const SITE_LOGIC_DIR_FALLBACKS = ['.github/corpus-workflows'];

/** Le candidate, nell'ordine in cui vanno provate. Override esplicito = lista di uno. */
export function siteLogicDirs(env = process.env) {
  const declared = env?.SITE_LOGIC_DIR?.trim();
  const dirs = declared ? [declared] : [SITE_LOGIC_DIR, ...SITE_LOGIC_DIR_FALLBACKS];
  return [...new Set(dirs.map((d) => d.replace(/\/+$/, '')))];
}

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
 *
 * Ogni check porta anche `sitePathCandidates`: i path da provare in ordine.
 * Per tutto cio' che il contratto o il manifest DICHIARANO e' un elenco di
 * uno — non si tira a indovinare su una coordinata dichiarata. Solo i
 * `sourceSha256`, la cui directory nessuno dichiara, ne hanno piu' di uno.
 */
export function planProvenanceChecks(contract, manifest, logicDirs = siteLogicDirs()) {
  const bySitePath = new Map(
    (manifest?.files || []).map((entry) => [entry.path, entry.sitePath || null]),
  );
  const declared = (sitePath) => ({ sitePath, sitePathCandidates: sitePath ? [sitePath] : [] });
  const checks = [
    {
      field: 'generatorSha256',
      ...declared(siteGeneratorPath(contract)),
      expected: contract.generatorSha256 || null,
    },
  ];

  for (const artifact of contract.artifacts || []) {
    const candidates = artifact.sourceLogic
      ? logicDirs.map((dir) => `${dir}/${artifact.sourceLogic}`)
      : [];
    checks.push({
      field: `${artifact.file}#sourceSha256`,
      sitePath: candidates[0] || null,
      sitePathCandidates: candidates,
      expected: artifact.sourceSha256 || null,
    });
    checks.push({
      field: `${artifact.file}#artifactSha256`,
      // Il lato sito del gemello lo dichiara gia' il manifest: leggerlo di la'
      // invece di ricostruirlo qui tiene una sola sorgente per quel path
      // (AGENTS.md #6), e un `sitePath` sbagliato esce rosso una volta sola.
      ...declared(bySitePath.get(`.github/workflows/${artifact.file}`) || null),
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
    // Il path RISOLTO se l'osservatore ne ha provati piu' d'uno: il report deve
    // nominare il file che ha davvero letto, non la prima candidata del piano.
    const sitePath = seen?.sitePath || check.sitePath;
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
      const tried = seen.triedPaths?.length ? seen.triedPaths : [sitePath];
      detail =
        `${tried.join(', ')} non esiste${tried.length > 1 ? 'ono' : ''} su ${SITE_REPO}@${SITE_REF}`;
    } else if (seen.sha256 === check.expected) {
      state = 'verified';
    } else {
      state = 'drifted';
      detail = `dichiarato ${check.expected.slice(0, 16)}, il sito serve ${seen.sha256.slice(0, 16)}`;
    }
    results.push({ ...check, sitePath, state, detail });
  }

  const counts = {};
  for (const r of results) counts[r.state] = (counts[r.state] || 0) + 1;
  const broken = results.filter((r) => r.state === 'drifted' || r.state === 'absent' || r.state === 'undeclared');
  const unobserved = counts.unobserved || 0;

  // Se spariscono TUTTI i `*-logic.yml` insieme, il sospettato non e' il
  // contratto: sono 24 file che non si perdono uno per uno, e' la directory
  // che questo lato inventa. Dirlo nel verdetto manda il fixer su
  // `SITE_LOGIC_DIR` invece che a rigenerare artifact sani (issue #982).
  const sources = results.filter((r) => r.field.endsWith('#sourceSha256'));
  const movedLogicDir = sources.length > 1 && sources.every((r) => r.state === 'absent');

  let red = false;
  let reason = null;
  if (broken.length) {
    red = true;
    if (movedLogicDir) {
      const tried = [...new Set(
        sources
          .flatMap((r) => (r.sitePathCandidates?.length ? r.sitePathCandidates : [r.sitePath]))
          .map((p) => p.split('/').slice(0, -1).join('/')),
      )];
      const others = broken.length - sources.length;
      reason =
        `nessuno dei ${sources.length} \`*-logic.yml\` esiste su ${SITE_REPO}@${SITE_REF} sotto ` +
        `${tried.join(' o ')}: il sito li ha spostati e la coordinata di questo lato ` +
        '(`SITE_LOGIC_DIR`) va aggiornata — gli artifact non c\'entrano.' +
        (others > 0 ? ` A parte: altri ${others} digest non corrispondono.` : '');
    } else {
      reason =
        `${broken.length}/${results.length} digest del contratto non corrispondono ai byte del sito: ` +
        'i 24 artifact qui sono stantii finche\' non vengono rigenerati dal sorgente.';
    }
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
  const observe = async (rel) => {
    if (!cache.has(rel)) {
      try {
        const bytes = await siteFile(rel);
        cache.set(rel, { sha256: bytes === null ? null : sha256(bytes) });
      } catch (e) {
        cache.set(rel, { error: String(e.message || e) });
      }
    }
    return cache.get(rel);
  };

  // La directory che ha risposto per prima si appiccica: fatta la scoperta su
  // un `*-logic.yml`, gli altri 23 partono da li' e il costo in rate-limit
  // resta un fetch a file, non uno per candidata (i 60/ora anonimi sono il
  // vincolo che tiene questo verificatore fuori da `node --test`).
  let stickyDir = null;
  const observed = new Map();
  for (const check of checks) {
    const candidates = check.sitePathCandidates?.length
      ? check.sitePathCandidates
      : (check.sitePath ? [check.sitePath] : []);
    if (!candidates.length) continue;
    const ordered = stickyDir
      ? [...candidates].sort((a, b) => (b.startsWith(`${stickyDir}/`) ? 1 : 0) - (a.startsWith(`${stickyDir}/`) ? 1 : 0))
      : candidates;

    const tried = [];
    let fallback = null;
    let hit = null;
    for (const rel of ordered) {
      tried.push(rel);
      const seen = await observe(rel);
      if (seen.sha256) {
        hit = { ...seen, sitePath: rel };
        break;
      }
      // Un errore di rete su una candidata non prova che il file non c'e':
      // resta il verdetto di riserva solo se nessun'altra risponde, cosi' il
      // caso «al buio» non si traveste da `absent`.
      if (seen.error && !fallback?.error) fallback = { ...seen, sitePath: rel };
      else if (!fallback) fallback = { ...seen, sitePath: rel };
    }
    if (hit && candidates.length > 1) stickyDir = hit.sitePath.split('/').slice(0, -1).join('/');
    observed.set(check.field, hit || { ...fallback, sitePath: fallback.sitePath, triedPaths: tried });
  }

  const verdict = evaluateProvenance(checks, observed);
  console.log(args.has('--json') ? JSON.stringify(verdict, null, 2) : formatReport(verdict));
  if (verdict.red && args.has('--strict')) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
