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
  const issueQuery = /ISSUES=\$\(gh api --paginate[\s\S]*?--jq '([^']+)'\)/.exec(step);
  assert.ok(issueQuery, 'query della lista issue dello step non trovata');
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

/**
 * Terzo modo di rendere irraggiungibile — o peggio, FALSA — la condizione di
 * chiusura: la query che la calcola fallisce. Lo step gira sotto
 * `set -uo pipefail` senza `set -e`, quindi un `gh` non-zero (jq su una forma
 * inattesa, rate-limit, token scaduto) lascia la variabile vuota e
 * indistinguibile da «nessun residuo»; con entrambe le query rotte dalla
 * stessa causa, il ramo di chiusura richiude il digest mentre il backlog
 * needs-human e' pieno, senza fallire e sotto `continue-on-error: true`.
 * I gemelli con `--resolve` (reconcile-article-shards.yml,
 * republish-dirty-content.yml) subordinano gia' la chiusura a
 * `steps.detect.outcome == 'success'`; qui produttore e consumatore stanno
 * nello stesso step, quindi l'equivalente e' catturare l'exit status.
 */
test('l esito delle due query e catturato, non solo il loro output', () => {
  const step = surfaceStep();
  assert.doesNotMatch(
    step,
    /\n\s+set -e[a-z]*uo pipefail/,
    'se lo step passasse a `set -e` questo test andrebbe ripensato, non cancellato',
  );
  assert.match(
    step,
    /PRS=\$\(gh api --paginate[\s\S]*?\n\s+PRS_RC=\$\?/,
    'l exit status della query PR va catturato subito dopo l assegnazione',
  );
  assert.match(
    step,
    /ISSUES=\$\(gh api --paginate[\s\S]*?\n\s+ISSUES_RC=\$\?/,
    'l exit status della query issue va catturato subito dopo l assegnazione',
  );
});

test('una query fallita non arriva mai al ramo di chiusura', () => {
  const step = surfaceStep();
  const guard = /if \[ "\$PRS_RC" -ne 0 \] \|\| \[ "\$ISSUES_RC" -ne 0 \]; then([\s\S]*?)\n\s+fi\n/.exec(step);
  assert.ok(guard, 'manca il guard sull esito delle query');
  assert.match(guard[1], /\n\s+exit 1/, 'una query fallita deve far fallire lo step, non passare oltre');
  assert.doesNotMatch(
    guard[1],
    /--resolve/,
    'il ramo di errore non deve chiudere niente: lo stato del backlog e sconosciuto, non vuoto',
  );
  // E deve stare PRIMA del ramo «liste vuote», o non lo protegge.
  const guardAt = step.indexOf('"$PRS_RC" -ne 0');
  const emptyAt = step.indexOf('if [ -z "$PRS" ] && [ -z "$ISSUES" ]; then');
  assert.notEqual(emptyAt, -1, 'ramo "liste vuote" non trovato');
  assert.ok(guardAt !== -1 && guardAt < emptyAt, 'il guard deve precedere il ramo di chiusura');
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
 * Secondo residuo permanente, stessa forma del primo: il digest dello sweep
 * (`🧭 Decisioni del proprietario — digest`) nasce in `needs-human-sweep.yml` ed
 * esiste per restare aperto. Finche' veniva elencato qui, `ISSUES` non poteva
 * essere vuoto e la chiusura promessa nel corpo restava irraggiungibile — cioe'
 * l'assorbente di #733 con un'altra issue al posto di questa.
 *
 * La discriminante e' il TITOLO, non la label `agent:no-age-out` (#981 item
 * 2/3). La label sbagliava nei due versi: sul digest la applica un prompt
 * Claude, quindi un run che lo ricrea senza label riporta l'assorbente in
 * silenzio; e su qualunque altra issue significa «non scade», non «non e' un
 * item umano», quindi nascondeva dall'unico canale umano una issue davvero
 * bloccata e lasciava per giunta auto-chiudere il digest mentre quel blocco era
 * vivo. Non e' nemmeno una partizione della classe: il ledger transient (#25) e'
 * un tracker e la label non ce l'ha.
 */
test('la lista issue esclude i tracker permanenti per titolo, non per label', () => {
  const step = surfaceStep();
  const issueQuery = /ISSUES=\$\(gh api --paginate([\s\S]*?)--jq '([^']+)'\)/.exec(step);
  assert.ok(issueQuery, 'query della lista issue dello step non trovata');
  assert.match(
    step,
    /NEEDS_HUMAN_API="repos\/\$GH_REPO\/issues\?[^"]*labels=needs-human/,
    'la lista viene dall endpoint `issues`, che filtra per label e restituisce `title`: senza, il filtro non ha su cosa lavorare',
  );
  assert.match(
    issueQuery[2],
    /index\(\s*\$i\.title\s*\)\s*\|\s*not/,
    'il jq deve escludere i tracker permanenti confrontando il TITOLO con PERMANENT_TRACKER_TITLES',
  );
  assert.match(
    issueQuery[2],
    /env\.PERMANENT_TRACKER_TITLES\s*\|\s*split\("\\n"\)/,
    'i titoli vengono da PERMANENT_TRACKER_TITLES, una riga per tracker',
  );
  // Il difetto riparato: escludere per label toglieva dall unico canale umano
  // anche le issue davvero bloccate a cui qualcuno ha messo `agent:no-age-out`.
  assert.doesNotMatch(
    issueQuery[2],
    /\.labels\[\]\.name/,
    'il filtro non deve tornare a guardare le label: `agent:no-age-out` vuol dire «non scade», non «non e un item umano»',
  );
  assert.doesNotMatch(step, /LBL_PERMANENT_TRACKER/, 'la env della vecchia esclusione per label non deve sopravvivere al fix');
});

/** I titoli esclusi. Uno per riga, nessuna riga vuota di mezzo. */
function permanentTrackerTitles(step) {
  const block = /\n\s+PERMANENT_TRACKER_TITLES: \|\n([\s\S]*?)\n\s+run: \|/.exec(step);
  assert.ok(block, 'lo step deve definire PERMANENT_TRACKER_TITLES come env a blocco');
  return block[1].split('\n').map((l) => l.trim()).filter(Boolean);
}

test('ogni titolo escluso ha la sua sorgente reale, e ce n e una sola', () => {
  // Uno YAML non puo' importare da un modulo ne' da un altro YAML: il legame
  // fra i titoli elencati qui e i processi che CREANO quegli oggetti e' questo
  // test (AGENTS.md #6). Se divergono, il tracker torna nella lista e il digest
  // non converge piu' — in silenzio, che e' il modo in cui #733 e' successa.
  const step = surfaceStep();
  assert.equal(
    [...step.matchAll(/\n\s+PERMANENT_TRACKER_TITLES:\s/g)].length,
    1,
    'PERMANENT_TRACKER_TITLES definita piu di una volta: due liste divergono in silenzio',
  );
  const titles = permanentTrackerTitles(step);

  const sweep = readFileSync(path.join(ROOT, '.github/workflows/needs-human-sweep.yml'), 'utf8');
  const sweepTitle = /\n\s+DIGEST_TITLE:\s*'([^']+)'/.exec(sweep);
  assert.ok(sweepTitle, 'needs-human-sweep.yml deve definire DIGEST_TITLE come env: e la sorgente del titolo del digest');
  assert.ok(
    titles.includes(sweepTitle[1]),
    `il digest dello sweep («${sweepTitle[1]}») non e fra i titoli esclusi: tornerebbe a impedire la chiusura`,
  );

  const creator = readFileSync(path.join(ROOT, 'scripts/lib/github-issue-creator.mjs'), 'utf8');
  const ledger = /const TRANSIENT_LEDGER_TITLE = '([^']+)';/.exec(creator);
  assert.ok(ledger, 'TRANSIENT_LEDGER_TITLE non trovata in github-issue-creator.mjs');
  assert.ok(
    titles.includes(ledger[1]),
    'il ledger transient e un tracker permanente e NON porta `agent:no-age-out`: va escluso per titolo',
  );
});

test('il titolo del digest ha una sola sorgente anche in needs-human-sweep.yml', () => {
  // Tre usi (prompt, step "Classify outcome", e il filtro dell altro workflow)
  // su un titolo che e' anche la chiave di ricerca dell oggetto: un letterale
  // ripetuto qui basterebbe a farli divergere senza che nulla fallisca.
  const sweep = readFileSync(path.join(ROOT, '.github/workflows/needs-human-sweep.yml'), 'utf8');
  const declared = /\n\s+DIGEST_TITLE:\s*'([^']+)'/.exec(sweep);
  assert.ok(declared, 'needs-human-sweep.yml deve definire DIGEST_TITLE');
  assert.equal(
    [...sweep.matchAll(/\n\s+DIGEST_TITLE:\s/g)].length,
    1,
    'DIGEST_TITLE definita piu di una volta in needs-human-sweep.yml',
  );
  const title = declared[1];
  const literals = [...sweep.matchAll(new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))];
  assert.equal(literals.length, 1, 'il titolo del digest compare fuori da DIGEST_TITLE: chi lo usa deve leggere la env');
  assert.match(sweep, /titolo ESATTO `\$\{\{ env\.DIGEST_TITLE \}\}`/, 'il prompt deve interpolare DIGEST_TITLE');
  assert.match(sweep, /--match title "\$DIGEST_TITLE"/, 'lo step "Classify outcome" deve cercare il digest con DIGEST_TITLE');
});

/**
 * Quarto modo di far dire il falso al digest, e il piu' silenzioso di tutti:
 * la lista e' TRONCATA. `gh pr list` / `gh issue list` non hanno `--paginate`
 * e il loro `--limit` taglia senza dirlo — la lista PR qui non ne aveva
 * nemmeno uno (default 30), quella issue si fermava a 200 con i filtri
 * applicati DOPO il taglio. Sopra il cap la lista pubblicata e `ISSUE_COUNT`
 * sotto-riportano restando verdi: l'unico canale che gli umani leggono
 * direbbe «30 PR» con 90 aperte. E' la stessa bugia del ramo di chiusura su
 * una query fallita, spostata dal ramo che chiude a quello che pubblica.
 */
test('nessuna delle due liste del digest puo essere troncata in silenzio', () => {
  const step = surfaceStep();
  assert.doesNotMatch(
    step,
    /\$\(gh (?:pr|issue) list/,
    'i sottocomandi `list` troncano al `--limit`: il digest deve leggere da `gh api --paginate`',
  );
  const paginated = [...step.matchAll(/\$\(gh api --paginate "\$NEEDS_HUMAN_API"/g)];
  assert.equal(paginated.length, 2, 'entrambe le liste (PR e issue) devono venire da `gh api --paginate`');
  // Una sola sorgente per l'endpoint (AGENTS.md #6): due URL divergerebbero, e
  // le due liste finirebbero per descrivere backlog diversi.
  assert.equal(
    [...step.matchAll(/\n\s+NEEDS_HUMAN_API=/g)].length,
    1,
    'NEEDS_HUMAN_API definita piu di una volta: due perimetri divergono in silenzio',
  );
  assert.match(step, /NEEDS_HUMAN_API="[^"]*per_page=100/, 'senza `per_page` la paginazione costa il triplo delle chiamate');
  // Le PR arrivano dallo stesso endpoint `issues` (l'unico che filtra per
  // label): `.pull_request` e' la discriminante fra i due tipi, e senza le due
  // liste conterrebbero gli stessi oggetti.
  assert.match(
    step,
    /--jq '\.\[\] \| select\(\.pull_request\) \|/,
    'la lista PR deve selezionare gli oggetti con `.pull_request`',
  );
  assert.match(
    step,
    /--jq '\.\[\] \| select\(\.pull_request \| not\) \|/,
    'la lista issue deve escludere gli oggetti con `.pull_request`, o elenca anche le PR',
  );
  // I campi dell'API REST sono snake_case: `updatedAt` (forma `gh ... list`)
  // renderebbe ogni riga «ultimo update null» senza fallire.
  assert.doesNotMatch(step, /\\\(\.updatedAt\)/, 'l API REST espone `updated_at`, non `updatedAt`');
  assert.match(step, /ultimo update \\\(\.updated_at\)/, 'ogni riga deve riportare `updated_at`');
});

/**
 * Stesso taglio, stesso file, un passo prima: lo scan che RICICLA le PR
 * `stale-review`. `gh pr list` ordina per creazione DISCENDENTE, quindi un
 * `--limit` taglia via le PR piu' VECCHIE — per costruzione le uniche che lo
 * scan puo' riciclare (gate 1: aperte da piu' di MAX_AGE_HOURS). Sopra il cap
 * resterebbe verde lasciando ferme per sempre proprio quelle. E' la stessa
 * classe del digest, e la stessa gia' imparata da transport-identical-twins,
 * auto-merge-enroll-sweep e stale-pr-rescuer.
 */
test('nemmeno lo scan stale-review legge una lista troncata', () => {
  assert.doesNotMatch(
    text,
    /\$\(gh (?:pr|issue) list/,
    'in recycle-stale-prs.yml nessuna lista che alimenta una decisione deve venire da un `list` con `--limit`',
  );
  assert.match(
    text,
    /prs=\$\(gh api --paginate "repos\/\$REPO\/issues\?[^"]*labels=stale-review[^"]*per_page=100"/,
    'lo scan stale-review deve leggere da `gh api --paginate`',
  );
  // Il rimappaggio deve restituire la forma che i gate sotto leggono: i campi
  // REST sono snake_case, e `.createdAt` diventerebbe null — con `date -d ""`
  // che fallisce e il fallback `$NOW` che rende OGNI PR «non abbastanza
  // vecchia», cioe' uno scan che non ricicla piu' niente, in silenzio.
  assert.match(
    text,
    /createdAt: \.created_at/,
    'il rimappaggio deve riportare `created_at` su `.createdAt`, che e il campo letto dal gate 1',
  );
  assert.match(text, /labels: \[\.labels\[\] \| \{name\}\]/, 'i gate leggono `.labels[].name`: la forma va preservata');
});
