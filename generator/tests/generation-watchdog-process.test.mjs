import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sliceBetween } from './lib/anchored-slice.mjs';

const workflow = readFileSync(new URL('../../.github/workflows/generate-article.yml', import.meta.url), 'utf8');
const processHelpers = readFileSync(new URL('../../scripts/ci/generation-watchdog-process.sh', import.meta.url), 'utf8');
const cleanup = sliceBetween(workflow, '            if wait "$attempt_pid";', '            if [ "$tee_rc" -ne 0 ];');

test('il Bash del watchdog seleziona Node e completa la cattura solo dopo uno stallo', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'generation-watchdog-'));
  try {
    const script = 'generator/scripts/create-article.mjs';
    mkdirSync(join(dir, 'generator/scripts'), { recursive: true });
    writeFileSync(join(dir, script), `
      import { writeFileSync } from 'node:fs';
      writeFileSync('node.pid', String(process.pid));
      setTimeout(() => {}, 2000);
    `);

    function runBash(body, ...args) {
      const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', processHelpers + body, 'fixture', process.execPath, ...args], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 4500,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    }

    await t.test('seleziona il solo figlio Node nel sottoalbero del wrapper', () => {
      const selected = runBash(`
        ps -A -o pid= -o ppid= >/dev/null
        bash -c '"$0" "$1" & wait "$!"' "$1" "$2" &
        root=$!
        trap 'kill_tree KILL "$root"' EXIT
        while [ ! -s node.pid ] && kill -0 "$root" 2>/dev/null; do sleep 0.01; done
        node_pid="$(cat node.pid)"
        create_article_pids "$root"
        kill "$node_pid"
        wait "$root" 2>/dev/null || true
        if kill -0 "$node_pid" 2>/dev/null || kill -0 "$root" 2>/dev/null; then exit 1; fi
        trap - EXIT
      `, script);
      assert.equal(selected, readFileSync(join(dir, 'node.pid'), 'utf8'));
    });

    await t.test('attende la cattura nello stallo e cancella il watcher nel percorso ordinario', () => {
      for (const mode of ['stalled', 'ordinary']) {
        runBash(`
          stall_flag="$2.flag"
          attempt_pipe="$2.pipe"
          mkfifo "$attempt_pipe"
          "$1" -e '
            const fs = require("node:fs");
            if (process.argv[1] === "stalled") fs.writeFileSync("stalled.flag", "");
            fs.writeFileSync(process.argv[1] + ".ready", "");
            setTimeout(() => {
              if (fs.existsSync(process.argv[1] + ".pipe")) {
                fs.writeFileSync(process.argv[1] + ".captured", "");
              }
            }, 500);
          ' "$2" &
          watch_pid=$!
          fixture_watch_pid=$watch_pid
          trap 'kill_tree KILL "$fixture_watch_pid"' EXIT
          while [ ! -f "$2.ready" ] && kill -0 "$watch_pid" 2>/dev/null; do sleep 0.01; done
          [ -f "$2.ready" ]
          (exit 124) &
          attempt_pid=$!
          (exit 0) &
          tee_pid=$!
          ${cleanup}
          [ "$rc" -eq 124 ]
          [ "$tee_rc" -eq 0 ]
          [ -z "$watch_pid$tee_pid$attempt_pipe" ]
          [ ! -e "$2.pipe" ]
          if kill -0 "$fixture_watch_pid" 2>/dev/null; then exit 1; fi
          trap - EXIT
        `, mode);
      }
      assert.equal(readFileSync(join(dir, 'stalled.captured'), 'utf8'), '');
      assert.throws(() => readFileSync(join(dir, 'ordinary.captured')), { code: 'ENOENT' });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
