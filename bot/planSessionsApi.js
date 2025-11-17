'use strict';

const API_BASE = process.env.API_BASE_URL || 'http://localhost:8010';
const API_KEY = process.env.API_KEY || 'test-api-key';
const API_VER = process.env.API_VER || 'v1';

function createPlanSessionsApi(fetchImpl = global.fetch) {
  if (!fetchImpl) {
    throw new Error('PlanSessionsApi requires fetch implementation');
  }

  async function request(method, path, { userId, query = {}, body } = {}) {
    if (!userId) throw new Error('PlanSessionsApi request requires userId');
    const url = new URL(`${API_BASE}${path}`);
    Object.entries(query).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      url.searchParams.set(key, String(value));
    });
    const resp = await fetchImpl(url, {
      method,
      headers: {
        'X-API-Key': API_KEY,
        'X-API-Ver': API_VER,
        'X-User-ID': String(userId),
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
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

  async function upsert(userId, payload) {
    return request('POST', '/v1/plans/sessions', { userId, body: payload });
  }

  async function patch(userId, sessionId, patchPayload) {
    if (!sessionId) throw new Error('patch requires sessionId');
    return request('PATCH', `/v1/plans/sessions/${sessionId}`, {
      userId,
      body: patchPayload,
    });
  }

  async function fetchLatest(userId, { includeExpired = false } = {}) {
    try {
      return await request('GET', '/v1/plans/sessions', {
        userId,
        query: includeExpired ? { include_expired: 'true' } : {},
      });
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  async function fetchByToken(userId, token, { includeExpired = false } = {}) {
    if (!token) return null;
    try {
      return await request('GET', '/v1/plans/sessions', {
        userId,
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

  async function deleteAll(userId) {
    return request('DELETE', '/v1/plans/sessions', { userId });
  }

  async function deleteByToken(userId, token) {
    if (!token) return null;
    return request('DELETE', '/v1/plans/sessions', {
      userId,
      query: { token },
    });
  }

  async function deleteByPlan(userId, planId) {
    if (!planId) return null;
    return request('DELETE', '/v1/plans/sessions', {
      userId,
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
