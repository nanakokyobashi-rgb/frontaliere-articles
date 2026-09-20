import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseCodexUsage } from '../../scripts/ci/codex-usage-summary.mjs';

const SUMMARY = fileURLToPath(new URL('../../scripts/ci/codex-usage-summary.mjs', import.meta.url));

test('stream vuoto: telemetry fail-open senza invocazione', () => {
  assert.deepEqual(
    parseCodexUsage('', { outcome: 'skipped', durationMs: null }),
    {
      codex_invocations: 0,
      usage_available: false,
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      duration_ms: 0,
      outcome: 'skipped',
      stream_status: 'not_invoked',
      malformed_lines: 0,
      usage_records: 0,
    },
  );
});

test('la CLI resta attiva quando il parser viene invocato tramite un path symlink', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'codex-usage-summary-'));
  try {
    const copied = path.join(root, 'summary.mjs');
    const linked = path.join(root, 'summary-link.mjs');
    const diagnostics = path.join(root, 'diagnostics.jsonl');
    cpSync(SUMMARY, copied);
    symlinkSync(copied, linked);
    writeFileSync(diagnostics, `${JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 3, cached_input_tokens: 2, output_tokens: 1 },
    })}\n`);

    const result = spawnSync(process.execPath, [linked, diagnostics, 'success', '7'], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      codex_invocations: 1,
      usage_available: true,
      input_tokens: 3,
      cached_input_tokens: 2,
      output_tokens: 1,
      duration_ms: 7,
      outcome: 'success',
      stream_status: 'complete',
      malformed_lines: 0,
      usage_records: 1,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('un turno Codex aggrega solo usage numerici e la durata del processo', () => {
  const stream = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'testo non esportabile' },
    }),
    JSON.stringify({
      type: 'turn.completed',
      usage: {
        input_tokens: 1_860_928,
        cached_input_tokens: 1_711_360,
        output_tokens: 29_314,
        reasoning_output_tokens: 25_204,
      },
    }),
  ].join('\n');

  assert.deepEqual(parseCodexUsage(stream, { outcome: 'success', durationMs: 1_055_432 }), {
    codex_invocations: 1,
    usage_available: true,
    input_tokens: 1_860_928,
    cached_input_tokens: 1_711_360,
    output_tokens: 29_314,
    duration_ms: 1_055_432,
    outcome: 'success',
    stream_status: 'complete',
    malformed_lines: 0,
    usage_records: 1,
  });
});

test('stream parziale/malformato non fa fallire il parser e non inventa usage', () => {
  const partial = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    '{"type":"turn.completed","usage":{"input_tokens":12}',
    'stderr: connection closed before the final event',
  ].join('\n');

  assert.deepEqual(parseCodexUsage(partial, { outcome: 'failure', durationMs: 42 }), {
    codex_invocations: 1,
    usage_available: false,
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    duration_ms: 42,
    outcome: 'failure',
    stream_status: 'partial',
    malformed_lines: 2,
    usage_records: 0,
  });

  assert.deepEqual(parseCodexUsage('not-json', { outcome: 'cancelled' }), {
    codex_invocations: 0,
    usage_available: false,
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    duration_ms: 0,
    outcome: 'cancelled',
    stream_status: 'malformed',
    malformed_lines: 1,
    usage_records: 0,
  });
});
