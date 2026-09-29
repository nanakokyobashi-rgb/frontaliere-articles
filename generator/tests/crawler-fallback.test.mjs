import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOWS = path.join(ROOT, '.github/workflows');
const CONTRACT = JSON.parse(
  readFileSync(path.join(ROOT, 'generator/data/crawler-cross-repo-contract.json'), 'utf8'),
);
const CRAWLER_ARTIFACTS = CONTRACT.artifacts
  .filter((artifact) => /^crawler-group-\d{2}\.yml$/.test(artifact.file))
  .filter((artifact) => artifact.members.length > 0);

function occurrences(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function detachedLaunchBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== 'if command -v setsid >/dev/null 2>&1; then') continue;
    const block = lines.slice(index, index + 7);
    assert.equal(block.length, 7, 'blocco di lancio detached troncato');
    assert.ok(block.every((line) => /^ {10}/.test(line)), 'blocco detached fuori dal run YAML');
    blocks.push(block.map((line) => line.slice(10)).join('\n'));
  }
  return blocks;
}

test('FU-2026-09-29-003: il fallback senza setsid conserva figlio, PID, status e log', () => {
  const target = CRAWLER_ARTIFACTS.find((artifact) => artifact.file === 'crawler-group-09.yml');
  assert.ok(target, 'artifact del gruppo 09 assente');

  for (const artifact of CRAWLER_ARTIFACTS) {
    const workflow = readFileSync(path.join(WORKFLOWS, artifact.file), 'utf8');
    const blocks = detachedLaunchBlocks(workflow);
    assert.equal(blocks.length, artifact.members.length, `${artifact.file}: un launcher per crawler`);
    assert.equal(new Set(blocks).size, 1, `${artifact.file}: launcher detached non uniforme`);
    assert.ok(
      blocks[0].includes('env -u RUNNER_TRACKING_ID nohup bash "$launcher_path" > "$log_path" 2>&1 < /dev/null &'),
      `${artifact.file}: fallback nohup senza setsid assente`,
    );
    assert.ok(blocks[0].includes('launcher_pid=$!'), `${artifact.file}: PID del launcher non catturato`);
    assert.ok(
      blocks[0].includes('printf \'%s\\n\' "$launcher_pid" > "$pid_path"'),
      `${artifact.file}: PID del launcher non pubblicato`,
    );
    assert.equal(
      occurrences(workflow, /kill -0 "\$pid"/g),
      artifact.members.length,
      `${artifact.file}: il wait loop non osserva ogni figlio`,
    );
    assert.equal(
      occurrences(workflow, /cat "\$log_file"/g),
      artifact.members.length,
      `${artifact.file}: il wait loop non raccoglie ogni log`,
    );
    assert.equal(
      occurrences(workflow, /while \[ ! -s "\$status_file" \]; do/g),
      artifact.members.length,
      `${artifact.file}: il wait loop non attende ogni status`,
    );
  }
});
