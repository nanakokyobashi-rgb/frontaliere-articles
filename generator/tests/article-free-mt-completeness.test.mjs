import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { translateFieldFreeMt } from '../scripts/lib/article-free-mt.mjs';

const sourceBody = `${'Paragrafo italiano completo. '.repeat(80)}\n\n${'Secondo blocco completo. '.repeat(80)}`;

describe('translateFieldFreeMt — completezza dei body', () => {
  test('rifiuta un body free-MT materialmente troncato e lo manda al recupero', async () => {
    const events = [];
    const warnings = [];
    const out = await translateFieldFreeMt({
      text: sourceBody,
      sourceLang: 'it',
      targetLang: 'de',
      fieldType: 'description',
      fieldName: 'body1',
      translate: async () => 'Vollständiger Anfang. '.repeat(35),
      onUnusableOutput: (event) => events.push(event),
      onWarn: (warning) => warnings.push(warning),
    });

    assert.equal(out, '');
    assert.equal(events.at(-1)?.reason, 'semantic-truncation');
    assert.match(warnings.at(-1) || '', /caratteri/);
  });

  test('accetta un body che conserva almeno il rapporto minimo', async () => {
    const translated = Array.from({ length: 100 }, () => 'Vollständiger übersetzter Abschnitt.').join(' ');
    const out = await translateFieldFreeMt({
      text: sourceBody,
      sourceLang: 'it',
      targetLang: 'de',
      fieldType: 'description',
      fieldName: 'body2',
      translate: async () => translated,
    });

    assert.equal(out, translated.trim());
  });

  test('non applica il floor assoluto ai titoli corti', async () => {
    const out = await translateFieldFreeMt({
      text: 'Rapporto Schengen e Dublino',
      sourceLang: 'it',
      targetLang: 'en',
      fieldType: 'title',
      fieldName: 'title',
      translate: async () => 'Schengen report',
    });

    assert.equal(out, 'Schengen report');
  });
});
