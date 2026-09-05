/**
 * needs-human-digest-self-listing.test.mjs — un report che si auto-elenca non
 * converge mai.
 *
 * Lo step "Surface needs-human PRs and issues" di `recycle-stale-prs.yml`
 * scrive nel proprio corpo la condizione di chiusura «Chiudila quando entrambe
 * le liste sono vuote». Nasceva assumendo che l'issue dedup non potesse
 * comparire nella propria lista, perche' creata con `automation` e non con
 * `needs-human`. L'assunzione e' caduta il 2026-09-02T13:39:50Z, quando il
 * followup-drainer ha aggiunto `needs-human` alla issue #733: il commento di
 * recurrence del 2026-09-03 elenca #733 fra i propri 17 item, e da li' la
 * lista issue non puo' piu' essere vuota. Nessun processo la chiude, e la
 * label la tiene fuori da ogni coda automatica: assorbente.
 *
 * La correzione e' un filtro sulla CHIAVE DI DEDUP (il titolo), non sulla
 * label — la label puo' essere aggiunta da chiunque, il titolo no: e' quello
 * che `github-issue-creator.mjs` usa per ritrovare la stessa issue.
 * Il titolo ha quindi UNA sorgente (AGENTS.md #6), `DEDUP_TITLE`, letta sia
 * dal filtro sia da `--title`; questo test e' il legame fra i due usi.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = path.join(ROOT, '.github/workflows/recycle-stale-prs.yml');
const text = readFileSync(WORKFLOW, 'utf8');

/** Il blocco dello step che pubblica il digest needs-human. */
function surfaceStep() {
  const start = text.indexOf('- name: Surface needs-human PRs and issues');
  assert.notEqual(start, -1, 'step "Surface needs-human PRs and issues" non trovato');
  const rest = text.slice(start + 1);
  const next = rest.indexOf('\n      - name: ');
  return next === -1 ? rest : rest.slice(0, next);
}

test('il titolo di dedup ha una sola sorgente nello step', () => {
  const step = surfaceStep();
  const assignment = /\n\s+DEDUP_TITLE:\s*'([^']+)'/.exec(step);
  assert.ok(assignment, 'lo step deve definire DEDUP_TITLE una volta sola, come env');
  assert.equal(
    [...step.matchAll(/\n\s+DEDUP_TITLE:\s/g)].length,
    1,
    'DEDUP_TITLE definita piu di una volta: due sorgenti divergono in silenzio',
  );

  const title = assignment[1];
  assert.match(title, /^needs-human: /, 'il titolo resta la chiave di dedup storica');
  // Rinominarlo orfanerebbe l'issue dedup gia' aperta, che nessuno chiuderebbe piu'.
  assert.equal(title, 'needs-human: PR bloccate in attesa di revisione umana');

  // Il titolo letterale non deve ricomparire altrove nello step: chi lo usa
  // legge la variabile.
  const literals = [...step.matchAll(new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))];
  assert.equal(literals.length, 1, 'il titolo letterale compare fuori da DEDUP_TITLE');
  assert.match(step, /--title "\$DEDUP_TITLE"/, 'github-issue-creator deve ricevere $DEDUP_TITLE');
});

test('la lista issue esclude l issue dedup stessa', () => {
  const step = surfaceStep();
  const issueQuery = /ISSUES=\$\(gh issue list[\s\S]*?--jq '([^']+)'\)/.exec(step);
  assert.ok(issueQuery, 'query `gh issue list` dello step non trovata');
  assert.match(
    issueQuery[1],
    /select\(\s*\.title\s*!=\s*env\.DEDUP_TITLE\s*\)/,
    'il jq della lista issue deve escludere l issue dedup per titolo, o il report si auto-elenca',
  );
});

test('la condizione di chiusura promessa nel corpo resta raggiungibile', () => {
  const step = surfaceStep();
  // Il corpo promette la chiusura a liste vuote; lo step non deve creare ne
  // aggiornare l'issue quando entrambe sono vuote.
  assert.match(step, /si richiude da sola al primo run in cui entrambe le liste sono vuote/);
  const emptyBranch = /if \[ -z "\$PRS" \] && \[ -z "\$ISSUES" \]; then([\s\S]*?)\n\s+fi\n/.exec(step);
  assert.ok(emptyBranch, 'ramo "liste vuote" non trovato: la promessa del corpo non e mantenuta');
  assert.match(emptyBranch[1], /\n\s+exit 0/, 'a liste vuote lo step non deve ricreare il digest');
});

test('a liste vuote lo step richiude l issue dedup, non si limita a uscire', () => {
  // Raggiungere la condizione di chiusura non basta: nessun altro processo
  // chiude questo titolo — close-recovered-failure-issues.mjs copre le
  // famiglie `Workflow Failure:` / `Crawler Failure:`. Senza questa chiamata
  // l'issue dedup resta aperta con un elenco falso, che e' il difetto di #733
  // un passo piu' in la'.
  const step = surfaceStep();
  const emptyBranch = /if \[ -z "\$PRS" \] && \[ -z "\$ISSUES" \]; then([\s\S]*?)\n\s+fi\n/.exec(step);
  assert.ok(emptyBranch, 'ramo "liste vuote" non trovato');
  assert.match(
    emptyBranch[1],
    /node scripts\/lib\/github-issue-creator\.mjs[\s\S]*?--resolve/,
    'a liste vuote lo step deve richiudere l issue dedup con --resolve',
  );
  // Stessa chiave di dedup dell'apertura (AGENTS.md #6): apertura e chiusura
  // devono cercare la stessa issue, o si chiude qualcos'altro o niente.
  assert.match(
    emptyBranch[1],
    /--title "\$DEDUP_TITLE"/,
    'il resolve deve usare la stessa DEDUP_TITLE con cui l issue viene creata',
  );
});
