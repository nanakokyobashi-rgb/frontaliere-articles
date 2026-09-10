#!/usr/bin/env node
/**
 * scan-hardcoded-secrets.mjs — il cancello che tiene le credenziali FUORI dai
 * file, dove `AGENTS.md` § Credenziali dice che devono stare.
 *
 * ── PERCHE' ESISTE ───────────────────────────────────────────────────────
 *
 * Il contratto («Nessun secret nei file. Tutto in Firebase Remote Config»)
 * esisteva gia' come prosa, e la prosa non ferma un commit. Il 2026-09-10 la
 * PR #1315 ha inlinato una Google API key dentro `host/constants.ts` per
 * scopare il check di accesso dell'Offerwall alla chiave di persistenza di
 * Firebase Auth:
 *
 *     const FIREBASE_AUTH_PERSISTENCE_KEY = 'firebase:authUser:AIza…:[DEFAULT]';
 *
 * Nessun test era rosso: il valore e' una costante di stringa come le altre in
 * quel file, e il gate del contratto della shell confronta i byte con il sito,
 * non la forma di cio' che contiene. Ad accorgersene e' stato il secret
 * scanning di GitHub, cioe' DOPO il push — quando la chiave e' gia' leggibile
 * da chiunque abbia accesso in lettura e la storia non si riscrive piu'.
 *
 * Un secret non fallisce come un bug: atterra verde. Questo script e' la forma
 * eseguibile del contratto, e gira su OGNI PR come gate
 * (`generator/tests/no-hardcoded-secrets.test.mjs`, raccolto da
 * `list-pr-gate-tests.mjs`) — non solo sui path che sembrano sensibili, perche'
 * quella PR toccava `host/`, non `scripts/ci/`.
 *
 * ── COSA CERCA, E PERCHE' SOLO QUESTO ────────────────────────────────────
 *
 * Solo forme con un PREFISSO dichiarato dall'emittente (`AIza`, `ghp_`,
 * `sk-ant-`, `AKIA`, `-----BEGIN … PRIVATE KEY-----`, …). Niente euristiche
 * sull'entropia e niente regex su esadecimali generici: questo repo pubblica
 * per costruzione degli identificatori pubblici che una regola del genere
 * renderebbe rossi per sempre — il token del beacon Cloudflare e
 * `ADSENSE_CLIENT_ID` in `host/constants.ts`, il `GA4_MEASUREMENT_ID`. Un gate
 * che grida al lupo su valori che DEVONO stare nel file viene disattivato dal
 * primo che ha fretta, e allora non copre piu' nemmeno il caso vero.
 *
 * Il prezzo e' che non intercetta un secret senza forma riconoscibile (una
 * password, un bearer opaco). Per quelli resta il contratto in `AGENTS.md` e
 * il secret scanning di GitHub; qui si copre la classe che e' gia' passata.
 *
 * ── NIENTE FALSO VERDE ───────────────────────────────────────────────────
 *
 * Il solo modo in cui questo file puo' fare danno e' scansionare poco o niente
 * e concludere «pulito». Percio' `scanRepo()` enumera i file tracciati con
 * `git ls-files` e ALZA se l'enumerazione fallisce o se scende sotto
 * `MIN_SCANNED_FILES`: stessa disciplina di `list-pr-gate-tests.mjs`.
 *
 * Uso:  node scripts/ci/scan-hardcoded-secrets.mjs
 *       (esce 1 elencando file:riga; il valore trovato e' REDATTO, perche' un
 *       log di Actions e' pubblico quanto il file da cui viene)
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Pavimento sul numero di file scansionati.
 *
 * Al 2026-09-10 l'enumerazione ne rende 691 (l'albero tracciato meno
 * `content/`, `data/`, `public/`). 300 lascia spazio a una potatura legittima
 * e intercetta comunque il caso che conta: una lista collassata.
 */
export const MIN_SCANNED_FILES = 300;

/**
 * Path esclusi dalla scansione.
 *
 * `content/`, `data/` e `public/` sono corpus e asset generati dai bot: ~31k
 * file che nessuna PR scrive a mano e in cui una credenziale non puo' entrare
 * se non passando prima da un sorgente qui scansionato. `package-lock.json` e'
 * rigenerato da npm. Tenerli fuori e' cio' che rende questo gate abbastanza
 * veloce da girare su ogni PR.
 */
export const SCAN_EXCLUDE = [
  /^content\//,
  /^data\//,
  /^public\//,
  /^package-lock\.json$/,
  /\.(png|jpe?g|webp|gif|ico|svg|woff2?|ttf|eot|pdf|zip|gz|mp4|webm)$/i,
];

/** Un file piu' grande di questo non e' un sorgente: si salta. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Le forme cercate. `re` ha SEMPRE il flag `g` (lo scanner riusa l'istanza e
 * azzera `lastIndex` ad ogni file).
 *
 * @type {{ id: string, label: string, re: RegExp }[]}
 */
export const SECRET_PATTERNS = [
  // Google API key (Firebase Web API key inclusa: e' la stessa forma, ed e'
  // esattamente cio' che ha fatto scattare l'alert del 2026-09-10).
  { id: 'google-api-key', label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // Google OAuth client secret.
  { id: 'google-oauth-secret', label: 'Google OAuth client secret', re: /\bGOCSPX-[0-9A-Za-z_-]{20,}/g },
  // GitHub: PAT classico/installazione (ghp_, gho_, ghu_, ghs_, ghr_) e fine-grained.
  { id: 'github-token', label: 'GitHub token', re: /\bgh[pousr]_[0-9A-Za-z]{36,255}\b/g },
  { id: 'github-pat-fine-grained', label: 'GitHub fine-grained PAT', re: /\bgithub_pat_[0-9A-Za-z_]{60,}/g },
  { id: 'anthropic-key', label: 'Anthropic API key', re: /\bsk-ant-[0-9A-Za-z_-]{20,}/g },
  { id: 'openai-key', label: 'OpenAI API key', re: /\bsk-(?:proj-)?[0-9A-Za-z]{32,}\b/g },
  { id: 'slack-token', label: 'Slack token', re: /\bxox[abposr]-[0-9A-Za-z-]{10,}/g },
  { id: 'aws-access-key-id', label: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // Chiave privata in chiaro: service account Firebase/GCP, deploy key, PGP.
  { id: 'private-key-block', label: 'blocco di chiave privata', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
];

/**
 * Redige il valore trovato: un log di GitHub Actions e' pubblico quanto il file
 * da cui il valore viene, quindi stamparlo intero rifarebbe il danno che questo
 * gate esiste per impedire. Restano gli estremi, che bastano a riconoscerlo.
 *
 * @param {string} value
 */
export function redact(value) {
  if (value.length <= 12) return `${value.slice(0, 3)}…`;
  return `${value.slice(0, 6)}…${value.slice(-3)} (${value.length} char)`;
}

/**
 * @param {string} text
 * @param {string} [file] path relativo, per il messaggio
 * @returns {{ file: string, line: number, patternId: string, label: string, redacted: string }[]}
 */
export function scanText(text, file = '<text>') {
  /** @type {{ file: string, line: number, patternId: string, label: string, redacted: string }[]} */
  const findings = [];
  for (const { id, label, re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      // Numero di riga senza splittare l'intero file per ogni match.
      const line = text.slice(0, m.index).split('\n').length;
      findings.push({ file, line, patternId: id, label, redacted: redact(m[0]) });
    }
  }
  return findings.sort((a, b) => a.line - b.line || a.patternId.localeCompare(b.patternId));
}

/** @param {string} rel */
export function isScanned(rel) {
  return !SCAN_EXCLUDE.some((re) => re.test(rel));
}

/**
 * @param {string} [root]
 * @returns {string[]} path relativi, tracciati da git e non esclusi
 */
export function scannedFiles(root = ROOT) {
  let out;
  try {
    out = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    // Alzare, non tornare lista vuota: una scansione di zero file concluderebbe
    // «nessun secret trovato» ed e' il solo esito davvero pericoloso.
    throw new Error(`git ls-files non eseguibile in ${root} (${err.code || err.message}): la scansione sarebbe vuota.`);
  }
  return out.split('\0').filter(Boolean).filter(isScanned);
}

/**
 * @param {string} [root]
 * @returns {{ findings: ReturnType<typeof scanText>, scanned: number }}
 */
export function scanRepo(root = ROOT) {
  const files = scannedFiles(root);
  if (files.length < MIN_SCANNED_FILES) {
    throw new Error(
      `scansionerei ${files.length} file, sotto il pavimento di ${MIN_SCANNED_FILES}: `
      + 'una lista collassata concluderebbe «pulito» senza aver guardato niente.',
    );
  }
  /** @type {ReturnType<typeof scanText>} */
  const findings = [];
  let scanned = 0;
  for (const rel of files) {
    const abs = path.join(root, rel);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue; // tracciato ma assente nel working tree (checkout sparso)
    }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
    scanned++;
    findings.push(...scanText(fs.readFileSync(abs, 'utf8'), rel));
  }
  return { findings, scanned };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let result;
  try {
    result = scanRepo();
  } catch (err) {
    process.stderr.write(`[scan-hardcoded-secrets] NON ho scansionato: ${err.message}\n`);
    process.exit(2);
  }
  const { findings, scanned } = result;
  if (findings.length) {
    process.stderr.write(
      `[scan-hardcoded-secrets] ${findings.length} credenziale/i in chiaro su ${scanned} file:\n`
      + findings.map((f) => `  ${f.file}:${f.line} — ${f.label} [${f.redacted}]`).join('\n')
      + '\n\nLe credenziali stanno in Firebase Remote Config (progetto `frontaliere-ticino`);'
      + '\nil ponte verso process.env e\' generator/scripts/load-rc-env.mjs — l\'unico.'
      + '\nMappa il parametro in RC_TO_ENV e leggilo da process.env: un valore inlinato'
      + '\nqui e\' leggibile da chiunque abbia accesso in lettura e la storia non si'
      + '\nriscrive. Vedi AGENTS.md § Credenziali.\n',
    );
    process.exit(1);
  }
  process.stdout.write(`[scan-hardcoded-secrets] ${scanned} file, nessuna credenziale in chiaro.\n`);
}
