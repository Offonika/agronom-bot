'use strict';

const API_BASE = process.env.API_BASE_URL || 'http://localhost:8010';
const { buildApiHeaders } = require('./apiAuth');

async function fetchPlan({
  planId,
  userId,
  apiKey,
  includePayload = false,
  diffAgainst = null,
  signal,
}) {
  if (!planId || !userId || !apiKey) {
    throw new Error('fetchPlan requires planId, userId and apiKey');
  }
  const url = new URL(`${API_BASE}/v1/plans/${planId}`);
  if (includePayload) {
    url.searchParams.set('include_payload', 'true');
  }
  if (diffAgainst) {
    url.searchParams.set('diff_against', diffAgainst);
  }
  const resp = await fetch(url, {
    headers: buildApiHeaders({
      apiKey,
      userId,
      method: 'GET',
      path: `/v1/plans/${planId}`,
      query: url.searchParams.toString(),
    }),
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

async function fetchPlanPdf({ planId, userId, apiKey }) {
  if (!planId || !userId || !apiKey) {
    throw new Error('fetchPlanPdf requires planId, userId and apiKey');
  }
  const path = `/v1/plans/${planId}/pdf`;
  const resp = await fetch(`${API_BASE}${path}`, {
    headers: buildApiHeaders({
      apiKey,
      userId,
      method: 'GET',
      path,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    const err = new Error(`plan_api_pdf_failed status=${resp.status}`);
    err.responseBody = body;
    err.status = resp.status;
    throw err;
  }
  const buffer = Buffer.from(await resp.arrayBuffer());
  return buffer;
}

module.exports = {
  fetchPlan,
  fetchPlanPdf,
};
