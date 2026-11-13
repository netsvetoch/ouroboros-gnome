import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewDiagnostic} from '../dist-gjs/gjs/review-diagnostic.js';
test('diagnostic known token shapes and structured credentials are masked',()=>{
 const tokens=['sk-ant-'+ 'a1'.repeat(24),'github_pat_'+ 'a1'.repeat(24),'AKIA'+'A1'.repeat(8),'gsk_'+ 'a1'.repeat(24),'hf_'+ 'a1'.repeat(24),'sk_live_'+ 'a1'.repeat(24),
  'Bearer '+ 'a1'.repeat(24),'Basic '+ 'a1'.repeat(24),'123456789:'+ 'a1'.repeat(24),'eyJ'+'a1'.repeat(10)+'.'+'a1'.repeat(10)+'.'+'a1'.repeat(10)];
 for(const token of tokens)assert.ok(!reviewDiagnostic('Provider says '+token).includes(token));
 const value={apiKey:'opaque secret',nested:[{password:'several private words',authorization:'short header',refresh_token:'opaque token',credential_profile_id:'profile',token_estimate:120}],route_fp:'a1'.repeat(32),http_status:429};
 const masked=reviewDiagnostic(value);assert.equal(masked.apiKey,'***REDACTED***');assert.equal(masked.nested[0].password,'***REDACTED***');assert.equal(masked.nested[0].authorization,'***REDACTED***');assert.equal(masked.nested[0].refresh_token,'***REDACTED***');
 assert.equal(masked.nested[0].credential_profile_id,'profile');assert.equal(masked.nested[0].token_estimate,120);assert.equal(masked.route_fp,value.route_fp);assert.equal(masked.http_status,429);assert.equal(value.apiKey,'opaque secret');
});
test('URLs, key dumps, PEM and safe diagnostics preserve surrounding facts',()=>{
 for(const value of ['https://name:password@example.invalid/x','https://example.invalid/x?api_key=opaque&model=public',"password='several secret words'",'api_key=opaque', '-----BEGIN PRIVATE KEY-----\nprivate bytes\n-----END PRIVATE KEY-----']){
  const masked=reviewDiagnostic(value);assert.ok(masked.includes('***REDACTED***'));assert.ok(!masked.includes('private bytes'));assert.ok(!masked.includes('several secret words'));assert.ok(!masked.includes('opaque'));
 }
 assert.equal(reviewDiagnostic('model=public token_estimate=1234 route_fp=aabbcc'), 'model=public token_estimate=1234 route_fp=aabbcc');
 assert.deepEqual(reviewDiagnostic(JSON.parse('{"__proto__":{"api_key":"opaque"},"tokens_total":42}')),JSON.parse('{"__proto__":{"api_key":"***REDACTED***"},"tokens_total":42}'));
});
