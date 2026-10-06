/**
 * The fast-publish CDN base must be injected after the document charset.
 *
 * GitHub Pages/CDN deploys may prepend the runtime hint script to the emitted
 * head. Keeping the encoding declaration first preserves the HTML parser's
 * required early-charset invariant on article pages.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts/offload-generated-images-cdn.mjs');
const CDN = 'https://cdn.example.test';

function runOffload(html) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'frontaliere-cdn-charset-'));
  try {
    const page = path.join(temp, 'dist', 'article', 'index.html');
    fs.mkdirSync(path.dirname(page), { recursive: true });
    fs.writeFileSync(page, html, 'utf8');
    const result = spawnSync(process.execPath, [SCRIPT], {
      cwd: temp,
      env: { ...process.env, CDN_BASE: CDN },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return fs.readFileSync(page, 'utf8');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

test('injects the CDN base after a quoted charset declaration', () => {
  const html = '<!doctype html><html><head><meta charset="utf-8"><title>Articolo</title></head><body></body></html>';
  const output = runOffload(html);
  const charsetAt = output.indexOf('<meta charset="utf-8">');
  const scriptAt = output.indexOf('window.__CDN_DATA_BASE__');
  assert.ok(charsetAt > output.indexOf('<head>'));
  assert.ok(charsetAt < scriptAt);
});

test('handles an unquoted charset after ignored head markup', () => {
  const html = '<!doctype html><html><head><!-- <meta charset=utf-8> --><script>const fake = "<meta charset=utf-8>";</script><meta charset=utf-8><title>Articolo</title></head></html>';
  const output = runOffload(html);
  const charsetAt = output.lastIndexOf('<meta charset=utf-8>');
  const scriptAt = output.indexOf('window.__CDN_DATA_BASE__');
  assert.ok(charsetAt > output.indexOf('<head>'));
  assert.ok(charsetAt > output.indexOf('</script>'));
  assert.ok(charsetAt < scriptAt);
  assert.equal((output.match(/window\.__CDN_DATA_BASE__/g) || []).length, 1);
});

test('ignores raw text nested inside a template before the real charset', () => {
  const html = '<!doctype html><html><head><template><textarea><meta charset=utf-8></textarea><title><meta charset=utf-8></title></template><meta charset=utf-8><title>Articolo</title></head></html>';
  const output = runOffload(html);
  const charsetAt = output.lastIndexOf('<meta charset=utf-8>');
  const scriptAt = output.indexOf('window.__CDN_DATA_BASE__');
  assert.ok(charsetAt < scriptAt);
  assert.ok(charsetAt > output.indexOf('</template>'));
});

test('finds the real head close past inactive raw text', () => {
  const html = '<!doctype html><html><head><!-- </head> -->'
    + '<script>const fake = "</head>";</script>'
    + '<meta charset="utf-8"><title>Articolo</title></head></html>';
  const output = runOffload(html);
  const charsetAt = output.indexOf('<meta charset="utf-8">');
  const scriptAt = output.indexOf('window.__CDN_DATA_BASE__');
  assert.ok(output.indexOf('</script>') < charsetAt);
  assert.ok(charsetAt < scriptAt);
});

test('does not treat a slash in an unquoted template value as self-closing', () => {
  const html = '<!doctype html><html><head><template data-src=/foo/>'
    + '<meta charset=utf-8></template><meta charset=utf-8><title>Articolo</title></head></html>';
  const output = runOffload(html);
  const templateEnd = output.indexOf('</template>');
  const charsetAt = output.lastIndexOf('<meta charset=utf-8>');
  const scriptAt = output.indexOf('window.__CDN_DATA_BASE__');
  assert.ok(templateEnd < charsetAt);
  assert.ok(charsetAt < scriptAt);
});

test('keeps CDN payloads when one HTML page has no active head', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'frontaliere-cdn-charset-guard-'));
  try {
    const dist = path.join(temp, 'dist');
    fs.mkdirSync(path.join(dist, 'article'), { recursive: true });
    fs.mkdirSync(path.join(dist, 'broken'), { recursive: true });
    fs.mkdirSync(path.join(dist, 'data'), { recursive: true });
    fs.mkdirSync(path.join(dist, 'images', 'brands'), { recursive: true });
    fs.writeFileSync(
      path.join(dist, 'article', 'index.html'),
      '<!doctype html><html><head><meta charset="utf-8"><title>Articolo</title></head></html>',
      'utf8',
    );
    fs.writeFileSync(
      path.join(dist, 'broken', 'index.html'),
      '<!doctype html><html><body><!-- window.__CDN_DATA_BASE__=\"https://stale.example\" -->senza head</body></html>',
      'utf8',
    );
    fs.writeFileSync(path.join(dist, 'data', 'keep.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(dist, 'images', 'brands', 'logo.webp'), 'asset', 'utf8');

    const result = spawnSync(process.execPath, [SCRIPT], {
      cwd: temp,
      env: { ...process.env, CDN_BASE: CDN },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /missing from 1\/2 HTML page/);
    assert.ok(fs.existsSync(path.join(dist, 'data', 'keep.json')), 'un page senza head deve mantenere dist/data');
    assert.ok(fs.existsSync(path.join(dist, 'images', 'brands', 'logo.webp')), 'un page senza head deve mantenere le immagini runtime');
    assert.match(fs.readFileSync(path.join(dist, 'article', 'index.html'), 'utf8'), /window\.__CDN_DATA_BASE__/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
