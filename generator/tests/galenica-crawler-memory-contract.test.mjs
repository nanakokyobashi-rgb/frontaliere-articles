import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONTRACT = JSON.parse(readFileSync(
  path.join(ROOT, 'generator/data/crawler-cross-repo-contract.json'),
  'utf8',
));

function launchStepFromArtifact(text, crawlerId) {
  const lines = text.split(/\r?\n/);
  const idAt = lines.findIndex((line) => line.trim() === `id: crawler-launch-${crawlerId}`);
  assert.notEqual(idAt, -1, `launcher ${crawlerId} non trovato`);

  const stepAt = lines.findLastIndex((line, index) =>
    index <= idAt && /^\s*-\s+name:\s+/.test(line));
  assert.notEqual(stepAt, -1, `inizio launcher ${crawlerId} non trovato`);
  const stepIndent = /^\s*/.exec(lines[stepAt])?.[0].length ?? 0;
  let endAt = lines.length;
  for (let index = idAt + 1; index < lines.length; index += 1) {
    const match = /^(\s*)-\s+name:\s+/.exec(lines[index]);
    if (match && match[1].length === stepIndent) {
      endAt = index;
      break;
    }
  }
  return lines.slice(stepAt, endAt).join('\n');
}

test('il launcher Galenica conserva il limite heap ratificato', () => {
  const artifact = CONTRACT.artifacts.find((entry) => entry.file === 'crawler-group-02.yml');
  assert.ok(artifact?.members.includes('galenica'));
  const workflow = readFileSync(path.join(ROOT, '.github/workflows', artifact.file), 'utf8');
  const galenicaStep = launchStepFromArtifact(workflow, 'galenica');

  assert.match(galenicaStep, /^\s+env:\s*$/m);
  assert.match(
    galenicaStep,
    /^\s+NODE_OPTIONS: --disable-warning=DEP0040 --disable-warning=DEP0169 --max-old-space-size=4608$/m,
  );
});
