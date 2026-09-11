/**
 * no-hardcoded-secrets.test.mjs — il gate che esegue `AGENTS.md` § Credenziali
 * («Nessun secret nei file. Tutto in Firebase Remote Config») su ogni PR.
 *
 * La prosa del contratto c'era gia' e non ha fermato niente: il 2026-09-10 la
 * PR #1315 ha inlinato una Google API key in `host/constants.ts:66` — dentro la
 * chiave di persistenza di Firebase Auth usata per scopare il check di accesso
 * dell'Offerwall — e la CI e' rimasta verde. A vederla e' stato il secret
 * scanning di GitHub, cioe' a push avvenuto: da li' in poi la chiave e'
 * leggibile da chiunque abbia accesso in lettura e la storia non si riscrive.
 *
 * Il gate vive qui e non in un workflow path-scoped per la ragione che quella
 * PR dimostra: toccava `host/`, non un path che «sembra» sensibile. I file in
 * `generator/tests/` li raccoglie `list-pr-gate-tests.mjs`, quindi questo test
 * gira dentro `tests (node --test)` — il check-run che governa il merge di
 * QUALUNQUE PR di questo repo.
 *
 * La sorgente unica delle regex e' `scripts/ci/scan-hardcoded-secrets.mjs`
 * (AGENTS.md non-negoziabile 6): lo script e' anche eseguibile a mano, e questo
 * test non ne duplica un solo pattern.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MIN_SCANNED_FILES,
  SECRET_PATTERNS,
  isScanned,
  redact,
  scanRepo,
  scanText,
} from '../../scripts/ci/scan-hardcoded-secrets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Campioni sintetici COMPOSTI a runtime, mai scritti come letterali.
 *
 * Due ragioni, entrambe pratiche: un letterale con la forma giusta renderebbe
 * rosso questo stesso gate (il file e' tracciato e viene scansionato), e farebbe
 * scattare la push protection di GitHub sul commit che lo introduce. Concatenare
 * i pezzi prova il rilevatore senza mai far esistere la stringa nel file.
 */
const CAMPIONI = [
  // La forma esatta dell'alert del 2026-09-10: la chiave dentro una stringa
  // piu' grande, non da sola. Se il rilevatore ancorasse a inizio valore,
  // questo caso — l'unico gia' successo — gli sfuggirebbe.
  {
    id: 'google-api-key',
    testo: `const K = 'firebase:authUser:${'AIza'}${'Sy'}${'A'.repeat(33)}:[DEFAULT]';`,
  },
  { id: 'google-api-key', testo: `${'AIza'}${'Sy'}${'b'.repeat(33)}` },
  { id: 'github-token', testo: `${'ghp'}_${'A1'.repeat(18)}` },
  { id: 'github-pat-fine-grained', testo: `${'github'}_${'pat'}_${'C'.repeat(70)}` },
  { id: 'google-oauth-secret', testo: `${'GOCSPX'}-${'d'.repeat(28)}` },
  { id: 'anthropic-key', testo: `${'sk'}-${'ant'}-api03-${'E'.repeat(40)}` },
  { id: 'openai-key', testo: `${'sk'}-${'f'.repeat(48)}` },
  { id: 'slack-token', testo: `${'xoxb'}-${'123456789012'}-${'G'.repeat(24)}` },
  { id: 'aws-access-key-id', testo: `${'AKIA'}${'H'.repeat(16)}` },
  { id: 'private-key-block', testo: `-----${'BEGIN'} RSA PRIVATE KEY-----` },
];

test('nessuna credenziale in chiaro nei file tracciati', () => {
  const { findings, scanned } = scanRepo(ROOT);
  assert.ok(
    scanned >= MIN_SCANNED_FILES,
    `scansionati ${scanned} file, sotto il pavimento di ${MIN_SCANNED_FILES}: il verde non significherebbe niente`,
  );
  assert.deepEqual(
    findings.map((f) => `${f.file}:${f.line} — ${f.label} [${f.redacted}]`),
    [],
    'credenziale in chiaro: spostala in Firebase Remote Config e mappala in RC_TO_ENV '
    + '(generator/scripts/load-rc-env.mjs). Vedi AGENTS.md § Credenziali.',
  );
});

test('ogni pattern dichiarato riconosce la propria forma', () => {
  for (const { id, testo } of CAMPIONI) {
    const trovati = scanText(testo, 'campione').map((f) => f.patternId);
    assert.ok(
      trovati.includes(id),
      `il pattern \`${id}\` non riconosce piu' la propria forma: il gate resterebbe verde su una credenziale di quel tipo`,
    );
  }
  const coperti = new Set(CAMPIONI.map((c) => c.id));
  for (const { id } of SECRET_PATTERNS) {
    assert.ok(coperti.has(id), `il pattern \`${id}\` non ha un campione: nessuno prova che funzioni`);
  }
});

test('gli identificatori pubblici del repo non fanno rosso il gate', () => {
  // Questi valori DEVONO stare nei file — finiscono nell'HTML servito. Un gate
  // che li rende rossi viene disattivato dal primo che ha fretta, e allora non
  // copre piu' nemmeno il caso vero. Vedi l'intestazione dello scanner.
  const pubblici = [
    "export const GA4_MEASUREMENT_ID = 'G-LGJ9LE360F';",
    "export const ADSENSE_CLIENT_ID = 'ca-pub-8628054934855353';",
    `data-cf-beacon='{"token": "1268b58e83f74d22a2136ff48e0746b7", "version": "2024.6.1"}'`,
    "if(window.localStorage.getItem('frontaliere:auth-session')==='true')return true;",
  ];
  for (const riga of pubblici) {
    assert.deepEqual(scanText(riga, 'pubblico'), [], `falso positivo su un valore pubblico: ${riga}`);
  }
});

test('il valore trovato non viene mai stampato per intero', () => {
  // Un log di Actions e' pubblico quanto il file da cui il valore viene:
  // stampare il match intero rifarebbe il danno che il gate impedisce.
  const finto = `${'AIza'}${'Sy'}${'z'.repeat(33)}`;
  const [finding] = scanText(finto, 'campione');
  assert.ok(finding, 'campione non riconosciuto');
  assert.ok(!finding.redacted.includes(finto), 'il messaggio contiene la credenziale intera');
  assert.ok(finding.redacted.includes(`${'AIza'}Sy`), 'la redazione non lascia abbastanza per riconoscere il valore');
  assert.equal(redact('corto'), 'cor…');
});

test('i path esclusi sono solo corpus, asset e generati', () => {
  // L'esclusione e' cio' che rende il gate abbastanza veloce da girare su ogni
  // PR; allargarla di una directory di SORGENTI aprirebbe un buco silenzioso.
  assert.equal(isScanned('content/articles/it/qualcosa.json'), false);
  assert.equal(isScanned('data/comuni.json'), false);
  assert.equal(isScanned('public/favicon.svg'), false);
  assert.equal(isScanned('package-lock.json'), false);

  assert.equal(isScanned('host/constants.ts'), true);
  assert.equal(isScanned('engine/ogPagesPlugin.ts'), true);
  assert.equal(isScanned('scripts/ci/scan-hardcoded-secrets.mjs'), true);
  assert.equal(isScanned('generator/scripts/load-rc-env.mjs'), true);
  assert.equal(isScanned('.github/workflows/tests.yml'), true);
  assert.equal(isScanned('services/qualcosa.ts'), true);
});
