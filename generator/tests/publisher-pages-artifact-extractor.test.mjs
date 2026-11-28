import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXTRACTOR = path.join(ROOT, 'generator/scripts/extract-publisher-pages-artifact.py');
const CREATE_TAR = String.raw`
import io, json, sys, tarfile
archive, entries_json = sys.argv[1], sys.stdin.read()
entries = json.loads(entries_json)
with tarfile.open(archive, 'w', format=tarfile.PAX_FORMAT) as tar:
    for item in entries:
        info = tarfile.TarInfo(item['name'])
        kind = item.get('type', 'file')
        if kind == 'directory':
            info.type = tarfile.DIRTYPE
            tar.addfile(info)
        elif kind == 'symlink':
            info.type = tarfile.SYMTYPE
            info.linkname = item.get('linkname', '../escape')
            tar.addfile(info)
        elif kind == 'hardlink':
            info.type = tarfile.LNKTYPE
            info.linkname = item.get('linkname', 'manifest.json')
            tar.addfile(info)
        else:
            data = item.get('contents', '').encode()
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
`;

const requiredEntries = [
  { name: './manifest.json', contents: '{"commit":"0123456789abcdef0123456789abcdef01234567"}' },
  { name: './edge/sections/registry.json', contents: '{"commit":"0123456789abcdef0123456789abcdef01234567"}' },
];

function withWrapper(entries, callback) {
  const root = mkdtempSync(path.join(tmpdir(), 'publisher-pages-artifact-'));
  const wrapper = path.join(root, 'downloaded-pages-artifact');
  mkdirSync(wrapper);
  const archive = path.join(wrapper, 'artifact.tar');
  const staging = path.join(root, 'fresh-staging');
  try {
    execFileSync('python3', ['-c', CREATE_TAR, archive], { input: JSON.stringify(entries) });
    return callback({ root, wrapper, archive, staging });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runExtractor(archive, destination) {
  return spawnSync('python3', [EXTRACTOR, '--archive', archive, '--destination', destination], {
    encoding: 'utf8',
  });
}

test('extracts only publisher-owned files from the downloaded wrapper artifact.tar', () => {
  const sitemap = '<urlset><url><loc>https://example.test/it/articolo/</loc></url></urlset>';
  const entries = [
    ...requiredEntries,
    { name: './sitemap-articles-canton-ti.xml', contents: sitemap },
    { name: './unrelated/index.html', contents: 'not staged' },
    { name: './unrelated/', type: 'directory' },
    { name: './', type: 'directory' },
  ];

  withWrapper(entries, ({ archive, staging }) => {
    const result = runExtractor(archive, staging);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(path.join(staging, 'manifest.json'), 'utf8'), requiredEntries[0].contents);
    assert.equal(readFileSync(path.join(staging, 'edge/sections/registry.json'), 'utf8'), requiredEntries[1].contents);
    assert.equal(readFileSync(path.join(staging, 'sitemap-articles-canton-ti.xml'), 'utf8'), sitemap);
    assert.equal(existsSync(path.join(staging, 'unrelated/index.html')), false);
    assert.equal(statSync(archive).isFile(), true, 'la fixture replica il wrapper download con artifact.tar alla radice');
  });
});

test('requires manifest and edge registry before reporting extraction success', () => {
  for (const entries of [
    [requiredEntries[1]],
    [requiredEntries[0]],
  ]) {
    withWrapper(entries, ({ archive, staging }) => {
      const result = runExtractor(archive, staging);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /artifact privo dei file publisher richiesti/);
      assert.equal(existsSync(staging), false, 'rimuove lo staging parziale dopo un errore');
    });
  }
});

test('rejects traversal and absolute member paths without writing outside staging', () => {
  for (const badName of ['../escape.txt', '/tmp/publisher-pages-escape.txt', 'C:/publisher-pages-escape.txt']) {
    withWrapper([...requiredEntries, { name: badName, contents: 'escape' }], ({ root, archive, staging }) => {
      const result = runExtractor(archive, staging);
      assert.notEqual(result.status, 0, badName);
      assert.match(result.stderr, /percorso artifact non valido|percorso assoluto/);
      assert.equal(existsSync(path.join(root, 'escape.txt')), false);
      assert.equal(existsSync(staging), false);
    });
  }
});

test('rejects symlink and hardlink members even when they are not extracted', () => {
  for (const linkType of ['symlink', 'hardlink']) {
    withWrapper([...requiredEntries, { name: './unused-link', type: linkType }], ({ archive, staging }) => {
      const result = runExtractor(archive, staging);
      assert.notEqual(result.status, 0, linkType);
      assert.match(result.stderr, /tipo di membro non ammesso/);
      assert.equal(existsSync(staging), false);
    });
  }
});

test('workflow extracts the wrapper tar before reading publisher state and uses that staging for readiness', () => {
  const workflow = readFileSync(path.join(ROOT, '.github/workflows/refresh-canton-hubs.yml'), 'utf8');
  const steps = [...workflow.matchAll(/^      - name: (.+)$/gm)].map((match) => ({ name: match[1], index: match.index }));
  const index = (name) => steps.find((step) => step.name === name)?.index ?? -1;

  assert.match(workflow, /path: \$\{\{ runner\.temp \}\}\/publish-api-wrapper/);
  assert.match(workflow, /ARTIFACT_ARCHIVE: \$\{\{ runner\.temp \}\}\/publish-api-wrapper\/artifact\.tar/);
  assert.match(workflow, /STAGING_DIR: \$\{\{ runner\.temp \}\}\/publish-api-staged/);
  assert.match(workflow, /extract-publisher-pages-artifact\.py --archive "\$ARTIFACT_ARCHIVE" --destination "\$STAGING_DIR"/);
  assert.match(workflow, /PUBLISH_API_ARTIFACT_DIR: \$\{\{ runner\.temp \}\}\/publish-api-staged/);
  assert.ok(index('Download publisher Pages artifact') < index('Checkout'));
  assert.ok(index('Checkout') < index('Setup Node.js'));
  assert.ok(index('Setup Node.js') < index('Extract publisher Pages artifact safely'));
  assert.ok(index('Extract publisher Pages artifact safely') < index('Resolve publisher artifact state'));
  assert.ok(index('Resolve publisher artifact state') < index('Checkout publisher artifact source'));
  assert.ok(index('Checkout publisher artifact source') < index('Resolve run mode'));
});
