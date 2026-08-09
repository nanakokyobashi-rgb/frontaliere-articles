/**
 * scripts/ci/retry-cmd.sh — suite di regressione (issue #98).
 *
 * Fratello di `generator/tests/npm-ci-retry.test.mjs`, e volutamente costruito
 * sulla stessa impalcatura: il comando e' stubbato su PATH, quindi la suite
 * esercita la logica del wrapper senza toccare la rete.
 *
 * Un wrapper di retry sbaglia in due direzioni opposte, ed entrambe sono
 * inchiodate qui: puo' ingoiare un guasto vero uscendo 0, e puo' perdere gli
 * argomenti che gli sono stati passati. Questo wrapper e' generico e ne ha una
 * terza tutta sua — se lo si invoca SENZA comando, `"$@"` vuoto e' un no-op con
 * stato 0, cioe' un successo silenzioso che non ha eseguito niente.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const SCRIPT = path.resolve(ROOT, 'scripts/ci/retry-cmd.sh');
const NPM_CI_RETRY = path.resolve(ROOT, 'scripts/lib/npm-ci-retry.sh');
const WORKFLOWS = path.resolve(ROOT, '.github/workflows');

/**
 * Esegue il wrapper su un comando `flaky` stubbato, che fallisce le prime
 * `failTimes` chiamate e registra gli argomenti di ognuna.
 */
function runWith({ failTimes, args = ['flaky'], attempts = 3, cmdArgs = [] }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'retry-cmd-'));
  const counter = path.join(dir, 'calls');
  const argsLog = path.join(dir, 'args');
  const stub = path.join(dir, 'flaky');

  writeFileSync(
    stub,
    `#!/usr/bin/env bash
n=0
[ -f "${counter}" ] && n=$(cat "${counter}")
n=$((n + 1))
echo "$n" > "${counter}"
echo "$@" >> "${argsLog}"
if [ "$n" -le ${failTimes} ]; then
  echo "flaky: ETIMEDOUT" >&2
  exit 7
fi
exit 0
`,
  );
  chmodSync(stub, 0o755);

  let code = 0;
  let out = '';
  try {
    out = execFileSync('bash', [SCRIPT, ...args, ...cmdArgs], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        RETRY_CMD_ATTEMPTS: String(attempts),
        // La suite deve restare veloce: il backoff e' attempt * step.
        RETRY_CMD_BACKOFF: '0',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    code = err.status ?? 1;
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }

  const calls = existsSync(counter) ? Number(readFileSync(counter, 'utf8').trim()) : 0;
  const argLines = existsSync(argsLog) ? readFileSync(argsLog, 'utf8').split('\n').filter(Boolean) : [];
  rmSync(dir, { recursive: true, force: true });
  return { code, out, calls, argLines };
}

test('un successo al primo colpo esegue il comando una volta sola', () => {
  const { code, calls } = runWith({ failTimes: 0 });
  assert.equal(code, 0);
  assert.equal(calls, 1, 'il percorso felice non deve pagare la logica di retry');
});

test('un guasto transiente viene ritentato e poi passa', () => {
  const { code, calls, out } = runWith({ failTimes: 1 });
  assert.equal(code, 0, `doveva recuperare, invece:\n${out}`);
  assert.equal(calls, 2);
});

test('un guasto persistente fallisce davvero, esaurite le attempt', () => {
  // La direzione che conta di piu': un wrapper che trasforma una rottura vera
  // in un run verde e' peggio di nessun wrapper. Su publish-api.yml
  // significherebbe pubblicare una superficie dati mai costruita.
  const { code, calls, out } = runWith({ failTimes: 99, attempts: 3 });
  assert.equal(code, 1, 'un guasto genuino non deve essere ingoiato');
  assert.equal(calls, 3, 'deve fermarsi al numero di tentativi configurato');
  assert.match(out, /fallito dopo 3 tentativi/);
});

test('ogni argomento e ogni flag arrivano al comando, a ogni tentativo', () => {
  const { code, argLines } = runWith({
    failTimes: 1,
    cmdArgs: ['-y', 'tsx@4', 'scripts/build-api.mjs'],
  });
  assert.equal(code, 0);
  assert.equal(argLines.length, 2, 'entrambi i tentativi devono aver ricevuto gli argomenti');
  for (const line of argLines) {
    assert.equal(line.trim(), '-y tsx@4 scripts/build-api.mjs');
  }
});

test('invocato SENZA comando esce diverso da zero, invece di dichiararsi verde', () => {
  // `"$@"` vuoto in bash e' un no-op con stato 0. Senza la guardia, una `run:`
  // con una variabile non espansa — `bash retry-cmd.sh $CMD` con CMD vuota —
  // sarebbe uno step verde che non ha eseguito niente: il falso verde piu'
  // economico da produrre in uno YAML.
  let code = 0;
  let out = '';
  try {
    out = execFileSync('bash', [SCRIPT], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    code = err.status ?? 1;
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  assert.notEqual(code, 0, 'un wrapper senza comando non deve mai uscire 0');
  assert.match(out, /senza comando/);
});

test('i due wrapper non divergono su tentativi e backoff', () => {
  // Il rischio dichiarato nella issue #98 e' «cosi' non nascono due
  // meccanismi». Due meccanismi ci sono — uno specifico per `npm ci`, uno
  // generico — ma devono avere la stessa cadenza, o il comportamento della CI
  // dipende da quale wrapper ha toccato quale step.
  const readDefaults = (file, prefix) => {
    const src = readFileSync(file, 'utf8');
    const grab = (name) => {
      const m = new RegExp(`^${name}="\\$\\{${prefix}_[A-Z_]+:-(\\d+)\\}"`, 'm').exec(src);
      assert.ok(m, `${path.basename(file)}: non trovo il default di ${name}`);
      return Number(m[1]);
    };
    return { attempts: grab('ATTEMPTS'), backoff: grab('BACKOFF_STEP') };
  };
  const generic = readDefaults(SCRIPT, 'RETRY_CMD');
  const npmCi = readDefaults(NPM_CI_RETRY, 'NPM_CI_RETRY');
  assert.deepEqual(
    generic,
    npmCi,
    'scripts/ci/retry-cmd.sh e scripts/lib/npm-ci-retry.sh hanno cadenze diverse. ' +
      'Allineale, oppure fai delegare il secondo al primo (era la proposta della #98).',
  );
});

/**
 * I punti `npx` dei workflow ANCORA senza wrapper, al 2026-08-09.
 *
 * Non e' un condono ed e' volutamente scomodo da tenere: questa PR possiede
 * `publish-api.yml` e basta, e wrappare i workflow di altri qui dentro
 * significherebbe metterli nel grafo delle collisioni per una riga a testa.
 * Il valore del registro non e' assolvere questi quattro: e' che il quinto —
 * un workflow nuovo copiato da uno vecchio, che e' esattamente come tornano i
 * `npm ci` nudi — non possa entrare in silenzio.
 *
 * Chiave: `<file> :: <comando a partire da npx>`.
 */
const NOT_YET_WRAPPED = {
  'fast-publish-article.yml :: npx -y tsx@4 scripts/publish-article-fast.mjs': {
    issue: 98,
    reason:
      "Percorso commit->200 in 60-115s. Merita il wrapper quanto publish-api, ma il file e' " +
      "di un'altra area: wrapparlo qui creerebbe una collisione su un workflow che qualcun " +
      'altro sta gia\' toccando. Da drenare con la stessa forma di questa PR.',
  },
  'fast-publish-article.yml :: npx -y tsx@4 scripts/refresh-hub-landing.mjs': {
    issue: 98,
    reason:
      "Stesso file e stesso motivo del precedente: e' il refresh degli hub che segue la " +
      'pubblicazione veloce, e un blip qui lascia gli hub indietro rispetto allo shard.',
  },
  'generate-border-wait-ranking-weekly.yml :: npx -y tsx@4 generator/scripts/generate-border-wait-ranking-article.mjs': {
    issue: 98,
    reason:
      "Cadenza settimanale: un guasto costa un articolo e il cron successivo lo recupera. " +
      "E' la priorita' piu' bassa dei quattro, ed e' l'unico per cui il retry e' un lusso.",
  },
  'generator-ci.yml :: npx -y tsx@4 generator/tests/shell-contract-coverage.mjs': {
    issue: 98,
    reason:
      "Gate di PR, non percorso di pubblicazione: un guasto qui si vede subito e si ripara " +
      "con un re-run, senza che nessun dato pubblicato ne risenta. La #98 chiede pero' anche " +
      "`cache: 'npm'` su questo file, che e' l'unico npm ci senza cache e ha gia' fallito " +
      '(run 31281796778).',
  },
};

/** Da una riga di workflow, il comando npx normalizzato — o null. */
function npxCommand(line) {
  const m = /(^|[\s;&|])(npx\s.*)$/.exec(line);
  if (!m) return null;
  return m[2]
    .replace(/\\\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

test('ogni npx dei workflow passa dal wrapper, o e\' dichiarato', () => {
  const found = new Map();
  for (const file of readdirSync(WORKFLOWS)) {
    if (!/\.ya?ml$/.test(file)) continue;
    const src = readFileSync(path.join(WORKFLOWS, file), 'utf8');
    src.split('\n').forEach((line, i) => {
      // Solo righe eseguibili: un `npx` citato in un commento e' prosa.
      if (/^\s*#/.test(line.trim())) return;
      const cmd = npxCommand(line);
      if (!cmd) return;
      const wrapped = line.includes('retry-cmd.sh') || line.includes('npm-ci-retry');
      const key = `${file} :: ${cmd}`;
      if (!found.has(key)) found.set(key, { file, cmd, wrapped, line: i + 1 });
    });
  }

  assert.ok(found.size > 0, 'nessun npx trovato nei workflow: il rilevatore e\' rotto, non il repo');

  const undeclared = [];
  for (const [key, c] of found) {
    if (c.wrapped) continue;
    if (NOT_YET_WRAPPED[key]) continue;
    undeclared.push(`${c.file}:${c.line} → ${c.cmd}`);
  }

  assert.deepEqual(
    undeclared,
    [],
    "`npx` senza retry e non dichiarati. `npx -y` SCARICA dal registro a ogni run: un " +
      'ETIMEDOUT fa fallire lo step, e su un percorso di pubblicazione costa la superficie ' +
      'dati intera (#98).\n' +
      '  - se e\' un percorso caldo → `bash scripts/ci/retry-cmd.sh npx ...`, dopo aver ' +
      'verificato che il comando sia idempotente;\n' +
      '  - se puo\' aspettare → aggiungilo a NOT_YET_WRAPPED con issue e ragione.\n\n  ' +
      undeclared.join('\n  '),
  );

  // Il registro non deve diventare l'elenco delle scuse di ieri.
  const stale = [];
  for (const key of Object.keys(NOT_YET_WRAPPED)) {
    const c = found.get(key);
    if (!c) stale.push(`${key} — questo npx non esiste piu': rimuovi la voce`);
    else if (c.wrapped) stale.push(`${key} — ORA passa dal wrapper: rimuovi la voce`);
  }
  assert.deepEqual(stale, [], `Voci stale in NOT_YET_WRAPPED:\n  ${stale.join('\n  ')}`);
});

test('il registro NOT_YET_WRAPPED e\' ben formato', () => {
  const bad = [];
  for (const [key, d] of Object.entries(NOT_YET_WRAPPED)) {
    if (!key.includes(' :: ')) bad.push(`${key}: chiave senza separatore ' :: '`);
    if (!Number.isInteger(d.issue)) bad.push(`${key}: manca il numero di issue di drenaggio`);
    // Una ragione di due parole non e' una decisione, e' un timbro.
    if (!d.reason || d.reason.length < 40) bad.push(`${key}: manca una ragione scritta (>=40 caratteri)`);
  }
  assert.deepEqual(bad, [], `Voci malformate:\n  ${bad.join('\n  ')}`);
});

test('publish-api.yml costruisce la superficie dati attraverso il wrapper', () => {
  // Il rewire e' la meta' della fix che marcisce per prima.
  const src = readFileSync(path.join(WORKFLOWS, 'publish-api.yml'), 'utf8');
  const buildLine = src
    .split('\n')
    .find((l) => l.includes('scripts/build-api.mjs') && l.includes('npx'));
  assert.ok(buildLine, 'non trovo piu\' lo step che costruisce la superficie dati');
  assert.match(
    buildLine,
    /retry-cmd\.sh/,
    'Lo step piu\' costoso del repo e\' tornato a un npx nudo: un blip di rete li\' non ' +
      'costa un articolo, costa manifest, articles.json, slugs.json, le sitemap, i dieci ' +
      'feed e il ticker.',
  );
});
