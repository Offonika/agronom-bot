'use strict';

const API_BASE = process.env.API_BASE_URL || 'http://localhost:8010';
const API_KEY = process.env.API_KEY || 'test-api-key';
const API_VER = process.env.API_VER || 'v1';

async function fetchPlan({
  planId,
  userId,
  includePayload = false,
  diffAgainst = null,
  signal,
}) {
  if (!planId || !userId) {
    throw new Error('fetchPlan requires planId and userId');
  }
  const url = new URL(`${API_BASE}/v1/plans/${planId}`);
  if (includePayload) {
    url.searchParams.set('include_payload', 'true');
  }
  if (diffAgainst) {
    url.searchParams.set('diff_against', diffAgainst);
  }
  const resp = await fetch(url, {
    headers: {
      'X-API-Key': API_KEY,
      'X-API-Ver': API_VER,
      'X-User-ID': String(userId),
    },
    signal,
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    const err = new Error(`plan_api_fetch_failed status=${resp.status}`);
    err.responseBody = body;
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

module.exports = {
  fetchPlan,
};
