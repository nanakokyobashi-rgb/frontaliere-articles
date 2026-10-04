#!/usr/bin/env node
/**
 * bonifica-report.mjs — legge il report di `retranslate-blocking-bodies.mjs
 * --out` e lo traduce in cio' che serve a `bonifica-blocking-bodies.yml`:
 *
 *   stats    righe `chiave=valore` per `$GITHUB_OUTPUT` (coppie trattate,
 *            scritte, `all_empty`, scritture false-friend);
 *   summary  lo step summary: prima riga d'allarme se la run e' stata a vuoto,
 *            poi i conteggi, lo stock per codice prima → dopo, il campione;
 *   pr-body  il body della PR di contenuto, nel contratto del corpus
 *            (`## Implementato` / `## Non implementato (ancora)`).
 *
 * Funzioni pure esportate, CLI sottile: il workflow non decide niente in un
 * `node -e` che nessun test vede.
 *
 * Uso:
 *   node generator/scripts/bonifica-report.mjs stats --report r.json
 *   node generator/scripts/bonifica-report.mjs summary --report r.json \
 *     --before b.json --after a.json --sample s.md --mode apply --out summary.md
 *   node generator/scripts/bonifica-report.mjs pr-body --report r.json \
 *     --before b.json --after a.json --run-url <url> --out body.md
 *
 * Un file assente (`--report` di una run fermata dal cancello, `--after` di
 * una run morta prima) non e' un errore per `summary`: il riepilogo lo dice.
 * Per `stats` e `pr-body` il report e' obbligatorio.
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const FALSE_FRIEND_CODE = 'translation-false-friend';

/** Issue del sito che tracciano lo stock di ciascun codice. */
export const SITE_ISSUE_BY_CODE = {
  'translation-false-friend': 7683,
  'leaked-prompt-scaffolding': 7682,
};

const SITE_REPO = 'valerielinc-ops/frontaliere-si-o-no';

/** Elenchi del body oltre questo numero si riassumono: il body ha un tetto. */
export const MAX_BODY_ITEMS = 150;

/** Chiave stabile di una coppia, la stessa del `--list-out` dello strumento. */
export const pairKey = (r) => `${r.dir}/${r.locale}/${r.id}`;

const reasonOf = (r) => String(r?.reason || '');

/**
 * Conteggi del report. `allEmpty` e' la run a vuoto: almeno una coppia
 * trattata e TUTTE scartate perche' la cascata ha restituito campi vuoti.
 */
export function summarizeReport(report) {
  const results = Array.isArray(report?.results) ? report.results : [];
  const count = (pred) => results.filter(pred).length;
  const treated = results.length;
  const written = count((r) => r.written === true);
  const clean = count((r) => reasonOf(r) === 'pulita');
  const refailed = count((r) => reasonOf(r).startsWith('ri-fallita'));
  const empty = count((r) => reasonOf(r) === 'campo-vuoto-dalla-cascata');
  const truncated = count((r) => reasonOf(r).startsWith('troncata'));
  const wrongLang = count((r) => reasonOf(r).startsWith('lingua-sbagliata'));
  const falseFriendWritten = count(
    (r) => r.written === true && Array.isArray(r.oldCodes) && r.oldCodes.includes(FALSE_FRIEND_CODE),
  );
  return {
    mode: report?.mode === 'apply' ? 'apply' : 'dry-run',
    total: Number.isFinite(report?.total) ? report.total : treated,
    treated,
    written,
    clean,
    refailed,
    empty,
    truncated,
    wrongLang,
    other: treated - clean - refailed - empty - truncated - wrongLang,
    falseFriendWritten,
    allEmpty: treated > 0 && empty === treated,
  };
}

/** Righe per `$GITHUB_OUTPUT`. */
export function statsLines(report) {
  const s = summarizeReport(report);
  return [
    `treated=${s.treated}`,
    `written=${s.written}`,
    `all_empty=${s.allEmpty ? 'true' : 'false'}`,
    `false_friend_written=${s.falseFriendWritten}`,
  ];
}

/** `{ codice: total }` da un `--count-only`, o `null` se manca. */
export function totalsByCode(counts) {
  if (!counts || typeof counts !== 'object' || !counts.byCode) return null;
  return Object.fromEntries(Object.entries(counts.byCode).map(([code, v]) => [code, Number(v?.total) || 0]));
}

function stockTable(before, after) {
  const b = totalsByCode(before);
  const a = totalsByCode(after);
  if (!b && !a) return ['Stock non misurato: nessun `--count-only` disponibile.'];
  const codes = [...new Set([...Object.keys(b || {}), ...Object.keys(a || {})])].sort();
  if (!codes.length) return ['Stock vuoto: nessuna coppia bloccante nei locali misurati.'];
  const cell = (m, code) => (m ? String(m[code] ?? 0) : 'n/d');
  return ['| codice | prima | dopo |', '|---|---|---|', ...codes.map((c) => `| ${c} | ${cell(b, c)} | ${cell(a, c)} |`)];
}

/**
 * Lo step summary. La prima riga e' l'allarme quando serve: una run in cui
 * ogni coppia e' `campo-vuoto-dalla-cascata` e' informativa, non un successo.
 */
export function renderSummary({ report = null, before = null, after = null, sample = '', params = {} } = {}) {
  const out = [];
  const s = report ? summarizeReport(report) : null;
  if (s?.allEmpty) {
    out.push(
      `> **Run informativa, non un successo:** tutte le ${s.treated} coppie trattate sono \`campo-vuoto-dalla-cascata\` ` +
        '(tier MT fuori servizio o senza quota). Nessuna pagina e\' cambiata.',
      '',
    );
  }
  out.push(`## Bonifica blocking bodies — ${s ? s.mode : 'senza report'}`, '');
  const shown = Object.entries(params).filter(([, v]) => v !== undefined && v !== null);
  if (shown.length) {
    out.push(shown.map(([k, v]) => `\`${k}\`=\`${String(v) || '(vuoto)'}\``).join(' · '), '');
  }
  if (s) {
    out.push(
      '| coppie trattate | scritte | ri-fallita | campo-vuoto-dalla-cascata | troncate | lingua sbagliata | altro |',
      '|---|---|---|---|---|---|---|',
      `| ${s.treated}/${s.total} | ${s.written} | ${s.refailed} | ${s.empty} | ${s.truncated} | ${s.wrongLang} | ${s.other} |`,
      '',
    );
  } else {
    out.push('Report della ri-traduzione assente: la run si e\' fermata prima (cancello del campione o errore, vedi il log).', '');
  }
  out.push('### Stock per codice (prima → dopo)', '', ...stockTable(before, after), '');
  if (sample) out.push(String(sample).trimEnd(), '');
  return `${out.join('\n')}\n`;
}

const REASON_GLOSS = [
  ['campo-vuoto-dalla-cascata', 'la cascata MT ha restituito un campo vuoto (tier fuori servizio o quota esaurita)'],
  ['ri-fallita', 'la ri-traduzione ripete il difetto e la guardia la rifiuta'],
  ['troncata', 'la cascata ha accorciato il body (tier che tronca la sorgente)'],
  ['lingua-sbagliata', 'la cascata ha restituito un campo nella lingua sbagliata'],
  ['sorgente-mancante', 'manca il body italiano di riferimento'],
  ['italiano-illeggibile', 'il body italiano di riferimento non si legge'],
  ['chiave-assente', 'una chiave del body non si trova nel file di destinazione'],
];

function glossOf(reason) {
  const hit = REASON_GLOSS.find(([prefix]) => reason.startsWith(prefix));
  return hit ? `${hit[1]} (\`${reason}\`)` : `\`${reason || 'motivo non riportato'}\``;
}

function codesOf(list) {
  return Array.isArray(list) && list.length ? list.join(', ') : 'nessuno';
}

function capped(items, overflowLine) {
  if (items.length <= MAX_BODY_ITEMS) return items;
  return [...items.slice(0, MAX_BODY_ITEMS), overflowLine(items.length - MAX_BODY_ITEMS)];
}

/**
 * Il body della PR di contenuto. Le coppie scritte vanno in `Implementato`
 * coi codici prima → dopo; le altre in `Non implementato (ancora)`, ciascuna
 * con il suo stato. `Addresses`, mai una parola di chiusura: lo stock resta
 * aperto finche' non e' zero.
 */
export function buildPrBody({ report, before = null, after = null, runUrl = '' } = {}) {
  const results = Array.isArray(report?.results) ? report.results : [];
  const s = summarizeReport(report);
  const written = results.filter((r) => r.written === true);
  const notWritten = results.filter((r) => r.written !== true);
  const runRef = runUrl ? `run ${runUrl}` : 'run del workflow';

  const done = capped(
    written.map((r) => `- \`${pairKey(r)}\`: codici ${codesOf(r.oldCodes)} → ${codesOf(r.newCodes)}.`),
    (n) => `- Altre ${n} coppie scritte con lo stesso esito: elenco completo nel report della ${runRef}.`,
  );
  const open = capped(
    notWritten.map((r) =>
      reasonOf(r) === 'vecchia-gia-pulita'
        ? `- \`${pairKey(r)}\` *(by construction)* **Motivo:** la guardia accetta gia' il body pubblicato. **Prossimo passo:** nessuno.`
        : `- \`${pairKey(r)}\` (${codesOf(r.oldCodes)}) — blocked: ${glossOf(reasonOf(r))}.`,
    ),
    (n) => `- Altre ${n} coppie non scritte — blocked: stessi motivi della cascata MT, elenco nel report della ${runRef}.`,
  );

  const lines = [
    '## Implementato',
    '',
    `- Bonifica di ${s.written} body bloccanti su ${s.treated} coppie trattate, ri-tradotti dalla cascata MT di produzione e scritti solo con zero \`critical\` (${runRef}).`,
    ...done,
    '',
    '## Non implementato (ancora)',
    '',
    ...(open.length
      ? open
      : ['- Nessuno. *(by construction)* **Motivo:** ogni coppia trattata in questo lotto e\' stata scritta. **Prossimo passo:** nessuno.']),
    '',
    '### Stock per codice (prima → dopo)',
    '',
    ...stockTable(before, after),
    '',
  ];
  const codes = [...new Set(written.flatMap((r) => (Array.isArray(r.oldCodes) ? r.oldCodes : [])))].sort();
  const refs = codes.filter((c) => SITE_ISSUE_BY_CODE[c]).map((c) => `Addresses ${SITE_REPO}#${SITE_ISSUE_BY_CODE[c]}`);
  if (refs.length) lines.push(...refs, '');
  return `${lines.join('\n')}`;
}

function readJson(path, { required = false } = {}) {
  if (!path || !existsSync(path)) {
    if (required) throw new Error(`file richiesto assente: ${path || '(non indicato)'}`);
    return null;
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

function cliValue(argv, name) {
  const exact = `--${name}`;
  const i = argv.indexOf(exact);
  if (i !== -1) {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`${exact} richiede un valore`);
    return next;
  }
  const inline = argv.find((a) => a.startsWith(`${exact}=`));
  return inline === undefined ? null : inline.slice(exact.length + 1);
}

export function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const v = (name) => cliValue(rest, name);
  if (command === 'stats') {
    console.log(statsLines(readJson(v('report'), { required: true })).join('\n'));
    return 0;
  }
  if (command === 'summary') {
    const samplePath = v('sample');
    const text = renderSummary({
      report: readJson(v('report')),
      before: readJson(v('before')),
      after: readJson(v('after')),
      sample: samplePath && existsSync(samplePath) ? readFileSync(samplePath, 'utf8') : '',
      params: {
        code: process.env.CODE,
        locale: process.env.LOCALE,
        limit: process.env.LIMIT,
        apply: process.env.APPLY,
        slugs: process.env.SLUGS,
      },
    });
    if (v('out')) writeFileSync(v('out'), text);
    else process.stdout.write(text);
    return 0;
  }
  if (command === 'pr-body') {
    const out = v('out');
    if (!out) throw new Error('--out richiesto per pr-body');
    writeFileSync(
      out,
      buildPrBody({
        report: readJson(v('report'), { required: true }),
        before: readJson(v('before')),
        after: readJson(v('after')),
        runUrl: v('run-url') || '',
      }),
    );
    return 0;
  }
  console.error('❌ uso: bonifica-report.mjs stats|summary|pr-body [opzioni] — vedi il docblock.');
  return 2;
}

const invokedDirectly = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] || '');
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(2);
  }
}
