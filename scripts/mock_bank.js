require('dotenv').config();
const crypto = require('crypto');

function canonicalJson(payload) {
  const ordered = Object.keys(payload)
    .sort()
    .reduce((acc, key) => {
      acc[key] = payload[key];
      return acc;
    }, {});
  return JSON.stringify(ordered);
}

function hmacSha(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function signPayload(secret, payload) {
  return hmacSha(secret, canonicalJson(payload));
}

function parseArgs() {
  const raw = process.argv.slice(2);
  if (raw.length === 0) {
    return { error: true };
  }
  const flags = new Map();
  const positional = [];
  for (let i = 0; i < raw.length; i += 1) {
    const token = raw[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = raw[i + 1];
      if (next && !next.startsWith('--')) {
        flags.set(key, next);
        i += 1;
      } else {
        flags.set(key, true);
      }
    } else {
      positional.push(token);
    }
  }
  let mode = 'invoice';
  if (positional[0] === 'invoice' || positional[0] === 'autopay') {
    mode = positional.shift();
  } else if (flags.has('autopay')) {
    mode = 'autopay';
  }
  return { mode, flags, positional };
}

function usage() {
  console.error('Usage:');
  console.error('  node scripts/mock_bank.js invoice <external_id> [status] [--user <id>]');
  console.error('  node scripts/mock_bank.js autopay <charge_id> [status] [--user <id>] [--binding <id>] [--amount <amount>]');
  console.error('  node scripts/mock_bank.js <external_id> [status] --autopay [--user <id>] [--binding <id>] [--amount <amount>]');
  console.error('Flags:');
  console.error('  --xff <ip>    override X-Forwarded-For (default 127.0.0.1)');
}

async function main() {
  const { mode, flags, positional, error } = parseArgs();
  if (error || positional.length === 0) {
    usage();
    process.exit(1);
  }

  const externalId = positional[0];
  const status = flags.get('status') || positional[1] || 'success';
  const secret = process.env.HMAC_SECRET || 'test-hmac-secret';
  const baseUrl = process.env.API_BASE_URL || 'http://localhost:8010';
  const apiKey = process.env.API_KEY || 'test-api-key';
  const forwardedFor = flags.get('xff') || process.env.MOCK_BANK_XFF || '127.0.0.1';
  const userId = parseInt(
    flags.get('user') || process.env.TEST_USER_ID || '1',
    10,
  );

  if (Number.isNaN(userId)) {
    console.error('Invalid user id');
    process.exit(1);
  }

  let payload;
  let endpoint;
  if (mode === 'autopay') {
    const amount = parseInt(
      flags.get('amount') || process.env.MOCK_AMOUNT || '19900',
      10,
    );
    if (Number.isNaN(amount)) {
      console.error('Invalid amount');
      process.exit(1);
    }
    const bindingId =
      flags.get('binding') ||
      process.env.MOCK_BINDING_ID ||
      `BND-${externalId}`;
    payload = {
      autopay_charge_id: externalId,
      binding_id: bindingId,
      user_id: userId,
      amount,
      status,
      charged_at: new Date().toISOString(),
    };
    endpoint = '/v1/payments/sbp/autopay/webhook';
  } else {
    payload = {
      external_id: externalId,
      status,
      paid_at: new Date().toISOString(),
    };
    endpoint = '/v1/payments/sbp/webhook';
  }

  const payloadSignature = signPayload(secret, payload);
  const payloadWithSignature = { ...payload, signature: payloadSignature };
  const body = canonicalJson(payloadWithSignature);
  const headerSignature = hmacSha(secret, body);

  const resp = await fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
      'X-API-Ver': 'v1',
      'X-User-ID': String(userId),
      'X-Sign': headerSignature,
      'X-Forwarded-For': forwardedFor,
    },
    body,
  });

  const text = await resp.text();
  if (!resp.ok) {
    console.error('Error', resp.status, text);
    process.exit(1);
  }
  console.log('OK', text);
}

main().catch((err) => {
  console.error('Mock bank error', err);
  process.exit(1);
});
