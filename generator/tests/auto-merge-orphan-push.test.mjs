/**
 * auto-merge-orphan-push.test.mjs — un push sul branch di una PR già MERGED
 * non deve restare orfano in silenzio (issue #532).
 *
 * Il difetto vive nel blocco `on:` del workflow. GitHub accetta il push, il
 * commit resta fuori da main, e nessuno lo dice. Non è un errore, è un'ASSENZA
 * — la stessa classe di `loop-workflow-triggers.test.mjs`.
 *
 * Il rilevatore era il primo job del workflow dell'auto-merge su LGTM finché
 * quello è esistito; dal 2026-09-03 vive in `orphan-push-warn.yml`, perché il
 * merge è passato all'auto-merge nativo e `tests.yml` — l'unico altro posto
 * dove avrebbe potuto stare — ha il `push:` scopato a `main`, cioè il trigger
 * OPPOSTO a quello che serve qui.
 *
 * Questo test NON reimplementa il workflow. Legge lo YAML shipped e
 * asserisce le cose che, se sparissero, riaprirebbero il silenzio:
 *   (a) il blocco `on` prima di `jobs` contiene `push`;
 *   (b) esiste uno step/job che parla di MERGED o orphan push;
 *   (c) il job `auto-merge` è gated via dal trigger push.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = path.join(ROOT, '.github/workflows/orphan-push-warn.yml');
const src = fs.readFileSync(WORKFLOW, 'utf8');

/** Solo le righe eseguibili: i commenti CITANO il difetto, e un match sul
 *  testo grezzo li leggerebbe come ancora presenti. */
const active = (text) =>
  text
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');

const ATTIVE = active(src);

/** Testa del file: tutto ciò che precede `jobs:`. È lo stesso taglio della
 *  metrica della scheda; qui si asserisce sul testo attivo, non sui commenti. */
function onBlock(text) {
  const jobsAt = text.search(/\njobs:\s*\n/);
  assert.notEqual(jobsAt, -1, 'orphan-push-warn.yml non ha una sezione `jobs:`');
  const head = text.slice(0, jobsAt);
  const onAt = head.search(/\non:\s*\n/);
  assert.notEqual(onAt, -1, 'auto-merge-on-lgtm.yml non ha un blocco `on:`');
  return head.slice(onAt + 1);
}

/** Blocco di un job: da `\n  <nome>:` al job successivo allo stesso livello. */
function jobBlock(text, name) {
  const start = text.search(new RegExp(`\\n  ${name}:\\s*\\n`));
  if (start === -1) return null;
  const rest = text.slice(start + 1);
  const next = rest.search(/\n {2}[a-z][\w-]*:\s*\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

test('(a) il blocco on prima di jobs contiene push (e ignora main)', () => {
  const on = onBlock(ATTIVE);
  assert.match(
    on,
    /^on:\n(?:.*\n)*[ \t]+push:/m,
    'Senza trigger `push` un git push sul branch di una PR già MERGED non fa ' +
      'partire nessun job: il commit resta orfano e il silenzio di #532 torna identico.',
  );
  assert.match(
    on,
    /push:\n[ \t]+branches-ignore:\s*\[main\]/,
    'Il trigger `push` deve ignorare `main`: spararlo lì costerebbe una run ' +
      'per ogni articolo generato (~90/giorno) senza nessuna PR da avvisare.',
  );
});

test('(b) esiste uno step/job che parla di MERGED o orphan push', () => {
  const jobsAt = ATTIVE.search(/\njobs:\s*\n/);
  assert.notEqual(jobsAt, -1, 'auto-merge-on-lgtm.yml non ha una sezione `jobs:`');
  const jobs = ATTIVE.slice(jobsAt);
  const parlaOrphan = /orphan push|orfano/i.test(jobs);
  const parlaMerged = /MERGED/.test(jobs);
  assert.ok(
    parlaOrphan || parlaMerged,
    'Nessuno step/job parla di MERGED o orphan push: il trigger `push` ' +
      'partirebbe e non segnalerebbe nulla, che è lo stesso silenzio con un run in più.',
  );
  assert.match(
    jobs,
    /gh pr comment/,
    'Lo step di avviso non commenta sulla PR: un ::warning nel log della run ' +
      'non arriva a chi ha pushato, e il commit resta orfano senza traccia sulla PR.',
  );
});

test('(d) il job warn-orphan-push ignora il push di cancellazione branch del proprio squash-merge', () => {
  const job = jobBlock(ATTIVE, 'warn-orphan-push');
  assert.ok(job, 'job `warn-orphan-push` non trovato');
  assert.match(
    job,
    /github\.event\.deleted\s*!=\s*true/,
    'Il job non esclude `github.event.deleted == true`: ogni squash-merge fatto ' +
      'da questo stesso workflow (`gh pr merge --delete-branch`) genera un push di ' +
      'cancellazione branch che il job leggerebbe come push orfano, postando un ' +
      'falso avviso su OGNI PR auto-mergiata.',
  );
});

// Il test (c) — «il job `auto-merge` e' gateato su `event_name != 'push'`» —
// e' stato rimosso il 2026-09-03 insieme al suo oggetto: il merge e' passato
// all'auto-merge nativo di GitHub e non esiste piu' un job di merge che
// condivida il trigger `push` con questo. La proprieta' che il test difendeva
// (il push non deve far partire una valutazione di merge) ora vale
// by construction: questo workflow ha SOLO il trigger `push` e SOLO questo job.
