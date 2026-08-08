/**
 * pat-down-title-sync.test.mjs — l'alert del PAT deve avere un chiuditore, e i
 * due lati devono usare lo STESSO titolo.
 *
 * ## Il difetto che sorveglia
 *
 * `scripts/ci/alert-pat-down.mjs` è arrivato qui `mode: "identical"` dal sito e
 * dichiara nel proprio commento due dipendenze:
 *
 *   «l'auto-close-on-recovery del monitor resta l'unico punto di chiusura»
 *   «⚠ Tenere PAT_DOWN_TITLE in sync con LOAD_FAIL_TITLE in
 *     .github/workflows/gh-pat-expiry-monitor.yml»
 *
 * Nessuna delle due era vera: il monitor non esisteva su questo repo. Il
 * 2026-08-08 un 429 transitorio di Remote Config ha aperto la issue #45
 * `priority:urgent`, la condizione è rientrata da sé in pochi minuti, e niente
 * poteva chiuderla — `close-recovered-failure-issues.mjs` matcha solo
 * `^(?:Workflow|Crawler|CI) Failure: `.
 *
 * Il danno vero non è la singola issue: l'alert fa DEDUP sul titolo canonico,
 * quindi senza chiuditore ogni 429 successivo commenta sulla stessa issue
 * urgente perenne. Un allarme sempre acceso è un allarme spento.
 *
 * ## Perché un test e non solo un commento
 *
 * Il commento c'era già, con tanto di ⚠, e non ha impedito niente — perché il
 * porting ha copiato il file che LO CONTIENE senza portare il file che NOMINA.
 * Un `##[warning]` in prosa non è un guard. Questi due assert lo sono, e il
 * primo avrebbe fatto fallire la CI il giorno del porting.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAT_DOWN_TITLE } from '../../scripts/ci/alert-pat-down.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MONITOR = '.github/workflows/gh-pat-expiry-monitor.yml';

test('esiste un workflow che può chiudere l\'alert del PAT', () => {
  assert.ok(
    fs.existsSync(path.join(ROOT, MONITOR)),
    `${MONITOR} non esiste. \`alert-pat-down.mjs\` apre una issue \`priority:urgent\` ` +
      'con dedup sul titolo canonico e dichiara che il monitor è «l\'unico punto di ' +
      'chiusura». Senza, la issue resta aperta per sempre e ogni futuro PAT-down ci ' +
      'commenta sopra invece di aprirne una nuova: il segnale «il ciclo è giù» resta ' +
      'acceso in permanenza e smette di distinguere l\'allarme vero da quello stantio.',
  );
});

test('LOAD_FAIL_TITLE nel monitor combacia byte a byte con PAT_DOWN_TITLE', () => {
  const src = fs.readFileSync(path.join(ROOT, MONITOR), 'utf8');
  // Solo l'assegnazione reale, non una menzione in un commento: la riga deve
  // iniziare (a meno di indentazione) con il nome della variabile.
  const m = /^\s*LOAD_FAIL_TITLE="([^"]*)"/m.exec(src);
  assert.ok(m, `Nessuna assegnazione \`LOAD_FAIL_TITLE="..."\` trovata in ${MONITOR}.`);
  assert.equal(
    m[1],
    PAT_DOWN_TITLE,
    'Il titolo del monitor e quello dell\'alerter DEVONO combaciare: è la chiave di ' +
      'dedup di github-issue-creator. Se divergono, il monitor apre una SECONDA issue ' +
      'invece di chiudere quella che l\'alerter ha aperto — e nessuna delle due si ' +
      'chiude più. Vale anche per le issue già emesse (la #45).',
  );
});

test('il titolo non nomina la variabile locale di questo repo', () => {
  // Trappola non ovvia: qui il PAT si chiama `GITHUB_PAT_NANAKO`, e "correggere"
  // il titolo per coerenza sembrerebbe una pulizia. Non lo è — spezzerebbe il
  // dedup col sito, con `alert-pat-down.mjs` (che è `identical`) e con lo
  // storico delle issue già aperte.
  assert.equal(
    PAT_DOWN_TITLE,
    'Agent loop down: GITHUB_PAT failed to load',
    'Il titolo canonico è condiviso e non va adattato al nome locale della variabile.',
  );
  assert.ok(
    !PAT_DOWN_TITLE.includes('NANAKO'),
    'Il titolo non deve nominare GITHUB_PAT_NANAKO: è una chiave di dedup cross-repo.',
  );
});

test('il monitor non fallisce il run sul load-failure (evita la issue doppia)', () => {
  // `workflow-failure-issues.yml` gira ogni `9,39` con `IGNORE_WORKFLOWS: ''`,
  // cioè non ignora nessun workflow. Un `exit 1` qui produrrebbe una seconda
  // issue — «Workflow Failure: GH_PAT Expiry Monitor» — accanto all'alert
  // urgente appena aperto: due issue per un fatto solo, esattamente il rumore
  // che questo monitor esiste per ridurre. Il sito può permetterselo, qui no.
  const src = fs.readFileSync(path.join(ROOT, MONITOR), 'utf8');
  const afterAlert = src.slice(src.indexOf('--workflow "GH_PAT Expiry Monitor"'));
  assert.ok(
    !/^\s*exit 1\s*$/m.test(afterAlert),
    'Il ramo di load-failure non deve uscire con 1: il failure-scanner aprirebbe una ' +
      'seconda issue per lo stesso fatto.',
  );
});
