import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveImportConflictsInText,
  resolveSafeTextConflictsInText,
} from '../../scripts/ci/pr-autorebase.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(HERE, '..', '..', 'scripts', 'ci', 'pr-autorebase.mjs');

test('#606 unisce le entry stringa aggiunte dai due lati allo stesso array', () => {
  const conflicted = [
    'const SLUGS = [',
    "  'base',",
    '<<<<<<< HEAD',
    "  'branch-entry',",
    '||||||| base',
    '=======',
    "  'main-entry',",
    '>>>>>>> origin/main',
    '];',
    '',
  ].join('\n');

  assert.equal(resolveSafeTextConflictsInText(conflicted), [
    'const SLUGS = [',
    "  'base',",
    "  'branch-entry',",
    "  'main-entry',",
    '];',
    '',
  ].join('\n'));
});

test('#606 conserva il resolver import-only anche con marker diff3', () => {
  const conflicted = [
    '<<<<<<< HEAD',
    "import { alpha } from './alpha.mjs';",
    '||||||| base',
    '=======',
    "import { beta } from './beta.mjs';",
    '>>>>>>> origin/main',
    '',
  ].join('\n');
  const expected = [
    "import { alpha } from './alpha.mjs';",
    "import { beta } from './beta.mjs';",
    '',
  ].join('\n');
  assert.equal(resolveImportConflictsInText(conflicted), expected);
  assert.equal(resolveSafeTextConflictsInText(conflicted), expected);
});

test('#606 rifiuta modifiche, statement liberi e collisioni di chiave', () => {
  const cases = [
    [
      '<<<<<<< HEAD',
      "  'changed-by-branch',",
      '||||||| base',
      "  'base',",
      '=======',
      "  'base',",
      "  'main-addition',",
      '>>>>>>> origin/main',
    ],
    [
      '<<<<<<< HEAD',
      '  runBranchSideEffect();',
      '||||||| base',
      '=======',
      '  runMainSideEffect();',
      '>>>>>>> origin/main',
    ],
    [
      '<<<<<<< HEAD',
      '  timeout: 10,',
      '||||||| base',
      '=======',
      '  timeout: 20,',
      '>>>>>>> origin/main',
    ],
  ];
  for (const lines of cases) {
    assert.equal(resolveSafeTextConflictsInText(lines.join('\n')), null);
  }
});

test('#606 non riunisce import quando un lato modifica o cancella il base', () => {
  const conflicted = [
    '<<<<<<< HEAD',
    "import { replacement } from './replacement.mjs';",
    '||||||| base',
    "import { shared } from './shared.mjs';",
    '=======',
    "import { shared } from './shared.mjs';",
    "import { addition } from './addition.mjs';",
    '>>>>>>> origin/main',
    '',
  ].join('\n');

  assert.equal(resolveSafeTextConflictsInText(conflicted), null);
});

test('#606 rifiuta collisioni con chiavi già nel base o con sintassi equivalente', () => {
  const cases = [
    [
      '<<<<<<< HEAD',
      '  existing: 1,',
      '||||||| base',
      '  existing: 1,',
      '=======',
      '  existing: 2,',
      '>>>>>>> origin/main',
    ],
    [
      '<<<<<<< HEAD',
      '  foo: 1,',
      '||||||| base',
      '  stable: 0,',
      '=======',
      '  "foo": 2,',
      '>>>>>>> origin/main',
    ],
    [
      '<<<<<<< HEAD',
      '  foo: 1, bar: 2,',
      '||||||| base',
      '  stable: 0,',
      '=======',
      '  baz: 3,',
      '>>>>>>> origin/main',
    ],
    [
      '<<<<<<< HEAD',
      '  foo,',
      '||||||| base',
      '  stable: 0,',
      '=======',
      '  foo: 2,',
      '>>>>>>> origin/main',
    ],
  ];

  for (const lines of cases) {
    assert.equal(resolveSafeTextConflictsInText(lines.join('\n')), null);
  }
});

test('#606 il merge usa diff3 e il fallback resta fail-closed', () => {
  const source = readFileSync(SOURCE, 'utf8');
  assert.equal(
    (source.match(/'merge\.conflictstyle=diff3'/g) || []).length,
    2,
    'entrambi i merge runtime devono esporre il base al resolver additivo',
  );
  assert.match(source, /if \(!done\) git\(\['merge', '--abort'\]/);
  assert.match(source, /resolveSafeTextConflicts\(\)/);
});
