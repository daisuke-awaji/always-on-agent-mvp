#!/usr/bin/env node
// デプロイ済み API（IAM 認証）を SigV4 署名付きで呼ぶクライアント。
//
//   export AOA_API_URL=$(aws cloudformation describe-stacks --stack-name AlwaysOnAgentMvp \
//     --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)
//
//   node scripts/aoa.mjs send alice "はじめまして。私は調達担当です"
//   node scripts/aoa.mjs send alice "ありがとう" --session s-xxxxxxxx-...
//   node scripts/aoa.mjs webhook alice github delivery-123 '{"repository":"dmp-procurement","action":"opened"}'
//   node scripts/aoa.mjs messages alice
//   node scripts/aoa.mjs events alice
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';

const apiUrl = process.env.AOA_API_URL;
if (!apiUrl) {
  console.error('AOA_API_URL を設定してください（スタック出力 ApiUrl）');
  process.exit(1);
}
const base = new URL(apiUrl);
const region = process.env.AWS_REGION ?? base.hostname.split('.')[2];

async function call(method, path, body, query) {
  const url = new URL(path.replace(/^\//, ''), base.href.endsWith('/') ? base.href : `${base.href}/`);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const request = new HttpRequest({
    method,
    protocol: url.protocol,
    hostname: url.hostname,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers: { host: url.hostname, ...(payload ? { 'content-type': 'application/json' } : {}) },
    body: payload,
  });
  const signer = new SignatureV4({ credentials: defaultProvider(), region, service: 'execute-api', sha256: Sha256 });
  const signed = await signer.sign(request);
  const res = await fetch(url, { method, headers: signed.headers, body: payload });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    console.error(`HTTP ${res.status}`, json);
    process.exit(1);
  }
  return json;
}

const [cmd, userId, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest.splice(i, 2)[1] : undefined;
};

switch (cmd) {
  case 'send': {
    const sessionId = flag('--session');
    const text = rest.join(' ');
    console.log(await call('POST', `/users/${userId}/events`, { text, ...(sessionId ? { sessionId } : {}) }));
    break;
  }
  case 'webhook': {
    const [source, sourceEventId, payload] = rest;
    console.log(
      await call('POST', `/users/${userId}/events`, {
        type: 'webhook',
        source,
        sourceEventId,
        payload: JSON.parse(payload ?? '{}'),
      }),
    );
    break;
  }
  case 'messages': {
    const { messages } = await call('GET', `/users/${userId}/messages`, undefined, { limit: '10' });
    for (const m of messages.reverse())
      console.log(`[${m.createdAt}] (session ${m.sessionId})${m.importance === 'high' ? ' [重要]' : ''}\n${m.text}\n`);
    break;
  }
  case 'events': {
    const { events } = await call('GET', `/users/${userId}/events`, undefined, { limit: '20' });
    for (const e of events)
      console.log(
        `${e.receivedAt}  ${e.status.padEnd(10)} attempts=${e.attempts}  ${e.type}/${e.source}${e.lastError ? `  error=${e.lastError}` : ''}`,
      );
    break;
  }
  default:
    console.error('usage: aoa.mjs <send|webhook|messages|events> <userId> ...');
    process.exit(1);
}
