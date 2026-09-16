/**
 * codex-action-bash-sandbox.test.mjs — i caller dell'action Codex devono
 * usare esclusivamente il contratto Codex. Gli input della vecchia action
 * Claude non devono riaccendere percorsi o sandbox ormai rimossi.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../..');
const WF_DIR = resolve(ROOT, '.github/workflows');
const ACTION_FILE = resolve(ROOT, '.github/actions/claude-codex-fallback/action.yml');
const CODEX_ACTION = /uses:\s*\.\/\.github\/actions\/claude-codex-fallback/;
const LEGACY_INPUT = /^(?:\s*)(allowed_non_write_users|allowed_bots|claude_args|claude_code_oauth_token):\s*/gm;

/** Valore di `chiave: <valore>` dentro un blocco di step. */
function valoreChiave(blocco, chiave) {
  const m = new RegExp(`^\\s*${chiave}:\\s*(.+?)\\s*$`, 'm').exec(blocco);
  return m ? m[1].trim() : '';
}

/** Spezza un workflow negli step di primo livello (`      - `, 6 spazi). */
function stepDi(testo) {
  const blocchi = [];
  let corrente = null;
  for (const riga of testo.split('\n')) {
    if (/^ {6}- /.test(riga)) {
      if (corrente) blocchi.push(corrente.join('\n'));
      corrente = [riga];
    } else if (corrente) {
      corrente.push(riga);
    }
  }
  if (corrente) blocchi.push(corrente.join('\n'));
  return blocchi;
}

/** Tutti gli step che invocano l'action Codex, in tutti i workflow. */
function stepCodex() {
  const out = [];
  for (const file of readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const testo = readFileSync(join(WF_DIR, file), 'utf8');
    for (const blocco of stepDi(testo)) {
      if (!CODEX_ACTION.test(blocco)) continue;
      out.push({
        file,
        nome: valoreChiave(blocco, 'name').replace(/^- /, '') || '(senza nome)',
        blocco,
        legacyInputs: [...blocco.matchAll(LEGACY_INPUT)].map((m) => m[1]),
      });
    }
  }
  return out;
}

test('il censimento degli step Codex non e\' vuoto', () => {
  const step = stepCodex();
  assert.ok(
    step.length >= 5,
    `attesi almeno 5 step Codex, trovati ${step.length}: il parser non vede piu' i workflow`,
  );
});

test('i caller Codex non valorizzano input della vecchia action Claude', () => {
  const colpevoli = stepCodex().filter((s) => s.legacyInputs.length > 0);

  assert.deepEqual(
    colpevoli.map((s) => `${s.file} → ${s.nome}: ${s.legacyInputs.join(', ')}`),
    [],
    'Un caller Codex valorizza ancora un input rimosso della action Claude.',
  );
});

test('la action Codex non installa ne\' invoca Claude', () => {
  const action = readFileSync(ACTION_FILE, 'utf8');
  assert.doesNotMatch(action, /^\s*(allowed_non_write_users|allowed_bots|claude_args|claude_code_oauth_token):\s*/m);
  assert.doesNotMatch(action, /@anthropic-ai\/claude-code/);
  assert.match(action, /Codex Luna Max primary/);
});

test('post-merge-followup non porta piu\' variabili di sandbox Claude', () => {
  const s = stepCodex().find((x) => x.file === 'post-merge-followup.yml');
  assert.ok(s, 'post-merge-followup.yml: step Codex non trovato');
  assert.doesNotMatch(s.blocco, /CLAUDE_CODE_SUBPROCESS_ENV_SCRUB/);
  assert.doesNotMatch(s.blocco, /MAX_THINKING_TOKENS/);
});
