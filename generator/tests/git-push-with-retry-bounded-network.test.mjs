import './lib/stdout-off-runner-pipe.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PUSH_WITH_RETRY_SCRIPT = path.join(ROOT, 'scripts/lib/git-push-with-retry.sh');
const BOUNDED_COMMAND_WRAPPER = 'scripts/lib/run-bounded-command.mjs';
const HELPER_RELATIVE_PATH = 'scripts/lib/git-push-with-retry.sh';
const WORKFLOWS_DIR = path.join(ROOT, '.github/workflows');
const BASH_BIN = ['/opt/homebrew/bin/bash', '/usr/local/bin/bash'].find(existsSync) ?? 'bash';
const NETWORK_TEST_TIMEOUT_SECONDS = '1';
// The shim below stalls a push for 30 seconds. The script under test must
// finish well inside that: a run that waited for the stall is cut here and
// reports no exit status, so the assertions on `status` are the proof of the
// ceiling. No assertion on elapsed time: that would measure the runner.
const NETWORK_TEST_STALL_SECONDS = 30;
const NETWORK_TEST_PROCESS_TIMEOUT_MS = 25_000;

function stripShellComment(line) {
  let quote = '';
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === "'") {
      if (character === "'") quote = '';
      continue;
    }
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quote = '';
      continue;
    }
    if (escaped) escaped = false;
    else if (character === '\\') escaped = true;
    else if (character === "'" || character === '"') quote = character;
    else if (character === '#' && (index === 0 || /[\s;|&(){}]/u.test(line[index - 1]))) {
      return line.slice(0, index);
    }
  }
  return line;
}

function findHereDoc(line) {
  let quote = '';
  let escaped = false;
  for (let index = 0; index < line.length - 1; index += 1) {
    const character = line[index];
    if (quote === "'") {
      if (character === "'") quote = '';
      continue;
    }
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quote = '';
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character !== '<' || line[index + 1] !== '<') continue;
    if (line[index + 2] === '<') {
      // A here-string (`<<<`) feeds one word, not the lines that follow. All
      // three characters go: reading its last two as `<<` opened a heredoc
      // that never closed, and the rest of the file was skipped in silence.
      index += 2;
      continue;
    }
    let delimiterIndex = index + 2;
    const stripTabs = line[delimiterIndex] === '-';
    if (stripTabs) delimiterIndex += 1;
    while (/\s/u.test(line[delimiterIndex] || '')) delimiterIndex += 1;
    const delimiterStart = line[delimiterIndex];
    if (delimiterStart === "'" || delimiterStart === '"') {
      const end = line.indexOf(delimiterStart, delimiterIndex + 1);
      if (end > delimiterIndex + 1) {
        return { index, delimiter: line.slice(delimiterIndex + 1, end), stripTabs };
      }
      continue;
    }
    const match = /^[^\s;|&<>]+/u.exec(line.slice(delimiterIndex));
    if (match) return { index, delimiter: match[0], stripTabs };
  }
  return undefined;
}

function hasLineContinuation(line) {
  const match = /(\\+)\s*$/u.exec(line);
  return Boolean(match && match[1].length % 2 === 1);
}

function updateSubstitutionDepth(text, depth) {
  let quote = '';
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote === "'") {
      if (character === "'") quote = '';
      continue;
    }
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quote = '';
      else if (character === '$' && text[index + 1] === '(') {
        depth += 1;
        index += 1;
      } else if (character === ')' && depth > 0) {
        depth -= 1;
      }
      continue;
    }
    if (escaped) escaped = false;
    else if (character === '\\') escaped = true;
    else if (character === "'" || character === '"') quote = character;
    else if (character === '$' && text[index + 1] === '(') {
      depth += 1;
      index += 1;
    } else if (character === ')' && depth > 0) {
      depth -= 1;
    }
  }
  return depth;
}

function logicalShellCommands(source) {
  const commands = [];
  let current = [];
  let substitutionDepth = 0;
  let heredoc;
  for (const [index, rawLine] of source.split('\n').entries()) {
    const number = index + 1;
    if (heredoc) {
      const bodyLine = heredoc.stripTabs ? rawLine.replace(/^\t+/u, '') : rawLine;
      if (bodyLine === heredoc.delimiter) heredoc = undefined;
      continue;
    }
    const line = stripShellComment(rawLine.replace(/\r$/u, ''));
    const hereDoc = findHereDoc(line);
    const commandLine = hereDoc ? line.slice(0, hereDoc.index) : line;
    if (current.length || commandLine.trim()) current.push({ number, text: commandLine });
    substitutionDepth = updateSubstitutionDepth(commandLine, substitutionDepth);
    if (hereDoc) heredoc = { delimiter: hereDoc.delimiter, stripTabs: hereDoc.stripTabs, openedAt: number };
    if (!hasLineContinuation(commandLine) && substitutionDepth === 0) {
      if (current.length) commands.push({ lines: current, text: current.map(({ text }) => text).join('\n') });
      current = [];
    }
  }
  // Everything after a heredoc that does not close is a body, and a body is
  // not read: a rule built on this reader would pass on lines it never saw.
  if (heredoc) {
    throw new Error(`heredoc <<${heredoc.delimiter} opened on line ${heredoc.openedAt} never closes: `
      + 'the lines after it were not read');
  }
  if (current.length) commands.push({ lines: current, text: current.map(({ text }) => text).join('\n') });
  return commands;
}

const NETWORK_COMMAND = /\bgit(?:(?:\s+-[A-Za-z]\s+\S+)|(?:\s+--?\S+))*\s+(?:fetch|push|ls-remote|clone|pull)\b|\bgh\s+\S+/gu;

// Where a command can start: outside every quote, straight inside a command
// substitution, or inside the script handed to `bash -c`. A quoted word inside
// a substitution is a word again (the label of run_bounded is not a command),
// so the contexts nest and only the innermost one decides.
function executableAt(text, target) {
  const contexts = [];
  for (let index = 0; index < target; index += 1) {
    const character = text[index];
    const innermost = contexts.at(-1);
    if (innermost === 'single' || innermost === 'single-script') {
      if (character === "'") contexts.pop();
      continue;
    }
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '$' && text[index + 1] === '(') {
      contexts.push('substitution');
      index += 1;
      continue;
    }
    if (innermost === 'double' || innermost === 'double-script') {
      if (character === '"') contexts.pop();
      continue;
    }
    if (character === ')' && innermost === 'substitution') {
      contexts.pop();
      continue;
    }
    if (character === "'" || character === '"') {
      const script = /\b(?:ba)?sh\s+-c\s+$/u.test(text.slice(0, index));
      if (character === "'") contexts.push(script ? 'single-script' : 'single');
      else contexts.push(script ? 'double-script' : 'double');
    }
  }
  const innermost = contexts.at(-1);
  return innermost !== 'single' && innermost !== 'double';
}

// Every network command the reader finds, bounded or not. The rule is only as
// good as this list: the cases below pin it, so a reader that stops seeing a
// command fails instead of passing.
function networkCommands(helper) {
  const found = [];
  for (const command of logicalShellCommands(helper)) {
    NETWORK_COMMAND.lastIndex = 0;
    let match;
    while ((match = NETWORK_COMMAND.exec(command.text))) {
      if (!executableAt(command.text, match.index)) continue;
      const offset = command.text.slice(0, match.index).split('\n').length - 1;
      const line = command.lines[offset]?.number ?? command.lines.at(-1).number;
      const before = command.text.slice(0, match.index);
      NETWORK_COMMAND.lastIndex = match.index + match[0].length;
      found.push({ line, command: match[0], bounded: /\brun_bounded\b/u.test(before) });
    }
  }
  return found;
}

function networkVerbs(helper) {
  return networkCommands(helper).map(({ command }) => command.split(/\s+/u).at(-1));
}

function unboundedNetworkCommands(helper) {
  return networkCommands(helper)
    .filter(({ bounded }) => !bounded)
    .map(({ line, command }) => ({ line, command }));
}

function indentOf(line) {
  return line.match(/^\s*/u)[0].length;
}

// Read the explicit sparse lists without adding a YAML dependency to the
// corpus test suite. Only checkout steps are retained; inline values are kept
// too, even though the helper is not currently in one.
function sparseCheckouts() {
  const fixed = [];
  const computed = [];
  for (const file of readdirSync(WORKFLOWS_DIR).filter((name) => /\.ya?ml$/u.test(name)).sort()) {
    const lines = readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const match = /^(\s*)sparse-checkout:\s*(.*)$/u.exec(lines[index]);
      if (!match) continue;
      const sparseIndent = match[1].length;
      let stepStart = -1;
      let stepIndent = -1;
      for (let cursor = index; cursor >= 0; cursor -= 1) {
        const step = /^(\s*)-\s+/u.exec(lines[cursor]);
        if (step && step[1].length < sparseIndent) {
          stepStart = cursor;
          stepIndent = step[1].length;
          break;
        }
      }
      if (stepStart < 0) continue;
      let stepEnd = lines.length;
      for (let cursor = stepStart + 1; cursor < lines.length; cursor += 1) {
        const trimmed = lines[cursor].trim();
        if (trimmed && !trimmed.startsWith('#') && indentOf(lines[cursor]) <= stepIndent) {
          stepEnd = cursor;
          break;
        }
      }
      const stepText = lines.slice(stepStart, stepEnd).join('\n');
      if (!/^\s*(?:-\s*)?uses:\s*['"]?actions\/checkout@/mu.test(stepText)) continue;

      const value = match[2].trim();
      let patterns;
      if (/^\|[-+]?/u.test(value)) {
        patterns = [];
        let end = index + 1;
        for (; end < stepEnd; end += 1) {
          if (lines[end].trim() === '') continue;
          if (indentOf(lines[end]) <= sparseIndent) break;
          const entry = lines[end].trim();
          if (!entry.startsWith('#')) patterns.push(entry);
        }
      } else if (value && value !== 'null' && value !== '~') {
        patterns = [value.replace(/^(['"])(.*)\1$/u, '$2')];
      } else {
        patterns = [];
      }
      const where = `${file} :: line ${index + 1}`;
      const record = {
        where,
        patterns,
        cone: !/^[^\n]*sparse-checkout-cone-mode:\s*false\b/mu.test(stepText),
      };
      if (patterns.some((pattern) => pattern.includes('${{'))) computed.push(`${where} :: ${patterns.join(' ')}`);
      else fixed.push(record);
    }
  }
  return { fixed, computed };
}

// Whether a sparse list puts a file on disk. Cone mode lists directories and
// always keeps root files; otherwise the patterns are gitignore-style, and a
// later `!` pattern takes away what an earlier one gave.
function materializes({ patterns, cone }, file) {
  const prefixOf = (pattern) => pattern.replace(/^!?\//u, '').replace(/^!/u, '').replace(/\/$/u, '');
  const under = (prefix) => file === prefix || file.startsWith(`${prefix}/`);
  if (cone) return !file.includes('/') || patterns.some((pattern) => under(prefixOf(pattern)));
  let included = false;
  for (const pattern of patterns) {
    if (pattern.startsWith('#')) continue;
    const negated = pattern.startsWith('!');
    const prefix = prefixOf(pattern);
    const matches = prefix === '*' || under(prefix)
      || (/[*?]/u.test(prefix) && new RegExp(`^${prefix.replace(/[.+^$()|[\]{}\\]/gu, '\\$&').replace(/\*/gu, '[^/]*').replace(/\?/gu, '[^/]')}(/|$)`, 'u').test(file));
    if (matches) included = !negated;
  }
  return included;
}

const COPY_OR_INSTALL = /\b(?:cp|install|tar|rsync|git\s+(?:show|archive)|gh\s+api|curl|wget)\b|>\s*[^\n]*git-push-with-retry\.sh/u;

function repositoryTextFiles(relativeRoot) {
  const files = [];
  const walk = (relative) => {
    const absolute = path.join(ROOT, relative);
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  walk(relativeRoot);
  return files;
}

function externalHelperCopies() {
  const findings = [];
  for (const relativeRoot of ['.github', 'scripts', 'generator/scripts']) {
    for (const relative of repositoryTextFiles(relativeRoot)) {
      let source;
      try {
        source = readFileSync(path.join(ROOT, relative), 'utf8');
      } catch {
        continue;
      }
      if (source.includes('\u0000')) continue;
      for (const [index, line] of source.split('\n').entries()) {
        if (line.includes(HELPER_RELATIVE_PATH) && COPY_OR_INSTALL.test(line)) {
          findings.push({ file: relative, line: index + 1, text: line.trim() });
        }
      }
    }
  }
  return findings;
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function configureIdentity(cwd) {
  git(cwd, ['config', 'user.name', 'Test Runner']);
  git(cwd, ['config', 'user.email', 'test@example.invalid']);
}

function setupScenario(prefix) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');
  const shim = path.join(root, 'bin');
  const pushCounter = path.join(root, 'push-count');
  git(root, ['init', '-q', '--bare', '--initial-branch=main', remote]);
  git(root, ['init', '-q', '--initial-branch=main', local]);
  configureIdentity(local);
  mkdirSync(path.join(local, 'generated'), { recursive: true });
  writeFileSync(path.join(local, 'generated', 'payload.txt'), 'base\n');
  git(local, ['add', 'generated/payload.txt']);
  git(local, ['commit', '-q', '-m', 'seed']);
  git(local, ['remote', 'add', 'origin', remote]);
  git(local, ['push', '-q', 'origin', 'HEAD:main']);
  git(local, ['fetch', '-q', 'origin', 'main']);
  mkdirSync(shim);
  writeFileSync(pushCounter, '0\n');
  return { root, local, remote, shim, pushCounter };
}

function shellQuote(value) {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function installGitShim(scenario, mode) {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const counter = shellQuote(scenario.pushCounter);
  const real = shellQuote(realGit);
  writeFileSync(
    path.join(scenario.shim, 'git'),
    `#!/bin/bash
is_push=false
for arg in "$@"; do
  if [ "$arg" = "push" ]; then is_push=true; fi
done
if [ "$is_push" = true ]; then
  attempts=$(cat ${counter})
  attempts=$((attempts + 1))
  printf '%s\\n' "$attempts" > ${counter}
  if [ '${mode}' = 'always' ] || [ "$attempts" -eq 1 ]; then
    /bin/sleep ${NETWORK_TEST_STALL_SECONDS}
  fi
fi
exec ${real} "$@"
`,
  );
  chmodSync(path.join(scenario.shim, 'git'), 0o755);
  writeFileSync(path.join(scenario.shim, 'sleep'), '#!/bin/bash\nexit 0\n');
  chmodSync(path.join(scenario.shim, 'sleep'), 0o755);
}

function commonEnvironment(scenario) {
  return {
    ...process.env,
    PATH: `${scenario.shim}${path.delimiter}${process.env.PATH ?? ''}`,
  };
}

function runScript(scenario, script, args, extraEnv) {
  const result = spawnSync(BASH_BIN, [script, ...args], {
    cwd: scenario.local,
    encoding: 'utf8',
    timeout: NETWORK_TEST_PROCESS_TIMEOUT_MS,
    env: { ...commonEnvironment(scenario), ...extraEnv },
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

function pushAttempts(scenario) {
  return Number(readFileSync(scenario.pushCounter, 'utf8').trim());
}

function prepareCommittedChange(scenario) {
  writeFileSync(path.join(scenario.local, 'generated', 'payload.txt'), 'published by push retry\n');
  git(scenario.local, ['add', 'generated/payload.txt']);
  git(scenario.local, ['commit', '-q', '-m', 'publish payload']);
}

function runPushWithRetry(scenario) {
  return runScript(
    scenario,
    PUSH_WITH_RETRY_SCRIPT,
    ['--branch', 'main', '--max-attempts', '2'],
    {
      APP_TOKEN: '',
      GIT_PUSH_WITH_RETRY_PUSH_TIMEOUT_SECONDS: NETWORK_TEST_TIMEOUT_SECONDS,
      GITHUB_PAT: '',
    },
  );
}

test('ogni comando di rete del retry helper usa run_bounded', () => {
  const source = readFileSync(PUSH_WITH_RETRY_SCRIPT, 'utf8');
  // The list is pinned: finding no commands is a reader failure, not a pass.
  assert.deepEqual(networkVerbs(source), ['push', 'fetch']);
  const violations = unboundedNetworkCommands(source);
  assert.deepEqual(violations, [], violations.map(({ line, command }) => `line ${line}: ${command}`).join('; '));
});

test('il lettore continua dopo un here-string e lancia su heredoc non chiuso', () => {
  // git-push-with-retry.sh feeds its loops with `<<<`. Read as a heredoc, the
  // first one hid every line after it, including both network commands.
  const hereString = ['while read -r path <&9; do', '  :', 'done 9<<< "$paths"', 'git fetch origin main', ''];
  assert.deepEqual(unboundedNetworkCommands(hereString.join('\n')), [{ line: 4, command: 'git fetch' }]);

  const hereDoc = ["node - <<'NODE'", "console.log('git push origin main');", 'NODE', 'git push origin main', ''];
  assert.deepEqual(unboundedNetworkCommands(hereDoc.join('\n')), [{ line: 4, command: 'git push' }]);

  assert.throws(
    () => logicalShellCommands('cat <<EOF\ngit push origin main\n'),
    /heredoc <<EOF opened on line 1 never closes/u,
  );
});

test('il lettore distingue comandi da parole quotate e legge bash -c', () => {
  const source = [
    'out="$(run_bounded 5 "git push origin main" \\',
    '  git push origin main 2>&1)"',
    "bash -c 'git fetch origin main'",
    'echo "git pull is only a word here"',
    '',
  ];
  assert.deepEqual(networkCommands(source.join('\n')), [
    { line: 2, command: 'git push', bounded: true },
    { line: 3, command: 'git fetch', bounded: false },
  ]);
});

test('ogni sparse checkout che porta l helper porta anche il wrapper', () => {
  assert.ok(existsSync(path.join(ROOT, BOUNDED_COMMAND_WRAPPER)));
  const { fixed, computed } = sparseCheckouts();
  assert.ok(fixed.length > 0, 'non sono stati trovati checkout sparse espliciti');
  assert.deepEqual(computed, [], `liste sparse calcolate non verificabili: ${computed.join('; ')}`);
  const carriesHelper = fixed.filter((checkout) => materializes(checkout, HELPER_RELATIVE_PATH));
  assert.ok(carriesHelper.length > 0, 'nessun checkout sparse materializza il retry helper');
  const missing = carriesHelper
    .filter((checkout) => !materializes(checkout, BOUNDED_COMMAND_WRAPPER))
    .map(({ where }) => where);
  assert.deepEqual(missing, []);

  const externalCopies = externalHelperCopies();
  const missingExternalWrapper = externalCopies.filter(({ text }) => !text.includes(BOUNDED_COMMAND_WRAPPER));
  assert.deepEqual(
    missingExternalWrapper,
    [],
    missingExternalWrapper.map(({ file, line, text }) => `${file}:${line}: ${text}`).join('\n'),
  );
});

test('lo stall dura piu del tempo concesso agli script', () => {
  assert.ok(NETWORK_TEST_STALL_SECONDS * 1000 > NETWORK_TEST_PROCESS_TIMEOUT_MS);
});

test('un push scaduto al primo tentativo viene ritentato e pubblicato', () => {
  const scenario = setupScenario('push-retry-timeout-once-');
  try {
    prepareCommittedChange(scenario);
    installGitShim(scenario, 'first');
    const result = runPushWithRetry(scenario);

    assert.equal(result.status, 0, result.output);
    assert.equal(pushAttempts(scenario), 2);
    assert.match(result.output, /git push --no-thin origin HEAD:main timed out after 1 second/u);
    assert.match(result.output, /Push rejected \(attempt 1\/2\)/u);
    assert.equal(git(scenario.remote, ['show', 'main:generated/payload.txt']), 'published by push retry');
  } finally {
    rmSync(scenario.root, { recursive: true, force: true });
  }
});

test('un push che scade sempre mantiene il codice di esaurimento', () => {
  const scenario = setupScenario('push-retry-timeout-always-');
  try {
    prepareCommittedChange(scenario);
    installGitShim(scenario, 'always');
    const result = runPushWithRetry(scenario);

    assert.equal(result.status, 1, result.output);
    assert.equal(pushAttempts(scenario), 2);
    assert.match(result.output, /git push --no-thin origin HEAD:main timed out after 1 second/u);
    assert.match(result.output, /Failed to push after 2 attempts/u);
  } finally {
    rmSync(scenario.root, { recursive: true, force: true });
  }
});
