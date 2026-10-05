/**
 * Eventfrog (AGB v1.28 §17(3)/(6)): a private-source event record never enters
 * the corpus. refresh-events-dataset.mjs is the only door through which the
 * site's events dataset reaches the weekend digest; it must drop such records
 * before caching, even if the site ever published one by mistake.
 *
 * The end-to-end case runs the real script in `--check` mode against a local
 * HTTP server (no write, no external network). TMPDIR=/tmp if the sandbox
 * refuses sockets.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  isPrivateEventRecord,
  stripPrivateEventRecords,
} from '../scripts/lib/private-event-records.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'generator', 'scripts', 'refresh-events-dataset.mjs');

const TIO = { id: 'tio-agenda:1', title: 'Concerto', startDate: '2099-01-02', sourceKey: 'tio-agenda' };
const FROG = { id: 'eventfrog:9', title: 'Jazz', startDate: '2099-01-03', sourceKey: 'eventfrog', ephemeral: true };

describe('isPrivateEventRecord', () => {
  it('matches source key, id prefix or ephemeral marker', () => {
    assert.equal(isPrivateEventRecord(FROG), true);
    assert.equal(isPrivateEventRecord({ id: 'eventfrog:1' }), true);
    assert.equal(isPrivateEventRecord({ id: 'x', sourceKey: 'Eventfrog' }), true);
    assert.equal(isPrivateEventRecord({ id: 'guidle:1', ephemeral: true }), true);
    assert.equal(isPrivateEventRecord(TIO), false);
    assert.equal(isPrivateEventRecord(null), false);
  });
});

describe('stripPrivateEventRecords', () => {
  it('drops private records and keeps the payload shape', () => {
    const input = { schemaVersion: 1, totalEvents: 2, events: [TIO, FROG] };
    const { payload, removed } = stripPrivateEventRecords(input);
    assert.equal(removed, 1);
    assert.deepEqual(payload.events, [TIO]);
    assert.equal(payload.totalEvents, 1);
    assert.equal(payload.schemaVersion, 1);
    assert.equal(input.events.length, 2, 'input not mutated');
  });

  it('returns the same payload when nothing is private', () => {
    const input = { schemaVersion: 1, events: [TIO] };
    const { payload, removed } = stripPrivateEventRecords(input);
    assert.equal(removed, 0);
    assert.equal(payload, input);
  });
});

function serve(body) {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function runScript(env, args = ['--check']) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, DRY_RUN: '', ...env }, cwd: ROOT });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });
}

describe('refresh-events-dataset.mjs', () => {
  it('drops a private record served by the publisher and says so', async () => {
    const server = await serve(JSON.stringify({ schemaVersion: 1, events: [TIO, FROG] }));
    try {
      const { port } = server.address();
      const { code, out } = await runScript({ EVENTS_DATASET_URL: `http://127.0.0.1:${port}/events.json`, GITHUB_ACTIONS: '' });
      assert.equal(code, 0, out);
      assert.match(out, /carried 1 private-source event record\(s\); dropped before caching/);
      assert.match(out, /--check: 1 events .* 1 private dropped, wrote nothing/);
      assert.doesNotMatch(out, /Jazz/);
    } finally {
      server.close();
    }
  });

  // The content gates judge the FILTERED payload: what would be cached.
  async function runAgainst(payload, args) {
    const server = await serve(JSON.stringify(payload));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-events-'));
    const cache = path.join(dir, 'events.json');
    try {
      const { port } = server.address();
      const result = await runScript(
        { EVENTS_DATASET_URL: `http://127.0.0.1:${port}/events.json`, EVENTS_DATASET_CACHE: cache, GITHUB_ACTIONS: '' },
        args,
      );
      return { ...result, cache };
    } finally {
      server.close();
    }
  }

  for (const args of [['--check'], []]) {
    const mode = args.length ? '--check' : 'write';
    it(`${mode}: a payload of private records only is refused, nothing written`, async () => {
      const { code, out, cache } = await runAgainst({ schemaVersion: 1, events: [FROG, { ...FROG, id: 'eventfrog:10' }] }, args);
      assert.notEqual(code, 0, out);
      assert.match(out, /zero public events — refusing/);
      assert.equal(fs.existsSync(cache), false);
    });

    it(`${mode}: the only startDate on a private record is refused, nothing written`, async () => {
      const undated = { id: 'tio-agenda:2', title: 'Senza data', sourceKey: 'tio-agenda' };
      const { code, out, cache } = await runAgainst({ schemaVersion: 1, events: [undated, FROG] }, args);
      assert.notEqual(code, 0, out);
      assert.match(out, /not one public event carries a startDate — refusing/);
      assert.equal(fs.existsSync(cache), false);
    });
  }

  it('write: a valid mixed payload is cached without the private records', async () => {
    const { code, out, cache } = await runAgainst({ schemaVersion: 1, totalEvents: 2, events: [TIO, FROG] }, []);
    assert.equal(code, 0, out);
    const written = JSON.parse(fs.readFileSync(cache, 'utf8'));
    assert.deepEqual(written.events, [TIO]);
    assert.equal(written.totalEvents, 1);
    assert.doesNotMatch(fs.readFileSync(cache, 'utf8'), /eventfrog/);
  });
});
