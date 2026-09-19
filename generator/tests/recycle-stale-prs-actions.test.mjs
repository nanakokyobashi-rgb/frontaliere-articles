/**
 * Esercita il blocco reale di recycle-stale-prs.yml con un fake `gh`.
 *
 * Le regressioni qui sono azioni-ordering, non solo stringhe: una close
 * fallita/non verificata, un probe ref non autorizzato o una transizione label
 * non confermata non deve mai arrivare a `add-label agent:fix`.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const WORKFLOW = readFileSync(new URL('../../.github/workflows/recycle-stale-prs.yml', import.meta.url), 'utf8');
const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function recycleScript() {
  const start = WORKFLOW.indexOf('\n        run: |', WORKFLOW.indexOf('- name: Recycle deeply-stale stale-review PRs'));
  assert.notEqual(start, -1, 'run block recycle non trovato');
  const end = WORKFLOW.indexOf('\n      - name: Flag parked draft PRs', start);
  assert.notEqual(end, -1, 'fine run block recycle non trovata');
  return WORKFLOW.slice(start + '\n        run: |\n'.length, end)
    .split('\n')
    .map((line) => line.startsWith('          ') ? line.slice(10) : line)
    .join('\n');
}

const FAKE_GH = `#!/bin/sh
set -eu
log=\"\${FAKE_LOG:?}\"
state=\"\${FAKE_STATE:?}\"
printf '%s\\n' \"$*\" >>\"$log\"

get_state() {
  awk -F= -v key=\"$1\" '$1 == key { print substr($0, index($0, \"=\") + 1); exit }' \"$state\"
}

set_state() {
  key=\"$1\"
  value=\"$2\"
  tmp=\"$state.tmp\"
  awk -F= -v key=\"$key\" -v value=\"$value\" '
    $1 == key { print key \"=\" value; found=1; next }
    { print }
    END { if (!found) print key \"=\" value }
  ' \"$state\" >\"$tmp\"
  mv \"$tmp\" \"$state\"
}

command=\"\${1:-}\"
shift || true
args=\"$*\"

case \"$command\" in
  api)
    if printf '%s' \"$args\" | grep -q -- '--paginate'; then
      printf '%s\\n' '{\"number\":17,\"title\":\"fix stale (#77)\",\"body\":\"\",\"createdAt\":\"2020-01-01T00:00:00Z\",\"headRefName\":\"fix/issue-77\",\"labels\":[{\"name\":\"stale-review\"},{\"name\":\"agent:autofix\"}]}'
      exit 0
    fi
    if printf '%s' \"$args\" | grep -q -- '-X DELETE'; then
      set_state REF_PRESENT false
      exit 0
    fi
    if printf '%s' \"$args\" | grep -q -- '--include'; then
      mode=\"\${FAKE_REF_MODE:-sha}\"
      if [ \"$mode\" = 404 ]; then
        printf 'HTTP/2 404 Not Found\\n\\n{\"message\":\"Not Found\"}\\n'
        exit 1
      fi
      if [ \"$(get_state REF_PRESENT)\" != true ]; then
        printf 'HTTP/2 404 Not Found\\n\\n{\"message\":\"Not Found\"}\\n'
        exit 1
      fi
      case \"$mode\" in
        403) printf 'HTTP/2 403 Forbidden\\n\\n{\"message\":\"Forbidden\"}\\n'; exit 1 ;;
        500) printf 'HTTP/2 500 Server Error\\n\\n{\"message\":\"Server error\"}\\n'; exit 1 ;;
        timeout) exit 1 ;;
        malformed) printf 'HTTP/2 200 OK\\n\\n{}\\n'; exit 0 ;;
        mismatch) printf 'HTTP/2 200 OK\\n\\n{\"object\":{\"sha\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"}}\\n'; exit 0 ;;
        *) printf 'HTTP/2 200 OK\\n\\n{\"object\":{\"sha\":\"%s\"}}\\n' \"\${FAKE_HEAD_SHA:-${SHA}}\"; exit 0 ;;
      esac
    fi
    ;;
  pr)
    sub=\"\${1:-}\"
    shift || true
    args=\"$*\"
    if [ \"$sub\" = close ]; then
      if [ \"\${FAKE_CLOSE:-ok}\" = fail ]; then exit 1; fi
      if printf '%s' \"$args\" | grep -q -- '--delete-branch'; then
        set_state PREMATURE_DELETE true
        set_state REF_PRESENT false
      fi
      if [ \"\${FAKE_CLOSE:-ok}\" != open ]; then set_state PR_STATE CLOSED; fi
      exit 0
    fi
    if [ \"$sub\" = view ]; then
      if printf '%s' \"$args\" | grep -q -- '--json state'; then
        printf '%s\\n' \"$(get_state PR_STATE)\"
      else
        if [ \"\${FAKE_HEAD_METADATA:-ok}\" = partial ]; then
          printf '{\"commits\":[{\"committedDate\":\"2020-01-01T00:00:00Z\"}],\"headRepository\":{\"nameWithOwner\":\"%s\"}}\\n' "\${FAKE_HEAD_REPO:-owner/repo}"
        else
          printf '{\"commits\":[{\"committedDate\":\"2020-01-01T00:00:00Z\"}],\"headRepository\":{\"nameWithOwner\":\"%s\"},\"headRepositoryOwner\":{\"login\":\"owner\"},\"headRefName\":\"fix/issue-77\",\"headRefOid\":\"%s\"}\\n' "\${FAKE_HEAD_REPO:-owner/repo}" "${SHA}"
        fi
      fi
      exit 0
    fi
    ;;
  issue)
    sub=\"\${1:-}\"
    shift || true
    args=\"$*\"
    if [ \"$sub\" = view ]; then
      if printf '%s' \"$args\" | grep -q -- '--json labels'; then
        if [ \"\${FAKE_LABEL_QUERY:-ok}\" = malformed ]; then printf '{}\\n'; elif [ \"\${FAKE_LABEL_QUERY:-ok}\" = malformed-record ]; then printf '{\"labels\":[{}]}\\n'; elif [ \"$(get_state LABEL_PRESENT)\" = true ]; then printf '{\"labels\":[{\"name\":\"agent:fix\"}]}\\n'; else printf '{\"labels\":[]}\\n'; fi
      else
        printf 'OPEN\\n'
      fi
      exit 0
    fi
    if [ \"$sub\" = edit ]; then
      if printf '%s' \"$args\" | grep -q -- '--remove-label'; then
        if [ \"\${FAKE_REMOVE:-ok}\" = fail ]; then exit 1; fi
        if [ \"\${FAKE_REMOVE:-ok}\" != stuck ]; then set_state LABEL_PRESENT false; fi
        exit 0
      fi
      if printf '%s' \"$args\" | grep -q -- '--add-label'; then
        if [ \"\${FAKE_ADD:-ok}\" = fail ]; then exit 1; fi
        if [ \"\${FAKE_ADD:-ok}\" != silent ]; then set_state LABEL_PRESENT true; fi
        exit 0
      fi
      exit 0
    fi
    ;;
esac
exit 0
`;

function runScenario(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'recycle-stale-actions-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const fakeGh = join(bin, 'gh');
  const fakeSleep = join(bin, 'sleep');
  const fakeDate = join(bin, 'date');
  const log = join(dir, 'gh.log');
  const state = join(dir, 'state');
  writeFileSync(fakeGh, FAKE_GH);
  writeFileSync(fakeSleep, '#!/bin/sh\nexit 0\n');
  writeFileSync(fakeDate, '#!/bin/sh\ncase "$*" in\n  "-u +%s") printf "2000000000\\n" ;;\n  "-u -d "*" +%s") printf "1577836800\\n" ;;\n  *) exit 1 ;;\nesac\n');
  writeFileSync(log, '');
  writeFileSync(state, 'LABEL_PRESENT=true\nREF_PRESENT=true\nPREMATURE_DELETE=false\nPR_STATE=OPEN\n');
  chmodSync(fakeGh, 0o755);
  chmodSync(fakeSleep, 0o755);
  chmodSync(fakeDate, 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH || ''}`,
    BASH_ENV: '/dev/null',
    GH_TOKEN: 'base-token',
    REPO: 'owner/repo',
    APP_TOKEN: 'runtime-token',
    GITHUB_PAT_NANAKO: '',
    DRY_RUN: 'false',
    MAX_AGE_HOURS: '24',
    MAX_RECYCLES_PER_RUN: '5',
    FAKE_LOG: log,
    FAKE_STATE: state,
    FAKE_BIN: bin,
    FAKE_HEAD_SHA: SHA,
    ...overrides,
  };
  const script = [
    'set -uo pipefail',
    'PATH="$FAKE_BIN:$PATH"',
    recycleScript(),
  ].join('\n');
  let output = '';
  let error = null;
  try {
    output = execFileSync('bash', ['-c', script], { encoding: 'utf8', env });
  } catch (caught) {
    error = caught;
    output = `${caught.stdout || ''}${caught.stderr || ''}`;
  }
  const events = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  const stateText = readFileSync(state, 'utf8');
  rmSync(dir, { recursive: true, force: true });
  return { output, events, stateText, error };
}

function eventIndex(events, pattern, from = 0) {
  return events.findIndex((event, index) => index >= from && pattern.test(event));
}

test('happy path: close verificata, ref liberato e remove→verify→add→verify in ordine', () => {
  const result = runScenario();
  assert.match(result.output, /issue #77 ri-accodata/);
  const close = eventIndex(result.events, /^pr close 17/);
  const state = eventIndex(result.events, /^pr view 17 .*--json state/);
  const probe = eventIndex(result.events, /^api .*--include/);
  const remove = eventIndex(result.events, /^issue edit 77 .*--remove-label agent:fix/);
  const removeVerify = eventIndex(result.events, /^issue view 77 .*--json labels/);
  const add = eventIndex(result.events, /^issue edit 77 .*--add-label agent:fix/);
  const addVerify = eventIndex(result.events, /^issue view 77 .*--json labels/, removeVerify + 1);
  const del = eventIndex(result.events, /^api -X DELETE /);
  assert.ok(close >= 0 && state > close && probe > state && del > probe);
  assert.ok(remove > del && removeVerify > remove && add > removeVerify && addVerify > add);
  assert.match(result.stateText, /PR_STATE=CLOSED/);
  assert.match(result.stateText, /LABEL_PRESENT=true/);
  assert.match(result.stateText, /PREMATURE_DELETE=false/);
  assert.doesNotMatch(result.events.find((event) => event.startsWith('pr close 17')) || '', /--delete-branch/);
});

test('close failure o stato ancora OPEN non raggiungono ref o label', () => {
  for (const overrides of [{ FAKE_CLOSE: 'fail' }, { FAKE_CLOSE: 'open' }]) {
    const result = runScenario(overrides);
    assert.doesNotMatch(result.events.join('\n'), /--include/);
    assert.doesNotMatch(result.events.join('\n'), /--remove-label agent:fix/);
    assert.doesNotMatch(result.events.join('\n'), /--add-label agent:fix/);
    assert.match(result.output, /close (fallita|non verificata)/);
  }
});

test('ref probe: solo 404 confermato conta come assenza', () => {
  for (const mode of ['403', '500', 'timeout', 'malformed']) {
    const result = runScenario({ FAKE_REF_MODE: mode });
    const log = result.events.join('\n');
    assert.doesNotMatch(log, /--remove-label agent:fix/, mode);
    assert.doesNotMatch(log, /--add-label agent:fix/, mode);
  }
  const gone = runScenario({ FAKE_REF_MODE: '404' });
  assert.match(gone.events.join('\n'), /--remove-label agent:fix/);
});

test('head cambiata dopo close non autorizza alcun DELETE', () => {
  const result = runScenario({ FAKE_REF_MODE: 'mismatch' });
  assert.doesNotMatch(result.events.join('\n'), /-X DELETE/);
  assert.match(result.stateText, /REF_PRESENT=true/);
  assert.match(result.stateText, /PREMATURE_DELETE=false/);
});

test('head fork/target sconosciuto non autorizza close o DELETE nel base repo', () => {
  const result = runScenario({ FAKE_HEAD_REPO: 'other/fork' });
  assert.doesNotMatch(result.events.join('\n'), /^pr close 17/);
  assert.doesNotMatch(result.events.join('\n'), /-X DELETE/);
  assert.match(result.output, /head repository non verificabile/);
});

test('metadata HEAD parziale non autorizza close, DELETE o re-queue', () => {
  const result = runScenario({ FAKE_HEAD_METADATA: 'partial' });
  const log = result.events.join('\n');
  assert.doesNotMatch(log, /^pr close 17/m);
  assert.doesNotMatch(log, /-X DELETE/);
  assert.doesNotMatch(log, /--remove-label agent:fix/);
  assert.doesNotMatch(log, /--add-label agent:fix/);
  assert.match(result.output, /metadata head ref\/SHA non verificabile/);
});

test('max_recycles enorme o oltre il limite operativo e\' fail-closed', () => {
  for (const value of ['999999999999999999999999999999999999', '101']) {
    const result = runScenario({ MAX_RECYCLES_PER_RUN: value });
    const log = result.events.join('\n');
    assert.doesNotMatch(log, /^pr close 17/m, value);
    assert.match(result.output, /MAX_RECYCLES_PER_RUN/, value);
  }
});

test('remove fallito o non verificato non puo\' fingere un retrigger add', () => {
  for (const overrides of [
    { FAKE_REMOVE: 'fail' },
    { FAKE_REMOVE: 'stuck' },
    { FAKE_LABEL_QUERY: 'malformed' },
    { FAKE_LABEL_QUERY: 'malformed-record' },
  ]) {
    const result = runScenario({ FAKE_REF_MODE: '404', ...overrides });
    const log = result.events.join('\n');
    assert.doesNotMatch(log, /--add-label agent:fix/);
  }
});

test('add fallito resta osservabile senza dichiarare il re-queue riuscito', () => {
  const result = runScenario({ FAKE_REF_MODE: '404', FAKE_ADD: 'fail' });
  assert.match(result.events.join('\n'), /--remove-label agent:fix/);
  assert.match(result.output, /add-label agent:fix fallita/);
  assert.doesNotMatch(result.output, /ri-accodata \(agent:fix via PAT\)/);
});

test('PAT assente blocca la prima azione distruttiva', () => {
  const result = runScenario({ APP_TOKEN: '', GITHUB_PAT_NANAKO: '' });
  const log = result.events.join('\n');
  assert.doesNotMatch(log, /^pr close 17/);
  assert.doesNotMatch(log, /--remove-label agent:fix/);
});
