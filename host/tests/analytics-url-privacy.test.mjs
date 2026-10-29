import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sanitizeTelemetryProperties } from '../analyticsUrlPrivacy.js';

test('transported telemetry sanitizer removes recipient credentials and keeps campaign/order attribution', () => {
 const url = 'https://frontaliereticino.ch/cerca-lavoro-ticino/?assisted_application_order_id=order-test&ac=secret&ne=candidate%40example.test&utm_source=email#details';
 const result = sanitizeTelemetryProperties({ page_location: url, $referrer: url });
 const parsed = new URL(result.page_location);
 assert.equal(parsed.searchParams.get('ac'), null);
 assert.equal(parsed.searchParams.get('ne'), null);
 assert.equal(parsed.searchParams.get('utm_source'), 'email');
 assert.equal(parsed.searchParams.get('assisted_application_order_id'), 'order-test');
 assert.equal(parsed.hash, '#details');
 assert.equal(result.$referrer, result.page_location);
});

test('raw canonical helper is embeddable without TypeScript or runtime imports', () => {
 const source = readFileSync(new URL('../analyticsUrlPrivacy.js', import.meta.url), 'utf8').replace(/^export /m, '');
 const embedded = new Function('return (' + source + ')')();
 const properties = { page_path: '#/checkout/?authToken=secret&utm_campaign=recovery' };
 assert.deepEqual(embedded(properties), { page_path: '#/checkout/?utm_campaign=recovery' });
 assert.deepEqual(embedded(properties), sanitizeTelemetryProperties(properties));
});
