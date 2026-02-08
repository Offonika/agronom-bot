'use strict';

const API_BASE = process.env.API_BASE_URL || 'http://localhost:8010';
const { buildApiHeaders } = require('./apiAuth');

function createPlanSessionsApi(fetchImpl = global.fetch) {
  if (!fetchImpl) {
    throw new Error('PlanSessionsApi requires fetch implementation');
  }

  async function request(method, path, { userId, apiKey, query = {}, body } = {}) {
    if (!userId || !apiKey) {
      throw new Error('PlanSessionsApi request requires userId and apiKey');
    }
    const url = new URL(`${API_BASE}${path}`);
    Object.entries(query).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      url.searchParams.set(key, String(value));
    });
    const bodyPayload = body ?? undefined;
    const headers = buildApiHeaders({
      apiKey,
      userId,
      method,
      path,
      query: url.searchParams.toString(),
      body: bodyPayload,
    });
    if (bodyPayload) {
      headers['Content-Type'] = 'application/json';
    }
    const resp = await fetchImpl(url, {
      method,
      headers,
      body: bodyPayload ? JSON.stringify(bodyPayload) : undefined,
    });
    if (method === 'DELETE') {
      if (!resp.ok && resp.status !== 404) {
        throw new Error(`plan_sessions_api delete failed status=${resp.status}`);
      }
      return null;
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      const err = new Error(`plan_sessions_api request failed status=${resp.status}`);
      err.status = resp.status;
      err.body = text;
      throw err;
    }
    return resp.json();
  }

  async function upsert(userId, apiKey, payload) {
    return request('POST', '/v1/plans/sessions', { userId, apiKey, body: payload });
  }

  async function patch(userId, apiKey, sessionId, patchPayload) {
    if (!sessionId) throw new Error('patch requires sessionId');
    return request('PATCH', `/v1/plans/sessions/${sessionId}`, {
      userId,
      apiKey,
      body: patchPayload,
    });
  }

  async function fetchLatest(userId, apiKey, { includeExpired = false } = {}) {
    try {
      return await request('GET', '/v1/plans/sessions', {
        userId,
        apiKey,
        query: includeExpired ? { include_expired: 'true' } : {},
      });
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  async function fetchByToken(userId, apiKey, token, { includeExpired = false } = {}) {
    if (!token) return null;
    try {
      return await request('GET', '/v1/plans/sessions', {
        userId,
        apiKey,
        query: {
          token,
          include_expired: includeExpired ? 'true' : undefined,
        },
      });
    } catch (err) {
      if (err.status === 404 || err.status === 410) return null;
      throw err;
    }
  }

  async function deleteAll(userId, apiKey) {
    return request('DELETE', '/v1/plans/sessions', { userId, apiKey });
  }

  async function deleteByToken(userId, apiKey, token) {
    if (!token) return null;
    return request('DELETE', '/v1/plans/sessions', {
      userId,
      apiKey,
      query: { token },
    });
  }

  async function deleteByPlan(userId, apiKey, planId) {
    if (!planId) return null;
    return request('DELETE', '/v1/plans/sessions', {
      userId,
      apiKey,
      query: { plan_id: planId },
    });
  }

  return {
    upsert,
    patch,
    fetchLatest,
    fetchByToken,
    deleteAll,
    deleteByToken,
    deleteByPlan,
  };
}

module.exports = { createPlanSessionsApi };
