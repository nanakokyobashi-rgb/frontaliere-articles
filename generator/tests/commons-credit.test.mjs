/**
 * commons-credit.test.mjs — the credit of a Wikimedia Commons cover, read when
 * the cover is chosen (P14, `generator/scripts/lib/commons-credit.mjs`).
 * Run with `node --test`.
 *
 * The fixture is the P14 probe of 2026-10-04 in snapshot form: every Commons
 * file behind a cover of either usage map, 532 titles, as the API returned
 * them (only the fields the rule and the record read; the three e-mail
 * addresses replaced with example.org ones, which the rule treats the same).
 * The probe classified them with jsdom; the dependency-free sanitiser must
 * reach the same verdicts, file by file — not just the same totals.
 */
import '../../host/cantonSectionsBootstrap.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ARTIST_SHAPES,
  acceptCommonsCandidate,
  assessCommonsFile,
  chooseCommonsCredit,
  classifyArtistShape,
  commonsLinkKind,
  creditRecordForCover,
  creditTemplate,
  fetchCommonsFileInfo,
  finalizeCreditRecord,
  loadCommonsUsage,
  modifiedFor,
  readCommonsPage,
  resolveCommonsPick,
  sanitizeCommonsHtml,
  titleFromCommonsUrl,
  webpDimensions,
  writeCreditRecord,
} from '../scripts/lib/commons-credit.mjs';
import { validateImageCreditRecord } from '../../engine/shared/imageCredits.mjs';

const SNAPSHOT = JSON.parse(fs.readFileSync(new URL('./fixtures/commons-credit/probe-2026-10-04.snapshot.json', import.meta.url), 'utf-8'));
const file = (title) => {
  const entry = SNAPSHOT.files[title];
  assert.ok(entry, `fixture lacks «${title}»`);
  return { title, ...entry };
};

/** A synthetic WebP header (extended format) of the given size. */
function webpHeader(width, height) {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(22, 4);
  b.write('WEBPVP8X', 8, 'ascii');
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'commons-credit-'));
}

// ── The 15 shapes of `Artist` ──────────────────────────────────────────────

/** One real file per shape, with what a reader sees and the name the rule takes. */
const SHAPES = [
  ['one-link:commons-user', '2019- Olten Train Station, Solothurn, Switzerland ( Ank Kumar ) 09.jpg', 'Ank Kumar', [['commons-user', 'Ank Kumar']], 'Ank Kumar', 'first-profile-link'],
  ['one-link:wikidata', 'SBB Historic - F 122 00433 001 - Gorgier - St-Aubin Stationsgebaeude Bahnseite.jpg', 'Hans-Rudolf Berner', [['wikidata', 'Hans-Rudolf Berner']], 'Hans-Rudolf Berner', 'first-profile-link'],
  ['one-link:external', 'Lugano, Switzerland - panoramio (42).jpg', 'marco mini', [['external:web.archive.org', 'marco mini']], 'marco mini', 'attribution'],
  ['one-link:flickr', 'Classroom problems in the education of gifted children (1917) (14591177510).jpg', 'Internet Archive Book Images', [['flickr', 'Internet Archive Book Images']], 'Internet Archive Book Images', 'first-profile-link'],
  ['one-link:commons-other', 'Lugano prokudin.jpg', 'Sergei Mikhailovich Prokudin-Gorskii', [['commons-other', 'Sergei Mikhailovich Prokudin-Gorskii']], 'Sergei Mikhailovich Prokudin-Gorskii', 'plain-text'],
  ['one-link:flickr+text', 'Switzerland - Comune di Chiasso Police Patch.jpg', 'Dave Conner from Inverness, Scotland', [['flickr', 'Dave Conner']], 'Dave Conner', 'first-profile-link'],
  ['plain-text', 'Classroom problems in the education of gifted children (1917) (14777509592).jpg', 'Henry, Theodore Spafford', [], 'Henry, Theodore Spafford', 'plain-text'],
  ['one-link:external+text', 'KFOR RC East’s Task Force MP reflects on its deployment (6142236).jpg', 'U.S. Army 340PAD by Sgt. Lynnwood Thomas', [['external:dvidshub.net', 'Lynnwood Thomas']], 'U.S. Army 340PAD by Sgt. Lynnwood Thomas', 'plain-text'],
  ['unknown-author', "Gottlieb Duttweiler - Familie, 'Dutti' rechts - Strohhaus-Ausstellung 'Park im Grüene' 2015-06-17 18-25-09.JPG", 'Unknown, upload by Roland zh', [['commons-user', 'Roland zh']], null, 'attribution-needs-curation'],
  ['one-link:commons-redlink', 'Gorgier station nov 2020.jpg', 'PetOtools', [['commons-redlink', 'PetOtools']], 'PetOtools', 'first-profile-link'],
  ['multi-link', 'Playground, Fryšták kindergarten (07).jpg', 'I would appreciate being notified if you use my work outside Wikimedia. Do not copy this image illegally by ignoring the terms of the license below, as it is not in the public domain. If you would like special permission to use, license, or purchase the image please contact me to negotiate terms. More of my work can be found in my personal gallery.', [['commons-other', 'being notified'], ['commons-other', 'contact me'], ['commons-other', 'personal gallery']], 'Pavel Ševela', 'attribution'],
  ['one-link:commons-user+text', 'Piazza grande locarno switzerland.jpg', 'Arno Konings (Schweiz-bilder)', [['commons-user', 'Schweiz-bilder']], 'Schweiz-bilder', 'first-profile-link'],
  ['absent', 'Voting sign Switzerland (2024, cropped).jpg', null, [], null, 'no-author'],
  ['html-no-link', 'CH.VS.Zermatt Sunnegga Grindjisee Matterhorn 9034 16x9-R 16K.jpg', 'NOTE: This image is a panorama consisting of multiple frames that were merged or stitched in software. As a result, this image necessarily underwent some form of digital manipulation. These manipulations may include blending, blurring, cloning, and color and perspective adjustments. As a result of these adjustments, the image content may be slightly different from reality at the points where multiple images were combined. This manipulation is often required due to lens, perspective, and parallax distortions.', [], null, 'artist-not-a-name'],
  ['one-link:wikipedia-article', 'Charlie Davis with his pay slip. Coleman Fuel Company, Red Bird Mine, Field, Bell County, Kentucky - NARA - 541139.jpg', 'Russell Lee', [['wikipedia-article', 'Russell Lee']], 'Russell Lee', 'first-profile-link'],
];

test('the fixture covers each of the 15 Artist shapes the probe found, once', () => {
  assert.equal(ARTIST_SHAPES.length, 15);
  assert.deepEqual(SHAPES.map(([shape]) => shape).sort(), [...ARTIST_SHAPES].sort());
});

for (const [shape, title, text, links, name, via] of SHAPES) {
  test(`Artist shape ${shape}: text, links and name as a reader sees them`, () => {
    const f = file(title);
    const reduced = sanitizeCommonsHtml(f.meta.Artist ?? null);
    assert.equal(classifyArtistShape(f.meta.Artist ?? null, reduced), shape);
    assert.equal(reduced.text, text);
    assert.deepEqual(reduced.links.map((l) => [commonsLinkKind(l.href), l.text]), links);
    const { named } = assessCommonsFile(f);
    assert.equal(named.name, name);
    assert.equal(named.via, via);
  });
}

test('sanitiser: hidden text, styles, scripts and reference marks are not text', () => {
  const r = sanitizeCommonsHtml('Unknown<span style="display: none;">Unknown </span>, upload by <a href="//commons.wikimedia.org/wiki/User:Ex">Ex</a>'
    + '<style>.x{color:red}</style><script>alert("x")</script><sup class="reference">[1]</sup><span class="mw-hidden">hidden</span>');
  assert.equal(r.text, 'Unknown, upload by Ex');
  assert.deepEqual(r.links, [{ href: 'https://commons.wikimedia.org/wiki/User:Ex', text: 'Ex' }]);
  assert.equal(r.hasHtml, true);
});

test('sanitiser: character references, NFC, bidi overrides and control characters', () => {
  assert.equal(sanitizeCommonsHtml('Jos&eacute; &amp; Ana&nbsp;Li &#8211; &#x2014; &#150;').text, 'José & Ana Li – — –');
  assert.equal(sanitizeCommonsHtml('José').text, 'José');
  assert.equal(sanitizeCommonsHtml('José').text.length, 4, 'NFC: one code point for é');
  assert.equal(sanitizeCommonsHtml('Ann‮Lee\u0007 ⁦x⁩').text, 'AnnLee x');
  assert.equal(sanitizeCommonsHtml('a < b &unknownentity; c').text, 'a < b &unknownentity; c');
});

test('sanitiser: block boundaries separate words, relative links become absolute', () => {
  // textContent would glue these into «AnnLeeZurich».
  assert.equal(sanitizeCommonsHtml('Ann<br>Lee<p>Zurich</p>').text, 'Ann Lee Zurich');
  const r = sanitizeCommonsHtml('<a href="/wiki/User:Y">Y</a> <!-- note --> <a href="https://www.flickr.com/people/x">X<a href="//commons.wikimedia.org/wiki/User:Z">Z</a>');
  assert.equal(r.text, 'Y XZ');
  assert.deepEqual(r.links.map((l) => [l.href, l.text]), [
    ['https://commons.wikimedia.org/wiki/User:Y', 'Y'],
    ['https://www.flickr.com/people/x', 'X'],
    ['https://commons.wikimedia.org/wiki/User:Z', 'Z'],
  ]);
});

test('sanitiser: absent is not empty', () => {
  assert.deepEqual(sanitizeCommonsHtml(null), { text: null, links: [], hasHtml: false });
  assert.equal(sanitizeCommonsHtml('').text, '');
  assert.equal(classifyArtistShape(null), 'absent');
  assert.equal(classifyArtistShape(''), 'empty');
});

// ── The acceptance rule: 492 / 38 / 2 ─────────────────────────────────────

/** The probe's review-queue-v2, file by file: every file NOT accepted, and why. */
const NOT_ACCEPTED = [
  ['review', "A starboard bow view of the vehicle cargo ship USNS ADMIRAL WILLIAM M. CALLAGHAN (T-AKR-1001) in a Mediterranean port. The ship is in the region for exercise BRIGHT STAR '85 - DPLA - e2266333cba881d2b2901dbf9b7e093f.jpeg", 'author:artist-not-a-name(courtesy)'],
  ['review', 'Altanshagal Munkhnasan, actor, at the Locarno Film Festival in Locarno, Switzerland in August 2025 1.jpg', 'restriction:personality'],
  ['review', 'Altanshagal Munkhnasan, actor, at the Locarno Film Festival in Locarno, Switzerland in August 2025 3.jpg', 'restriction:personality'],
  ['review', 'Azzaya Munkhbat, actor, at the Locarno Film Festival in Locarno, Switzerland in August 2025 2.jpg', 'restriction:personality'],
  ['review', 'Ben Rivers, director, at the Locarno Film Festival in Locarno, Switzerland in August 2025 03.jpg', 'restriction:personality'],
  ['review', 'CH.VS.Zermatt Sunnegga Grindjisee Matterhorn 9034 16x9-R 16K.jpg', 'author:artist-not-a-name'],
  ['review', 'Copy of a Dale-Schuster pump, Europe, undated Wellcome L0060514.jpg', 'author:no-author'],
  ['replace', 'Doctor Dorkar logo.png', 'deleted-on-commons'],
  ['review', 'Doctor Patient (NIH BioArt 130).png', 'author:artist-not-a-name(courtesy)'],
  ['review', 'Eduardo Casanova, director, at the Locarno Film Festival in Locarno, Switzerland in August 2025 01.jpg', 'restriction:personality'],
  ['review', 'Eduardo Casanova, director, at the Locarno Film Festival in Locarno, Switzerland in August 2025 02.jpg', 'restriction:personality'],
  ['replace', 'EHIC Slovenia.jpg', 'licence:GFDL,author:artist-not-a-name'],
  ['review', 'Emosson Construction.jpg', 'author:no-author'],
  ['review', 'Flag of the Pension Fund of Ukraine.png', 'restriction:insignia'],
  ['review', 'Food shop, Istanbul, July 2018 - 3.jpg', 'author:attribution-needs-curation'],
  ['review', 'Gabriel next to an open train door, Basel SBB train station, Basel, Switzerland julesvernex2.jpg', 'restriction:personality'],
  ['review', "Gottlieb Duttweiler - Familie, 'Dutti' rechts - Strohhaus-Ausstellung 'Park im Grüene' 2015-06-17 18-25-09.JPG", 'author:attribution-needs-curation(courtesy)'],
  ['review', 'ISS051-E-12869 (Bellinzona) lrg.jpg', 'author:artist-not-a-name(courtesy)'],
  ['review', 'ISS051-E-12869 (Bellinzona).jpg', 'author:artist-not-a-name(courtesy)'],
  ['review', 'Katia Khazak, director, at the Locarno Film Festival in Locarno, Switzerland in August 2025.jpg', 'restriction:personality'],
  ['review', 'Lugano, Switzerland - panoramio (83).jpg', 'author:attribution-needs-curation'],
  ['review', 'María Léon, actor, at the Locarno Film Festival in Locarno, Switzerland in August 2025 06.jpg', 'restriction:personality'],
  ['review', 'Mariola Fuentes, actor, at the Locarno Film Festival in Locarno, Switzerland in August 2025 01.jpg', 'restriction:personality'],
  ['review', "Mastcam-Z Views the 'Cheyava Falls' Workspace (PIA26401).jpg", 'licence:OTHER:none'],
  ['review', 'Oberfallenberg Rheintal Panorama 3.jpg', 'author:artist-not-a-name,email-in-artist'],
  ['review', 'Park Syeyoung, director, at the Locarno Film Festival in Locarno, Switzerland in August 2025 01.jpg', 'restriction:personality'],
  ['review', 'Park Syeyoung, director, at the Locarno Film Festival in Locarno, Switzerland in August 2025 02.jpg', 'restriction:personality'],
  ['review', 'Patrol Police.jpg', 'restriction:personality'],
  ['review', 'People on a platform waiting for a train, Basel SBB train station, Basel, Switzerland julesvernex2.jpg', 'restriction:personality'],
  ['review', 'Philippe Bober, producer, at the Locarno Film Festival in Locarno, Switzerland in August 2025.jpg', 'restriction:personality'],
  ['review', 'PIA11044-PhoenixLander-WorkspaceNames-20080819.jpg', 'licence:OTHER:none'],
  ['review', 'Piazza Grande at the 2026 Locarno Film Festival.jpg', 'restriction:personality'],
  ['review', 'Piazza Grande at the 78th Locarno Film Festival.jpg', 'restriction:personality'],
  ['review', 'Piazza Grande, Locarno 78.jpg', 'restriction:personality'],
  ['review', 'Pureum Kim, actor, at the Locarno Film Festival in Locarno, Switzerland in August 2025 01.jpg', 'restriction:personality'],
  ['review', 'Spectators at Piazza Grande, Locarno Film Festival.jpg', 'restriction:personality'],
  ['review', 'Storm clouds brewing in the mountains. (14909116490).jpg', 'author:artist-not-a-name'],
  ['review', 'Storm clouds brewing in the mountains. (14909201167).jpg', 'author:artist-not-a-name'],
  ['review', 'Storm clouds brewing in the mountains. (15092739701).jpg', 'author:artist-not-a-name'],
  ['review', 'Voting sign Switzerland (2024, cropped).jpg', 'author:no-author'],
];

test('regression: the rule accepts 492, reviews 38 and replaces 2 of the 532 probed files', () => {
  const titles = Object.keys(SNAPSHOT.files);
  assert.equal(titles.length, 532, 'the fixture is the whole probe, not a sample');
  const counts = { ok: 0, review: 0, replace: 0 };
  const notAccepted = [];
  for (const title of titles) {
    const verdict = assessCommonsFile(file(title));
    counts[verdict.decision] += 1;
    if (verdict.decision !== 'ok') notAccepted.push([verdict.decision, title, verdict.reasons.join(',')]);
  }
  assert.deepEqual(counts, { ok: 492, review: 38, replace: 2 });
  const sort = (rows) => [...rows].sort((a, b) => a[1].localeCompare(b[1]));
  assert.deepEqual(sort(notAccepted), sort(NOT_ACCEPTED), 'the same files, for the same reasons');
});

test('every accepted file builds a record the engine validator accepts', () => {
  let accepted = 0;
  for (const title of Object.keys(SNAPSHOT.files)) {
    const verdict = acceptCommonsCandidate(file(title), { fetchedAt: '2026-10-04' });
    if (assessCommonsFile(file(title)).decision !== 'ok') {
      assert.equal(verdict.ok, false, `${title}: a file the rule does not accept is never a candidate`);
      continue;
    }
    assert.equal(verdict.ok, true, `${title}: ${verdict.reasons?.join('; ')}`);
    const record = finalizeCreditRecord(verdict.template, { cover: '/images/blog/some-article.webp', modified: 'cropped' });
    const { valid, errors } = validateImageCreditRecord(record);
    assert.ok(valid, `${title}: ${errors.join('; ')}`);
    accepted += 1;
  }
  assert.equal(accepted, 492);
});

test('the record of Locarno 1.jpg is the design example (P14 §2.2), field for field', () => {
  const verdict = acceptCommonsCandidate(file('Locarno 1.jpg'), { fetchedAt: '2026-10-04' });
  assert.equal(verdict.ok, true);
  const record = creditRecordForCover(verdict.template, {
    cover: '/images/blog/kuhne-nagel-tagli-posti-ticino-2026.webp',
    original: { width: 2560, height: 1920 },
    coverSize: { width: 1344, height: 1008 },
  });
  assert.deepEqual(record, {
    schema: 1,
    cover: '/images/blog/kuhne-nagel-tagli-posti-ticino-2026.webp',
    source: 'wikimedia-commons',
    commons: {
      title: 'Locarno 1.jpg',
      pageUrl: 'https://commons.wikimedia.org/wiki/File:Locarno_1.jpg',
      pageId: 15180899,
      width: 2560,
      height: 1920,
      revision: '2011-05-12T01:11:59Z',
    },
    author: { text: 'Riessdo at de.wikipedia', name: 'Riessdo', url: 'https://de.wikipedia.org/wiki/User:Riessdo', type: 'Person' },
    attribution: null,
    licence: { name: 'CC BY-SA 3.0', url: 'https://creativecommons.org/licenses/by-sa/3.0/', family: 'cc-by-sa', attributionRequired: true },
    restrictions: [],
    modified: 'resized',
    fetchedAt: '2026-10-04',
    status: 'ok',
    curation: null,
  });
});

test('an attribution names whom to credit, but never links the uploader', () => {
  // Artist: «Unknown, upload by <User:Roland zh>» — the uploader, not the author.
  const f = file("Gottlieb Duttweiler - Familie, 'Dutti' rechts - Strohhaus-Ausstellung 'Park im Grüene' 2015-06-17 18-25-09.JPG");
  const clean = { ...f, meta: { ...f.meta, Attribution: 'Roland Fischer, Zürich' } };
  const assessment = assessCommonsFile(clean);
  assert.equal(assessment.decision, 'ok');
  const template = creditTemplate(assessment, clean, { fetchedAt: '2026-10-04' });
  assert.equal(template.attribution, 'Roland Fischer, Zürich');
  assert.equal(template.author.name, 'Roland Fischer, Zürich');
  assert.equal(template.author.url, null);
});

test('a port licence keeps its jurisdiction as a country code', () => {
  const verdict = acceptCommonsCandidate({ ...file('Locarno 1.jpg'), meta: { ...file('Locarno 1.jpg').meta, LicenseShortName: 'CC BY-SA 3.0 at', LicenseUrl: 'http://creativecommons.org/licenses/by-sa/3.0/at/deed.en' } });
  assert.equal(verdict.template.licence.name, 'CC BY-SA 3.0 AT');
  assert.equal(verdict.template.licence.url, 'https://creativecommons.org/licenses/by-sa/3.0/at/');
});

// ── What the generator refuses ─────────────────────────────────────────────

test('a candidate that cannot be credited is refused, with the reason', () => {
  const base = file('Locarno 1.jpg');
  const withMeta = (meta) => ({ ...base, meta: { ...base.meta, ...meta } });
  const cases = [
    ['deleted file', { title: 'Gone.jpg', exists: false }, /deleted-on-commons/],
    ['GFDL-only', withMeta({ LicenseShortName: 'GFDL 1.2', License: 'gfdl', LicenseUrl: 'http://www.gnu.org/licenses/old-licenses/fdl-1.2.html' }), /licence:GFDL/],
    ['no machine-readable licence', withMeta({ LicenseShortName: undefined, License: undefined, LicenseUrl: undefined }), /licence:OTHER:none/],
    ['personality rights', withMeta({ Restrictions: 'personality' }), /restriction:personality/],
    ['insignia', withMeta({ Restrictions: 'insignia' }), /restriction:insignia/],
    ['non-free', withMeta({ NonFree: 'true' }), /non-free/],
    ['CC BY-NC (hardening: never read as CC BY)', withMeta({ LicenseShortName: 'CC BY-NC 2.0', License: 'cc-by-nc-2.0', LicenseUrl: 'https://creativecommons.org/licenses/by-nc/2.0' }), /licence:OTHER/],
    ['an address as author', withMeta({ Artist: 'mail me: someone@example.org' }), /email-in-artist|author:/],
    ['no author where attribution is required', withMeta({ Artist: undefined }), /author:no-author/],
  ];
  for (const [label, candidate, reason] of cases) {
    for (const key of Object.keys(candidate.meta ?? {})) if (candidate.meta[key] === undefined) delete candidate.meta[key];
    const verdict = acceptCommonsCandidate(candidate);
    assert.equal(verdict.ok, false, label);
    assert.match(verdict.reasons.join(','), reason, label);
  }
});

test('a public-domain file with an unknown author is a valid courtesy credit', () => {
  const verdict = acceptCommonsCandidate(file('Copy of a Dale-Schuster pump, Europe, undated Wellcome L0060514.jpg'));
  assert.equal(verdict.ok, false, 'CC BY needs a name');
  const pd = file('Lugano prokudin.jpg');
  const unknown = acceptCommonsCandidate({ ...pd, meta: { ...pd.meta, Artist: 'Unknown author' } });
  assert.equal(unknown.ok, true);
  assert.equal(unknown.template.author.name, null);
});

test('an attribution that names nobody is no author: CC BY-SA goes to review, public domain stays a courtesy credit', () => {
  const ccBySa = file('Locarno 1.jpg');
  for (const attribution of ['Unknown', 'Anonymous', 'Autore sconosciuto', 'Unbekannter Fotograf', 'Auteur inconnu']) {
    const noArtist = { ...ccBySa, meta: { ...ccBySa.meta, Attribution: attribution } };
    delete noArtist.meta.Artist;
    const verdict = acceptCommonsCandidate(noArtist, { fetchedAt: '2026-10-04' });
    assert.equal(verdict.ok, false, `«${attribution}» is not a name to credit under CC BY-SA`);
    assert.ok(verdict.reasons.some((r) => r.startsWith('author:')), verdict.reasons.join(', '));
    // With a named Artist, the Artist is the author and the empty attribution is not shown.
    const named = acceptCommonsCandidate({ ...ccBySa, meta: { ...ccBySa.meta, Attribution: attribution } }, { fetchedAt: '2026-10-04' });
    assert.equal(named.ok, true);
    assert.equal(named.template.author.name, 'Riessdo');
    assert.equal(named.template.attribution, null);
  }
  const pd = file('Lugano prokudin.jpg');
  const courtesy = acceptCommonsCandidate({ ...pd, meta: { ...pd.meta, Artist: undefined, Attribution: 'Unknown' } }, { fetchedAt: '2026-10-04' });
  assert.equal(courtesy.ok, true, 'public domain: an unknown author is allowed');
  assert.equal(courtesy.template.author.name, null);
  assert.equal(courtesy.template.attribution, null);
});

// ── Dedup by file, reuse with the existing credit ──────────────────────────

test('dedup is by Commons file: maps and records mark a file as used; a credited file is inherited', () => {
  const root = tempRoot();
  try {
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data/blog-images-used.json'), JSON.stringify({
      'old-article': 'https://thumb.wikimedia.org/wikipedia/commons/thumb/2/2b/Lugano_prokudin.jpg/1280px-Lugano_prokudin.jpg?utm_source=commons.wikimedia.org',
    }));
    // A restricted file the owner accepted: its record carries the restriction and the curation.
    const restricted = file('Patrol Police.jpg');
    const template = creditTemplate(assessCommonsFile(restricted), restricted, { fetchedAt: '2026-10-04' });
    const accepted = finalizeCreditRecord({ ...template, status: 'ok', curation: { by: 'owner', at: '2026-10-05', note: 'Q1: kept' } }, { cover: '/images/blog/police-story.webp', modified: 'cropped' });
    writeCreditRecord(root, accepted);

    const usage = loadCommonsUsage(root);
    assert.ok(usage.titles.has('Lugano prokudin.jpg'), 'a URL of the map is read as its file title');
    assert.ok(usage.titles.has('Patrol Police.jpg'));

    const reused = chooseCommonsCredit(restricted, usage);
    assert.equal(reused.ok, true, 'an owner-accepted file is reused with its record, though a NEW pick would be refused');
    assert.equal(reused.reused, true);
    assert.deepEqual(reused.template.curation, { by: 'owner', at: '2026-10-05', note: 'Q1: kept' });
    assert.equal(acceptCommonsCandidate(restricted).ok, false, 'as a new pick the same file is refused');

    const mapOnly = chooseCommonsCredit(file('Lugano prokudin.jpg'), usage);
    assert.equal(mapOnly.ok, true);
    assert.equal(mapOnly.reused, true, 'used by an article without a record: still a last resort');

    const fresh = chooseCommonsCredit(file('Locarno 1.jpg'), usage);
    assert.equal(fresh.reused, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the file title of every URL form the API hands out', () => {
  assert.equal(titleFromCommonsUrl('https://upload.wikimedia.org/wikipedia/commons/1/18/Lugano_prokudin.jpg'), 'Lugano prokudin.jpg');
  assert.equal(titleFromCommonsUrl('https://upload.wikimedia.org/wikipedia/commons/thumb/c/ca/Dogana_di_Como-Brogeda_-_segnale.jpg/1280px-Dogana_di_Como-Brogeda_-_segnale.jpg'), 'Dogana di Como-Brogeda - segnale.jpg');
  assert.equal(titleFromCommonsUrl('https://thumb.wikimedia.org/wikipedia/commons/thumb/8/8f/32_Food_store_-_casta%C3%B1as.jpg/1280px-32_Food_store_-_casta%C3%B1as.jpg?utm_source=commons.wikimedia.org&utm_content=thumbnail'), '32 Food store - castañas.jpg');
  assert.equal(titleFromCommonsUrl('https://pixabay.com/get/abc.jpg'), null);
  assert.equal(titleFromCommonsUrl('not a url'), null);
});

test('crop or resize, from the two sizes; WebP sizes from the header alone', () => {
  assert.equal(modifiedFor({ width: 2560, height: 1920 }, { width: 1200, height: 900 }), 'resized');
  assert.equal(modifiedFor({ width: 2560, height: 1920 }, { width: 1200, height: 675 }), 'cropped');
  assert.equal(modifiedFor({ width: 2560 }, { width: 1200, height: 675 }), null);
  assert.deepEqual(webpDimensions(webpHeader(1200, 675)), { width: 1200, height: 675 });
  const lossy = Buffer.alloc(30);
  lossy.write('RIFF', 0, 'ascii'); lossy.write('WEBPVP8 ', 8, 'ascii');
  lossy.writeUInt16LE(1200, 26); lossy.writeUInt16LE(675, 28);
  assert.deepEqual(webpDimensions(lossy), { width: 1200, height: 675 });
  const lossless = Buffer.alloc(30);
  lossless.write('RIFF', 0, 'ascii'); lossless.write('WEBPVP8L', 8, 'ascii');
  lossless.writeUInt32LE((1199 & 0x3fff) | ((674 & 0x3fff) << 14), 21);
  assert.deepEqual(webpDimensions(lossless), { width: 1200, height: 675 });
  assert.equal(webpDimensions(Buffer.from('\xff\xd8\xff not a webp')), null);
  // Unknown cover size: the pipeline's target; unknown original: declared as a crop.
  const template = acceptCommonsCandidate(file('Locarno 1.jpg')).template;
  assert.equal(creditRecordForCover(template, { cover: '/images/blog/a.webp', original: { width: 1600, height: 900 }, coverSize: null }).modified, 'resized');
  assert.equal(creditRecordForCover(template, { cover: '/images/blog/a.webp', original: {}, coverSize: null }).modified, 'cropped');
});

test('a record is written only when it validates, at content/image-credits/blog/<cover>.json', () => {
  const root = tempRoot();
  try {
    const record = finalizeCreditRecord(acceptCommonsCandidate(file('Locarno 1.jpg')).template, { cover: '/images/blog/one.webp', modified: 'cropped' });
    const written = writeCreditRecord(root, record);
    assert.equal(written, path.join(root, 'content', 'image-credits', 'blog', 'one.json'));
    assert.deepEqual(JSON.parse(fs.readFileSync(written, 'utf-8')), record);
    const bad = { ...record, cover: '/images/blog/two.webp', author: { ...record.author, name: null, url: null } };
    assert.throws(() => writeCreditRecord(root, bad), /invalid: .*author\.name is required/);
    assert.equal(fs.existsSync(path.join(root, 'content', 'image-credits', 'blog', 'two.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── One file by title: the journalist path ─────────────────────────────────

/** A fake Commons API answering one title from the fixture, recording each call. */
function fakeCommons(answer) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    if (answer instanceof Error) throw answer;
    return { ok: true, status: 200, json: async () => answer };
  };
  return { calls, fetchImpl };
}

/** The API's formatversion=2 page for a fixture file. */
function apiPage(title) {
  const f = SNAPSHOT.files[title];
  if (!f.exists) return { title: `File:${title}`, missing: true };
  const extmetadata = Object.fromEntries(Object.entries(f.meta).map(([k, v]) => [k, { value: v, source: 'commons-desc-page' }]));
  return {
    pageid: f.pageId, title: `File:${title}`,
    imageinfo: [{ timestamp: f.revision, width: f.width, height: f.height, descriptionurl: f.pageUrl, url: 'https://upload.wikimedia.org/x', extmetadata }],
  };
}

test('fetchCommonsFileInfo: one read-only call, the right parameters, a rename kept as alias', async () => {
  const { calls, fetchImpl } = fakeCommons({ query: { redirects: [{ from: 'File:Locarno one.jpg', to: 'File:Locarno 1.jpg' }], pages: [apiPage('Locarno 1.jpg')] } });
  const info = await fetchCommonsFileInfo('Locarno one.jpg', { fetchImpl });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://commons.wikimedia.org/w/api.php');
  for (const [k, v] of [['action', 'query'], ['formatversion', '2'], ['redirects', '1'], ['maxlag', '5'], ['titles', 'File:Locarno one.jpg'], ['iiextmetadatalanguage', 'en']]) {
    assert.equal(url.searchParams.get(k), v, k);
  }
  assert.match(url.searchParams.get('iiprop'), /extmetadata/);
  assert.match(url.searchParams.get('iiextmetadatafilter'), /Artist.*LicenseShortName.*Restrictions/);
  assert.match(calls[0].headers['User-Agent'], /^FrontaliereTicino-ImageCredits\/\d.*frontaliereticino\.ch/);
  assert.equal(info.title, 'Locarno 1.jpg');
  assert.deepEqual(info.aliases, ['Locarno one.jpg']);
  assert.deepEqual(readCommonsPage(apiPage('Doctor Dorkar logo.png')), { title: 'Doctor Dorkar logo.png', exists: false });
});

test('resolveCommonsPick: a creditable pick, a refused one, Commons down, and a non-Commons URL', async () => {
  const root = tempRoot();
  try {
    const locarno = 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/23/Locarno_1.jpg/1280px-Locarno_1.jpg';
    let api = fakeCommons({ query: { pages: [apiPage('Locarno 1.jpg')] } });
    const ok = await resolveCommonsPick({ root, url: locarno, fetchImpl: api.fetchImpl, fetchedAt: '2026-10-04' });
    assert.equal(ok.commons, true);
    assert.equal(ok.ok, true);
    assert.equal(ok.template.author.name, 'Riessdo');
    assert.deepEqual(ok.original, { width: 2560, height: 1920 });
    assert.equal(api.calls.length, 1);

    api = fakeCommons({ query: { pages: [apiPage('Patrol Police.jpg')] } });
    const refused = await resolveCommonsPick({ root, url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Patrol_Police.jpg', fetchImpl: api.fetchImpl });
    assert.equal(refused.ok, false);
    assert.deepEqual(refused.reasons, ['restriction:personality']);

    api = fakeCommons(new Error('ETIMEDOUT'));
    const down = await resolveCommonsPick({ root, url: locarno, fetchImpl: api.fetchImpl });
    assert.equal(down.ok, false, 'no metadata, no credit: the pick is refused, never used uncredited');
    assert.match(down.reasons[0], /commons-api:ETIMEDOUT/);

    api = fakeCommons(new Error('must not be called'));
    assert.deepEqual(await resolveCommonsPick({ root, url: 'https://storage.googleapis.com/bucket/upload.jpg', fetchImpl: api.fetchImpl }), { commons: false });
    assert.equal(api.calls.length, 0);

    // Already credited: inherited from the record, no request.
    writeCreditRecord(root, finalizeCreditRecord({ ...ok.template, curation: { by: 'owner', at: '2026-10-05', note: 'type fixed' } }, { cover: '/images/blog/earlier.webp', modified: 'cropped' }));
    api = fakeCommons(new Error('must not be called'));
    const inherited = await resolveCommonsPick({ root, url: locarno, fetchImpl: api.fetchImpl });
    assert.equal(inherited.ok, true);
    assert.equal(inherited.reused, true);
    assert.deepEqual(inherited.template.curation, { by: 'owner', at: '2026-10-05', note: 'type fixed' });
    assert.equal(api.calls.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
