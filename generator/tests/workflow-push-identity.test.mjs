/**
 * workflow-push-identity.test.mjs — un job che pusha con un'identita' scelta
 * dallo script non lascia persistite le credenziali del checkout.
 *
 * ## Il difetto che sorveglia
 *
 * Dalla v6 `actions/checkout` non scrive piu' il proprio token in
 * `.git/config`: lo mette in un file sotto `$RUNNER_TEMP`, incluso con
 * `includeIf.gitdir`. Li' un `git config --unset-all
 * http.https://github.com/.extraheader` non lo trova, e da li' copre sia
 * l'header generico passato con `-c http.extraheader=…` sia l'userinfo di un
 * `git remote set-url`. Il push parte come `github-actions[bot]`.
 *
 * E' gia' costato due volte. Il 30 settembre 2026 nessun gruppo crawler
 * pubblicava (push cross-repo, 403). Fra il 7 e l'8 ottobre 2026 il passo
 * «Publish governed blog cover bytes before Pages deploy» di `publish-api.yml`
 * e' fallito 16 volte: la regola di `main` respingeva il bot (GH013), il deploy
 * dell'API non partiva e le copertine di quel push non arrivavano sulla CDN.
 * Quel passo aveva l'`--unset-all`, e un test verificava che la riga ci fosse.
 *
 * ## Cosa conta come difesa
 *
 *   - `persist-credentials: false` su ogni checkout del job;
 *   - un `token:` proprio sul checkout: allora l'identita' persistita e' gia'
 *     quella voluta;
 *   - la rimozione delle voci `includeIf` che puntano al file
 *     `git-credentials-<uuid>.config`, come fanno i fixer;
 *   - l'azzeramento nel comando stesso: `git -c
 *     http.https://github.com/.extraheader= push …`. Un valore vuoto svuota
 *     l'elenco degli header letti fin li', file inclusi compresi.
 *
 * L'`--unset-all` da solo non conta. Un push fatto da un clone a parte non
 * entra nel conto: le credenziali del checkout valgono solo nel repository del
 * workspace, e quel push non passa da una riga `git … push` del job con
 * l'identita' costruita accanto.
 *
 * Solo testo dei workflow: nessun parser YAML, come gli altri test di forma.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const WORKFLOWS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.github/workflows');

/** I job di un workflow, divisi per indentazione. */
function jobsOf(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (start === -1) return [];
  const jobs = [];
  let current = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line) && line.trim() !== '') break;
    const header = /^ {2}([A-Za-z0-9_-]+):\s*(?:#.*)?$/.exec(line);
    if (header) {
      current = { id: header[1], lines: [] };
      jobs.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return jobs;
}

/** I checkout di un job con gli input che li seguono. */
function checkoutsOf(job) {
  const out = [];
  job.lines.forEach((line, index) => {
    if (!/^\s*(?:-\s+)?uses:\s*actions\/checkout@\S+/.test(line)) return;
    const indent = line.search(/\S/);
    const block = [];
    for (let j = index + 1; j < job.lines.length; j += 1) {
      const next = job.lines[j];
      if (next.trim() === '') continue;
      const nextIndent = next.search(/\S/);
      if (nextIndent < indent || (/^\s*-\s/.test(next) && nextIndent <= indent)) break;
      block.push(next);
    }
    const inputs = block.join('\n');
    out.push({
      persistFalse: /^\s*persist-credentials:\s*false\b/m.test(inputs),
      ownToken: /^\s*token:\s*\S/m.test(inputs),
    });
  });
  return out;
}

/** Un `git … push` eseguito davvero: non un commento, non prosa dentro una stringa. */
function isRealPush(line) {
  if (/^\s*#/.test(line)) return false;
  const match = /(?:^|[\s;&|(!])git\b[^\n|;&]*\bpush\b/.exec(line);
  if (!match) return false;
  const before = line.slice(0, match.index + 1);
  const openQuotes = (before.match(/(?<!\\)"/g) || []).length;
  return openQuotes % 2 === 0;
}

/** Il push azzera da se' gli header persistiti: e' difeso qualunque cosa faccia il checkout. */
function resetsPersistedHeader(line) {
  return /-c\s+["']?http\.https:\/\/github\.com\/\.extraheader=["']?(?:\s|$)/.test(line);
}

/** Il job costruisce da se' l'identita' con cui va in rete. */
const OWN_IDENTITY_RE = /x-access-token:|AUTHORIZATION: basic/i;

function pushIdentityOf(job) {
  const body = job.lines.join('\n');
  const checkouts = checkoutsOf(job);
  const pushLines = job.lines.filter(isRealPush);
  const pushes = pushLines.length;
  const undefendedPushes = pushLines.filter((line) => !resetsPersistedHeader(line)).length;
  const ownIdentity = OWN_IDENTITY_RE.test(body);
  const persisted = checkouts.filter((checkout) => !checkout.persistFalse && !checkout.ownToken).length;
  const dropsIncludeIf = /includeIf/.test(body) && /git-credentials-/.test(body) && /--unset-all/.test(body);
  return {
    job: job.id,
    checkouts: checkouts.length,
    pushes,
    ownIdentity,
    persisted,
    dropsIncludeIf,
    undefendedPushes,
    exposed: undefendedPushes > 0 && ownIdentity && persisted > 0 && !dropsIncludeIf,
  };
}

function census(dir = WORKFLOWS) {
  const rows = [];
  for (const name of fs.readdirSync(dir).filter((file) => /\.ya?ml$/.test(file)).sort()) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    for (const job of jobsOf(text)) rows.push({ workflow: name, ...pushIdentityOf(job) });
  }
  return rows;
}

const jobFrom = (yaml) => pushIdentityOf(jobsOf(yaml)[0]);

const PUSH_WITH_PAT = [
  '          auth="$(printf \'x-access-token:%s\' "$GITHUB_PAT_NANAKO" | base64 | tr -d \'\\n\')"',
  '          git -c "http.extraheader=AUTHORIZATION: basic $auth" push origin HEAD:main',
];
const workflowWith = ({ checkoutInputs = [], before = [], push = PUSH_WITH_PAT }) => [
  'jobs:',
  '  publish:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@v7',
  '        with:',
  '          fetch-depth: 0',
  ...checkoutInputs.map((line) => `          ${line}`),
  '      - name: Push',
  '        run: |',
  ...before,
  ...push,
].join('\n');

test('il censimento legge davvero i workflow e trova i job che pushano con un\'identita\' propria', () => {
  const rows = census();
  const workflows = new Set(rows.map((row) => row.workflow));
  assert.ok(workflows.size >= 40, `solo ${workflows.size} workflow letti`);
  const pushers = rows.filter((row) => row.pushes > 0 && row.ownIdentity);
  assert.ok(pushers.length >= 5, `solo ${pushers.length} job con un push a identita' propria: il lettore non li sta vedendo`);
  // I tre fixer difendono il push togliendo le voci includeIf: il censimento
  // deve riconoscere quella forma, altrimenti li segnalerebbe a torto.
  for (const workflow of ['issue-fix.yml', 'pr-redcheck-fixer.yml', 'pr-redflag-fixer.yml']) {
    const guarded = rows.filter((row) => row.workflow === workflow && row.dropsIncludeIf);
    assert.ok(guarded.length > 0, `${workflow}: la rimozione delle voci includeIf non e' piu' riconosciuta`);
  }
});

test('nessun job pusha con un\'identita\' propria lasciando persistite le credenziali del checkout', () => {
  const exposed = census()
    .filter((row) => row.exposed)
    .map((row) => `${row.workflow}#${row.job}`);
  assert.deepEqual(
    exposed,
    [],
    'Con actions/checkout v6+ il token persistito copre l\'header o l\'URL scelti dallo script: il push parte come '
      + 'github-actions[bot]. Metti `persist-credentials: false` sui checkout del job, oppure togli le voci includeIf '
      + 'che puntano a git-credentials-<uuid>.config prima del push.',
  );
});

test('publish-api: il job che pusha la coda delle copertine non persiste il token del checkout', () => {
  const [publish] = census().filter((row) => row.workflow === 'publish-api.yml' && row.job === 'publish');
  assert.ok(publish, 'job publish di publish-api.yml non trovato');
  assert.ok(publish.pushes > 0 && publish.ownIdentity, 'il push della coda con il PAT non e\' piu\' riconosciuto');
  assert.equal(publish.persisted, 0);
});

test('la forma del 7 ottobre, checkout persistito e solo --unset-all, e\' segnalata', () => {
  const row = jobFrom(workflowWith({
    before: [
      '          git config --local --unset-all http.https://github.com/.extraheader || true',
      '          git config --local --unset-all http.extraheader || true',
    ],
  }));
  assert.equal(row.exposed, true);
});

test('le difese valide non sono segnalate', () => {
  assert.equal(jobFrom(workflowWith({
    push: [
      '          git -c http.https://github.com/.extraheader= push "https://x-access-token:${OWNER_PAT}@github.com/${GITHUB_REPOSITORY}.git" HEAD:main',
    ],
  })).exposed, false);
  assert.equal(jobFrom(workflowWith({ checkoutInputs: ['persist-credentials: false'] })).exposed, false);
  assert.equal(jobFrom(workflowWith({ checkoutInputs: ['token: ${{ secrets.OWNER_PAT }}'] })).exposed, false);
  assert.equal(jobFrom(workflowWith({
    before: [
      '          while read -r inc_key inc_path; do',
      '            if [[ "$inc_path" =~ (^|/)git-credentials-[0-9A-Fa-f-]+\\.config$ ]]; then',
      '              git config --local --fixed-value --unset-all "$inc_key" "$inc_path"',
      '            fi',
      '          done < <(git config --local --get-regexp \'^includeIf\\.gitdir:\')',
    ],
  })).exposed, false);
});

test('non e\' un push: la parola dentro una stringa, un commento, il push con il token del checkout', () => {
  const prose = jobFrom(workflowWith({
    push: ['          RESCUE="fai git fetch origin main, poi git push sul branch"', '          echo "$RESCUE"'],
  }));
  assert.equal(prose.pushes, 0);
  const comment = jobFrom(workflowWith({ push: ['          # git push origin HEAD:main'] }));
  assert.equal(comment.pushes, 0);
  const sameIdentity = jobFrom(workflowWith({ push: ['          git push origin HEAD:refs/heads/data'] }));
  assert.equal(sameIdentity.pushes, 1);
  assert.equal(sameIdentity.exposed, false);
});

test('un solo push non difeso basta: l\'azzeramento vale per il comando che lo porta', () => {
  const mixed = jobFrom(workflowWith({
    push: [
      '          auth="$(printf \'x-access-token:%s\' "$OWNER_PAT" | base64 | tr -d \'\\n\')"',
      '          git -c http.https://github.com/.extraheader= push "https://x-access-token:${OWNER_PAT}@github.com/${GITHUB_REPOSITORY}.git" HEAD:data',
      '          git -c "http.extraheader=AUTHORIZATION: basic $auth" push origin HEAD:main',
    ],
  }));
  assert.equal(mixed.pushes, 2);
  assert.equal(mixed.undefendedPushes, 1);
  assert.equal(mixed.exposed, true);
});
