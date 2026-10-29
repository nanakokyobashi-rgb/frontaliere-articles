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
test('nested userinfo is removed at the canonical recursion budget',()=>{
 let nested='https://user:password@destination.test/path?ac=secret&utm_source=inner';
 for(let i=0;i<4;i++)nested='https://redirect.test/?url='+encodeURIComponent(nested)+'&utm_source=email';
 let cleaned=sanitizeTelemetryProperties({page_location:nested}).page_location;
 for(let i=0;i<4;i++){const parsed=new URL(cleaned);assert.equal(parsed.searchParams.get('utm_source'),'email');cleaned=parsed.searchParams.get('url');}
 const end=new URL(cleaned);assert.equal(end.username,'');assert.equal(end.password,'');assert.equal(end.search,'');assert.equal(end.pathname,'/path');
});
test('ordinary campaign path stays byte-identical',()=>{
 const value='/path?utm_campaign=a%20b&action=continue#details';assert.equal(sanitizeTelemetryProperties({page_path:value}).page_path,value);
});
for(const reference of ['https:user:password@example.test/path','https:/user:password@example.test/path','http:user:password@example.test/path'])test('nested slashless '+reference,()=>{
 const out=sanitizeTelemetryProperties({page_location:'https://redirect.test/?redirect='+encodeURIComponent(reference+'?ac=secret&utm_source=email')}).page_location;
 const nested=new URL(new URL(out).searchParams.get('redirect'));assert.equal(nested.username,'');assert.equal(nested.password,'');assert.equal(nested.hostname,'example.test');assert.equal(nested.search,'?utm_source=email');
});

// Fragment and bare-reference regressions.
const fragmentCases=[
 ['https://outer.test/#https://user:password@inner.test/path','https://outer.test/#https://inner.test/path'],
 ['https://outer.test/#'+encodeURIComponent('https://user:password@inner.test/path?utm_campaign=a%26b'),'https://outer.test/#'+encodeURIComponent('https://inner.test/path?utm_campaign=a%26b')],
 ['https://outer.test/#next='+encodeURIComponent('https://user:password@inner.test/path'),'https://outer.test/#next='+encodeURIComponent('https://inner.test/path')],
 ['https://outer.test/#route?ac=secret&utm_source=email','https://outer.test/#route?utm_source=email'],
 ['https://outer.test/#'+encodeURIComponent('route?email=secret&utm_source=email'),'https://outer.test/#'+encodeURIComponent('route?utm_source=email')],
 ['https://outer.test/#next=https://user:password@inner.test/path?ac=secret&utm_source=email','https://outer.test/#utm_source=email&next='+encodeURIComponent('https://inner.test/path')],
];for(const[input,expected]of fragmentCases)test('fragment '+input,()=>assert.equal(sanitizeTelemetryProperties({page_location:input}).page_location,expected));
for(const relative of ['login?email=secret&utm_source=email','login#ne=secret&utm_source=email'])test('bare relative '+relative,()=>{const input='https://outer.test/?next='+encodeURIComponent(relative)+'&utm_medium=payment_reminder';const out=new URL(sanitizeTelemetryProperties({page_location:input}).page_location);assert.equal(out.searchParams.get('next'),relative.replace(/(?:email|ne)=secret&/,''));assert.equal(out.searchParams.get('utm_medium'),'payment_reminder');});
for(const hash of ['#ordinary-route','#caf%C3%A9','#topic=a%20b'])test('ordinary hash '+hash,()=>{const input='https://outer.test/?utm_campaign=a%26b'+hash;assert.equal(sanitizeTelemetryProperties({page_location:input}).page_location,input)});

// Undecodable fragments are omitted from telemetry.
const malformedFragments=['https://user:password@inner.test/path%ZZ?ac=secret&ne=person',encodeURIComponent('https://user:password@inner.test/path?ac=secret&ne=person')+'%ZZ',encodeURIComponent('https://user:password@inner.test/path')+'%ZZ&ac=secret&ne=person','route?ac=secret&ne=person&value=%ZZ','invalid%escape','%E0%A4%A'];
for(const fragment of malformedFragments)test('malformed fragment omitted '+fragment,()=>{
 const prefix='https://outer.test/?application_concierge_service_id=service-test&utm_source=email&utm_campaign=a%26b';const input=prefix+'#'+fragment;const data={page_location:input,page_referrer:input};assert.deepEqual(sanitizeTelemetryProperties(data),{page_location:prefix,page_referrer:prefix});assert.equal(data.page_location,input);
});
