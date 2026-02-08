'use strict';

const crypto = require('crypto');

const API_VER = process.env.API_VER || 'v1';

function stableStringify(payload) {
  const keys = Object.keys(payload).sort();
  return JSON.stringify(payload, keys);
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = canonicalize(value[key]);
        return acc;
      }, {});
  }
  return value;
}

function buildBodyHash(body) {
  if (body === undefined || body === null) return null;
  let payload = body;
  if (typeof body === 'string') {
    try {
      payload = JSON.parse(body);
    } catch {
      payload = body;
    }
  }
  const canonical =
    typeof payload === 'string'
      ? payload
      : JSON.stringify(canonicalize(payload));
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function buildRequestSignature(apiKey, payload) {
  const body = stableStringify(payload);
  return crypto.createHmac('sha256', apiKey).update(body).digest('hex');
}

function buildApiHeaders({ apiKey, userId, method, path, query = '', body, apiVer = API_VER }) {
  if (!apiKey) {
    throw new Error('buildApiHeaders requires apiKey');
  }
  if (!userId) {
    throw new Error('buildApiHeaders requires userId');
  }
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString('hex');
  const payload = {
    user_id: Number(userId),
    ts,
    nonce,
    method: method.toUpperCase(),
    path,
    query,
  };
  const bodyHash = buildBodyHash(body);
  if (bodyHash) {
    payload.body_sha256 = bodyHash;
  }
  const signature = buildRequestSignature(apiKey, payload);
  const headers = {
    'X-API-Key': apiKey,
    'X-API-Ver': apiVer,
    'X-User-ID': String(userId),
    'X-Req-Ts': String(ts),
    'X-Req-Nonce': nonce,
    'X-Req-Sign': signature,
  };
  if (bodyHash) {
    headers['X-Req-Body-Sha256'] = bodyHash;
  }
  return headers;
}

module.exports = { buildApiHeaders };
