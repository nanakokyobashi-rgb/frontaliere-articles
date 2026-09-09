/**
 * Redcheck deve scartare prima di Claude il rosso che appartiene solo al
 * verdetto della review — ma la PROVA che quel rosso ha gia' un proprietario e'
 * la review stessa, non la `conclusion` degli step del run.
 *
 * `Run Claude review` gira con `continue-on-error: true`, quindi la jobs API lo
 * riporta `success` anche quando l'action e' morta: dedurre da li' che una
 * review esiste faceva skippare il ❌-fixer proprio nel caso in cui NESSUNA
 * review e' stata postata, dove il \u{1F534}-fixer non parte mai e il rosso resta
 * orfano. Il gate qui e' quindi: ultima review del reviewer bot sulla HEAD +
 * marker `\u{1F534} Important` reale, e `tests` unico check rosso.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REDFLAG_IMPORTANT_RE, REVIEWER_BOT_LOGIN_JQ } from '../../scripts/ci/lib/constants.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = path.join(ROOT, '.github/workflows/pr-redcheck-fixer.yml');
const source = fs.readFileSync(WORKFLOW, 'utf8');

function preflightBlock() {
  const start = source.indexOf('- name: PR azionabile, e il rosso e\' ancora quello della HEAD?');
  const end = source.indexOf('\n\n  redcheck-fix:', start);
  assert.notEqual(start, -1, 'lo step preflight non e\' stato trovato');
  assert.notEqual(end, -1, 'il job redcheck-fix non e\' stato trovato');
  return source.slice(start, end);
}

test('lo skip si decide sulla review reale sulla HEAD, non sugli step del run', () => {
  const block = preflightBlock();

  assert.match(
    block,
    /pulls\/\$PR\/reviews\?per_page=100" --paginate/,
    'il preflight deve leggere le review della PR per stabilire chi possiede il rosso',
  );
  assert.match(
    block,
    /select\(\.commit_id == env\.HEAD_SHA_FILTER/,
    'devono contare solo le review sulla HEAD corrente: una review su uno SHA superato e\' gia\' stata risolta da un push',
  );
  assert.ok(
    block.includes(REVIEWER_BOT_LOGIN_JQ),
    `il filtro sul reviewer deve essere ${REVIEWER_BOT_LOGIN_JQ} (REVIEWER_BOT_LOGIN_JQ), non un login riscritto a mano`,
  );
  assert.ok(
    block.includes(`grep -qP '${REDFLAG_IMPORTANT_RE.source.replaceAll('[^\\n', '[^')}'`),
    'il marker \u{1F534} Important deve essere la regex condivisa, non una variante locale',
  );
  assert.match(
    block,
    /if \[ "\$review_owned" = "true" \]; then\n\s*skip /,
    'un rosso di sola review con un \u{1F534} Important reale deve uscire dal preflight senza invocare Claude del fixer',
  );
});

test('la conclusion degli step continue-on-error non decide piu\' nulla', () => {
  // Solo il CODICE: i commenti nominano lo step della review proprio per dire
  // perche' la sua `conclusion` non e' una prova, e non devono far fallire il guard.
  const block = preflightBlock()
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

  assert.doesNotMatch(
    block,
    /actions\/runs\/\$RUN_ID\/jobs/,
    'la jobs API riporta `success` anche per uno step `continue-on-error` MORTO: non puo\' provare che una review esiste',
  );
  assert.doesNotMatch(
    block,
    /Run Claude review/,
    'nessuna deduzione dal nome/conclusion dello step della review',
  );
});

test('lo skip pretende che `tests` sia l\'unico check rosso della HEAD', () => {
  const block = preflightBlock();

  assert.match(
    block,
    /if \[ "\$rollup" = "\$CI_CHECK_NAME" \]; then/,
    'il verdetto della review non spiega un `generator-ci` o un `pr-collision-detector` rosso: senza questo gate lo skip abbandonerebbe quei rossi',
  );
  assert.match(
    source,
    /^\s*CI_CHECK_NAME: 'tests \(node --test\)'$/m,
    'il nome del check richiesto deve essere dichiarato nell\'env dello step (guard: ci-check-name.test.mjs)',
  );
});
