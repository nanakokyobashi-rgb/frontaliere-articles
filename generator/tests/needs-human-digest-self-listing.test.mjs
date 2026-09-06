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

/**
 * #920 — la chiusura deve mirare alla STESSA issue che la lista esclude.
 *
 * La lista esclude se stessa per UGUAGLIANZA (`select(.title != env.DEDUP_TITLE)`),
 * il resolve chiudeva per PREFISSO (60 char, `searchSafePrefix`). Una issue
 * aperta il cui titolo comincia per `DEDUP_TITLE` e prosegue non viene esclusa
 * dalla lista — quindi non impedisce nemmeno la condizione «liste vuote» — ma
 * al ramo vuoto verrebbe chiusa AL POSTO del digest, e chiudere la issue
 * sbagliata riesce: nessun errore, nessuna traccia. Apertura, esclusione e
 * chiusura devono usare una sola forma della chiave.
 */
test('a liste vuote il resolve chiude per uguaglianza, come la lista esclude', () => {
  const step = surfaceStep();
  const emptyBranch = /if \[ -z "\$PRS" \] && \[ -z "\$ISSUES" \]; then([\s\S]*?)\n\s+fi\n/.exec(step);
  assert.ok(emptyBranch, 'ramo "liste vuote" non trovato');
  assert.match(
    emptyBranch[1],
    /--exact-title/,
    'senza --exact-title il resolve chiude «la prima aperta che comincia per», non il digest',
  );
  // Il flag deve esistere davvero dall'altra parte: uno YAML non importa da un
  // modulo, e un flag sconosciuto verrebbe ignorato in silenzio (AGENTS.md #6).
  const creator = readFileSync(path.join(ROOT, 'scripts/lib/github-issue-creator.mjs'), 'utf8');
  assert.match(
    creator,
    /args\.includes\('--exact-title'\)/,
    'la CLI del creator non legge --exact-title: il flag sarebbe ignorato in silenzio',
  );
});

/**
 * #920 — un close respinto non puo' lasciare la run verde.
 *
 * `set -uo pipefail` (niente `-e`), `continue-on-error: true` e un `gh`
 * best-effort facevano sparire un close rifiutato (permessi, rate-limit, 5xx)
 * dietro una riga di log. Il digest restava aperto con un elenco falso fino al
 * prossimo giorno a liste vuote, che puo' non arrivare presto: e' la classe
 * «non si rompe, non fa».
 */
test('il fallimento del close emerge invece di essere assorbito', () => {
  const step = surfaceStep();
  const emptyBranch = /if \[ -z "\$PRS" \] && \[ -z "\$ISSUES" \]; then([\s\S]*?)\n\s+fi\n/.exec(step);
  assert.ok(emptyBranch, 'ramo "liste vuote" non trovato');
  assert.match(
    emptyBranch[1],
    /if node scripts\/lib\/github-issue-creator\.mjs/,
    'l esito del resolve va ispezionato: senza `if`, con `set -uo pipefail` e senza `-e`, sparisce',
  );
  assert.match(emptyBranch[1], /::error::/, 'un close respinto deve lasciare un annotazione');
  assert.match(emptyBranch[1], /\n\s+exit 1\n/, 'lo step deve uscire non-zero quando il close e respinto');

  // L'altra meta': la CLI deve davvero uscire non-zero, o l `if` qui sopra e
  // sempre vero e il ramo rosso e' morto.
  const creator = readFileSync(path.join(ROOT, 'scripts/lib/github-issue-creator.mjs'), 'utf8');
  assert.match(
    creator,
    /process\.exit\(res && res\.resolved === false \? 1 : 0\)/,
    'la CLI --resolve non distingue piu il close respinto dal no-op «niente da chiudere»',
  );
});

/**
 * #920 — il corpo del digest e' un ELENCO, non un evento.
 *
 * Sul dedup (issue gia' aperta) e sulla RIAPERTURA della gemella chiusa entro
 * la finestra, `createGithubIssue` posta un commento di ricorrenza e lascia il
 * corpo della prima occorrenza: il lettore trova nel corpo le liste di ieri e
 * quelle vere solo nell'ultimo commento. E' lo stesso «elenco falso» che il
 * chiuditore elimina sull'issue aperta, ricomparso un percorso piu' in la'.
 */
test('la creazione del digest riscrive il corpo, invece di lasciare l elenco vecchio', () => {
  const step = surfaceStep();
  assert.match(
    step,
    /--refresh-body/,
    'senza --refresh-body il digest riaperto mostra le liste pre-chiusura',
  );
  const creator = readFileSync(path.join(ROOT, 'scripts/lib/github-issue-creator.mjs'), 'utf8');
  assert.match(
    creator,
    /args\.includes\('--refresh-body'\)/,
    'la CLI del creator non legge --refresh-body: il flag sarebbe ignorato in silenzio',
  );
});

/**
 * Secondo residuo permanente, stessa forma del primo: il digest dello sweep
 * (`🧭 Decisioni del proprietario`) nasce in `needs-human-sweep.yml` con
 * `needs-human,automation,agent:no-age-out` e lo sweep ha il divieto esplicito di
 * togliergli quella label. Finche' veniva elencato qui, `ISSUES` non poteva
 * essere vuoto e la chiusura promessa nel corpo restava irraggiungibile — cioe'
 * l'assorbente di #733 con un'altra issue al posto di questa.
 */
test('la lista issue esclude i tracker permanenti', () => {
  const step = surfaceStep();
  const issueQuery = /ISSUES=\$\(gh issue list([\s\S]*?)--jq '([^']+)'\)/.exec(step);
  assert.ok(issueQuery, 'query `gh issue list` dello step non trovata');
  assert.match(
    issueQuery[1],
    /--json [\w,]*\blabels\b/,
    'senza `labels` nel --json il filtro sulla label non ha su cosa lavorare',
  );
  assert.match(
    issueQuery[2],
    /select\(\s*\[\s*\.labels\[\]\.name\s*\]\s*\|\s*index\(\s*env\.LBL_PERMANENT_TRACKER\s*\)\s*\|\s*not\s*\)/,
    'il jq deve escludere i tracker permanenti per LABEL, o la lista non si svuota mai',
  );
});

test('la label del tracker permanente ha la stessa sorgente degli script del ciclo', () => {
  // Uno YAML non puo' importare da un modulo: il legame fra il valore qui e
  // quello che followup-drainer/needs-human-prepass usano per riconoscere lo
  // stesso oggetto e' questo test (AGENTS.md #6). Se divergono, il digest
  // elenca un tracker che ogni altro stadio salta, e torna a non convergere.
  const step = surfaceStep();
  const assignment = /\n\s+LBL_PERMANENT_TRACKER:\s*'([^']+)'/.exec(step);
  assert.ok(assignment, 'lo step deve definire LBL_PERMANENT_TRACKER come env');
  assert.equal(
    [...step.matchAll(/\n\s+LBL_PERMANENT_TRACKER:\s/g)].length,
    1,
    'LBL_PERMANENT_TRACKER definita piu di una volta',
  );
  const label = assignment[1];

  const drainer = readFileSync(path.join(ROOT, 'scripts/ci/followup-drainer.mjs'), 'utf8');
  const declared = /const LBL_NO_AGE_OUT = '([^']+)';/.exec(drainer);
  assert.ok(declared, 'LBL_NO_AGE_OUT non trovata in followup-drainer.mjs');
  assert.equal(label, declared[1], 'la label dello YAML e quella del drainer sono divergenti');

  const prepass = readFileSync(path.join(ROOT, 'scripts/ci/needs-human-prepass.mjs'), 'utf8');
  assert.ok(
    prepass.includes(`'${label}'`),
    'needs-human-prepass.mjs non riconosce piu questa label come tracker permanente',
  );

  // E la sorgente che la APPLICA: senza questa, il filtro escluderebbe una
  // classe che nessuno popola piu.
  const sweep = readFileSync(path.join(ROOT, '.github/workflows/needs-human-sweep.yml'), 'utf8');
  assert.ok(
    sweep.includes(label),
    'needs-human-sweep.yml non crea piu il digest con la label di tracker permanente',
  );
});
