require('dotenv').config();
const crypto = require('crypto');

function signPayload(secret, payload) {
  const ordered = Object.keys(payload)
    .sort()
    .reduce((acc, key) => {
      acc[key] = payload[key];
      return acc;
    }, {});
  const body = JSON.stringify(ordered);
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function main() {
  const externalId = process.argv[2];
  if (!externalId) {
    console.error('Usage: node mock_bank.js <external_id>');
    process.exit(1);
  }
  const payload = {
    external_id: externalId,
    status: 'success',
    paid_at: new Date().toISOString(),
  };
  const secret = process.env.HMAC_SECRET || 'test-hmac-secret';
  const signature = signPayload(secret, payload);
  payload.signature = signature;

  const baseUrl = process.env.API_BASE_URL || 'http://localhost:8000';
  const resp = await fetch(`${baseUrl}/v1/payments/sbp/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': process.env.API_KEY || 'test-api-key',
      'X-API-Ver': 'v1',
      'X-Signature': signature,
    },
    body: JSON.stringify(payload),
  });

  const text = await resp.text();
  if (!resp.ok) {
    console.error('Error', resp.status, text);
  } else {
    console.log('OK', text);
  }
}

main();
