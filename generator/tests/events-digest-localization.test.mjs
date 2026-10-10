import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findArticleLocalizedToponymMismatches } from '../scripts/lib/localized-toponyms.mjs';
import { repairEventsDigestLocalizedToponyms } from '../scripts/lib/events-digest-localization.mjs';

function incidentArticle() {
  return {
    imageAlt: {
      it: 'Eventi in Zurigo',
      en: 'Events in Zürich',
      de: 'Veranstaltungen in Zurich',
      fr: 'Événements à Zürich',
    },
    content: {
      it: {
        body2: 'Ginevra; Zurigo; Ticino; Sion; Berna; Coira.',
        faq: [{ q: 'Eventi in Ginevra?' }],
      },
      en: {
        body2: '### [Genève](/en/events/geneva/)\nZürich',
        faq: [{ q: 'Events in Genève?' }],
      },
      de: {
        body2: 'Genève; Ticino; Sion; Zurich.',
        faq: [{ q: 'Veranstaltungen in Genève?' }],
      },
      fr: {
        body2: 'Bern; Chur; Ticino; Zürich.',
        faq: [{ q: 'Événements à Genève?' }],
      },
    },
  };
}

describe('repairEventsDigestLocalizedToponyms', () => {
  it('repairs the live digest failure set before the unchanged factuality gate', () => {
    const original = incidentArticle();
    const before = findArticleLocalizedToponymMismatches(original);
    const keys = before.map(({ locale, code, form, expected }) => `${locale}:${code}:${form}->${expected}`).sort();
    assert.deepEqual(keys, [
      'de:GE:Genève->Genf',
      'de:TI:Ticino->Tessin',
      'de:VS:Sion->Sitten',
      'de:ZH:Zurich->Zürich',
      'en:GE:Genève->Geneva',
      'en:ZH:Zürich->Zurich',
      'fr:BE:Bern->Berne',
      'fr:GR:Chur->Coire',
      'fr:TI:Ticino->Tessin',
      'fr:ZH:Zürich->Zurich',
    ]);

    const repaired = repairEventsDigestLocalizedToponyms(original);
    assert.deepEqual(findArticleLocalizedToponymMismatches(repaired), []);
    assert.match(repaired.content.en.body2, /\[Geneva\]\(\/en\/events\/geneva\/\)/);
    assert.equal(repaired.content.de.body2, 'Genf; Tessin; Sitten; Zürich.');
    assert.equal(repaired.content.fr.body2, 'Berne; Coire; Tessin; Zurich.');
    assert.equal(repaired.imageAlt.en, 'Events in Zurich');
    assert.equal(repaired.content.en.faq[0].q, 'Events in Geneva?');
    assert.equal(original.content.en.body2, '### [Genève](/en/events/geneva/)\nZürich');
    assert.deepEqual(repairEventsDigestLocalizedToponyms(repaired), repaired);
  });
});
