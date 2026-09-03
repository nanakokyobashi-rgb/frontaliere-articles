/**
 * issue-fix-work-preservation.test.mjs — il lavoro pagato non deve morire col
 * container, e il colore del job deve dire la verita'.
 *
 * ## Perche' e' un test sullo YAML
 *
 * I tre step che questo file sorveglia hanno una proprieta' in comune: sono
 * DETERMINISTICI e stanno in `issue-fix.yml` proprio perche' la versione
 * affidata al prompt non funzionava. Un passo che l'agente esegue «se gli
 * restano turni» non viene eseguito esattamente nei casi che contano — sul sito
 * venti issue su ventinove parcheggiate con verdetto `max-turns` non avevano
 * nessun branch `fix/issue-N` su origin: il diff era morto col container,
 * insieme ai turni gia' pagati per produrlo.
 *
 * Il modo in cui questi step tornano a non funzionare non e' un errore: e' una
 * condizione `if:` che li salta in silenzio. Un `if: success()` implicito sul
 * checkpoint lo spegne proprio sulla morte per max-turns; un
 * `continue-on-error: true` sul classificatore rende il job verde su una
 * non-consegna. Nessuno dei due produce un log rosso. Da qui questo file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = fs.readFileSync(path.join(ROOT, '.github/workflows/issue-fix.yml'), 'utf8');

/** Il blocco di uno step: dal suo `- name:` al `- name:` successivo. */
function step(name) {
  const start = SRC.indexOf(`      - name: ${name}`);
  if (start === -1) return null;
  const rest = SRC.slice(start + 1);
  const next = rest.indexOf('\n      - name: ');
  return next === -1 ? rest : rest.slice(0, next);
}

const WIP = 'Salva il lavoro parziale (WIP checkpoint deterministico, zero-Claude)';
const BACKSTOP = 'Emit FIX_OUTCOME telemetry (deterministic backstop)';
const CLASSIFY = 'Classify outcome (work-done, not CLI exit)';

test('il checkpoint WIP esiste e gira su always()', () => {
  const s = step(WIP);
  assert.ok(s, `step «${WIP}» assente: senza, un run morto ai turni perde il diff che aveva in mano.`);
  assert.match(
    s,
    /if: always\(\)/,
    'Il checkpoint non gira su `always()`. Con il `success()` implicito verrebbe saltato proprio\n' +
      'quando la CLI e\' morta — cioe\' nell\'unico caso per cui esiste.',
  );
  assert.match(
    s,
    /continue-on-error: true/,
    'Il checkpoint non e\' best-effort: un salvataggio fallito trasformerebbe un run terminato\n' +
      'in un run rosso, aggiungendo un falso segnale a una perdita.',
  );
});

test('il checkpoint non tocca niente quando il lavoro e\' gia\' consegnato', () => {
  const s = step(WIP);
  assert.match(
    s,
    /state=="OPEN" or \.state=="MERGED"/,
    'Il checkpoint non controlla se esiste gia\' una PR aperta o mergiata sul branch della issue:\n' +
      'committerebbe sopra un lavoro gia\' consegnato.',
  );
  assert.match(
    s,
    /rev-list --count origin\/main\.\.HEAD/,
    'Il checkpoint non verifica di avere qualcosa da salvare: su un albero pulito e 0 commit davanti\n' +
      'a main pusherebbe un branch vuoto a ogni run terminale.',
  );
});

test('il backstop FIX_OUTCOME non sovrascrive il marker granulare dell\'agente', () => {
  const s = step(BACKSTOP);
  assert.ok(s, `step «${BACKSTOP}» assente: senza, un run senza marker e\' indistinguibile da uno morto.`);
  assert.match(
    s,
    /select\(test\("<!-- FIX_OUTCOME:"\)\)/,
    'Il backstop non cerca un marker esistente prima di scriverne uno: sovrascriverebbe il verdetto\n' +
      'granulare dell\'agente con un `no-pr-unspecified` grezzo, avvelenando il segnale invece di\n' +
      'completarlo.',
  );
  assert.match(s, /continue-on-error: true/, 'la telemetria non deve mai far fallire il job');
});

test('il classificatore PUO\' rendere rosso il job (nessun continue-on-error)', () => {
  const s = step(CLASSIFY);
  assert.ok(s, `step «${CLASSIFY}» assente`);
  assert.doesNotMatch(
    s,
    /continue-on-error: true/,
    'Il classificatore ha `continue-on-error`: un run che non ha consegnato nessuna PR uscirebbe\n' +
      'verde, cioe\' un falso-verde su una non-consegna. E\' l\'unico degli step post-Claude che DEVE\n' +
      'poter fallire.',
  );
  assert.match(s, /if: always\(\)/, 'il classificatore deve girare anche dopo una CLI fallita');
});

test('il classificatore guarda il LAVORO, non l\'exit della CLI', () => {
  const s = step(CLASSIFY);
  // L'ordine dei due rami e' sostanziale: se il controllo sulla PR venisse
  // DOPO quello sull'outcome della CLI, un run morto ai turni dopo aver aperto
  // la PR uscirebbe rosso pur avendo consegnato.
  const prCheck = s.indexOf('PR_STATE=');
  const cliCheck = s.indexOf('$CLAUDE_OUTCOME" = "failure"');
  assert.ok(prCheck !== -1, 'il classificatore non cerca una PR sul branch della issue');
  assert.ok(cliCheck !== -1, 'il classificatore non guarda l\'outcome della CLI');
  assert.ok(
    prCheck < cliCheck,
    'Il controllo sull\'outcome della CLI viene PRIMA di quello sulla PR: un run morto ai turni\n' +
      'dopo aver consegnato la PR verrebbe classificato come fallimento.',
  );
});
