import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const id = 'sequestro-cocaina-brogeda-2026';
const key = `blog.article.${id}`;
const articlePath = locale => path.join(root, 'content/blog-body', locale, `${id}.ts`);
const sourceLinks = [
  'bc0886c8-13e5-4691-724e-d4b703f4a501', // Original joint ADM/GdF release.
  '/weisungen/fza/weisungen-fza.pdf.download.pdf/weisungen-fza-i.pdf',
  'bazg.admin.ch/it/stupefacenti-e-droga-importazione-sorveglianza',
];
function loadBody(locale) {
  const source = readFileSync(articlePath(locale), 'utf8');
  const executable = source.replace(/:\s*Record<string,\s*string>/, '')
    .replace(/export default bodySequestroCocainaBrogeda2026;/, '')
    + '\nbodySequestroCocainaBrogeda2026;';
  return vm.runInNewContext(executable, {}, { timeout: 1000 });
}
const localeConditions = {
  it: ['libera circolazione', 'proporzionata', 'espulsione penale', 'non colpevolezza'],
  en: ['free movement', 'proportionate', 'criminal expulsion', 'presumption of innocence'],
  de: ['Freizügigkeitsabkommen', 'verhältnismässige', 'strafrechtliche Landesverweisung', 'Unschuldsvermutung'],
  fr: ['libre circulation', 'proportionnée', 'expulsion pénale', 'présomption d’innocence'],
};
for (const [locale, conditions] of Object.entries(localeConditions)) {
  test(`${locale}: corrected body retains documented event and scoped primary sources`, () => {
    const body = loadBody(locale);
    const text = [1, 2, 3].map(n => body[`${key}.body${n}`]).join('\n');
    assert.ok(text.split(/\s+/).length >= 300, 'substantive correction, not an empty replacement');
    for (const link of sourceLinks) assert.ok(text.includes(link), `missing primary source ${link}`);
    for (const term of conditions) assert.ok(text.includes(term), `missing qualification ${term}`);
    assert.match(text, /15 kg/);
    assert.match(text, /14 (panetti|packages|Paketen|paquets)/);
    assert.ok(text.includes('Milano–Cortina'));
    assert.ok(text.includes('Como Bassone'));
    assert.doesNotMatch(text, /TI-987654|Rovescalli|Sinaloa|89\s*%|70\s*%|88[.,]650|0[.,]5\s*(?:g|gram)/i);
  });
  test(`${locale}: all FAQ answers retire unsupported automatic sanctions`, () => {
    const faq = JSON.parse(loadBody(locale)[`${key}.faq`]);
    assert.equal(faq.length, 3);
    for (const item of faq) {
      assert.equal(typeof item.q, 'string'); assert.equal(typeof item.a, 'string');
      assert.ok(item.q.trim()); assert.ok(item.a.trim());
    }
    assert.ok(faq.some(item => item.a.includes('SEM')));
    assert.doesNotMatch(JSON.stringify(faq), /0[.,]5|24\s*(?:ore|hours|Stunden|heures)|SDI|PEC|70\s*%|20\s*(?:anni|years|Jahre|ans)/i);
  });
  test(`${locale}: metadata no longer promises unverified consequences`, () => {
    const source = readFileSync(path.join(root, `content/blog-meta-${locale}.ts`), 'utf8');
    const lines = source.split('\n').filter(line => line.includes(`${key}.`)).join('\n');
    assert.ok(lines.includes(`${key}.title`)); assert.ok(lines.includes(`${key}.excerpt`));
    assert.doesNotMatch(lines, /68[.,]000|89\s*%|sopravvivenza|survival|Überlebens|survie/i);
  });
}
test('correction records a real modification without rewriting original publication', () => {
  const registry = readFileSync(path.join(root, 'content/blog-articles-data.ts'), 'utf8');
  const entry = registry.match(new RegExp(`id: '${id}',([\\s\\S]*?)\\n \\},`))?.[1];
  assert.ok(entry); assert.ok(entry.includes("date: '2026-03-17T21:08:34.195Z'"));
  const updated = entry.match(/updatedAt: '([^']+)'/)?.[1];
  assert.ok(updated); assert.ok(Number.isFinite(Date.parse(updated)));
  assert.ok(Date.parse(updated) > Date.parse('2026-03-17T21:08:34.195Z'));
  assert.ok(Date.parse(updated) <= Date.now());
  const seo = readFileSync(path.join(root, 'content/seo/seo-blog.ts'), 'utf8');
  const section = seo.slice(seo.indexOf(`'blog-${id}':`)).split(/\n 'blog-/)[0];
  assert.ok(section.includes('"datePublished": "2026-03-17T21:08:34+00:00"'));
  assert.ok(section.includes(`"dateModified": "${updated}"`));
  assert.doesNotMatch(section, /68[.,]000|sopravvivenza|aumentano i controlli|record di cocaina/i);
});
