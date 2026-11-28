/**
 * loop-labels.test.mjs — le label del ciclo devono essere creabili, e devono
 * coprire tutto ciò che il ciclo applica.
 *
 * ## Perché
 *
 * Il corpus è nato con le sole label di default di GitHub. `gh issue edit
 * --add-label` NON crea la label che manca: fallisce. Nei punti in cui quel
 * fallimento restava un warning non bloccante il ciclo girava inerte —
 * instradando nulla, senza un errore da nessuna parte. Oggi la riconciliazione
 * è fail-closed: se non riesce, i workflow si fermano prima di classificare o
 * avviare un fixer (i test `ensureLoopLabels` e il contratto dei workflow sotto).
 *
 * Due modi di sbagliare, entrambi già capitati:
 *
 * 1. **Una label usata dal codice ma assente dalla lista.** Il primo test
 *    estrae le label dai sorgenti e verifica che siano tutte dichiarate.
 * 2. **Una descrizione troppo lunga.** GitHub rifiuta oltre i 100 caratteri
 *    con un errore generico che non lo dice. È già costato la mancata
 *    creazione di `agent:in-progress` — l'unica che serve davvero al mutex —
 *    mentre le altre dodici passavano: un fallimento parziale visibile solo
 *    leggendo il conteggio finale.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureLoopLabels, LABELS, LIST_LIMIT, MAX_DESCRIPTION } from '../../scripts/ci/ensure-loop-labels.mjs';
import { classifyIssue } from '../../scripts/lib/classify-issue.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function labelFixture(overrides = {}) {
  return LABELS.map(([name, color, description], index) => ({
    name,
    color: overrides.wrongColorAt === index ? 'ffffff' : color,
    description,
  })).filter((_, index) => index !== overrides.missingAt);
}

function ensureHarness({ labels = labelFixture(), failCommand, listResponse, createError, getResponse } = {}) {
  const calls = [];
  const messages = [];
  const runGh = (args) => {
    calls.push(args);
    if (args[1] === 'list') {
      if (failCommand === 'list') throw Object.assign(new Error('do not print this'), { status: 403 });
      return listResponse ?? JSON.stringify(labels);
    }
    if (args[0] === 'api') {
      if (getResponse === undefined) throw Object.assign(new Error('do not print this'), { status: 404 });
      return getResponse;
    }
    if (args[1] === 'create' && createError) throw createError;
    if (failCommand === args[1]) throw Object.assign(new Error('do not print this'), { status: 403 });
    return '';
  };
  const logger = {
    log: (message) => messages.push(message),
    error: (message) => messages.push(message),
    warn: (message) => messages.push(message),
  };
  return { calls, messages, runGh, logger };
}

test('nessuna descrizione supera il limite di GitHub', () => {
  const tooLong = LABELS.filter(([, , d]) => (d || '').length > MAX_DESCRIPTION).map(
    ([n, , d]) => `${n} (${d.length} caratteri)`,
  );
  assert.deepEqual(
    tooLong,
    [],
    `GitHub rifiuta le descrizioni oltre ${MAX_DESCRIPTION} caratteri con un errore generico. ` +
      `Queste non verrebbero create:\n  ${tooLong.join('\n  ')}`,
  );
});

test('ogni label applicata dal ciclo è dichiarata in ensure-loop-labels', () => {
  const declared = new Set(LABELS.map(([n]) => n.toLowerCase()));
  // `crawler-transient` e le `priority:*` le crea da sé github-issue-creator
  // (ensureLabelsExist), quindi non devono essere per forza qui.
  const selfCreated = new Set(['crawler-transient']);

  const sources = [];
  for (const dir of ['scripts/ci', 'scripts/lib', '.github/workflows']) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) {
      if (/\.(mjs|yml)$/.test(f)) sources.push(path.join(abs, f));
    }
  }

  // Solo le label applicate DAVVERO — `--add-label X` / `--remove-label X` —
  // non ogni menzione in un commento, che produrrebbe falsi positivi.
  const APPLY_RE = /--(?:add-label|remove-label)[= ]+["']?([A-Za-z][\w:-]*)["']?/g;
  // Punto cieco scoperto portando l'hardening di pr-autorebase dal sito: una
  // label passata come VARIABILE in una chiamata gh ad array
  // (`'--add-label', REOPEN_FAILED_LABEL`) non viene vista dalla regex sopra,
  // perche' dopo il flag c'e' una virgola, non il nome. Si raccolgono quindi
  // anche le costanti `*_LABEL = '<literal>'`: e' la forma con cui questi nomi
  // vengono dichiarati, e senza di esse il guard tace proprio sui casi che
  // scattano di rado — cioe' quelli in cui una label mancante fa piu' danno.
  const CONST_RE = /\b\w*LABELS?\b\s*=\s*["']([A-Za-z][\w:-]*)["']/g;
  // `gh issue create --label X` applica una label quanto `--add-label`. Va
  // distinto da `gh issue list --label X`, che filtra e basta: si guarda la
  // riga, perche' e' li' che la sottocomando compare.
  const CREATE_LABEL_RE = /--label[= ]+["']?([A-Za-z][\w:-]*)["']?/g;
  const LIST_CONTEXT_RE = /(?:issue|pr)["']?\s*,?\s*["']?list|(?:issue|pr) list/;
  // `run-bounded-command.mjs` usa `--label` per il nome del comando nei log,
  // non per una label GitHub. Il suo uso non e' un'azione del ciclo da
  // dichiarare in `ensure-loop-labels.mjs`.
  const NON_ISSUE_LABEL_SOURCES = new Set(['scripts/lib/run-bounded-command.mjs']);

  // ── Il punto cieco che e' costato l'intera Fase 0 ────────────────────────
  // Le label che un PROMPT istruisce l'agente ad applicare non hanno forma di
  // flag. `post-merge-followup.yml` dice, in prosa dentro il prompt:
  //     Label: `follow-up` + UNO funnel-* se inferibile.
  // Nessuna regex sui flag di `gh` puo' vederlo — e infatti `follow-up`
  // compariva nei sorgenti SOLO dentro un esempio `gh issue list --label
  // follow-up`, cioe' in un contesto di filtro, mentre la label che il triage
  // applica davvero viveva in quella riga di prosa. Risultato misurato: il
  // workflow ha girato per giorni batchando correttamente le PR e non ha mai
  // mintato una issue, perche' la label non esisteva sul repo; 0 issue
  // `follow-up` sul corpus contro 100+ sul sito, e tutto il deferred work
  // delle PR mergiate evaporato senza un errore da nessuna parte.
  //
  // E' la stessa forma di `SiteShellContract`: un contratto che non ha forma
  // di import non e' coperto dai guard che seguono gli import. Qui si legge
  // la convenzione con cui questi prompt dichiarano le label — una riga
  // `Label: ...` — e se ne estraggono i token, backtickati o no.
  const PROMPT_LABEL_LINE_RE = /^.*\bLabels?:\s*(.+)$/gim;
  const PROMPT_TOKEN_RE = /`([A-Za-z][\w:-]*\*?)`|\b([a-z][\w:-]*-\*)/g;

  const used = new Set();
  for (const f of sources) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(APPLY_RE)) used.add(m[1].toLowerCase());
    for (const m of src.matchAll(CONST_RE)) used.add(m[1].toLowerCase());
    if (!NON_ISSUE_LABEL_SOURCES.has(path.relative(ROOT, f))) {
      for (const line of src.split('\n')) {
        if (LIST_CONTEXT_RE.test(line)) continue;
        for (const m of line.matchAll(CREATE_LABEL_RE)) used.add(m[1].toLowerCase());
      }
    }
    for (const lineMatch of src.matchAll(PROMPT_LABEL_LINE_RE)) {
      for (const m of lineMatch[1].matchAll(PROMPT_TOKEN_RE)) {
        // `funnel-*` e simili sono famiglie: si normalizzano al prefisso, che
        // il controllo di famiglia sotto verifica come tale.
        used.add((m[1] || m[2]).toLowerCase().replace(/\*$/, ''));
      }
    }
  }

  // Alcune label si compongono a runtime (`--add-label "fu-prio:$prio"`): la
  // regex cattura il PREFISSO. Non vanno scartate — è proprio lì che un valore
  // non dichiarato passerebbe inosservato — ma verificate come famiglia: deve
  // esistere almeno una label dichiarata con quel prefisso.
  const undeclared = [...used]
    .filter((l) => {
      if (declared.has(l) || selfCreated.has(l)) return false;
      if (/[:-]$/.test(l)) return ![...declared].some((d) => d.startsWith(l));
      return true;
    })
    .sort();
  assert.deepEqual(
    undeclared,
    [],
    `Queste label vengono applicate dal ciclo ma non sono dichiarate in ensure-loop-labels.mjs. ` +
      `Se mancano sul repo, gh fallisce e il routing resta inerte SENZA errore:\n  ${undeclared.join('\n  ')}`,
  );
});

test('ogni fu-prio che il classificatore puo\' emettere ha la sua label', () => {
  // Il controllo di famiglia del test precedente si accontenta di UN membro
  // del prefisso: togliendo `fu-prio:high` dalla lista non se ne accorgeva,
  // perche' `fu-prio:low` bastava a soddisfarlo. Qui i valori possibili non si
  // indovinano — si prendono dalla loro sorgente, il classificatore.
  //
  // Se manca la label del valore emesso, il triage accoda con una label
  // inesistente: gh fallisce, il workflow logga un warning e va avanti, e la
  // issue resta in coda senza priorita' — cioe' non viene mai drenata.
  const declared = new Set(LABELS.map(([n]) => n.toLowerCase()));
  const emitted = new Set();
  const probes = [
    ['Workflow Failure: Generate Blog Article', ['Bug']],
    ['Workflow Failure: engine lockstep drift', ['Bug']],
    ['Workflow Failure: qualcosa', ['Bug', 'priority:high']],
    ['follow-up(#12): resto', []],
    ['Loop drift: il ciclo autonomo diverge dal sito', []],
  ];
  for (const [title, labels] of probes) {
    const { fuPrio } = classifyIssue(title, labels);
    if (fuPrio) emitted.add(`fu-prio:${fuPrio}`.toLowerCase());
  }

  assert.ok(emitted.size >= 2, `atteso almeno high e low fra i valori emessi, visti: ${[...emitted]}`);
  const missing = [...emitted].filter((l) => !declared.has(l)).sort();
  assert.deepEqual(
    missing,
    [],
    `Il classificatore puo' emettere queste label di priorita', ma ensure-loop-labels non le crea. ` +
      `La issue verrebbe accodata senza priorita' e non drenata mai:\n  ${missing.join('\n  ')}`,
  );
});

test('la riconciliazione fallisce se non può leggere le label o il repo non è configurato', () => {
  const noRepo = ensureHarness();
  assert.equal(ensureLoopLabels({ repo: '', runGh: noRepo.runGh, logger: noRepo.logger }), 1);
  assert.equal(noRepo.calls.length, 0);

  const readFailure = ensureHarness({ failCommand: 'list' });
  assert.equal(ensureLoopLabels({ repo: 'owner/repo', runGh: readFailure.runGh, logger: readFailure.logger }), 1);
  assert.equal(readFailure.calls.length, 1);
  assert.ok(readFailure.messages.every((message) => !message.includes('do not print this')));
});

test('la riconciliazione non modifica label se la risposta di GitHub non è una lista valida', () => {
  const fixture = ensureHarness({ listResponse: '{}' });
  assert.equal(ensureLoopLabels({ repo: 'owner/repo', runGh: fixture.runGh, logger: fixture.logger }), 1);
  assert.equal(fixture.calls.length, 1);
});

test('il fallimento nel creare una label rende non-zero il risultato dopo il tentativo bounded', () => {
  const fixture = ensureHarness({ labels: labelFixture({ missingAt: 0 }), failCommand: 'create' });
  assert.equal(ensureLoopLabels({ repo: 'owner/repo', runGh: fixture.runGh, logger: fixture.logger }), 1);
  assert.equal(fixture.calls.filter((args) => args[1] === 'create').length, 1);
  assert.ok(fixture.messages.some((message) => message.includes('status_403')));
  assert.ok(fixture.messages.every((message) => !message.includes('do not print this')));
});

const alreadyExistsError = () =>
  Object.assign(new Error('do not print this'), {
    status: 1,
    stderr: 'HTTP 422: Validation Failed (already_exists)',
  });

test('create che trova la label gia creata da un run concorrente e successo dopo la rilettura per nome', () => {
  const fixture = ensureHarness({
    labels: labelFixture({ missingAt: 0 }),
    createError: alreadyExistsError(),
    getResponse: JSON.stringify({ name: LABELS[0][0] }),
  });
  assert.equal(ensureLoopLabels({ repo: 'owner/repo', runGh: fixture.runGh, logger: fixture.logger }), 0);
  const reread = fixture.calls.filter((args) => args[0] === 'api');
  assert.equal(reread.length, 1);
  assert.deepEqual(reread[0].slice(0, 3), ['api', '-X', 'GET']);
  assert.ok(reread[0][3].startsWith('repos/owner/repo/labels/'));
  assert.ok(fixture.messages.some((message) => message.includes('concorrente')));
});

test('already_exists senza conferma dalla rilettura resta un fallimento', () => {
  const fixture = ensureHarness({ labels: labelFixture({ missingAt: 0 }), createError: alreadyExistsError() });
  assert.equal(ensureLoopLabels({ repo: 'owner/repo', runGh: fixture.runGh, logger: fixture.logger }), 1);
  assert.ok(fixture.messages.every((message) => !message.includes('do not print this')));
});

test('un errore di create diverso da already_exists non viene riletto e resta fail-closed', () => {
  const fixture = ensureHarness({
    labels: labelFixture({ missingAt: 0 }),
    createError: Object.assign(new Error('x'), { status: 1, stderr: 'HTTP 403: forbidden' }),
    getResponse: JSON.stringify({ name: LABELS[0][0] }),
  });
  assert.equal(ensureLoopLabels({ repo: 'owner/repo', runGh: fixture.runGh, logger: fixture.logger }), 1);
  assert.equal(fixture.calls.filter((args) => args[0] === 'api').length, 0);
});

test('il listing usa il tetto esteso e un elenco che lo raggiunge fallisce invece di indovinare', () => {
  const ok = ensureHarness();
  ensureLoopLabels({ repo: 'owner/repo', runGh: ok.runGh, logger: ok.logger });
  const idx = ok.calls[0].indexOf('--limit');
  assert.equal(ok.calls[0][idx + 1], String(LIST_LIMIT));

  const filler = Array.from({ length: LIST_LIMIT }, (_, i) => ({ name: `x-${i}`, color: 'ffffff', description: '' }));
  const full = ensureHarness({ labels: filler });
  assert.equal(ensureLoopLabels({ repo: 'owner/repo', runGh: full.runGh, logger: full.logger }), 1);
  assert.equal(full.calls.length, 1);
});

test('il fallimento nel riallineare una label rende non-zero il risultato', () => {
  const fixture = ensureHarness({ labels: labelFixture({ wrongColorAt: 0 }), failCommand: 'edit' });
  assert.equal(ensureLoopLabels({ repo: 'owner/repo', runGh: fixture.runGh, logger: fixture.logger }), 1);
  assert.equal(fixture.calls.filter((args) => args[1] === 'edit').length, 1);
  assert.equal(fixture.calls.filter((args) => args[1] === 'create').length, 0);
});

test('la riconciliazione completa è idempotente quando tutte le label sono allineate', () => {
  const fixture = ensureHarness();
  assert.equal(ensureLoopLabels({ repo: 'owner/repo', runGh: fixture.runGh, logger: fixture.logger }), 0);
  assert.equal(fixture.calls.length, 1);
  assert.ok(fixture.messages.some((message) => message.includes('tutte le')));
});

test('ogni step "Ensure loop labels exist" dei workflow è fail-closed', () => {
  const files = [
    '.github/workflows/generation-health-watchdog.yml',
    '.github/workflows/issue-decompose.yml',
    '.github/workflows/issue-fix.yml',
    '.github/workflows/issue-triage.yml',
  ];
  for (const file of files) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    let steps = 0;
    lines.forEach((line, i) => {
      if (!/^\s*- name: Ensure loop labels exist/.test(line)) return;
      steps++;
      // Il blocco dello step arriva fino al successivo `- name:`.
      let end = i + 1;
      while (end < lines.length && !/^\s*- name:/.test(lines[end])) end++;
      const block = lines.slice(i, end).join('\n');
      assert.match(block, /node scripts\/ci\/ensure-loop-labels\.mjs/, `${file}: step senza lo script`);
      assert.doesNotMatch(block, /continue-on-error|\|\|\s*(true|echo)/, `${file}: lo step non deve essere non bloccante`);
    });
    assert.ok(steps >= 1, `${file}: manca lo step di riconciliazione delle label`);
  }
});
