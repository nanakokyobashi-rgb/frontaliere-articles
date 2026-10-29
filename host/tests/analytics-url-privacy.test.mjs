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

// Regression cases from the source helper review.
const cases=[
 [' \u0000https://user:password@example.test/path?ac=secret','https://example.test/path'],
 [' \t//user:password@example.test/path?ac=secret','//example.test/path'],
 ['https:\n//user:password@example.test/path?ac=secret','https://example.test/path'],
 ['https://user:password@example.test/path','https://example.test/path'],
 ['//user:password@example.test/path','//example.test/path'],
 ['https://user:p%40ss@example.test/path?utm_source=email','https://example.test/path?utm_source=email'],
 ['//example.test:8443/path?ac=secret&utm_source=email#anchor','//example.test:8443/path?utm_source=email#anchor'],
 ['#route?ac=secret&utm_source=email','#route?utm_source=email'],
 ['#/route?ac=secret&utm_source=email','#/route?utm_source=email'],
 ['./route?ac=secret&utm_source=email','./route?utm_source=email'],
 ['https://user:password@[broken/path?ac=secret',''],
];
for(const [input,expected] of cases)test('userinfo and URL form '+JSON.stringify(input),()=>assert.equal(sanitizeTelemetryProperties({page_location:input}).page_location,expected));
for(const relative of ['./route','../route',' ./route'])test('encoded nested relative '+relative,()=>{
 const result=sanitizeTelemetryProperties({page_location:'https://redirect.test/?next='+encodeURIComponent(relative+'?ac=secret&utm_source=email')}).page_location;
 assert.equal(new URL(result).searchParams.get('next'),relative.trim()+'?utm_source=email');
});
test('nested userinfo remains scrubbed beyond the previous recursion depth',()=>{
 let nested='https://user:password@destination.test/path?ac=secret&utm_source=inner';
 for(let i=0;i<4;i++)nested='https://redirect.test/?url='+encodeURIComponent(nested)+'&utm_source=email';
 let cleaned=sanitizeTelemetryProperties({page_location:nested}).page_location;
 for(let i=0;i<4;i++){const parsed=new URL(cleaned);assert.equal(parsed.searchParams.get('utm_source'),'email');cleaned=parsed.searchParams.get('url');}
 const end=new URL(cleaned);assert.equal(end.username,'');assert.equal(end.password,'');assert.equal(end.searchParams.get('ac'),null);assert.equal(end.searchParams.get('utm_source'),'inner');assert.equal(end.pathname,'/path');
});
test('ordinary campaign path stays byte-identical',()=>{
 const value='/path?utm_campaign=a%20b&action=continue#details';assert.equal(sanitizeTelemetryProperties({page_path:value}).page_path,value);
});
for(const reference of ['https:user:password@example.test/path','https:/user:password@example.test/path','http:user:password@example.test/path'])test('nested slashless '+reference,()=>{
 const out=sanitizeTelemetryProperties({page_location:'https://redirect.test/?redirect='+encodeURIComponent(reference+'?ac=secret&utm_source=email')}).page_location;
 const nested=new URL(new URL(out).searchParams.get('redirect'));assert.equal(nested.username,'');assert.equal(nested.password,'');assert.equal(nested.hostname,'example.test');assert.equal(nested.search,'?utm_source=email');
});
