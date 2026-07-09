import { test } from 'node:test';
import assert from 'node:assert/strict';

import { signSigV4, type SigV4Credentials, type SigV4Request } from '../../src/providers/bedrock-sigv4.js';

const CREDS: SigV4Credentials = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+GbJEfUeXPbHkQEXAMPLE',
};

const REGION = 'us-east-1';
const HOST = 'bedrock-runtime.us-east-1.amazonaws.com';

test('signSigV4: 返回非空 authorization header', () => {
  const req: SigV4Request = {
    method: 'POST',
    path: '/model/test/invoke',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    host: HOST,
  };
  const result = signSigV4(CREDS, REGION, req, new Date('2026-07-09T10:30:00Z'));
  assert.ok(result.authorization.length > 0);
  assert.match(result.authorization, /AWS4-HMAC-SHA256/);
  assert.match(result.authorization, /Credential=AKIDEXAMPLE\/20260709\/us-east-1\/bedrock\/aws4_request/);
  assert.match(result.authorization, /Signature=[0-9a-f]+/);
});

test('signSigV4: 同输入产生同签名（确定性）', () => {
  const date = new Date('2026-07-09T10:30:00Z');
  const req: SigV4Request = {
    method: 'POST',
    path: '/model/test/invoke',
    headers: { 'content-type': 'application/json' },
    body: '{"hello":"world"}',
    host: HOST,
  };
  const r1 = signSigV4(CREDS, REGION, req, date);
  const r2 = signSigV4(CREDS, REGION, req, date);
  assert.equal(r1.authorization, r2.authorization);
});

test('signSigV4: 不同 body 产生不同签名', () => {
  const date = new Date('2026-07-09T10:30:00Z');
  const req1: SigV4Request = {
    method: 'POST',
    path: '/model/test/invoke',
    headers: { 'content-type': 'application/json' },
    body: '{"hello":"world1"}',
    host: HOST,
  };
  const req2: SigV4Request = { ...req1, body: '{"hello":"world2"}' };
  const r1 = signSigV4(CREDS, REGION, req1, date);
  const r2 = signSigV4(CREDS, REGION, req2, date);
  assert.notEqual(r1.authorization, r2.authorization);
});

test('signSigV4: 不同 access key 产生不同签名', () => {
  const date = new Date('2026-07-09T10:30:00Z');
  const req: SigV4Request = {
    method: 'POST',
    path: '/model/test/invoke',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    host: HOST,
  };
  const creds2: SigV4Credentials = {
    accessKeyId: 'AKIDDIFFERENT',
    secretAccessKey: 'differentSecretKey',
  };
  const r1 = signSigV4(CREDS, REGION, req, date);
  const r2 = signSigV4(creds2, REGION, req, date);
  assert.notEqual(r1.authorization, r2.authorization);
});

test('signSigV4: session token 加入 signedHeaders', () => {
  const creds: SigV4Credentials = {
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+GbJEfUeXPbHkQEXAMPLE',
    sessionToken: 'session-token-123',
  };
  const req: SigV4Request = {
    method: 'POST',
    path: '/model/test/invoke',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    host: HOST,
  };
  const result = signSigV4(creds, REGION, req, new Date('2026-07-09T10:30:00Z'));
  assert.ok('x-amz-security-token' in result.signedHeaders);
  assert.equal(result.signedHeaders['x-amz-security-token'], 'session-token-123');
});

test('signSigV4: headers 小写化 + 排序', () => {
  const req: SigV4Request = {
    method: 'POST',
    path: '/model/test/invoke',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: '{}',
    host: HOST,
  };
  const result = signSigV4(CREDS, REGION, req, new Date('2026-07-09T10:30:00Z'));
  // header key 应已被小写化
  assert.ok('accept' in result.signedHeaders);
  assert.ok('content-type' in result.signedHeaders);
});

test('signSigV4: 不同 region 产生不同签名', () => {
  const date = new Date('2026-07-09T10:30:00Z');
  const req: SigV4Request = {
    method: 'POST',
    path: '/model/test/invoke',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    host: 'bedrock-runtime.us-west-2.amazonaws.com',
  };
  const r1 = signSigV4(CREDS, 'us-east-1', req, date);
  const r2 = signSigV4(CREDS, 'us-west-2', req, date);
  assert.notEqual(r1.authorization, r2.authorization);
});

test('signSigV4: GET method 也可签名', () => {
  const req: SigV4Request = {
    method: 'GET',
    path: '/models',
    headers: {},
    body: '',
    host: HOST,
  };
  const result = signSigV4(CREDS, REGION, req, new Date('2026-07-09T10:30:00Z'));
  assert.match(result.authorization, /AWS4-HMAC-SHA256/);
});
