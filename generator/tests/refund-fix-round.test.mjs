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
  formatRefundAttemptComment,
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

test('pickRoundCommentId ordina per timestamp, non per ordine della pagina API', () => {
  const comments = [
    { id: 100, created_at: '2026-09-08T12:00:00Z', body: '<!-- REDCHECK_FIX_ROUND: 1 --> newest' },
    { id: 99, created_at: '2026-09-08T11:00:00Z', body: '<!-- REDCHECK_FIX_ROUND: 1 --> older' },
  ];
  assert.equal(pickRoundCommentId(comments, 'REDCHECK_FIX_ROUND', 1), 100);
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

test('il commento provvisorio conserva il beacon della quota prima della DELETE', () => {
  const body = formatRefundAttemptComment({
    round: 1,
    workflow: 'pr-redflag-fixer',
    resetsAt: 1788624000,
    rateLimitType: 'five_hour',
    runUrl: 'https://example.invalid/run/1',
    marker: 'REDFLAG_FIX_ROUND',
  });
  assert.match(body, /<!-- QUOTA_RESETS_AT: 1788624000 -->/);
  assert.match(body, /five_hour/);
  assert.match(body, /DELETE verificata/);
});

test('#984: execution_file vuoto usa solo il log verificabile della run', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/ci/refund-fix-round.mjs'), 'utf-8');
  assert.match(src, /function executionRaw\(\)/);
  assert.match(src, /GITHUB_RUN_ID/);
  assert.match(src, /'run', 'view'.*'--log-failed'/s);
  assert.match(src, /Nessun execution file né log verificabile/);
  assert.match(src, /shouldRefundRateLimitedRound\(raw\)/);
});

test('il rimborso posta l`handle PRIMA di cancellare il marker', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/ci/refund-fix-round.mjs'), 'utf-8');
  const post = src.indexOf("ghStatus(['pr', 'comment'");
  const del = src.indexOf("ghStatus(['api', '-X', 'DELETE'");
  assert.ok(post > 0 && del > 0, 'post del commento e DELETE del marker devono esistere entrambi');
  // `gh()` inghiotte i fallimenti: se la DELETE riesce e il post no, il round e`
  // rimborsato e l'handle non esiste — marker sparito, classe B disarmata, PR
  // ferma col budget intero. L'ordine inverso fallisce verso lo stato ante-PR.
  assert.ok(post < del,
    'DELETE del marker prima del commento di rimborso: sul fallimento del post la PR resta senza handle');
  assert.match(src, /formatRefundAttemptComment/);
  assert.match(src, /api', '--paginate', '--slurp/,
    'la ricerca del marker deve considerare tutte le pagine dei commenti');
  assert.match(src, /DELETE del marker fallita/);
  assert.match(src, /marker resta contato/);
  assert.doesNotMatch(formatRefundAttemptComment({
    round: 1, workflow: 'pr-fixer', resetsAt: null, rateLimitType: null, runUrl: '', marker: 'REDCHECK_FIX_ROUND',
  }), /marker rimosso|rimborsato|REDCHECK_FIX_REFUNDED|QUOTA_RESETS_AT/);
});

for (const { file, marker } of FIXERS) {
  test(`${path.basename(file)}: quota telemetry, Codex primario e rimborso cablato su ${marker}`, () => {
    const yaml = fs.readFileSync(path.join(ROOT, file), 'utf-8');

    // La quota Claude è osservabilità, non un gate: il Codex primario deve
    // poter partire anche quando il beacon segnala un 429.
    assert.doesNotMatch(yaml, new RegExp(`steps\\.quota\\.outputs\\.codex_fallback`),
      `${file}: il vecchio skip quota non deve più impedire il tentativo Codex`);
    assert.match(yaml, /Pre-flight — Claude quota telemetry \(Codex primary\)/,
      `${file}: il pre-flight deve essere esplicitamente telemetria`);

    // Il conteggio dei round e il rimborso devono parlare dello STESSO marker.
    assert.ok(yaml.includes(`${marker}: [0-9]+`),
      `${file} non conta piu` + '`' + `${marker}` + '`' + ': il rimborso resterebbe orfano');
    assert.ok(new RegExp(`MARKER: ${marker}\\b`).test(yaml),
      `${file} non passa MARKER=${marker} a refund-fix-round.mjs`);
    assert.ok(yaml.includes('node scripts/ci/refund-fix-round.mjs'),
      `${file} non invoca il rimborso: un 429 tornerebbe a consumare un round`);
    assert.match(yaml, /QUOTA_BEACON_PEER_REPO: valerielinc-ops\/frontaliere-si-o-no/,
      `${file} legge un beacon locale ma resta cieco al 429 del peer che condivide l'account`);
    assert.ok(/ROUND: \$\{\{ steps\.guard\.outputs\.round \}\}/.test(yaml),
      `${file} deve rimborsare il round che il guard ha appena postato`);

    // Il marker viene prima della telemetry: il round è già riservato, poi il
    // beacon osserva la quota e infine l'action tenta Codex.
    const quotaAt = yaml.indexOf('check-quota-backoff.mjs');
    const markerAt = yaml.indexOf(`<!-- ${marker}: %s -->`);
    const actionAt = yaml.indexOf('- name: Run Claude');
    assert.notEqual(quotaAt, -1, `${file} non consulta il beacon di quota prima del round`);
    assert.notEqual(markerAt, -1, `${file} non posta piu' il marker di round`);
    assert.notEqual(actionAt, -1, `${file} non invoca l'action Codex/Claude`);
    assert.ok(markerAt < quotaAt && quotaAt < actionAt,
      `${file}: marker → telemetry → action devono restare in quest'ordine`);
    const quotaStep = yaml.slice(yaml.lastIndexOf('- name:', quotaAt), actionAt);
    assert.match(quotaStep, /continue-on-error: true/,
      `${file}: un guasto del beacon non deve sopprimere l'action`);
    const actionStep = yaml.slice(actionAt, yaml.indexOf('\n      - name:', actionAt + 1));
    assert.doesNotMatch(actionStep, /steps\.quota\.outputs\./,
      `${file}: la condizione dell'action non deve dipendere dalla quota Claude`);
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
  assert.ok(yaml.includes("*'<!-- REDCHECK_FIX_REFUNDED:'*"),
    'stale-pr-rescuer.yml non guarda l`handle del fixer REDCHECK');
});
