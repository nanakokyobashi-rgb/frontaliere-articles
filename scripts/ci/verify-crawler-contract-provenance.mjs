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
 *   unrecognized il path esiste, ma i byte non hanno la firma di una sorgente
 *               logic riconoscibile. ROSSO, distinto da un 404.
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
 * quando la si SA: senza, viene usata la directory osservata qui sotto.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRawFetcher } from '../lib/cross-repo-raw-fetch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONTRACT_PATH = path.join(ROOT, 'generator/data/crawler-cross-repo-contract.json');
const MANIFEST_PATH = path.join(ROOT, 'scripts/ci/loop-sync-manifest.json');
const SITE_REPO = process.env.SITE_REPO || 'valerielinc-ops/frontaliere-si-o-no';
const SITE_REF = process.env.SITE_REF || 'main';
const SOURCE_COMMIT_RE = /^[a-f0-9]{40}$/u;
const SOURCE_REF_RE = /^(?![.-])[A-Za-z0-9._/-]{1,256}$/u;

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
 * La coordinata ora e' osservata: su `frontaliere-si-o-no@main` tutti i 24
 * `*-logic.yml` vivono sotto `.github/workflows`, mentre
 * `.github/corpus-workflows` contiene solo gli artifact. Non si conserva una
 * fallback inventata: un futuro spostamento deve diventare un rosso esplicito
 * sulla coordinata, non un verde o un falso `drifted` su un residuo omonimo.
 * Con `SITE_LOGIC_DIR` in ambiente la lista resta quella sola directory: un
 * override esplicito e' una dichiarazione, non una supposizione, e va creduto
 * anche quando fallisce.
 */
export const SITE_LOGIC_DIR = '.github/workflows';

/**
 * Nessuna fallback: `.github/corpus-workflows/` ospita gli artifact, non le
 * sorgenti osservate. Una nuova candidata va aggiunta solo dopo una misura
 * sull'albero del sito.
 */
export const SITE_LOGIC_DIR_FALLBACKS = [];

/** Le candidate, nell'ordine in cui vanno provate. Override esplicito = lista di uno. */
export function siteLogicDirs(env = process.env) {
  const declared = env?.SITE_LOGIC_DIR?.trim();
  const dirs = declared ? [declared] : [SITE_LOGIC_DIR];
  return [...new Set(dirs.map((d) => d.replace(/\/+$/, '')))];
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function localLineageCheck(field, expected, observed) {
  return {
    field,
    localOnly: true,
    sitePath: null,
    sitePathCandidates: [],
    expected: expected ?? null,
    observed: observed ?? null,
  };
}

function contractObservationLineage(contract) {
  const sourceRef = typeof contract?.sourceRef === 'string' ? contract.sourceRef : null;
  const sourceCommit = typeof contract?.sourceCommit === 'string' ? contract.sourceCommit : null;
  const observation = contract?.artifactObservation && typeof contract.artifactObservation === 'object'
    ? contract.artifactObservation
    : {};
  const validSourceRef = sourceRef && SOURCE_REF_RE.test(sourceRef) ? sourceRef : null;
  const validSourceCommit = sourceCommit && SOURCE_COMMIT_RE.test(sourceCommit) ? sourceCommit : null;
  const observationRef = validSourceCommit || validSourceRef || SITE_REF;
  return {
    sourceRef,
    sourceCommit,
    observation,
    validSourceRef,
    validSourceCommit,
    observationRef,
  };
}

/**
 * True when bytes are a generated logic source, rather than an artifact or a
 * same-named residual file. The YAML shape is load-bearing: a top-level
 * `on`/`"on"`/`'on'` trigger containing `workflow_call` plus top-level `jobs:`
 * proves a reusable workflow. The check accepts block and inline YAML forms,
 * while the basename guard prevents a non-logic candidate from being treated
 * as a source. A cosmetic comment change on the site cannot invalidate the
 * observation.
 */
export function isLogicSource(bytes, sourceLogic) {
  if (!bytes || !/^[a-z0-9][a-z0-9-]*-logic\.yml$/u.test(String(sourceLogic))) return false;
  const text = Buffer.from(bytes).toString('utf8');
  const lines = text.split(/\r?\n/u).map(stripYamlComment);
  const topLevelKey = (line, key) => new RegExp(
    `^(?:${key}|["']${key}["']):(?:[ \\t]|$)`,
    'u',
  ).test(line);
  const workflowCallKey = /^(?:[ \t]+)(?:workflow_call|["']workflow_call["']):(?:[ \t]|$)/u;
  const inlineWorkflowCallKey = /(?:^|[,{][ \t]*)(?:workflow_call|["']workflow_call["']):/u;

  let hasWorkflowCall = false;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(?:on|["']on["']):[ \t]*(.*)$/u);
    if (!match) continue;
    const value = match[1].trim();
    if (value.startsWith('{')) {
      const inline = [];
      for (let cursor = index; cursor < lines.length; cursor += 1) {
        if (cursor > index && topLevelKey(lines[cursor], 'jobs')) break;
        inline.push(lines[cursor]);
      }
      hasWorkflowCall = inlineWorkflowCallKey.test(inline.join('\n'));
    } else {
      let childIndent = null;
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const line = lines[cursor];
        if (/^[ \t]*(?:#.*)?$/u.test(line)) continue;
        if (topLevelKey(line, 'jobs') || /^(?:[A-Za-z0-9_-]+|["'][^"']+["']):/u.test(line)) break;
        const indent = line.match(/^[ \t]*/u)[0].length;
        if (indent === 0) break;
        childIndent ??= indent;
        if (indent === childIndent && workflowCallKey.test(line)) {
          hasWorkflowCall = true;
          break;
        }
      }
    }
    break;
  }

  const hasJobs = lines.some((line) => topLevelKey(line, 'jobs'));
  return hasWorkflowCall && hasJobs;
}

/** Remove YAML comments without treating a quoted `#` as a comment. */
function stripYamlComment(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index];
    if (quote === '"') {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        quote = null;
      }
      continue;
    }
    if (quote === "'") {
      if (ch === "'" && line[index + 1] === "'") {
        index += 1;
      } else if (ch === "'") {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (index === 0 || /\s/u.test(line[index - 1]))) {
      return line.slice(0, index);
    }
  }
  return line;
}

/**
 * The contract carries runtime paths by name because the site owns these
 * scripts. That is still enough to make an artifact/runtime flag mismatch
 * observable: inspect the flags actually invoked by the transported artifact,
 * then fetch only those named runtime paths from the site.
 */
export const CRAWLER_COMMIT_RUNTIME_PATH = 'scripts/lib/git-commit-data.sh';
const RUNTIME_FLAG_PATTERN = /^--[A-Za-z0-9][A-Za-z0-9-]*$/u;
const escapeRegExp = (value) => value.replace(/[\^$.*+?()[\]{}|]/g, '\\$&');

function runtimeFlagsInvokedBy(text, runtimePath) {
  const command = new RegExp(
    '(?:^|[;&|\'"]|\\s)(?:bash|sh)\\s+' +
      escapeRegExp(runtimePath) +
      '(?<args>[^\\r\\n]*)',
    'u',
  );
  const flags = new Set();
  for (const line of String(text || '').split(/\r?\n/u)) {
    if (line.trimStart().startsWith('#')) continue;
    const match = line.match(command);
    if (!match) continue;
    const optionPrefix = match.groups.args.match(
      /^\s*((?:--[A-Za-z0-9][A-Za-z0-9-]*(?:\s+|$))*)/u,
    );
    for (const flag of optionPrefix?.[1].match(/--[A-Za-z0-9][A-Za-z0-9-]*/gu) || []) {
      flags.add(flag);
    }
  }
  return flags;
}

/**
 * Plan one remote source check per distinct runtime flag invoked by the
 * artifacts. Duplicate invocations across the 23 groups remain traceable
 * without multiplying the same remote fetch.
 */
export function planRuntimeFlagChecks(
  contract,
  artifactSources,
  runtimePath = CRAWLER_COMMIT_RUNTIME_PATH,
) {
  const declaredRuntimePaths = new Set(contract?.siteRuntimePaths || []);
  const artifactsByFlag = new Map();
  for (const artifact of artifactSources || []) {
    for (const flag of runtimeFlagsInvokedBy(artifact.text, runtimePath)) {
      const files = artifactsByFlag.get(flag) || [];
      files.push(artifact.file);
      artifactsByFlag.set(flag, files);
    }
  }
  return [...artifactsByFlag.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([flag, artifactFiles]) => ({
      field: runtimePath + '#' + flag,
      sitePath: runtimePath,
      runtimePath,
      flag,
      artifactFiles,
      declared: declaredRuntimePaths.has(runtimePath),
    }));
}

/**
 * Check a runtime source semantically, not by a comment or usage example:
 * the flag must participate in the script's argument dispatch. This covers
 * the current if/elif form and leaves the case-label form available to a
 * future rewrite.
 */
export function isRuntimeFlagSupported(bytes, flag) {
  if (!bytes || !RUNTIME_FLAG_PATTERN.test(flag)) return false;
  const text = Buffer.from(bytes).toString('utf8');
  const executableText = text
    .split(/\r?\n/u)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  const escaped = escapeRegExp(flag);
  const comparison = new RegExp(
    "\\$\\{1:-\\}[\\s'\"]*={1,2}\\s*['\"]?" +
      escaped +
      "['\"]?(?=[\\s\\];]|$)",
    'u',
  );
  const caseLabel = new RegExp('(?:^|[|;&\\s])' + escaped + '\\s*\\)', 'mu');
  return comparison.test(executableText) || caseLabel.test(executableText);
}

/**
 * Evaluate the remote runtime observations. A present source without the
 * invoked flag is a hard failure; a missing contract entry is also hard
 * failure. A transport error remains proceed-safe unless it blinds every
 * runtime check, matching the digest verifier's policy.
 */
export function evaluateRuntimeFlagChecks(
  checks,
  observed,
  {
    runtimeDeclared = false,
    runtimePath = CRAWLER_COMMIT_RUNTIME_PATH,
    unobservedArtifacts = [],
  } = {},
) {
  const results = [];
  for (const check of checks || []) {
    const seen = observed instanceof Map ? observed.get(check.field) : observed?.[check.field];
    let state;
    let detail = '';
    if (!check.declared) {
      state = 'undeclared';
      detail = check.runtimePath + ' non è presente in contract.siteRuntimePaths';
    } else if (!seen || seen.error) {
      state = 'unobserved';
      detail = seen?.error ? String(seen.error).slice(0, 120) : 'nessuna osservazione';
    } else if (seen.sha256 === null || seen.bytes == null) {
      state = 'absent';
      detail = check.sitePath + ' non esiste su ' + SITE_REPO + '@' + SITE_REF;
    } else if (!isRuntimeFlagSupported(seen.bytes, check.flag)) {
      state = 'unrecognized';
      detail = check.sitePath + ' non riconosce ' + check.flag;
    } else {
      state = 'verified';
    }
    results.push({ ...check, state, detail });
  }

  // Un artifact che il checkout locale non riesce a leggere non deve far
  // saltare l'intero report prima dei fetch remoti: resta una osservazione
  // `unobserved`, così il caso isolato è proceed-safe e quello cieco diventa
  // rosso insieme agli altri controlli.
  for (const artifact of unobservedArtifacts || []) {
    results.push({
      field: `${artifact.file}#runtime`,
      sitePath: runtimePath,
      runtimePath,
      flag: null,
      artifactFiles: [artifact.file],
      state: 'unobserved',
      detail: `artifact locale non leggibile: ${String(artifact.error || 'errore sconosciuto').slice(0, 120)}`,
    });
  }

  // Un piano vuoto mentre il contratto dichiara il runtime è un fallimento
  // del guard, non la prova che il runtime non venga invocato: altrimenti un
  // template generato con una forma di comando non riconosciuta potrebbe
  // cancellare silenziosamente tutti i controlli.
  const emptyRuntimePlan = (checks?.length ?? 0) === 0 && runtimeDeclared;
  if (emptyRuntimePlan) {
    results.push({
      field: `${runtimePath}#<nessuna-invocazione-rilevata>`,
      sitePath: runtimePath,
      runtimePath,
      flag: null,
      artifactFiles: [],
      state: 'unobserved',
      detail: 'nessuna invocazione runtime rilevata negli artifact dichiarati',
    });
  }

  const counts = {};
  for (const result of results) counts[result.state] = (counts[result.state] || 0) + 1;
  const broken = results.filter((result) => (
    result.state === 'absent' ||
    result.state === 'unrecognized' ||
    result.state === 'undeclared'
  ));
  const unobserved = counts.unobserved || 0;
  let red = false;
  let reason = null;
  if (broken.length) {
    red = true;
    reason =
      broken.length + '/' + results.length +
      ' flag runtime invocate dagli artifact non sono garantite dal sorgente remoto: ' +
      broken.map((result) => result.flag + ' (' + result.state + ')').join(', ');
  } else if (emptyRuntimePlan) {
    red = true;
    reason =
      'nessuna invocazione runtime rilevata negli artifact dichiarati: ' +
      'il piano non può autoassolversi per assenza di controlli.';
  } else if (results.length > 0 && unobserved === results.length) {
    red = true;
    reason =
      unobserved + '/' + results.length +
      ' flag runtime non osservate: il verdetto non significa piu niente, ' +
      'quindi non viene dato.';
  }
  return { results, counts, red, reason };
}

/**
 * Resolve one site observation from ordered candidates.
 *
 * A source candidate is accepted only with its generated-source marker. A
 * 404 is definitive absence when no valid candidate is found. A response
 * whose bytes are present but do not carry the source signature is kept as
 * `unrecognized`; `unobserved` is reserved for the case where every
 * candidate failed in transport.
 *
 * @param {string[]} candidates
 * @param {(rel: string) => Promise<object>} observe
 * @param {string|null} sourceLogic
 * @returns {Promise<object>}
 */
export async function resolveSiteCandidate(candidates, observe, sourceLogic = null) {
  const triedPaths = [];
  let fallback = null;
  let observedResponse = false;
  let invalidSource = false;

  for (const rel of candidates) {
    triedPaths.push(rel);
    const seen = await observe(rel);
    if (seen?.error) {
      if (!fallback || fallback.error) fallback = { ...seen, sitePath: rel };
      continue;
    }
    if (!seen || seen.sha256 === null) {
      observedResponse = true;
      if (!fallback || fallback.error) fallback = { ...(seen || { sha256: null }), sitePath: rel };
      continue;
    }
    if (sourceLogic && !isLogicSource(seen.bytes, sourceLogic)) {
      observedResponse = true;
      invalidSource = true;
      fallback = { ...seen, sha256: null, sitePath: rel, invalidSource: true };
      continue;
    }
    return { ...seen, sitePath: rel, triedPaths };
  }

  if (observedResponse) {
    return {
      sha256: null,
      sitePath: fallback?.sitePath || candidates[candidates.length - 1],
      triedPaths,
      ...(invalidSource ? { invalidSource: true } : {}),
    };
  }
  return {
    ...(fallback || { error: 'nessuna osservazione' }),
    sitePath: fallback?.sitePath || candidates[candidates.length - 1],
    triedPaths,
  };
}

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
export function planProvenanceChecks(
  contract,
  manifest,
  logicDirs = siteLogicDirs(),
  observationRef = contractObservationLineage(contract).observationRef,
) {
  const bySitePath = new Map(
    (manifest?.files || []).map((entry) => [entry.path, entry.sitePath || null]),
  );
  const declared = (sitePath) => ({ sitePath, sitePathCandidates: sitePath ? [sitePath] : [] });
  const lineage = contractObservationLineage(contract);
  const checks = [
    localLineageCheck('contract#sourceRef', lineage.sourceRef, lineage.validSourceRef),
    localLineageCheck('contract#sourceCommit', lineage.sourceCommit, lineage.validSourceCommit),
    localLineageCheck(
      'contract#artifactObservation.generatorSha256',
      contract.generatorSha256,
      lineage.observation.generatorSha256,
    ),
    localLineageCheck(
      'contract#artifactObservation.sourceRef',
      lineage.sourceRef,
      lineage.observation.sourceRef,
    ),
    localLineageCheck(
      'contract#artifactObservation.sourceCommit',
      lineage.sourceCommit,
      lineage.observation.sourceCommit,
    ),
    {
      field: 'generatorSha256',
      ...declared(siteGeneratorPath(contract)),
      expected: contract.generatorSha256 || null,
      observationRef,
    },
  ];

  for (const artifact of contract.artifacts || []) {
    const candidates = artifact.sourceLogic
      ? logicDirs.map((dir) => `${dir}/${artifact.sourceLogic}`)
      : [];
    checks.push({
      field: `${artifact.file}#sourceSha256`,
      sourceLogic: artifact.sourceLogic || null,
      sitePath: candidates[0] || null,
      sitePathCandidates: candidates,
      expected: artifact.sourceSha256 || null,
      observationRef,
    });
    checks.push({
      field: `${artifact.file}#artifactSha256`,
      // Il lato sito del gemello lo dichiara gia' il manifest: leggerlo di la'
      // invece di ricostruirlo qui tiene una sola sorgente per quel path
      // (AGENTS.md #6), e un `sitePath` sbagliato esce rosso una volta sola.
      ...declared(bySitePath.get(`.github/workflows/${artifact.file}`) || null),
      expected: artifact.artifactSha256 || null,
      observationRef,
    });
    checks.push(localLineageCheck(
      `${artifact.file}#generatorSha256`,
      contract.generatorSha256,
      artifact.generatorSha256,
    ));
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
  const observationRef = checks.find((check) => check.observationRef)?.observationRef || SITE_REF;
  for (const check of checks) {
    const seen = observed instanceof Map ? observed.get(check.field) : observed?.[check.field];
    // Il path RISOLTO se l'osservatore ne ha provati piu' d'uno: il report deve
    // nominare il file che ha davvero letto, non la prima candidata del piano.
    const sitePath = seen?.sitePath || check.sitePath;
    let state;
    let detail = '';
    if (check.localOnly) {
      if (check.expected == null || check.observed == null) {
        state = 'undeclared';
        detail = 'il contratto non porta una lineage completa e valida';
      } else if (check.observed === check.expected) {
        state = 'verified';
      } else {
        state = 'drifted';
        detail = `dichiarato ${String(check.expected).slice(0, 16)}, osservato ${String(check.observed).slice(0, 16)}`;
      }
    } else if (check.expected == null || !check.sitePath) {
      state = 'undeclared';
      detail = check.expected == null
        ? 'il contratto non porta il digest'
        : 'il contratto non dice quale path del sito verificare';
    } else if (!seen || seen.error) {
      state = 'unobserved';
      detail = seen?.error ? String(seen.error).slice(0, 120) : 'nessuna osservazione';
    } else if (seen.sha256 === null) {
      state = seen.invalidSource ? 'unrecognized' : 'absent';
      const tried = seen.triedPaths?.length ? seen.triedPaths : [sitePath];
      detail = seen.invalidSource
        ? `${tried.join(', ')} e' presente ma non riconosciuta come sorgente logic su ${SITE_REPO}@${check.observationRef || observationRef}`
        : `${tried.join(', ')} non esiste${tried.length > 1 ? 'ono' : ''} su ${SITE_REPO}@${check.observationRef || observationRef}`;
    } else if (seen.sha256 === check.expected) {
      state = 'verified';
    } else {
      state = 'drifted';
      detail = `dichiarato ${check.expected.slice(0, 16)}, il sito serve ${seen.sha256.slice(0, 16)}`;
    }
    results.push({ ...check, sitePath, state, detail, invalidSource: Boolean(seen?.invalidSource) });
  }

  const counts = {};
  for (const r of results) counts[r.state] = (counts[r.state] || 0) + 1;
  const broken = results.filter((r) => (
    r.state === 'drifted' || r.state === 'absent' || r.state === 'unrecognized' || r.state === 'undeclared'
  ));
  const remoteResults = results.filter((result) => !result.localOnly);
  const unobserved = remoteResults.filter((result) => result.state === 'unobserved').length;

  // Se spariscono TUTTI i `*-logic.yml` insieme, il sospettato non e' il
  // contratto: sono 24 file che non si perdono uno per uno, e' la directory
  // che questo lato inventa. Dirlo nel verdetto manda il fixer su
  // `SITE_LOGIC_DIR` invece che a rigenerare artifact sani (issue #982).
  const sources = results.filter((r) => r.field.endsWith('#sourceSha256'));
  const invalidSources = sources.filter((r) => r.invalidSource);
  const movedLogicDir = sources.length > 1
    && sources.every((r) => r.state === 'absent');

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
        (invalidSources.length === sources.length
          ? `nessuno dei ${sources.length} \`*-logic.yml\` sotto `
          : `nessuno dei ${sources.length} \`*-logic.yml\` esiste su `) +
        (invalidSources.length === sources.length ? '' : `${SITE_REPO}@${observationRef} sotto `) +
        `${tried.join(' o ')}: il sito li ha spostati e la coordinata di questo lato ` +
        (invalidSources.length === sources.length
          ? '(`SITE_LOGIC_DIR`) va aggiornata: le risposte non portano il marker della sorgente — gli artifact non c\'entrano.'
          : '(`SITE_LOGIC_DIR`) va aggiornata — gli artifact non c\'entrano.') +
        (others > 0 ? ` A parte: altri ${others} digest non corrispondono.` : '');
    } else if (invalidSources.length) {
      reason =
        `${invalidSources.length}/${sources.length} sorgenti \`*-logic.yml\` rispondono senza il marker ` +
        `della sorgente su ${SITE_REPO}@${observationRef}: verificare la coordinata ` +
        '`SITE_LOGIC_DIR` o la generazione del sito.' +
        (broken.length > invalidSources.length
          ? ` A parte: altri ${broken.length - invalidSources.length} digest non corrispondono.`
          : '');
    } else {
      reason =
        `${broken.length}/${results.length} digest del contratto non corrispondono ai byte del sito: ` +
        'i 24 artifact qui sono stantii finche\' non vengono rigenerati dal sorgente.';
    }
  } else if (remoteResults.length > 0 && unobserved === remoteResults.length) {
    red = true;
    reason =
      `${unobserved}/${remoteResults.length} voci remote non osservate: il verdetto «tutto verificato» non significa ` +
      'piu\' niente, quindi non viene dato.';
  }

  return { results, counts, red, reason, observationRef };
}

function mergeVerdicts(...verdicts) {
  const results = verdicts.flatMap((verdict) => verdict.results);
  const counts = {};
  for (const result of results) counts[result.state] = (counts[result.state] || 0) + 1;
  const reasons = verdicts.map((verdict) => verdict.reason).filter(Boolean);
  return {
    results,
    counts,
    red: verdicts.some((verdict) => verdict.red),
    reason: reasons.length ? reasons.join(' A parte: ') : null,
    observationRef: verdicts.find((verdict) => verdict.observationRef)?.observationRef || SITE_REF,
  };
}

export function formatReport({ results, counts, red, reason, observationRef = SITE_REF }) {
  const lines = [`# Provenienza del contratto cross-repo — ${SITE_REPO}@${observationRef}`, ''];
  const order = ['drifted', 'unrecognized', 'absent', 'undeclared', 'unobserved', 'verified'];
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

/**
 * Il client verso il sito. `GH_TOKEN` qui e' il `GITHUB_TOKEN` di QUESTO repo,
 * che su `valerielinc-ops/…` non ha alcun permesso: se raw lo rifiuta, la
 * risposta autorevole e' quella anonima — il repo del sito e' pubblico. Senza
 * questo fallback un 401 renderebbe `unobserved` tutte e 49 le voci, e un 404
 * da mancato accesso si travestirebbe da `absent`. Vedi
 * `scripts/lib/cross-repo-raw-fetch.mjs` (issue #982).
 */
const rawFetch = createRawFetcher({
  userAgent: 'verify-crawler-contract-provenance',
  token: process.env.GH_TOKEN,
});

/** Byte del file dal sito al ref dato; null su 404. */
async function siteFile(rel, ref = SITE_REF) {
  const url = `https://raw.githubusercontent.com/${SITE_REPO}/${ref}/${rel}`;
  const res = await rawFetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${rel} → HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const checks = planProvenanceChecks(contract, manifest);
  const observationRef = checks.find((check) => check.observationRef)?.observationRef || SITE_REF;
  const unreadableArtifacts = [];
  const artifactSources = [];
  for (const artifact of contract.artifacts || []) {
    try {
      artifactSources.push({
        file: artifact.file,
        text: fs.readFileSync(path.join(ROOT, '.github/workflows', artifact.file), 'utf8'),
      });
    } catch (error) {
      unreadableArtifacts.push({
        file: artifact.file,
        error: error.message || String(error),
      });
    }
  }
  const runtimeChecks = planRuntimeFlagChecks(contract, artifactSources);

  // Un fetch per path DISTINTO: i 24 `sourceSha256` puntano a 24 file diversi,
  // ma un contratto malformato potrebbe ripetere lo stesso path.
  const cache = new Map();
  const observe = async (rel) => {
    if (!cache.has(rel)) {
      try {
        const bytes = await siteFile(rel, observationRef);
        cache.set(rel, { sha256: bytes === null ? null : sha256(bytes), bytes });
      } catch (e) {
        cache.set(rel, { error: String(e.message || e) });
      }
    }
    return cache.get(rel);
  };

  const observed = new Map();
  for (const check of checks) {
    const candidates = check.sitePathCandidates?.length
      ? check.sitePathCandidates
      : (check.sitePath ? [check.sitePath] : []);
    if (!candidates.length) continue;
    observed.set(check.field, await resolveSiteCandidate(candidates, observe, check.sourceLogic));
  }

  const runtimeObserved = new Map();
  for (const check of runtimeChecks) {
    if (!check.declared) continue;
    runtimeObserved.set(check.field, await observe(check.sitePath));
  }

  const verdict = mergeVerdicts(
    evaluateProvenance(checks, observed),
    evaluateRuntimeFlagChecks(runtimeChecks, runtimeObserved, {
      runtimeDeclared: (contract.siteRuntimePaths || []).includes(CRAWLER_COMMIT_RUNTIME_PATH),
      unobservedArtifacts: unreadableArtifacts,
    }),
  );
  console.log(args.has('--json') ? JSON.stringify(verdict, null, 2) : formatReport(verdict));
  // Un token rifiutato non e' un guasto — le osservazioni sopra sono state
  // rifatte in anonimo — ma va detto: e' la sola spia del fatto che il resto
  // della passata ha viaggiato sui 60 fetch/ora anonimi per IP.
  if (rawFetch.state.tokenRejected.size > 0) {
    console.log(
      `\nℹ️ \`GH_TOKEN\` rifiutato da raw.githubusercontent per ${SITE_REPO}: ` +
      'le letture sono proseguite in anonimo (repo pubblico).',
    );
  }
  if (verdict.red && args.has('--strict')) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`verify-crawler-contract-provenance fallito: ${error && error.stack ? error.stack : error}`);
    // Un errore di rete non osservato non deve diventare un rosso del dispatch
    // di sola ispezione; `--strict` mantiene invece il contratto esplicito del
    // chiamante che ha chiesto un verdetto bloccante.
    process.exitCode = process.argv.includes('--strict') ? 1 : 0;
  });
}
