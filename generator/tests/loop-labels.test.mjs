/**
 * loop-labels.test.mjs — le label del ciclo devono essere creabili, e devono
 * coprire tutto ciò che il ciclo applica.
 *
 * ## Perché
 *
 * Il corpus è nato con le sole label di default di GitHub. `gh issue edit
 * --add-label` NON crea la label che manca: fallisce. E nei workflow quel
 * fallimento è un warning non bloccante, quindi il ciclo sarebbe girato
 * inerte — instradando nulla, senza un errore da nessuna parte.
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
import { LABELS, MAX_DESCRIPTION } from '../../scripts/ci/ensure-loop-labels.mjs';
import { classifyIssue } from '../../scripts/lib/classify-issue.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

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
    for (const line of src.split('\n')) {
      if (LIST_CONTEXT_RE.test(line)) continue;
      for (const m of line.matchAll(CREATE_LABEL_RE)) used.add(m[1].toLowerCase());
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
