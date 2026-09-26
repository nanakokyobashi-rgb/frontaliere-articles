import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildRedflagDocumentSections,
  extractSectionByHeading,
  REDFLAG_DOC_SECTIONS_EOF,
  REDFLAG_DOC_SECTIONS_MAX_BYTES,
  validateRedflagDocumentSections,
} from '../../scripts/ci/redflag-doc-sections.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = fs.readFileSync(
  path.join(ROOT, '.github/workflows/pr-redflag-fixer.yml'),
  'utf8',
);
const REVIEW = fs.readFileSync(path.join(ROOT, 'REVIEW.md'), 'utf8');
const AGENTS = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');

function stepBlock(source, name) {
  const start = source.indexOf(`      - name: ${name}`);
  assert.notEqual(start, -1, `step «${name}» non trovato`);
  const rest = source.slice(start + 1);
  const next = rest.indexOf('\n      - name: ');
  return next === -1 ? rest : rest.slice(0, next);
}

test('estrae le sezioni vincolanti reali del corpus e le valida per GITHUB_OUTPUT', () => {
  const document = buildRedflagDocumentSections({
    read: (file) => (file === 'REVIEW.md' ? REVIEW : AGENTS),
  });

  assert.match(document, /# Redflag-fix: sezioni documentali vincolanti/);
  assert.match(document, /## REVIEW\.md — Scopo progetto = filtro "important"/);
  assert.match(document, /## REVIEW\.md — Severity/);
  assert.match(document, /## AGENTS\.md — Non-negoziabili/);
  assert.match(document, /## AGENTS\.md — Credenziali/);
  assert.ok(Buffer.byteLength(document, 'utf8') <= REDFLAG_DOC_SECTIONS_MAX_BYTES);
  assert.doesNotMatch(document, new RegExp(`^${REDFLAG_DOC_SECTIONS_EOF}$`, 'm'));
});

test('ignora heading dentro fence e rifiuta heading ambigui o fence aperti', () => {
  const source = [
    '```md',
    '## Target',
    '```',
    '## Target',
    '',
    'contenuto',
    '### sottosezione',
    'dettaglio',
    '## Dopo',
  ].join('\n');
  assert.equal(extractSectionByHeading(source, '## Target'), 'contenuto\n### sottosezione\ndettaglio');
  assert.throws(
    () => extractSectionByHeading('## Target\nuno\n## Target\ndue', '## Target'),
    /ambiguous/,
  );
  assert.throws(
    () => extractSectionByHeading('## Target\n```\n## altro', '## Target'),
    /Unclosed fenced code block/,
  );
});

test('il validatore impedisce collisioni col delimiter e crescita oltre il cap UTF-8', () => {
  assert.throws(
    () => validateRedflagDocumentSections(`prima\n${REDFLAG_DOC_SECTIONS_EOF}\ndopo`),
    /heredoc delimiter/,
  );
  assert.throws(
    () => validateRedflagDocumentSections('è'.repeat(REDFLAG_DOC_SECTIONS_MAX_BYTES)),
    /too large for GITHUB_OUTPUT/,
  );
});

test('il context usa parser e documenti dalla stessa SHA canonica e passa l’output al prompt', () => {
  const context = stepBlock(WORKFLOW, 'Collect PR + review context (zero-Claude)');
  const promptStart = WORKFLOW.indexOf('          prompt: |');
  assert.notEqual(promptStart, -1, 'prompt Codex non trovato');
  const prompt = WORKFLOW.slice(promptStart);

  assert.match(context, /git fetch --no-tags origin main:refs\/remotes\/origin\/main/);
  assert.match(context, /CANONICAL_DOC_SHA=\$\(git rev-parse --verify 'origin\/main\^\{commit\}'/);
  assert.match(context, /git show "\$CANONICAL_DOC_SHA:\$doc" > "\$OUT\/canonical-docs\/\$doc"/);
  assert.match(context, /git show "\$CANONICAL_DOC_SHA:scripts\/ci\/redflag-doc-sections\.mjs"/);
  assert.match(context, /node "\$OUT\/canonical-docs\/redflag-doc-sections\.mjs"/);
  assert.match(context, /redflag_doc_sections<<REDFLAG_DOC_SECTIONS_EOF/);
  assert.match(context, /cat "\$OUT\/redflag-doc-sections\.md"/);
  assert.ok(
    context.indexOf('node "$OUT/canonical-docs/redflag-doc-sections.mjs"')
      < context.indexOf('redflag_doc_sections<<REDFLAG_DOC_SECTIONS_EOF'),
    'il documento deve essere validato prima di essere scritto nel heredoc',
  );
  assert.match(prompt, /sezioni vincolanti sono già dentro questa richiesta/);
  assert.match(prompt, /\$\{\{ steps\.ctx\.outputs\.redflag_doc_sections \}\}/);
  assert.doesNotMatch(prompt, /\$\{\{ env\.REDFLAG_DOC_SECTIONS \}\}/);
  assert.match(prompt, /REVIEW\.md.*scopo.*severity/i);
  assert.match(prompt, /AGENTS\.md.*Non-negoziabili/i);
});
