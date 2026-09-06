#!/usr/bin/env node
/**
 * loop-baseline-pr-gate.mjs — rifiuta IN PR una baseline non verificabile di
 * `scripts/ci/loop-sync-manifest.json` (issue #956, follow-up della #954).
 *
 * ## Il buco che chiude
 *
 * `checkBaselineProvenance()` dentro `loop-drift-check.mjs` scopre le baseline
 * fantasma — hash registrati che non corrispondono a nessun blob mai esistito
 * su quel lato — ma le scopre **al cron successivo, dopo il merge**. Nel
 * frattempo il verdetto a tre vie di `classify()` su quella voce e' privo di
 * significato: confronta `now` contro un `base` che non e' mai esistito, e
 * produce comunque una classe plausibile (misurato sulla #954: 13 voci, di cui
 * 6 dichiarate DOPO l'apertura della issue che ne contava 7 — la classe si
 * ricreava da sola).
 *
 * La #954 ha chiuso la CAUSA dando l'affordance che mancava
 * (`--init --only <path>`, che scrive la baseline REALE di una sola voce senza
 * dichiarare allineate le altre trecento). Ma non impedisce a chi la ignora di
 * continuare a scrivere a mano una stringa esadecimale plausibile: senza un
 * gate, la classe resta riaperta da quel percorso.
 *
 * ## Perche' e' diff-scoped, e non un `node --test`
 *
 * Verificare TUTTE le voci a ogni PR costerebbe centinaia di richieste e
 * renderebbe rossa una PR per un dato che non ha scritto — esattamente
 * l'antipattern che `list-pr-gate-tests.mjs` documenta. Questo gate guarda
 * quindi **solo le voci il cui `baseline` e' cambiato nella PR**, confrontate
 * contro il contenuto del suo head: di norma zero voci, quindi zero rete.
 *
 * ## Le tre risposte, e perche' l'asimmetria fra i due lati
 *
 * Per ogni lato cambiato: se l'hash combacia col contenuto ATTUALE di quel
 * lato, e' verificato senza rete e finisce li'. Altrimenti serve una prova
 * storica (il caso legittimo: una baseline riparata col blob reale a cui quel
 * lato era davvero allineato ad `alignedAt`, come ha fatto la #954).
 *
 *   - lato `corpus` → STRETTO. Il contenuto e' nel checkout, e c'e' sempre una
 *     via senza rete per rendere verde il gate quando la baseline e' giusta:
 *     `--init --only <path>`, che scrive `now`. Quindi "non verificabile"
 *     (storia non esaurita, o errore di rete) e' un rifiuto: l'autore ha un
 *     rimedio deterministico.
 *   - lato `site` → FAIL-OPEN su cio' che non si e' potuto verificare. Non
 *     esiste una via offline: il contenuto vive in un altro repo. Un rifiuto
 *     su errore di rete fermerebbe la coda di merge di QUESTO repo per la
 *     disponibilita' di un terzo. Rifiuta solo sul negativo definitivo
 *     (storia intera esaminata, nessun match) — che e' la stessa prova che
 *     `ghostVerdict` pretende, e il cron resta comunque a coprire il resto.
 *
 * La semantica del verdetto NON e' riscritta qui: `gateVerdict()` avvolge
 * `ghostVerdict()` importato da `loop-drift-check.mjs`, cosi' come `sha256`,
 * `siteFile` e `repoHistoryMatch`. Una baseline giudicata fantasma dal cron e
 * accettata dal gate (o viceversa) sarebbe il modo peggiore di fallire, e una
 * seconda copia della regola lo renderebbe inevitabile (AGENTS.md #6).
 *
 * Uso:
 *   node scripts/ci/loop-baseline-pr-gate.mjs            # exit 1 se rifiuta
 *   node scripts/ci/loop-baseline-pr-gate.mjs --json
 *
 * Env:
 *   BASE_SHA / BASE_REF   il commit di base della PR (default `origin/main`).
 *   GITHUB_REPOSITORY     repo corpus, per la storia via API.
 *   HEAD_SHA              ref del head della PR per la storia corpus via API
 *                         (default `GITHUB_SHA`, poi `HEAD`).
 *   GH_TOKEN              opzionale; alza il rate-limit anonimo.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ghostVerdict, sha256, siteFile, repoHistoryMatch } from './loop-drift-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST_REL = 'scripts/ci/loop-sync-manifest.json';
const SITE_REPO = process.env.SITE_REPO || 'valerielinc-ops/frontaliere-si-o-no';
const SITE_REF = process.env.SITE_REF || 'main';
const CORPUS_REPO = process.env.GITHUB_REPOSITORY || 'nanakokyobashi-rgb/frontaliere-articles';
const CORPUS_REF = process.env.HEAD_SHA || process.env.GITHUB_SHA || 'HEAD';
const BASE = process.env.BASE_SHA || process.env.BASE_REF || 'origin/main';
const JSON_OUT = process.argv.includes('--json');

/**
 * Le voci il cui `baseline` e' cambiato fra base e head, un elemento per LATO
 * cambiato. PURA: niente disco, niente rete — e' questo a renderla testabile
 * offline, come `ghostVerdict` e `classify`.
 *
 * Una voce nuova (assente dalla base) conta come cambiata su entrambi i lati
 * non-null: e' il percorso che ha fabbricato 6 delle 13 baseline fantasma
 * della #954, quindi e' il caso che questo gate esiste per vedere.
 *
 * Un lato che passa a `null` non e' un hash da verificare: sparisce e basta.
 *
 * @param {{files?: Array<object>}} baseManifest  manifest al commit di base
 *   (null se il file non esisteva: tutto e' nuovo).
 * @param {{files?: Array<object>}} headManifest  manifest nel head della PR.
 * @returns {Array<{path: string, sitePath: string, side: 'site'|'corpus', hash: string, previous: string|null}>}
 */
export function changedBaselines(baseManifest, headManifest) {
  const before = new Map();
  for (const e of baseManifest?.files || []) before.set(e.path, e);
  const out = [];
  for (const entry of headManifest?.files || []) {
    const prev = before.get(entry.path)?.baseline || {};
    const now = entry.baseline || {};
    for (const side of ['site', 'corpus']) {
      const hash = now[side];
      if (hash == null) continue;
      if (prev[side] === hash) continue;
      out.push({
        path: entry.path,
        sitePath: entry.sitePath || entry.path,
        side,
        hash,
        previous: prev[side] ?? null,
      });
    }
  }
  return out;
}

/**
 * Il verdetto del gate per un lato cambiato. Avvolge `ghostVerdict()` — la
 * stessa regola del cron — e ci aggiunge la sola decisione che appartiene al
 * gate: cosa fare di cio' che NON si e' potuto verificare, che sul lato
 * `corpus` e' un rifiuto (c'e' un rimedio offline) e sul lato `site` no.
 *
 * PURA, per la stessa ragione di `ghostVerdict`.
 *
 * @param {object} a
 * @param {'site'|'corpus'} a.side
 * @param {string} a.baselineHash
 * @param {string|null} a.currentHash   hash ORA di quel lato (null: assente).
 * @param {boolean|undefined} a.historyMatch      esito del walk storico.
 * @param {boolean|undefined} a.historyExhausted  true se era TUTTA la storia.
 * @param {boolean} [a.networkError]    il walk non e' stato possibile.
 * @returns {{status: 'ok'|'reject'|'warn', reason: string}}
 */
export function gateVerdict({ side, baselineHash, currentHash, historyMatch, historyExhausted, networkError = false }) {
  const verdict = ghostVerdict({ baselineHash, currentHash, historyMatch, historyExhausted });
  if (verdict.ghost) {
    return { status: 'reject', reason: 'fantasma: non trovata in TUTTA la storia disponibile di quel lato' };
  }
  if (verdict.matchedAt === 'current') return { status: 'ok', reason: 'combacia col contenuto attuale' };
  if (verdict.matchedAt === 'history') return { status: 'ok', reason: 'trovata nella storia di quel lato' };
  // Resta il non-verificato: storia non esaurita (`unresolved`) o walk non
  // eseguito (rete). Il cron passa oltre in entrambi i casi per non produrre
  // falsi rossi ricorrenti; in PR il lato corpus ha un rimedio deterministico,
  // quindi qui non passare oltre e' informazione, non rumore.
  const reason = networkError
    ? 'non verificabile: la storia di quel lato non e\' stata leggibile'
    : 'non verificabile: la storia esaminata non e\' tutta quella disponibile';
  return { status: side === 'corpus' ? 'reject' : 'warn', reason };
}

/** Il manifest al commit di base: da git se c'e', altrimenti da raw. */
async function baseManifest() {
  try {
    const raw = execFileSync('git', ['show', `${BASE}:${MANIFEST_REL}`], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(raw);
  } catch {
    /* checkout shallow, o base non fetchata: si prova la rete. */
  }
  const url = `https://raw.githubusercontent.com/${CORPUS_REPO}/${BASE}/${MANIFEST_REL}`;
  const headers = { 'User-Agent': 'loop-baseline-pr-gate' };
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  const res = await fetch(url, { headers });
  // 404 = il manifest non esisteva alla base. Non e' un errore: significa che
  // ogni voce e' nuova, ed e' esattamente il caso che il gate deve esaminare.
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${MANIFEST_REL}@${BASE} → HTTP ${res.status}`);
  return JSON.parse(await res.text());
}

/**
 * La storia LOCALE del path, quando il checkout ce l'ha. Evita la rete nel
 * caso normale dello sviluppo locale; su un checkout `fetch-depth: 1` non
 * trova niente e dichiara `exhausted: false`, cosi' il chiamante passa all'API
 * invece di scambiare una storia troncata per una prova.
 */
function localHistoryMatch(rel, targetHash) {
  const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  let shas;
  try {
    shas = git(['log', '--format=%H', '--', rel]).split('\n').filter(Boolean);
  } catch {
    return { match: false, exhausted: false, checked: 0 };
  }
  let shallow = true;
  try {
    shallow = git(['rev-parse', '--is-shallow-repository']).trim() === 'true';
  } catch {
    /* git troppo vecchio per la flag: si resta prudenti. */
  }
  let checked = 0;
  for (const sha of shas) {
    let buf;
    try {
      buf = execFileSync('git', ['cat-file', 'blob', `${sha}:${rel}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      // Il path non esisteva sotto questo nome a quella revisione: come nel
      // walk remoto, non e' un errore, si prosegue.
      continue;
    }
    checked += 1;
    if (sha256(buf) === targetHash) return { match: true, exhausted: true, checked };
  }
  return { match: false, exhausted: !shallow, checked };
}

/** Hash ORA del lato corpus (working tree del head), o null se il file non c'e'. */
function corpusHash(rel) {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? sha256(fs.readFileSync(p)) : null;
}

async function verifyOne(change) {
  const isCorpus = change.side === 'corpus';
  const filePath = isCorpus ? change.path : change.sitePath;
  const file = isCorpus ? null : await siteFile(change.sitePath).catch(() => undefined);
  const currentHash = isCorpus ? corpusHash(change.path) : file === undefined ? undefined : file === null ? null : sha256(file);
  if (currentHash === undefined) {
    return { ...change, filePath, ...gateVerdict({ ...change, baselineHash: change.hash, currentHash: null, networkError: true }) };
  }
  let historyMatch;
  let historyExhausted;
  let networkError = false;
  if (currentHash !== change.hash) {
    if (isCorpus) {
      const local = localHistoryMatch(change.path, change.hash);
      if (local.match || local.exhausted) {
        historyMatch = local.match;
        historyExhausted = local.exhausted;
      }
    }
    if (historyMatch === undefined) {
      try {
        const r = await repoHistoryMatch({
          repo: isCorpus ? CORPUS_REPO : SITE_REPO,
          ref: isCorpus ? CORPUS_REF : SITE_REF,
          filePath,
          targetHash: change.hash,
        });
        historyMatch = r.match;
        historyExhausted = r.exhausted;
      } catch {
        networkError = true;
      }
    }
  }
  return {
    ...change,
    filePath,
    ...gateVerdict({ side: change.side, baselineHash: change.hash, currentHash, historyMatch, historyExhausted, networkError }),
  };
}

async function main() {
  const head = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST_REL), 'utf8'));
  const changes = changedBaselines(await baseManifest(), head);
  if (!changes.length) {
    if (!JSON_OUT) console.log(`loop-baseline-pr-gate: nessuna baseline modificata rispetto a ${BASE} → niente da verificare.`);
    else console.log(JSON.stringify({ base: BASE, checked: 0, results: [] }, null, 2));
    return 0;
  }
  const results = [];
  for (const change of changes) results.push(await verifyOne(change));
  const rejected = results.filter((r) => r.status === 'reject');

  if (JSON_OUT) {
    console.log(JSON.stringify({ base: BASE, checked: results.length, results }, null, 2));
  } else {
    console.log(`loop-baseline-pr-gate: ${results.length} baseline modificate rispetto a ${BASE}.\n`);
    for (const r of results) {
      const mark = r.status === 'ok' ? '✅' : r.status === 'warn' ? '⚠️ ' : '❌';
      console.log(`${mark} \`${r.path}\` baseline.${r.side} = ${r.hash} — ${r.reason}`);
    }
    if (rejected.length) {
      console.log(
        '\nUna baseline si registra dal contenuto REALE, mai a mano:\n' +
          `  node scripts/ci/loop-drift-check.mjs --init --only ${rejected.map((r) => r.path).join(',')}\n` +
          'che scrive `now` per le sole voci indicate (issue #653). Se il valore giusto NON e' `now` — una\n' +
          'baseline riparata col blob a cui quel lato era davvero allineato ad `alignedAt` — deve comunque\n' +
          'esistere nella storia di quel lato: se non ci compare, non e\' mai esistito.',
      );
    }
  }
  return rejected.length ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith('loop-baseline-pr-gate.mjs')) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      // Un errore di questo script non e' la prova che una baseline sia falsa:
      // si dichiara e si passa, come il resto del ciclo (PROCEED-SAFE).
      console.error(`loop-baseline-pr-gate: errore non gestito → ${e && e.stack ? e.stack : e}`);
      process.exit(0);
    },
  );
}
