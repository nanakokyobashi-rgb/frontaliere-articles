/**
 * refund-fix-round.test.mjs — l'osservatore del rimborso del round su 429.
 *
 * I fixer di PR contano i round con un marker nascosto postato PRIMA di
 * invocare Claude, e al cap mettono `needs-human` sulla PR — che su questo repo
 * e' un filtro di ESCLUSIONE da ogni coda automatica, cioe' uno stato
 * assorbente (#733). Su un 429 Claude non parte nemmeno (0 turni, $0): il round
 * non e' stato usato, e caricarlo comunque significa poter buttare fuori dal
 * ciclo una PR mai guardata.
 *
 * Qui si fissano le due meta' del fix: la funzione che sceglie il commento da
 * cancellare (deve prendere QUEL round e nessun altro) e il cablaggio nei due
 * workflow gemelli — il nome del marker vive sia nella bash del guard sia
 * nell'env dello step di rimborso, e non possono importarsi (AGENTS.md #6).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  formatRefundComment,
  pickRoundCommentId,
  refundMarkerName,
  roundMarkerRe,
} from '../../scripts/ci/refund-fix-round.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const FIXERS = [
  { file: '.github/workflows/pr-redcheck-fixer.yml', marker: 'REDCHECK_FIX_ROUND' },
  { file: '.github/workflows/pr-redflag-fixer.yml', marker: 'REDFLAG_FIX_ROUND' },
];

test('pickRoundCommentId prende il marker del round richiesto', () => {
  const comments = [
    { id: 1, body: '<!-- REDCHECK_FIX_ROUND: 1 -->\nround 1' },
    { id: 2, body: 'una review qualunque' },
    { id: 3, body: '<!-- REDCHECK_FIX_ROUND: 2 -->\nround 2' },
  ];
  assert.equal(pickRoundCommentId(comments, 'REDCHECK_FIX_ROUND', 2), 3);
  assert.equal(pickRoundCommentId(comments, 'REDCHECK_FIX_ROUND', 1), 1);
});

test('pickRoundCommentId non confonde i round del gemello', () => {
  const comments = [{ id: 9, body: '<!-- REDFLAG_FIX_ROUND: 1 -->' }];
  assert.equal(pickRoundCommentId(comments, 'REDCHECK_FIX_ROUND', 1), null);
});

test('pickRoundCommentId: nessun marker, input degeneri → null (mai una delete alla cieca)', () => {
  assert.equal(pickRoundCommentId([{ id: 1, body: 'niente' }], 'REDCHECK_FIX_ROUND', 1), null);
  assert.equal(pickRoundCommentId([], 'REDCHECK_FIX_ROUND', 1), null);
  assert.equal(pickRoundCommentId(null, 'REDCHECK_FIX_ROUND', 1), null);
  assert.equal(pickRoundCommentId([{ id: 1, body: '<!-- X: 1 -->' }], '', 1), null);
  assert.equal(pickRoundCommentId([{ id: 1, body: '<!-- X: 1 -->' }], 'X', 0), null);
});

test('roundMarkerRe non fa match su un round con lo stesso prefisso di cifre', () => {
  const re = roundMarkerRe('REDCHECK_FIX_ROUND', 1);
  assert.equal(re.test('<!-- REDCHECK_FIX_ROUND: 1 -->'), true);
  assert.equal(re.test('<!-- REDCHECK_FIX_ROUND: 12 -->'), false);
});

test('il commento di rimborso non ri-arma il contatore ne` finge un verdetto di issue', () => {
  const body = formatRefundComment({
    round: 2,
    workflow: 'pr-redcheck-fixer',
    resetsAt: 1788624000,
    rateLimitType: 'five_hour',
    runUrl: 'https://example.invalid/run/1',
  });
  for (const { marker } of FIXERS) {
    assert.ok(!new RegExp(`<!--\\s*${marker}`).test(body),
      `il commento di rimborso non deve contenere il marker ${marker}: verrebbe ri-contato come round`);
  }
  assert.ok(!/FIX_OUTCOME/.test(body), 'FIX_OUTCOME e` telemetria delle issue: su una PR confonde il drainer');
  assert.match(body, /<!-- QUOTA_RESETS_AT: 1788624000 -->/);
  assert.match(body, /five_hour/);
});

// ── L'handle di re-trigger ───────────────────────────────────────────────────
// Cancellare il marker di round rimborsa il round MA disarma anche la classe B
// di `stale-pr-rescuer.yml`, che decide il rerun di `tests` sulla PRESENZA di
// `<!-- REDFLAG_FIX_ROUND:` — l'unico evento che rifa ripartire il fixer senza
// un commit umano. Senza un handle sostitutivo il rimborso lascia la PR ferma
// col budget intero: il round non speso non serve a niente se nessuno lo spende.

test('refundMarkerName: handle derivato dal marker di round, mai il marker stesso', () => {
  assert.equal(refundMarkerName('REDFLAG_FIX_ROUND'), 'REDFLAG_FIX_REFUNDED');
  assert.equal(refundMarkerName('REDCHECK_FIX_ROUND'), 'REDCHECK_FIX_REFUNDED');
});

test('il commento di rimborso porta l`handle di re-trigger, invisibile al contatore', () => {
  for (const { marker } of FIXERS) {
    const body = formatRefundComment({
      round: 1, workflow: 'pr-fixer', resetsAt: null, rateLimitType: null, runUrl: '', marker,
    });
    assert.match(body, new RegExp(`<!-- ${refundMarkerName(marker)}: 1 -->`),
      `senza handle il rimborso disarma il rerun della classe B di stale-pr-rescuer.yml`);
    // Il grep dei fixer: `grep -oE '<MARKER>: [0-9]+'`. L'handle non deve matcharlo.
    assert.ok(!new RegExp(`${marker}: [0-9]+`).test(body),
      `l'handle ri-armerebbe il contatore dei round: il rimborso si annullerebbe da solo`);
  }
});

test('senza resetsAt il beacon viene omesso, non scritto vuoto', () => {
  const body = formatRefundComment({
    round: 1, workflow: 'pr-redflag-fixer', resetsAt: null, rateLimitType: null, runUrl: '',
  });
  assert.ok(!/QUOTA_RESETS_AT/.test(body));
});

for (const { file, marker } of FIXERS) {
  test(`${path.basename(file)}: guard con pre-flight di quota e rimborso cablato su ${marker}`, () => {
    const yaml = fs.readFileSync(path.join(ROOT, file), 'utf-8');

    // Anche lo skip pre-flight deve lasciare l'handle di re-trigger: li' il
    // marker di round non viene MAI postato, quindi la classe B non avrebbe
    // nessun segnale e la PR resterebbe ferma senza aver consumato niente.
    assert.ok(yaml.includes(`<!-- ${refundMarkerName(marker)}: 0 -->`),
      `${file}: lo skip per quota non lascia \`${refundMarkerName(marker)}\` → nessun re-trigger`);

    // Il conteggio dei round e il rimborso devono parlare dello STESSO marker.
    assert.ok(yaml.includes(`${marker}: [0-9]+`),
      `${file} non conta piu` + '`' + `${marker}` + '`' + ': il rimborso resterebbe orfano');
    assert.ok(new RegExp(`MARKER: ${marker}\\b`).test(yaml),
      `${file} non passa MARKER=${marker} a refund-fix-round.mjs`);
    assert.ok(yaml.includes('node scripts/ci/refund-fix-round.mjs'),
      `${file} non invoca il rimborso: un 429 tornerebbe a consumare un round`);
    assert.ok(/ROUND: \$\{\{ steps\.guard\.outputs\.round \}\}/.test(yaml),
      `${file} deve rimborsare il round che il guard ha appena postato`);

    // Il pre-flight deve stare PRIMA del marker, o il round e` gia` speso.
    const quotaAt = yaml.indexOf('check-quota-backoff.mjs');
    const markerAt = yaml.indexOf(`<!-- ${marker}: %s -->`);
    assert.notEqual(quotaAt, -1, `${file} non consulta il beacon di quota prima del round`);
    assert.notEqual(markerAt, -1, `${file} non posta piu' il marker di round`);
    assert.ok(quotaAt < markerAt,
      `${file}: il gate di quota deve precedere la scrittura del marker di round`);
  });
}

// Il nome dell'handle vive in tre posti che non possono importarsi (AGENTS.md
// #6): `refundMarkerName()`, la bash dello skip nei due fixer, e il `case` del
// rescuer. Qui si chiude il triangolo sul lato che tiene in piedi il ciclo: se
// il rescuer smette di riconoscere l'handle, il rimborso torna a essere uno
// stallo silenzioso.
test('stale-pr-rescuer: la classe B riconosce anche l`handle di rimborso', () => {
  const yaml = fs.readFileSync(path.join(ROOT, '.github/workflows/stale-pr-rescuer.yml'), 'utf-8');
  assert.ok(yaml.includes(`<!-- ${refundMarkerName('REDFLAG_FIX_ROUND')}:`),
    'stale-pr-rescuer.yml non guarda l`handle di rimborso: dopo un 429 la PR resta ferma ' +
    'per sempre, perche` refund-fix-round.mjs cancella proprio il marker che il rescuer legge');
  assert.ok(yaml.includes("*'<!-- REDFLAG_FIX_ROUND:'*"),
    'stale-pr-rescuer.yml non guarda piu` il marker di round della classe B');
});
