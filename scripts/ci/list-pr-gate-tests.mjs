#!/usr/bin/env node
/**
 * list-pr-gate-tests.mjs — i file che `tests.yml` deve eseguire su una PR.
 *
 * ── PERCHE' `tests.yml` NON LI ESEGUE PIU' TUTTI ──────────────────────────
 *
 * `tests.yml` e' il check-run che l'auto-merge aspetta prima di mergiare
 * QUALUNQUE PR. Finche' eseguiva l'intera cartella, eseguiva anche i gate che
 * leggono `content/`, cioe' il corpus generato dai bot — e quel corpus cambia
 * senza che nessuna PR lo tocchi: ~90 push al giorno su `main`.
 *
 * Il costo, misurato il 2026-08-19. Alle 07:27Z e' atterrato l'articolo
 * `vivere-villa-guardia-lavorare-ticino` («Villa Guardia» e' un comune,
 * «guardia» l'alias del mestiere `agente-sicurezza`) e
 * `article-topic-coverage-guard.test.mjs` e' diventato rosso su `main` e su
 * OGNI branch. Nessuna PR ha potuto auto-mergiare per sei ore, per un dato che
 * nessuna di loro aveva scritto e che nessuna di loro poteva riparare. Non e'
 * la prima volta: il 2026-08-18 le sei PR #410, #413, #414, #416, #417 e #418
 * erano tutte e sei rosse sugli stessi tre gate, e un `gh pr update-branch` le
 * ha rese verdi 9/9 senza cambiare una riga — perche' nel frattempo altri
 * articoli generati avevano sostituito quello colpevole.
 *
 * Un check che diventa rosso per un dato che l'autore della PR non ha scritto
 * e non puo' riparare non sta misurando quella PR.
 *
 * ── DOVE I GATE RESTANO ESEGUITI, CHE E' IL PUNTO ─────────────────────────
 *
 * L'esclusione non toglie copertura, la sposta dove il segnale e' azionabile:
 *
 *   - `generator-ci.yml` gira su `pull_request` con `paths: generator/**` ed
 *     esegue l'INTERA cartella (`node --test 'generator/tests/*.test.mjs'`).
 *     Quindi una PR che tocca un gate — o il codice che il gate esercita — lo
 *     esegue comunque, e resta bloccata se lo rompe. Verificato sulla PR #492,
 *     che riparava proprio il classificatore: tocca `generator/**`, quindi
 *     `generator-ci` la copre per intero. E' anche un check richiesto
 *     dall'auto-merge per quelle PR (gate 4 di `auto-merge-eval.mjs`).
 *   - `content-gates-main.yml` gira sui push a `main` che toccano `content/**`
 *     ed esegue i gate sul corpus appena scritto: su offender apre UNA issue
 *     deduplicata a priorita' alta invece di rendere rossa una PR che non
 *     c'entra. E' li' che il segnale e' azionabile, perche' li' il dato c'e'.
 *
 * ── NIENTE FALSO VERDE ────────────────────────────────────────────────────
 *
 * Il modo in cui questo script puo' fare danno e' UNO: rendere una lista corta
 * o vuota, cosi' che `tests.yml` passi verde avendo eseguito poco o niente.
 * Per questo esce !=0 — rumorosamente, senza stampare la lista — se la
 * cartella non si legge, se un gate elencato non esiste, o se cio' che resta
 * scende sotto un pavimento. Un elenco troncato spegne un gate; qui deve
 * fermare la run.
 *
 * Uso:  node --test $(node scripts/ci/list-pr-gate-tests.mjs)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTENT_GATES } from './content-gates-main.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TESTS_REL = 'generator/tests';

/**
 * Pavimento sul numero di file che restano.
 *
 * Non e' un numero tondo: al 2026-08-20 la cartella ne ha 137 e i gate sul
 * contenuto sono 18, quindi ne restano 119. 90 lascia spazio a una potatura
 * legittima e intercetta comunque il caso che conta — una lista collassata.
 */
export const MIN_PR_GATE_TESTS = 90;

/**
 * @param {string} [root]
 * @returns {{ files: string[], violations: string[] }}
 */
export function listPrGateTests(root = ROOT) {
  const dir = path.join(root, TESTS_REL);
  const violations = [];

  let tutti = [];
  try {
    tutti = fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort();
  } catch (err) {
    violations.push(`${TESTS_REL} non leggibile (${err.code || err.message}): la lista sarebbe vuota.`);
    return { files: [], violations };
  }

  const esclusi = new Set(CONTENT_GATES);
  for (const g of CONTENT_GATES) {
    if (!fs.existsSync(path.join(root, g))) {
      violations.push(`gate elencato ma inesistente: ${g}. La lista da escludere non descrive piu' la cartella.`);
    }
  }

  const files = tutti.map((f) => `${TESTS_REL}/${f}`).filter((f) => !esclusi.has(f));
  if (files.length < MIN_PR_GATE_TESTS) {
    violations.push(
      `restano ${files.length} test, sotto il pavimento di ${MIN_PR_GATE_TESTS}. `
      + 'Una lista collassata farebbe passare `tests` verde avendo eseguito quasi niente.',
    );
  }
  return { files, violations };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { files, violations } = listPrGateTests();
  if (violations.length) {
    // Su stderr e senza stampare la lista: chi ci fa `$(...)` attorno non deve
    // poter comporre un comando con un elenco che questo script ha rifiutato.
    process.stderr.write(`[list-pr-gate-tests] NON eseguo:\n  ${violations.join('\n  ')}\n`);
    process.exit(1);
  }
  process.stdout.write(`${files.join('\n')}\n`);
}
