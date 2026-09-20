#!/usr/bin/env node

/**
 * review-scope.mjs — classifica i finding Important rispetto alla HEAD della PR.
 *
 * Il reviewer puo' ispezionare il repository intero. Un finding su un file che
 * non appartiene al diff corrente resta una segnalazione valida, ma non deve
 * tenere rosso il gate della PR: viene raccolto in una sola issue follow-up.
 * L'errore di risoluzione e' conservativo: un basename ambiguo o una review
 * senza un file identificabile continua a bloccare, invece di perdere il
 * contesto del finding.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { REDFLAG_IMPORTANT_RE, REVIEWER_BOT_LOGIN_RE } from './lib/constants.mjs';
import { fetchPrFiles } from './lib/fetchPrFiles.mjs';
import { createGithubIssue } from '../lib/github-issue-creator.mjs';
import { evaluateBodyContract } from '../lib/pr-body-contract-eval.mjs';
import {
  changedLinesFromPatch,
  stableFindingId,
  unchangedLineImportants,
} from './lib/review-findings.mjs';

const FOLLOWUP_MARKER = 'OUT_OF_SCOPE_REVIEW_FOLLOWUP';
// Stesso margine del writer condiviso (`MAX_BODY_LEN`): il tetto API e' 65536.
const MAX_FOLLOWUP_BODY_LEN = 60000;
const FILE_CITATION_RE = /(?:^|[\s([{"'`])((?:\.\.?\/)?(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:cjs|css|html|js|json|md|mjs|sh|ts|tsx|txt|toml|yaml|yml|jsx))(?:[:#]L?\d+(?:[-–]\d+)?)?/giu;
const IMPORTANT_MARKER_RE = /🔴\s*\*{0,2}\s*Important\s*\*{0,2}\s*[:—-]\s*/u;
const FINDING_MARKER_RE = /🔴|🟡\s*\*{0,2}\s*Nit\s*\*{0,2}\s*[:—-]|🟣\s*\*{0,2}\s*Pre-existing\s*\*{0,2}\s*[:—-]|❓\s*q\s*:/gu;
const ZERO_IMPORTANT_RE = /^(?:0|none|nessuno)\s*$/iu;
// Anchor di un finding il cui unico riferimento e' la descrizione della PR.
const PR_BODY_ANCHOR_RE = /^\s*(?:[-*]\s*)?`?PR body[:#]L?([1-9]\d*)(?:[-–]\d+)?(?=$|[`:\s])/iu;
const PR_BODY_ANCHOR_LOOSE_RE = /`?PR body[:#]L?([1-9]\d*)/iu;
// TUTTI gli anchor `PR body:L<n>` del finding, non solo il primo, e con
// l'INTERVALLO quando c'e' (`PR body:L5-9`). Un anchor a intervallo che parte
// dentro `## Non implementato` puo' finire fuori — per esempio su una riga di
// `## Implementato` che il contratto non giudica — e tenerne solo l'estremo
// iniziale declasserebbe un finding che parla anche di quell'altra riga.
// L'endpoint `compare` di GitHub restituisce al massimo 300 file e non
// dichiara il troncamento: raggiunto il tetto, l'elenco non e' una prova.
const COMPARE_FILES_CAP = 300;
const PR_BODY_ANCHOR_ALL_RE = /`?PR body[:#]L?([1-9]\d*)(?:\s*[-–]\s*L?([1-9]\d*))?/giu;
// Cio' che il contratto deterministico NON sa giudicare resta bloccante anche
// se ancorato al body: il claim di performance senza baseline (REVIEW.md punto
// 7) non e' una regola del contratto, e' una regola della review. La lista e'
// deliberatamente LARGA: ogni termine in piu' lascia bloccante un finding in
// piu', che e' la direzione sicura dell'errore. Stringerla richiede una
// misura, allargarla no.
const NON_CONTRACT_BODY_RE = new RegExp([
  'baseline', 'perf', 'performance', 'speed-?up', 'speed', 'faster', 'veloc',
  'throughput', 'latenc[yz]', 'latenza', 'benchmark', 'overhead', 'regressi',
  'misura', 'misurat', 'pre/post', 'revert', 'ottimizzazion', 'optimi[sz]',
  'claim', 'risparmi', 'saving', 'p50', 'p90', 'p95', 'p99',
].map((part) => `(?:${part})`).join('|'), 'iu');

function resetImportantRegex() {
  REDFLAG_IMPORTANT_RE.lastIndex = 0;
}

/** Normalizza le forme `a/`, `b/`, `./` e i separatori usati dal reviewer. */
export function normalizePath(value) {
  let path = String(value || '')
    .trim()
    .replace(/^['"`([{<]+|['"`\])}>.,;:]+$/g, '')
    .replace(/\\/g, '/');
  path = path.replace(/^\.\//, '').replace(/^(?:\.\.\/)+/, '');
  path = path.replace(/^[ab]\//, '');
  return path.replace(/^\/+/, '').replace(/[:#]L?\d+(?:[-–]\d+)?$/u, '');
}

function citationPathAndLine(rawPath, fullMatch) {
  const lineMatch = fullMatch.match(/[:#]L?(\d+)(?:[-–]\d+)?$/u);
  return {
    path: normalizePath(rawPath),
    line: lineMatch ? Number(lineMatch[1]) : null,
  };
}

export function extractFileCitations(line) {
  const citations = [];
  FILE_CITATION_RE.lastIndex = 0;
  for (const match of String(line || '').matchAll(FILE_CITATION_RE)) {
    const citation = citationPathAndLine(match[1], match[0]);
    if (citation.path) citations.push(citation);
  }
  const seen = new Set();
  return citations.filter((citation) => {
    const key = `${citation.path}:${citation.line || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isInsideCodeSpan(line, index) {
  return (String(line).slice(0, index).match(/`/gu) || []).length % 2 === 1;
}

function firstFindingMarker(line) {
  FINDING_MARKER_RE.lastIndex = 0;
  for (const match of String(line || '').matchAll(FINDING_MARKER_RE)) {
    if (!isInsideCodeSpan(line, match.index)) return match;
  }
  return null;
}

/** A severity line is a boundary only when its prefix identifies a finding. */
function isFindingStart(line, marker) {
  if (!marker) return false;
  const prefix = String(line).slice(0, marker.index)
    .trim()
    .replace(/^(?:[-*+>]\s*)+/u, '')
    .replace(/^(?:[_*~`]\s*)+/u, '')
    .trim();
  if (!prefix || extractFileCitations(prefix).length > 0) return true;
  return /^PR\s+body\s*[:#]\s*L?\d+(?:[-–]\d+)?\s*:\s*$/iu.test(prefix)
    || /`[^`\n]+`\s*:\s*$/u.test(prefix)
    || /(?:^|\s)(?:L?\d+)(?:[-–]\d+)?\s*:\s*$/iu.test(prefix);
}

function importantFindingLine(line) {
  resetImportantRegex();
  if (!REDFLAG_IMPORTANT_RE.test(line)) return false;
  const marker = IMPORTANT_MARKER_RE.exec(line);
  if (!marker) return false;
  // Una riga di conteggio come `🔴 Important: 0` non e' un finding.
  return !ZERO_IMPORTANT_RE.test(line.slice(marker.index + marker[0].length).trim());
}

function findingsSection(body) {
  // REVIEW.md permits a blocking verdict in both `## Findings` and
  // `## Adversarial check`. Truncating at the latter silently declassifies a
  // real in-diff Important finding. Parse the whole review body; the marker
  // predicate below still excludes `Important: 0` and quoted lower-severity
  // prose through the shared positional regex.
  return String(body || '');
}

/** Ritorna i blocchi che sono davvero verdetti Important, non il conteggio. */
export function importantFindings(body) {
  const section = findingsSection(body);
  const lines = (section || String(body || '')).split(/\r?\n/);
  const boundaries = lines
    .map((line, index) => ({ line, index, marker: firstFindingMarker(line) }))
    .filter(({ marker, line }) => isFindingStart(line, marker))
    .map(({ index }) => index);
  const markers = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => importantFindingLine(line));
  return markers.map(({ line, index }, markerIndex) => {
    const nextFinding = boundaries.find(boundary => boundary > index) ?? lines.length;
    const nextH2 = lines.findIndex((candidate, candidateIndex) =>
      candidateIndex > index && /^##\s/u.test(candidate));
    const end = Math.min(nextFinding, nextH2 === -1 ? lines.length : nextH2);
    const text = lines.slice(index, end).join('\n').trim();
    return {
      line,
      text,
      lineNumber: index + 1,
      citations: extractFileCitations(text),
    };
  });
}

function suffixMatches(candidate, wanted) {
  return candidate === wanted || candidate.endsWith(`/${wanted}`);
}

/** Risolve un riferimento reviewer sul path completo o lo marca ambiguo. */
export function resolveCitedPath(citation, repositoryPaths, { treeAvailable = repositoryPaths !== null && repositoryPaths !== undefined } = {}) {
  const wanted = normalizePath(citation.path);
  const paths = [...new Set((repositoryPaths || []).map(normalizePath).filter(Boolean))];
  const candidates = paths.filter((path) => {
    if (wanted.includes('/')) return suffixMatches(path, wanted);
    return path === wanted || path.endsWith(`/${wanted}`);
  });
  if (candidates.length === 1) {
    return { status: 'resolved', path: candidates[0], candidates };
  }
  if (candidates.length > 1) {
    return { status: 'non-risolubile', path: null, candidates };
  }
  // Senza tree non e' possibile distinguere un path fuori diff da uno
  // inesistente/rinominato: il fallimento della fetch resta non risolvibile e
  // bloccante, mai un'inferenza che approva la review.
  return { status: 'non-risolubile', path: null, candidates: [] };
}

function changedContains(changedFiles, resolvedPath) {
  return changedFiles.some((file) => file === resolvedPath || file.endsWith(`/${resolvedPath}`));
}

/**
 * Classificazione pura. `repositoryPaths` deve essere il tree completo quando
 * disponibile; senza tree i basename vengono risolti solo contro i file del
 * diff, quindi un basename esterno resta non risolvibile.
 */
/** Numero di riga del body a cui un finding e' ancorato, o `null`. */
export function prBodyFindingLine(finding) {
  const fromText = String(finding?.text || '').match(PR_BODY_ANCHOR_RE);
  if (fromText) return Number(fromText[1]);
  const fromLine = String(finding?.line || '').match(PR_BODY_ANCHOR_LOOSE_RE);
  return fromLine ? Number(fromLine[1]) : null;
}

/**
 * Vero quando il finding e' un 🔴 ancorato SOLO su `PR body:L<n>`, su una riga
 * che cade dentro `## Non implementato` — la sezione che il contratto
 * deterministico valida — e non parla di un claim che il contratto non sa
 * giudicare.
 *
 * Tutto il resto resta bloccante: una riga altrove nel body, un claim di
 * performance, o l'assenza del testo del body con cui provare la posizione.
 * Senza `prBody` non si declassa niente: la prova che l'anchor cade nella
 * sezione giusta e' parte del predicato, non un'assunzione.
 */
export function isContractDomainBodyFinding(finding, prBody) {
  if (typeof prBody !== 'string' || !prBody) return false;
  const text = String(finding?.text || '');
  if (NON_CONTRACT_BODY_RE.test(text)) return false;
  const lines = prBody.split(/\r?\n/u);
  PR_BODY_ANCHOR_ALL_RE.lastIndex = 0;
  const anchors = [];
  for (const match of text.matchAll(PR_BODY_ANCHOR_ALL_RE)) {
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    // I limiti si verificano PRIMA di espandere. Il testo della review e'
    // prodotto da un modello: `PR body:L1-999999999` altrimenti farebbe
    // crescere questo array fino a fermare la classificazione e con essa il
    // review gate — cioe' la coda di merge e di pubblicazione — per un
    // anchor che comunque non sarebbe verificabile. Un intervallo rovesciato
    // o che esce dal body si rifiuta, non si interpreta.
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    if (end < start || end > lines.length) return false;
    for (let line = start; line <= end; line += 1) anchors.push(line);
  }
  const first = prBodyFindingLine(finding);
  if (first !== null && !anchors.includes(first)) anchors.push(first);
  if (anchors.length === 0) return false;
  // Ogni anchor deve cadere dentro `## Non implementato` E la riga che cita
  // non deve essere essa stessa un claim che il contratto non sa giudicare:
  // il finding puo' limitarsi a puntare la riga senza ripeterne il contenuto.
  return anchors.every((line) => {
    if (!Number.isFinite(line) || line > lines.length) return false;
    if (NON_CONTRACT_BODY_RE.test(lines[line - 1] || '')) return false;
    let section = null;
    for (let index = 0; index < line; index += 1) {
      const heading = lines[index].match(/^\s{0,3}#{2,3}\s+(.+?)\s*$/u);
      if (heading) section = heading[1];
    }
    return Boolean(section && /^Non implementato\b/iu.test(section));
  });
}

/**
 * Il contratto deterministico del body, ricalcolato dal body stesso con gli
 * stessi moduli dello step `PR-body completeness` (`evaluateBodyContract`:
 * sezioni, `Closes`, stato bloccante di ogni voce; gli advisory non bloccano
 * quel gate e non bloccano qui).
 *
 * Esiste perche' il verdetto NON puo' arrivare solo da una variabile d'ambiente
 * di `tests.yml`: `pr-redflag-fixer.yml` e la CLI di questo file classificano
 * gli stessi finding SENZA quello step, e li' un 🔴 sul body con contratto
 * verde consumerebbe round del fixer su lavoro che non esiste. Ricalcolarlo
 * rende il declassamento uguale per ogni consumer, che e' l'unico modo di non
 * avere due politiche sulla stessa superficie.
 */
export function bodyContractIsGreen(prBody) {
  if (typeof prBody !== 'string' || !prBody) return false;
  try {
    return evaluateBodyContract(prBody).blocking === 0;
  } catch (error) {
    console.log(`review-scope: contratto del body non valutabile (${String(error).slice(0, 160)}) → nessun declassamento.`);
    return false;
  }
}

export function classifyImportantFindings(body, changedFiles, repositoryPaths = null, {
  // Il contratto deterministico del body (`scripts/ci/pr-body-contract.mjs`,
  // step `PR-body completeness` di tests.yml) e' passato su QUESTO body nella
  // stessa run. E' l'unica fonte di verita' sul body: un 🔴 del modello
  // ancorato solo su `PR body:L<n>` vale allora al massimo un Nit.
  bodyContractPassed = false,
  // Body corrente della PR: serve a PROVARE che la riga citata cade dentro
  // `## Non implementato`. Assente → nessun declassamento.
  prBody = null,
  // Id stabili (`lib/review-findings.mjs`) dei 🔴 gia' emessi dalle review
  // precedenti su questa PR. Un finding il cui id e' qui NON e' nuovo e non
  // viene mai declassato dalla regola sulle righe non cambiate.
  priorFindingIds = null,
  // Map path → Set(righe) toccate DALL'ultima review a questa HEAD. `null` =
  // delta non calcolabile → nessuna declassazione: su un dato mancante si
  // tiene il finding, non lo si butta.
  changedLinesSince = null,
  // Path che il compare ha riportato ma di cui NON ha dato il patch: non si
  // puo' dire che le loro righe non siano cambiate.
  uncomparablePaths = null,
} = {}) {
  const changed = [...new Set((changedFiles || []).map(normalizePath).filter(Boolean))];
  const treeAvailable = repositoryPaths !== null && repositoryPaths !== undefined;
  const knownPaths = treeAvailable ? repositoryPaths : changed;
  const outside = [];
  const inScope = [];
  const unresolved = [];
  const bodyDeclassified = [];
  const staleDeclassified = [];

  const allFindings = importantFindings(body);
  // Righe davvero CONFRONTATE fra l'ultima review e questa HEAD. Il seed con
  // l'elenco file della PR e' la parte che rende la regola utile: dopo un
  // merge di main che NON tocca i file della PR il patch e' vuoto, e senza il
  // seed ogni path citato risulterebbe «mai confrontato» — cioe' esattamente
  // il caso che la regola deve coprire.
  // I path che il compare ha riportato SENZA patch (binari, file troppo
  // grandi, patch omessa) non sono «intatti»: sono NON VERIFICABILI riga per
  // riga, ed e' diverso da «assente dal compare», che invece significa
  // davvero non toccato nella finestra. Restano quindi fuori dalla mappa, e
  // `unchangedLineImportants` pretende che OGNI path citato sia dentro.
  const uncomparable = uncomparablePaths instanceof Set
    ? uncomparablePaths
    : new Set(uncomparablePaths || []);
  const comparedLines = changedLinesSince instanceof Map
    ? new Map(changed
      .filter((file) => !uncomparable.has(file))
      .map((file) => [file, changedLinesSince.get(file) ?? new Set()]))
    : null;
  // I candidati si costruiscono QUI, sui soli finding che il parser sa
  // delimitare: di un finding ambiguo non si puo' dire «punta a una riga non
  // cambiata», perche' non si sa nemmeno dove finisca. Costruirlo qui invece
  // che dentro il loop rende la proprieta' indipendente dall'ORDINE dei
  // controlli — sul sito bastava invertire due righe per lasciar passare una
  // review malformata.
  for (const finding of allFindings) {
    if (bodyContractPassed && finding.citations.length === 0
        && isContractDomainBodyFinding(finding, prBody)) {
      bodyDeclassified.push(finding);
      continue;
    }
    if (finding.citations.length === 0) {
      unresolved.push({ ...finding, reason: 'nessun file citato' });
      continue;
    }
    const resolved = finding.citations.map((citation) => ({
      citation,
      result: resolveCitedPath(citation, knownPaths, { treeAvailable }),
    }));
    const bad = resolved.find((item) => item.result.status !== 'resolved');
    if (bad) {
      unresolved.push({
        ...finding,
        reason: bad.result.candidates.length
          ? 'basename ambiguo'
          : 'file non risolto',
        candidates: bad.result.candidates,
        resolved,
      });
      continue;
    }
    const resolvedFiles = resolved.map((item) => item.result.path);
    const isInScope = resolvedFiles.some((file) => changedContains(changed, file));
    const classified = {
      ...finding,
      resolvedFiles,
      resolved,
    };
    (isInScope ? inScope : outside).push(classified);
  }

  // Il declassamento per riga non cambiata si applica SOLO ai finding gia'
  // risolti e gia' dentro il diff della PR. Farlo prima della risoluzione era
  // un buco: `changedLinesSince.get(file) ?? new Set()` trasforma un file
  // omesso dal compare — o cancellato — in «confrontato e intatto», e un
  // Important ancorato a un path che nell'albero della HEAD non esiste piu'
  // sarebbe uscito declassato invece che `unresolved`. Cosi' invece un
  // finding puo' essere declassato solo dopo aver dimostrato che il path
  // esiste, risolve, ed e' fra i file che la PR tocca.
  if (comparedLines) {
    const known = priorFindingIds instanceof Set
      ? priorFindingIds
      : new Set(priorFindingIds || []);
    // Si interroga il predicato UN FINDING ALLA VOLTA. Una chiave — la riga
    // del marker, o qualunque altra posizione — non e' un'identita': due
    // finding distinti che la condividessero verrebbero rimossi insieme, e un
    // rilievo reale sparirebbe dal blocco del gate perche' un altro era
    // declassabile. Qui non c'e' nessuna chiave da far collidere.
    for (let index = inScope.length - 1; index >= 0; index -= 1) {
      const finding = inScope[index];
      if (finding.parserUncertain) continue;
      const stale = unchangedLineImportants({
        findings: [finding],
        priorFindingIds: known,
        changedLines: comparedLines,
      });
      if (stale.length === 0) continue;
      inScope.splice(index, 1);
      staleDeclassified.unshift({ ...finding, stableId: stableFindingId(finding) });
    }
  }

  return {
    findings: importantFindings(body),
    outside,
    inScope,
    unresolved,
    bodyDeclassified,
    staleDeclassified,
    bodyOnly: bodyDeclassified.length > 0
      && outside.length === 0
      && inScope.length === 0
      && unresolved.length === 0,
    outsideOnly: (outside.length + bodyDeclassified.length + staleDeclassified.length) > 0
      && inScope.length === 0 && unresolved.length === 0,
    blocking: inScope.length > 0 || unresolved.length > 0,
  };
}

function gh(args, { json = true } = {}) {
  const output = execFileSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return json ? JSON.parse(output) : output;
}

function fetchChangedFiles(repo, pr) {
  return fetchPrFiles(Number(pr), gh, repo);
}

/**
 * Body corrente della PR. Un errore torna `null`, che spegne il declassamento
 * invece di concederlo: senza il body non c'e' prova che l'anchor cada dentro
 * `## Non implementato`.
 */
function readPrBody(repo, pr) {
  try {
    const view = gh(['api', `repos/${repo}/pulls/${pr}`]);
    return typeof view?.body === 'string' ? view.body : null;
  } catch (error) {
    console.log(`review-scope: body della PR non leggibile (${String(error).slice(0, 160)}) → nessun declassamento.`);
    return null;
  }
}

/**
 * Id stabili dei 🔴 gia' emessi dalle review precedenti, e la finestra di
 * confronto su cui misurare «righe non cambiate»: il commit dell'ultima review
 * gestita PRIMA di quella corrente, su un commit DIVERSO. Il commit diverso non
 * e' un dettaglio — due review sulla stessa HEAD hanno delta vuoto per
 * costruzione e declasserebbero qualunque rilievo nuovo.
 *
 * Deriva qui invece di farsi passare i parametri dal chiamante perche' i
 * consumer di questo modulo sono due e uno non li passerebbe mai: il review
 * gate in `tests.yml` e la CLI invocata da `pr-redflag-fixer.yml`. Se solo il
 * primo li avesse, un 🔴 declassato dal gate farebbe comunque partire il fixer
 * e brucerebbe un round su lavoro che non esiste — due politiche sullo stesso
 * verdetto, che e' il modo in cui questo ciclo si incaglia.
 */
/** HEAD corrente della PR; stringa vuota se non leggibile. */
function resolveHeadSha(repo, pr) {
  try {
    const head = gh(['api', `repos/${repo}/pulls/${pr}`, '--jq', '.head.sha'], { json: false }).trim();
    return /^[0-9a-f]{40}$/iu.test(head) ? head : '';
  } catch {
    return '';
  }
}

function reviewHistoryContext(repo, pr, headSha) {
  const empty = { priorFindingIds: new Set(), changedLinesSince: null };
  try {
    const reviews = gh(['api', `repos/${repo}/pulls/${pr}/reviews`, '--paginate']);
    const managed = (Array.isArray(reviews) ? reviews : [])
      // STESSA identita' che accetta `review-gate.mjs`. Con il solo
      // `REVIEWER_BOT_LOGIN_RE` si scartavano le review
      // `github-actions[bot]` col marker `CODEX_FALLBACK_REVIEW` — cioe' il
      // reviewer PRIMARIO di questo repo: gli id precedenti e il delta
      // sarebbero usciti vuoti su ogni re-review reale, e la regola sarebbe
      // stata un no-op che non protegge nulla.
      .filter((review) => review?.user?.type === 'Bot'
        && (REVIEWER_BOT_LOGIN_RE.test(String(review?.user?.login || ''))
          || (/^github-actions\[bot\]$/iu.test(String(review?.user?.login || ''))
            && String(review?.body || '').includes('<!-- CODEX_FALLBACK_REVIEW -->')))
        && String(review?.state || '') !== 'PENDING'
        && String(review?.state || '') !== 'DISMISSED');
    if (managed.length <= 1) return empty;
    // La storia e' TUTTO tranne la review che stiamo classificando, cioe'
    // l'ultima. Escludere invece ogni review sulla HEAD corrente era il buco:
    // dopo una prima review sulla stessa HEAD il finding immediatamente
    // precedente non entrava in `priorFindingIds`, quindi un 🔴 RIPETUTO
    // risultava «nuovo» ed era declassabile — esattamente il caso che la
    // regola deve lasciar passare intatto.
    const history = managed.slice(0, -1);
    const priorFindingIds = new Set();
    for (const review of history) {
      for (const finding of importantFindings(review?.body || '')) {
        priorFindingIds.add(stableFindingId(finding));
      }
    }
    // La finestra e' quella della review IMMEDIATAMENTE precedente, non della
    // piu' recente su un commit diverso: con la seconda, il compare
    // includerebbe anche cambiamenti anteriori alla review precedente e un
    // rilievo su codice mosso DOPO di essa sembrerebbe su codice fermo.
    const prior = history[history.length - 1];
    if (!prior || !/^[0-9a-f]{40}$/iu.test(String(headSha || ''))) {
      return { priorFindingIds, changedLinesSince: null };
    }
    // Review precedente sulla STESSA HEAD: il delta e' vuoto per costruzione,
    // e una Map vuota e' il dato giusto — `null` direbbe «non calcolabile» e
    // spegnerebbe la regola proprio nel caso in cui serve.
    if (String(prior.commit_id || '') === String(headSha)) {
      return { priorFindingIds, changedLinesSince: new Map() };
    }
    if (!/^[0-9a-f]{40}$/iu.test(String(prior.commit_id || ''))) {
      return { priorFindingIds, changedLinesSince: null };
    }
    const compare = gh(['api', `repos/${repo}/compare/${prior.commit_id}...${headSha}`]);
    if (!Array.isArray(compare?.files)) return { priorFindingIds, changedLinesSince: null };
    // L'endpoint `compare` TRONCA l'elenco dei file a 300 senza dirlo. Su un
    // elenco troncato un file davvero modificato puo' mancare, e il seed con
    // i file della PR lo farebbe passare per «confrontato e intatto»: un
    // finding nuovo su una riga cambiata verrebbe declassato e il bug
    // entrerebbe nel ciclo. Al limite dell'API il delta NON e' calcolabile, e
    // «non calcolabile» spegne del tutto la declassazione.
    if (compare.files.length >= COMPARE_FILES_CAP) {
      console.log(`review-scope: compare al limite API (${compare.files.length} file) → delta non calcolabile, nessuna declassazione per riga.`);
      return { priorFindingIds, changedLinesSince: null };
    }
    // `changedLinesFromPatch` vuole un patch unificato con gli header `+++`:
    // l'API li omette e da' il patch per file, quindi si ricompone. Riusare il
    // parser gia' testato vale piu' di una seconda lettura dei hunk.
    const patch = compare.files
      .filter((file) => typeof file?.patch === 'string' && file?.filename)
      .map((file) => `+++ b/${file.filename}\n${file.patch}`)
      .join('\n');
    // Un file che il compare RIPORTA ma di cui non da' il patch e' cambiato e
    // non confrontabile riga per riga: dichiararlo, cosi' non passa per
    // «intatto» attraverso il seed dell'elenco file della PR.
    const uncomparablePaths = new Set(compare.files
      .filter((file) => file?.filename && typeof file?.patch !== 'string')
      .map((file) => String(file.filename)));
    return { priorFindingIds, changedLinesSince: changedLinesFromPatch(patch), uncomparablePaths };
  } catch (error) {
    // Delta non calcolabile: nessuna declassazione. Su un dato mancante si
    // tiene il finding, non lo si butta.
    console.log(`review-scope: storia delle review non leggibile (${String(error).slice(0, 160)}) → nessuna declassazione per riga.`);
    return empty;
  }
}

function fetchRepositoryPaths(repo, pr) {
  try {
    // Citations are resolved against the tree that the reviewer actually
    // inspected. The base tree omits files added by the PR and made every
    // Important on a new corpus script look like an unresolvable finding.
    const head = gh(['api', `repos/${repo}/pulls/${pr}`, '--jq', '.head.sha'], { json: false }).trim();
    if (!/^[0-9a-f]{40}$/iu.test(head)) return null;
    const tree = gh(['api', `repos/${repo}/git/trees/${head}?recursive=1`]);
    if (tree?.truncated || !Array.isArray(tree?.tree)) return null;
    return tree.tree
      .filter((item) => item.type === 'blob' && item.path)
      .map((item) => normalizePath(item.path));
  } catch (error) {
    console.log(`review-scope: tree del repository non disponibile (${String(error).slice(0, 160)}).`);
    return null;
  }
}

function safeText(value) {
  return String(value || '').replace(/\r?\n/g, ' ').trim();
}

function distinctiveToken(text) {
  const candidates = [];
  for (const match of String(text || '').matchAll(/`([^`\n]{3,90})`/gu)) {
    const token = match[1].trim();
    if (!token.includes('/') && /[(){}'"`]|::|=>|\.\w|:\d|>=|<=/.test(token)) {
      candidates.push(token);
    }
  }
  return candidates.sort((a, b) => b.length - a.length)[0] || null;
}

function suggestedAction(finding) {
  const path = finding.resolvedFiles[0];
  const citation = finding.citations[0];
  const token = distinctiveToken(finding.text || finding.line);
  const anchor = citation.line ? `${path} alla riga ${citation.line}` : path;
  if (token) {
    return `Applicare la correzione indicata dal reviewer in ${anchor} e verificare \`${token}\`.`;
  }
  // Il path e la riga restano contesto umano, non un token di accettazione:
  // `path:12` sarebbe sempre "distintivo" per il matcher dei follow-up ma non
  // puo' mai comparire nel contenuto del file. Senza un token di codice reale
  // l'item resta leggibile ma non falsificabile, quindi non viene auto-chiuso.
  return `Applicare la correzione indicata dal reviewer in ${anchor} e verificare la riga citata.`;
}

/** Il testo di un item, senza l'intestazione `### N.` che lo numera. */
function followupItemBodies(findings) {
  return findings.map((finding) => {
    const path = finding.resolvedFiles[0];
    return [
      `Finding fuori dal diff: \`${path}\``,
      '- Source: reviewer 🔴 Important fuori dal diff',
      '- Stato dichiarato nella PR: nessuno',
      '- Original text:',
      `  > ${safeText(finding.text || finding.line)}`,
      '- Funnel impact: superficie pubblicata / contratto col sito',
      '- Rationale: il reviewer ha trovato un difetto in una funzione condivisa che non appartiene al diff corrente; il fix va tracciato senza bloccare questa PR.',
      `- Suggested action: ${suggestedAction(finding)}`,
    ].join('\n');
  });
}

/**
 * Gli item gia' presenti nel corpo di una follow-up, senza la numerazione.
 * Stessa spezzatura di `splitFollowupItems()` in followup-resolution-match.mjs:
 * il drainer legge il CORPO, quindi il merge deve partire da cio' che il
 * drainer vede, non da cio' che i commenti raccontano.
 */
export function followupItemsFromBody(body) {
  return String(body || '')
    .split(/^### \d+\.\s*/mu)
    .slice(1)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
}

function itemKey(item) {
  return String(item).replace(/\s+/gu, ' ').trim().toLowerCase();
}

/** Unisce gli item vecchi e nuovi in ordine, senza duplicarli. */
export function mergeFollowupItems(existingBody, freshItems) {
  const merged = [];
  const seen = new Set();
  for (const item of [...followupItemsFromBody(existingBody), ...freshItems]) {
    const key = itemKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

function renderFollowupBody({ repo, pr, prUrl, items }) {
  const originUrl = prUrl || `https://github.com/${repo}/pull/${pr}`;
  const header = [
    `<!-- ${FOLLOWUP_MARKER}: ${repo}#${pr} -->`,
    '## Origine',
    '',
    `- PR: #${pr}`,
    `- URL: ${originUrl}`,
    '',
    '## Item',
    '',
  ].join('\n');
  // Il corpo ha un tetto duro lato API: se l'aggregato lo supera si tengono gli
  // item piu' RECENTI (in coda) e si dichiara quanti sono stati omessi, invece
  // di far fallire l'edit e lasciare il corpo fermo al giro precedente.
  const kept = [...items];
  let omitted = 0;
  let body = '';
  for (;;) {
    const numbered = kept.map((item, index) => `### ${index + 1}. ${item}`).join('\n\n');
    const note = omitted
      ? `\n\n_${omitted} item più vecchi omessi per il limite di lunghezza del corpo; restano nella cronologia dei commenti._`
      : '';
    body = `${header}${numbered}${note}\n`;
    if (body.length <= MAX_FOLLOWUP_BODY_LEN || kept.length <= 1) break;
    kept.shift();
    omitted += 1;
  }
  return body;
}

export function followupIssueBody({ repo, pr, prUrl, findings, existingBody = '' }) {
  return renderFollowupBody({
    repo,
    pr,
    prUrl,
    items: mergeFollowupItems(existingBody, followupItemBodies(findings)),
  });
}

/** Stessa risoluzione del target del writer condiviso: `GH_REPO` o la cwd. */
function repoFlag() {
  return process.env.GH_REPO ? ['--repo', process.env.GH_REPO] : [];
}

function readIssueBody(number) {
  return gh(['issue', 'view', String(number), '--json', 'body', '--jq', '.body', ...repoFlag()], { json: false });
}

/**
 * Riscrive il CORPO della follow-up con l'aggregato.
 *
 * Il writer condiviso, quando la issue e' gia' aperta, si limita a COMMENTARE
 * (`github-issue-creator.mjs`): il corpo resterebbe quello del primo giro. Ma i
 * consumer della follow-up leggono il corpo — `followup-has-candidates.mjs` e
 * `splitFollowupItems()` in `followup-resolution-match.mjs` — e non i commenti,
 * quindi dal secondo giro i finding declassati non atterrerebbero in nessuna
 * superficie drenabile: il gate diventa verde e l'item sparisce senza errore.
 */
function syncFollowupBody({ repo, pr, prUrl, findings, number }) {
  const current = readIssueBody(number);
  const merged = followupIssueBody({ repo, pr, prUrl, findings, existingBody: current });
  if (merged.trim() === String(current || '').trim()) return { bodySynced: true, bodyChanged: false };
  gh(['issue', 'edit', String(number), '--body', merged, ...repoFlag()], { json: false });
  return { bodySynced: true, bodyChanged: true };
}

async function mintFollowup({ repo, pr, prUrl, body, findings }) {
  // Il titolo stabile per PR rende il conio idempotente sul titolo: il writer
  // deduplica gli aperti con la ricerca più il listing immediatamente consistente.
  // Non riaprire una follow-up chiusa: se il drainer l'ha chiusa, il giro nuovo
  // deve aprire un thread nuovo, non reinnestare item gia' risolti.
  const title = `follow-up(#${pr}): finding fuori dal diff`;
  const result = await createGithubIssue({
    title,
    description: body,
    priority: 2,
    labels: ['follow-up'],
    // Una follow-up chiusa puo' essere stata drenata: il suo corpo non va
    // risuscitato nel nuovo thread. 0 e' l'opt-out esplicito del writer.
    reopenWithinHours: 0,
  });
  if (!result || result.persisted !== true) {
    throw new Error(`writer follow-up non ha confermato la persistenza per PR #${pr}`);
  }
  if (result.number == null) {
    throw new Error(`writer follow-up non ha restituito il numero della issue per PR #${pr}`);
  }
  // Il corpo e' l'unica superficie che il drainer legge: se non riusciamo a
  // riscriverlo, il finding non e' tracciato e l'errore deve restare bloccante.
  const synced = syncFollowupBody({ repo, pr, prUrl, findings, number: result.number });
  return {
    number: result.number,
    url: result.url,
    reopened: result.reopened === true,
    updated: result.reopened !== true && result.number != null,
    ...synced,
  };
}

/**
 * Classifica la review sulla PR reale e, solo se tutti i finding sono fuori
 * scope, conia/aggiorna la singola issue della PR.
 */
export async function classifyAndMintReview(body, {
  repo, pr, prUrl, mutate = true, headSha = null,
  priorFindingIds = null, changedLinesSince = null,
  // `null`/assente = «non lo so»: il verdetto si RICALCOLA dal body con gli
  // stessi moduli del gate. Un booleano esplicito lo impone (il review gate
  // passa `true` quando lo step del contratto di quella run e' andato bene).
  // Cosi' ogni consumer — review gate, fixer, CLI — applica la stessa
  // politica senza che un workflow debba propagare una variabile.
  bodyContractPassed = null, prBody = null,
} = {}) {
  if (!repo || !pr) throw new Error('repo e pr sono obbligatori');
  const effectivePrBody = prBody === null && bodyContractPassed !== false
    ? readPrBody(repo, pr)
    : prBody;
  const contractPassed = typeof bodyContractPassed === 'boolean'
    ? bodyContractPassed
    : bodyContractIsGreen(effectivePrBody);
  const changed = fetchChangedFiles(repo, pr);
  const diffUnavailable = changed.complete !== true || changed.files.length === 0;
  if (diffUnavailable) {
    const findings = importantFindings(body);
    const reason = changed.files.length === 0 ? 'empty' : changed.reason;
    // Un finding sul body non dipende dal diff: il contratto lo ha gia'
    // giudicato su questo stesso body. Senza questa separazione un diff
    // illeggibile — una PR che rigenera migliaia di file di corpus e' il caso
    // normale qui — resusciterebbe come bloccante proprio i 🔴 che il
    // contratto verde ha appena chiuso, e lo farebbe per una ragione che non
    // ha niente a che vedere con loro.
    const bodyDeclassified = contractPassed
      ? findings.filter((finding) => finding.citations.length === 0
          && isContractDomainBodyFinding(finding, effectivePrBody))
      : [];
    const stillOpen = findings.filter((finding) => !bodyDeclassified.includes(finding));
    return {
      findings,
      outside: [],
      inScope: [],
      unresolved: stillOpen.map((finding) => ({
        ...finding,
        reason: `diff non verificabile (${reason})`,
      })),
      bodyDeclassified,
      bodyOnly: bodyDeclassified.length > 0 && stillOpen.length === 0,
      // Il ramo dichiara di voler sbloccare la PR con diff illeggibile i cui
      // unici 🔴 erano sul body: senza questo, `blocking` diventava false ma
      // `outsideOnly` restava false e il gate non approvava comunque —
      // il ramo non avrebbe sbloccato niente.
      outsideOnly: bodyDeclassified.length > 0 && stillOpen.length === 0,
      blocking: stillOpen.length > 0,
      minted: false,
      changedFiles: changed.files,
      changedFilesComplete: changed.complete,
      diffReason: reason,
    };
  }
  const repositoryPaths = fetchRepositoryPaths(repo, pr);
  // `null` = «non lo so» e si deriva; passarli esplicitamente resta possibile
  // (i test lo fanno) e disattiva la rete.
  const history = (priorFindingIds === null && changedLinesSince === null)
    ? reviewHistoryContext(repo, pr, headSha || resolveHeadSha(repo, pr))
    : { priorFindingIds, changedLinesSince };
  const result = classifyImportantFindings(body, changed.files, repositoryPaths, {
    bodyContractPassed: contractPassed,
    prBody: effectivePrBody,
    priorFindingIds: history.priorFindingIds,
    changedLinesSince: history.changedLinesSince,
    uncomparablePaths: history.uncomparablePaths ?? null,
  });
  for (const finding of result.staleDeclassified ?? []) {
    console.log(`review-scope: DECLASSIFIED-UNCHANGED-LINE finding=L${finding.lineNumber} id=${finding.stableId} reason=Important NUOVO ancorato solo su righe non toccate dall'ultima review; per tenerlo bloccante dichiara \`🔴 Important: [regression]\``);
  }
  if (result.outside.length === 0 || !mutate) {
    return {
      ...result,
      minted: false,
      changedFiles: changed.files,
      changedFilesComplete: changed.complete,
      diffReason: changed.reason,
    };
  }
  const issueBody = followupIssueBody({ repo, pr, prUrl, findings: result.outside });
  const followup = await mintFollowup({ repo, pr, prUrl, body: issueBody, findings: result.outside });
  return {
    ...result,
    minted: true,
    followup,
    changedFiles: changed.files,
    changedFilesComplete: changed.complete,
    diffReason: changed.reason,
  };
}

function readReviewBody() {
  if (process.env.REVIEW_BODY_FILE) return readFileSync(process.env.REVIEW_BODY_FILE, 'utf8');
  return process.env.REVIEW_BODY || '';
}

if (process.argv[1] && process.argv[1].endsWith('review-scope.mjs')) {
  try {
    const result = await classifyAndMintReview(readReviewBody(), {
      repo: process.env.GITHUB_REPOSITORY || process.env.REPO,
      pr: process.env.PR_NUMBER,
      prUrl: process.env.PR_URL,
      mutate: process.env.REVIEW_SCOPE_MUTATE !== 'false',
    });
    process.stdout.write(`${JSON.stringify({
      outsideOnly: result.outsideOnly,
      blocking: result.blocking,
      important: result.findings.length,
      outside: result.outside.length,
      inScope: result.inScope.length,
      unresolved: result.unresolved.length,
      bodyOnly: result.bodyOnly === true,
      minted: result.minted,
      followup: result.followup || null,
    })}\n`);
  } catch (error) {
    console.error(`review-scope: errore conservativo: ${String(error)}`);
    process.exit(1);
  }
}
