/**
 * AWS SigV4 签名（L3-M1 §3.2.2 — Bedrock 用）
 *
 * 自实现避免引入 @aws-sdk 完整栈（M1 保持最小依赖）。
 *
 * SigV4 流程：
 *  1. 构造 canonical request（method / URI / query / headers / payload hash）
 *  2. 构造 string to sign（algorithm / timestamp / credential scope / canonical request hash）
 *  3. 计算 signing key（secret key + date + region + service）
 *  4. HMAC-SHA256 签名 string to sign
 *  5. 组装 Authorization header
 *
 * 参考：https://docs.aws.amazon.com/general/latest/gr/sigv4-create-canonical-request.html
 */

import { createHmac, createHash } from 'node:crypto';

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** 临时凭证用（可选） */
  sessionToken?: string;
}

export interface SigV4Request {
  method: string;
  /** URL path，如 /model/{modelId}/invoke */
  path: string;
  /** Query string，如 "key1=val1&key2=val2"（已编码） */
  query?: string;
  /** HTTP headers（小写 key） */
  headers: Record<string, string>;
  /** 请求体 */
  body: string | Uint8Array;
  host: string;
}

export interface SigV4SignResult {
  authorization: string;
  /** 完整 headers（含 Authorization / X-Amz-Date / X-Amz-Content-Sha256 / X-Amz-Security-Token） */
  signedHeaders: Record<string, string>;
}

const SIGV4_ALGORITHM = 'AWS4-HMAC-SHA256';
const SIGV4_SERVICE = 'bedrock';
const SIGV4_REQUEST = 'aws4_request';

/** SigV4 签名主入口 */
export function signSigV4(
  creds: SigV4Credentials,
  region: string,
  req: SigV4Request,
  date: Date = new Date(),
): SigV4SignResult {
  const amzDate = formatAmzDate(date);
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(req.body);

  // Step 1: canonical request
  const canonicalHeaders = buildCanonicalHeaders(req.headers, {
    host: req.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    ...(creds.sessionToken ? { 'x-amz-security-token': creds.sessionToken } : {}),
  });
  const signedHeaders = Object.keys(canonicalHeaders).join(';');
  const canonicalRequest = [
    req.method.toUpperCase(),
    req.path,
    req.query ?? '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  // Step 2: string to sign
  const credentialScope = `${dateStamp}/${region}/${SIGV4_SERVICE}/${SIGV4_REQUEST}`;
  const stringToSign = [
    SIGV4_ALGORITHM,
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  // Step 3: signing key
  const signingKey = deriveSigningKey(creds.secretAccessKey, dateStamp, region, SIGV4_SERVICE);

  // Step 4: signature
  const signature = hmacHex(signingKey, stringToSign);

  // Step 5: Authorization header
  const authorization =
    `${SIGV4_ALGORITHM} ` +
    `Credential=${creds.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, ` +
    `Signature=${signature}`;

  const finalHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    finalHeaders[k.toLowerCase().trim()] = v.trim();
  }
  finalHeaders['host'] = req.host;
  finalHeaders['x-amz-date'] = amzDate;
  finalHeaders['x-amz-content-sha256'] = payloadHash;
  if (creds.sessionToken) {
    finalHeaders['x-amz-security-token'] = creds.sessionToken;
  }

  return { authorization, signedHeaders: finalHeaders };
}

/** 构造 canonical headers（key 排序，value trim，小写） */
function buildCanonicalHeaders(
  original: Record<string, string>,
  additions: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...original, ...additions })) {
    merged[k.toLowerCase().trim()] = v.trim();
  }
  // 排序
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(merged).sort()) {
    sorted[k] = merged[k];
  }
  return sorted;
}

/** 派生 signing key（HMAC 链式） */
function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Uint8Array {
  const kDate = hmacBytes(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmacBytes(kDate, region);
  const kService = hmacBytes(kRegion, service);
  return hmacBytes(kService, SIGV4_REQUEST);
}

/** SHA-256 → hex */
function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/** HMAC-SHA256(key: string, data: string) → hex */
function hmacHex(key: string | Uint8Array, data: string): string {
  return createHmac('sha256', typeof key === 'string' ? Buffer.from(key, 'utf8') : Buffer.from(key))
    .update(data, 'utf8')
    .digest('hex');
}

/** HMAC-SHA256(key: string | Uint8Array, data: string) → bytes */
function hmacBytes(key: string | Uint8Array, data: string): Uint8Array {
  const keyBuf = typeof key === 'string' ? Buffer.from(key, 'utf8') : Buffer.from(key);
  return new Uint8Array(
    createHmac('sha256', keyBuf).update(data, 'utf8').digest(),
  );
}

/** AWS amz-date 格式：yyyyMMdd'T'HHmmss'Z' */
function formatAmzDate(date: Date): string {
  const iso = date.toISOString();
  // 2026-07-09T10:30:45.123Z → 20260709T103045Z
  return iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}
