'use strict';

const { Pool } = require('pg');

const MS_IN_HOUR = 60 * 60 * 1000;
const DEFAULT_RECENT_DIAG_TTL_H = Number(process.env.RECENT_DIAG_TTL_H || '24');
const RECENT_DIAG_MAX_AGE_H = Number(process.env.RECENT_DIAG_MAX_AGE_H || '72');
const PLAN_SESSION_TTL_H = Number(process.env.PLAN_SESSION_TTL_H || '6');
const PLAN_SESSION_MAX_AGE_H = Number(process.env.PLAN_SESSION_MAX_AGE_H || '24');

function ensurePool(pool) {
  if (pool instanceof Pool) return pool;
  throw new Error('services/db requires an instance of pg.Pool');
}

async function withClient(pool, fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

async function withTransaction(pool, fn) {
  return withClient(pool, async (client) => {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

function createDb(poolInstance) {
  const pool = ensurePool(poolInstance);

  const exec = (text, params = [], client = pool) => client.query(text, params);

  const json = (value) => (value === undefined || value === null ? {} : value);
  const defaultRecentTtlMs =
    Number.isFinite(DEFAULT_RECENT_DIAG_TTL_H) && DEFAULT_RECENT_DIAG_TTL_H > 0
      ? DEFAULT_RECENT_DIAG_TTL_H * MS_IN_HOUR
      : 24 * MS_IN_HOUR;
  const cleanupRecentMs =
    Number.isFinite(RECENT_DIAG_MAX_AGE_H) && RECENT_DIAG_MAX_AGE_H > 0
      ? RECENT_DIAG_MAX_AGE_H * MS_IN_HOUR
      : 0;
  const defaultSessionTtlMs =
    Number.isFinite(PLAN_SESSION_TTL_H) && PLAN_SESSION_TTL_H > 0
      ? PLAN_SESSION_TTL_H * MS_IN_HOUR
      : 6 * MS_IN_HOUR;
  const cleanupSessionMs =
    Number.isFinite(PLAN_SESSION_MAX_AGE_H) && PLAN_SESSION_MAX_AGE_H > 0
      ? PLAN_SESSION_MAX_AGE_H * MS_IN_HOUR
      : 0;

  function computeExpiresAt(hours) {
    const ttlMs =
      Number.isFinite(hours) && hours > 0 ? hours * MS_IN_HOUR : defaultRecentTtlMs;
    return new Date(Date.now() + ttlMs);
  }

  function computeSessionExpiresAt(hours) {
    const ttlMs =
      Number.isFinite(hours) && hours > 0 ? hours * MS_IN_HOUR : defaultSessionTtlMs;
    return new Date(Date.now() + ttlMs);
  }

  async function ensureUser(tgId) {
    const sql = `
      INSERT INTO users (tg_id)
      VALUES ($1)
      ON CONFLICT (tg_id)
      DO UPDATE SET tg_id = EXCLUDED.tg_id
      RETURNING *;
    `;
    const { rows } = await exec(sql, [tgId]);
    return rows[0];
  }

  async function getUserByTgId(tgId) {
    const { rows } = await exec('SELECT * FROM users WHERE tg_id = $1', [tgId]);
    return rows[0] || null;
  }

  async function updateUserLastObject(userId, objectId) {
    const { rows } = await exec(
      'UPDATE users SET last_object_id = $2 WHERE id = $1 RETURNING *',
      [userId, objectId],
    );
    return rows[0] || null;
  }

  async function listObjects(userId) {
    const sql = `
      SELECT *
      FROM objects
      WHERE user_id = $1
      ORDER BY created_at DESC, id DESC;
    `;
    const { rows } = await exec(sql, [userId]);
    return rows;
  }

  async function createObject(userId, data) {
    const { name, type = null, locationTag = null, meta = {} } = data;
    const sql = `
      INSERT INTO objects (user_id, name, type, location_tag, meta)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *;
    `;
    const params = [userId, name, type, locationTag, json(meta)];
    const { rows } = await exec(sql, params);
    return rows[0];
  }

  async function getObjectById(objectId) {
    const { rows } = await exec('SELECT * FROM objects WHERE id = $1', [objectId]);
    return rows[0] || null;
  }

  async function mergeObjects(userId, sourceId, targetId) {
    if (!userId || !sourceId || !targetId || Number(sourceId) === Number(targetId)) {
      throw new Error('invalid merge params');
    }
    return withTransaction(pool, async (client) => {
      const [source, target] = await Promise.all([
        withClient(client, (c) => c),
        withClient(client, (c) => c),
      ]).then(async ([c1, c2]) => {
        const [sRows, tRows] = await Promise.all([
          exec('SELECT * FROM objects WHERE id = $1', [sourceId], c1),
          exec('SELECT * FROM objects WHERE id = $1', [targetId], c2),
        ]);
        return [sRows[0] || null, tRows[0] || null];
      });
      if (!source || !target) {
        throw new Error('object not found');
      }
      if (Number(source.user_id) !== Number(userId) || Number(target.user_id) !== Number(userId)) {
        throw new Error('object not owned');
      }
      const tablesToUpdate = [
        'plans',
        'cases',
        'recent_diagnoses',
        'plan_sessions',
      ];
      for (const table of tablesToUpdate) {
        await exec(
          `UPDATE ${table} SET object_id = $1 WHERE object_id = $2`,
          [targetId, sourceId],
          client,
        );
      }
      await exec(
        'UPDATE users SET last_object_id = $2 WHERE last_object_id = $1 AND id = $3',
        [sourceId, targetId, userId],
        client,
      );
      await exec('DELETE FROM objects WHERE id = $1', [sourceId], client);
      return target;
    });
  }

  function mergeMeta(base = {}, patch = {}) {
    const result = { ...(base || {}) };
    if (!patch || typeof patch !== 'object') return result;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        delete result[key];
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  function sanitizeCoordinates(baseMeta = {}, mergedMeta = {}, patch = {}) {
    const hasCoordPatch =
      Object.prototype.hasOwnProperty.call(patch, 'lat') ||
      Object.prototype.hasOwnProperty.call(patch, 'lon');
    if (!hasCoordPatch) return mergedMeta;
    const lat = Number(mergedMeta.lat);
    const lon = Number(mergedMeta.lon);
    const valid =
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      lat >= -90 &&
      lat <= 90 &&
      lon >= -180 &&
      lon <= 180;
    if (valid) {
      mergedMeta.lat = lat;
      mergedMeta.lon = lon;
      return mergedMeta;
    }
    if (Object.prototype.hasOwnProperty.call(baseMeta, 'lat')) {
      mergedMeta.lat = baseMeta.lat;
    } else {
      delete mergedMeta.lat;
    }
    if (Object.prototype.hasOwnProperty.call(baseMeta, 'lon')) {
      mergedMeta.lon = baseMeta.lon;
    } else {
      delete mergedMeta.lon;
    }
    return mergedMeta;
  }

  async function updateObjectMeta(objectId, patch = {}) {
    if (!objectId || !patch || typeof patch !== 'object') return null;
    const current = await getObjectById(objectId);
    if (!current) return null;
    const baseMeta = current.meta || {};
    const merged = sanitizeCoordinates(baseMeta, mergeMeta(baseMeta, patch), patch);
    const sql = `
      UPDATE objects
      SET meta = $2
      WHERE id = $1
      RETURNING *;
    `;
    const { rows } = await exec(sql, [objectId, json(merged)]);
    return rows[0] || null;
  }

  async function createCase(data) {
    const sql = `
      INSERT INTO cases (user_id, object_id, crop, disease, confidence, raw_ai)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *;
    `;
    const params = [
      data.user_id,
      data.object_id,
      data.crop || null,
      data.disease || null,
      data.confidence ?? null,
      json(data.raw_ai),
    ];
    const { rows } = await exec(sql, params);
    return rows[0];
  }

  async function createPlan(plan) {
    const sql = `
      INSERT INTO plans (
        user_id,
        object_id,
        case_id,
        title,
        status,
        version,
        hash,
        source,
        payload,
        plan_kind,
        plan_errors
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *;
    `;
    const params = [
      plan.user_id,
      plan.object_id,
      plan.case_id || null,
      plan.title,
      plan.status || 'draft',
      Number.isFinite(plan.version) ? plan.version : 1,
      plan.hash || null,
      plan.source || null,
      plan.payload || null,
      plan.plan_kind || null,
      plan.plan_errors || null,
    ];
    const { rows } = await exec(sql, params);
    return rows[0];
  }

  async function getPlanById(planId) {
    const { rows } = await exec('SELECT * FROM plans WHERE id = $1', [planId]);
    return rows[0] || null;
  }

  async function getPlanForUser(planId, userId) {
    const sql = `
      SELECT *
      FROM plans
      WHERE id = $1 AND user_id = $2
      LIMIT 1;
    `;
    const { rows } = await exec(sql, [planId, userId]);
    return rows[0] || null;
  }

  async function listPlansByObject(objectId, limit = 10) {
    const sql = `
      SELECT
        p.*,
        (
          SELECT COUNT(*) FROM events e
          WHERE e.plan_id = p.id AND e.status = 'scheduled'
        ) AS scheduled_events
      FROM plans p
      WHERE p.object_id = $1
      ORDER BY p.created_at DESC
      LIMIT $2;
    `;
    const { rows } = await exec(sql, [objectId, limit]);
    return rows;
  }

  async function listUpcomingEventsByUser(userId, limit = 5, objectId = null, cursor = null) {
    const params = [userId];
    let idx = 2;
    let filterClause = '';
    if (objectId) {
      filterClause = ` AND p.object_id = $${idx}`;
      params.push(objectId);
      idx += 1;
    }
    if (cursor?.dueAt && cursor?.eventId) {
      filterClause += ` AND (e.due_at > $${idx} OR (e.due_at = $${idx} AND e.id > $${idx + 1}))`;
      params.push(cursor.dueAt);
      params.push(cursor.eventId);
      idx += 2;
    }
    params.push(limit);
    const sql = `
      SELECT
        e.*,
        p.title    AS plan_title,
        o.name     AS object_name
      FROM events e
      JOIN plans p ON p.id = e.plan_id
      JOIN objects o ON o.id = p.object_id
      WHERE e.user_id = $1
        AND e.status = 'scheduled'
        ${filterClause}
      ORDER BY e.due_at ASC NULLS LAST, e.id ASC
      LIMIT $${idx};
    `;
    const { rows } = await exec(sql, params);
    return rows;
  }

  async function listOverdueEventsByUser(userId, limit = 3, objectId = null) {
    const params = [userId];
    let idx = 2;
    let filterClause = '';
    if (objectId) {
      filterClause = ` AND p.object_id = $${idx}`;
      params.push(objectId);
      idx += 1;
    }
    params.push(limit);
    const sql = `
      SELECT
        e.*,
        p.title    AS plan_title,
        o.name     AS object_name
      FROM events e
      JOIN plans p ON p.id = e.plan_id
      JOIN objects o ON o.id = p.object_id
      WHERE e.user_id = $1
        AND e.status = 'scheduled'
        AND e.due_at IS NOT NULL
        AND e.due_at < NOW()
        ${filterClause}
      ORDER BY e.due_at ASC, e.id ASC
      LIMIT $${idx};
    `;
    const { rows } = await exec(sql, params);
    return rows;
  }

  async function listOverdueUsersSummary(thresholdMinutes = 60, limit = 100) {
    const sql = `
      SELECT
        u.id       AS user_id,
        u.tg_id    AS user_tg_id,
        COUNT(*)   AS overdue_count,
        MIN(e.due_at) AS oldest_due
      FROM events e
      JOIN plans p ON p.id = e.plan_id
      JOIN users u ON u.id = p.user_id
      WHERE e.status = 'scheduled'
        AND e.due_at IS NOT NULL
        AND e.due_at < NOW() - ($1 * INTERVAL '1 minute')
      GROUP BY u.id, u.tg_id
      ORDER BY oldest_due ASC
      LIMIT $2;
    `;
    const { rows } = await exec(sql, [thresholdMinutes, limit]);
    return rows;
  }

  async function createPlanStages(planId, stages, client) {
    if (!stages?.length) return [];
    const usedClient = client || pool;
    const results = [];
    for (const stage of stages) {
      const sql = `
        INSERT INTO plan_stages (plan_id, title, kind, note, phi_days, meta)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *;
      `;
      const params = [
        planId,
        stage.title,
        stage.kind,
        stage.note || null,
        stage.phi_days ?? null,
        json(stage.meta),
      ];
      const { rows } = await exec(sql, params, usedClient);
      results.push(rows[0]);
    }
    return results;
  }

  async function saveRecentDiagnosis({
    userId,
    objectId = null,
    payload,
    caseId = null,
    planId = null,
    ttlHours = null,
  }) {
    if (!userId || !payload) return null;
    const expiresAt = computeExpiresAt(ttlHours);
    const sql = `
      INSERT INTO recent_diagnoses (user_id, object_id, diagnosis_payload, case_id, plan_id, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *;
    `;
    const params = [userId, objectId, payload, caseId, planId, expiresAt];
    const { rows } = await exec(sql, params);
    if (cleanupRecentMs > 0) {
      const cutoff = new Date(Date.now() - cleanupRecentMs);
      exec('DELETE FROM recent_diagnoses WHERE expires_at < $1', [cutoff]).catch((err) => {
        console.error('recent_diagnosis cleanup failed', err);
      });
    }
    return rows[0] || null;
  }

  async function getLatestRecentDiagnosis(userId) {
    if (!userId) return null;
    const sql = `
      SELECT *
      FROM recent_diagnoses
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 1;
    `;
    const { rows } = await exec(sql, [userId]);
    return rows[0] || null;
  }

  async function getRecentDiagnosisById(userId, diagnosisId) {
    if (!userId || !diagnosisId) return null;
    const sql = `
      SELECT *
      FROM recent_diagnoses
      WHERE user_id = $1 AND id = $2
      LIMIT 1;
    `;
    const { rows } = await exec(sql, [userId, diagnosisId]);
    return rows[0] || null;
  }

  async function linkRecentDiagnosisToPlan({ diagnosisId, objectId = null, caseId = null, planId = null }) {
    if (!diagnosisId) return null;
    const updates = [];
    const params = [];
    if (objectId !== undefined && objectId !== null) {
      updates.push(`object_id = $${updates.length + 1}`);
      params.push(objectId);
    }
    if (caseId !== undefined && caseId !== null) {
      updates.push(`case_id = $${updates.length + 1}`);
      params.push(caseId);
    }
    if (planId !== undefined && planId !== null) {
      updates.push(`plan_id = $${updates.length + 1}`);
      params.push(planId);
    }
    if (!updates.length) return null;
    params.push(diagnosisId);
    const sql = `
      UPDATE recent_diagnoses
      SET ${updates.join(', ')}
      WHERE id = $${params.length}
      RETURNING *;
    `;
    const { rows } = await exec(sql, params);
    return rows[0] || null;
  }

  async function createPlanSession({
    userId,
    token,
    diagnosisPayload,
    recentDiagnosisId = null,
    objectId = null,
    planId = null,
    currentStep = 'choose_object',
    state = {},
    ttlHours = null,
  }) {
    if (!userId || !token || !diagnosisPayload) return null;
    const expiresAt = computeSessionExpiresAt(ttlHours);
    const sql = `
      INSERT INTO plan_sessions (
        user_id,
        recent_diagnosis_id,
        diagnosis_payload,
        token,
        object_id,
        plan_id,
        current_step,
        state,
        expires_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *;
    `;
    const params = [
      userId,
      recentDiagnosisId,
      json(diagnosisPayload),
      token,
      objectId,
      planId,
      currentStep,
      json(state),
      expiresAt,
    ];
    const { rows } = await exec(sql, params);
    return rows[0] || null;
  }

  async function updatePlanSession(sessionId, patch = {}) {
    if (!sessionId) return null;
    const sets = [];
    const params = [];
    const apply = (column, value, transformer = (v) => v) => {
      if (value === undefined) return;
      sets.push(`${column} = $${sets.length + 1}`);
      params.push(transformer(value));
    };
    apply('recent_diagnosis_id', patch.recentDiagnosisId);
    apply('diagnosis_payload', patch.diagnosisPayload, json);
    apply('object_id', patch.objectId);
    apply('plan_id', patch.planId);
    apply('current_step', patch.currentStep);
    apply('state', patch.state, json);
    if (patch.ttlHours !== undefined) {
      sets.push(`expires_at = $${sets.length + 1}`);
      params.push(computeSessionExpiresAt(patch.ttlHours));
    }
    if (!sets.length) return getPlanSessionById(sessionId);
    sets.push(`updated_at = NOW()`);
    params.push(sessionId);
    const sql = `
      UPDATE plan_sessions
      SET ${sets.join(', ')}
      WHERE id = $${params.length}
      RETURNING *;
    `;
    const { rows } = await exec(sql, params);
    return rows[0] || null;
  }

  async function getPlanSessionByToken(token) {
    if (!token) return null;
    const sql = `
      SELECT *
      FROM plan_sessions
      WHERE token = $1
      LIMIT 1;
    `;
    const { rows } = await exec(sql, [token]);
    return rows[0] || null;
  }

  async function getLatestPlanSessionForUser(userId) {
    if (!userId) return null;
    const sql = `
      SELECT *
      FROM plan_sessions
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 1;
    `;
    const { rows } = await exec(sql, [userId]);
    return rows[0] || null;
  }

  async function getPlanSessionById(sessionId) {
    if (!sessionId) return null;
    const { rows } = await exec(
      'SELECT * FROM plan_sessions WHERE id = $1 LIMIT 1;',
      [sessionId],
    );
    return rows[0] || null;
  }

  async function deletePlanSession(sessionId) {
    if (!sessionId) return false;
    const { rowCount } = await exec('DELETE FROM plan_sessions WHERE id = $1', [sessionId]);
    return rowCount > 0;
  }

  async function purgeExpiredPlanSessions(now = new Date()) {
    if (!cleanupSessionMs) return 0;
    const cutoff = new Date(now.getTime() - cleanupSessionMs);
    const { rowCount } = await exec(
      'DELETE FROM plan_sessions WHERE expires_at < $1 OR updated_at < $2',
      [now, cutoff],
    );
    return rowCount;
  }

  async function deletePlanSessionsForUser(userId) {
    if (!userId) return 0;
    const { rowCount } = await exec('DELETE FROM plan_sessions WHERE user_id = $1', [userId]);
    return rowCount;
  }
  async function getLatestTimeSessionForUser(userId) {
    if (!userId) return null;
    const sql = `
      SELECT *
      FROM plan_sessions
      WHERE user_id = $1
        AND current_step LIKE 'time_%'
      ORDER BY updated_at DESC
      LIMIT 1;
    `;
    const { rows } = await exec(sql, [userId]);
    return rows[0] || null;
  }

  async function getPlanSessionByPlan(planId) {
    if (!planId) return null;
    const sql = `
      SELECT *
      FROM plan_sessions
      WHERE plan_id = $1
      ORDER BY updated_at DESC
      LIMIT 1;
    `;
    const { rows } = await exec(sql, [planId]);
    return rows[0] || null;
  }

  async function deletePlanSessionsByPlan(planId) {
    if (!planId) return 0;
    const { rowCount } = await exec('DELETE FROM plan_sessions WHERE plan_id = $1', [planId]);
    return rowCount;
  }

  async function createStageOptions(stageId, options, client) {
    if (!options?.length) return [];
    const usedClient = client || pool;
    const inserted = [];
    for (const opt of options) {
      const sql = `
        INSERT INTO stage_options (stage_id, product, ai, dose_value, dose_unit, method, meta)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *;
      `;
      const params = [
        stageId,
        opt.product,
        opt.ai || null,
        opt.dose_value ?? null,
        opt.dose_unit || null,
        opt.method || null,
        json(opt.meta),
      ];
      const { rows } = await exec(sql, params, usedClient);
      inserted.push(rows[0]);
    }
    return inserted;
  }

  async function createStagesWithOptions(planId, definitions) {
    if (!definitions?.length) return [];
    return withTransaction(pool, async (client) => {
      const created = [];
      for (const def of definitions) {
        const [stage] = await createPlanStages(planId, [def], client);
        let options = [];
        if (def.options?.length) {
          options = await createStageOptions(stage.id, def.options, client);
        }
        created.push({ stage, options });
      }
      return created;
    });
  }

  async function getPlanStagesWithOptions(planId) {
    const sql = `
      SELECT
        ps.*,
        so.id        AS option_id,
        so.product   AS option_product,
        so.ai        AS option_ai,
        so.dose_value,
        so.dose_unit,
        so.method,
        so.meta      AS option_meta,
        so.is_selected,
        so.created_at AS option_created_at
      FROM plan_stages ps
      LEFT JOIN stage_options so ON so.stage_id = ps.id
      WHERE ps.plan_id = $1
      ORDER BY ps.id ASC, option_created_at ASC, so.id ASC;
    `;
    const { rows } = await exec(sql, [planId]);
    const map = new Map();
    for (const row of rows) {
      if (!map.has(row.id)) {
        map.set(row.id, {
          id: row.id,
          plan_id: row.plan_id,
          title: row.title,
          kind: row.kind,
          note: row.note,
          phi_days: row.phi_days,
          meta: row.meta,
          created_at: row.created_at,
          options: [],
        });
      }
      if (row.option_id) {
        map.get(row.id).options.push({
          id: row.option_id,
          stage_id: row.id,
          product: row.option_product,
          ai: row.option_ai,
          dose_value: row.dose_value,
          dose_unit: row.dose_unit,
          method: row.method,
          meta: row.option_meta,
          is_selected: row.is_selected,
          created_at: row.option_created_at,
        });
      }
    }
    return Array.from(map.values());
  }

  async function selectStageOption({ userId, planId, stageId, optionId }) {
    return withTransaction(pool, async (client) => {
      const stageSql = `
        SELECT ps.*, p.user_id, p.object_id
        FROM plan_stages ps
        JOIN plans p ON p.id = ps.plan_id
        WHERE ps.id = $1;
      `;
      const stageRes = await exec(stageSql, [stageId], client);
      const stage = stageRes.rows[0];
      if (!stage) throw new Error('stage_not_found');
      const stagePlanKey = stage.plan_id != null ? String(stage.plan_id) : null;
      const requestedPlanKey = planId != null ? String(planId) : null;
      if (requestedPlanKey && stagePlanKey !== requestedPlanKey) {
        throw new Error('plan_mismatch');
      }
      const stageOwnerKey = stage.user_id != null ? String(stage.user_id) : null;
      const requesterKey = userId != null ? String(userId) : null;
      if (stageOwnerKey && requesterKey && stageOwnerKey !== requesterKey) {
        throw new Error('forbidden');
      }

      await exec('UPDATE stage_options SET is_selected = FALSE WHERE stage_id = $1', [stageId], client);
      const updateSql = `
        UPDATE stage_options
        SET is_selected = TRUE
        WHERE id = $1 AND stage_id = $2
        RETURNING *;
      `;
      const optRes = await exec(updateSql, [optionId, stageId], client);
      const option = optRes.rows[0];
      if (!option) throw new Error('option_not_found');
      return { stage, option };
    });
  }

  async function getStageById(stageId) {
    const sql = `
      SELECT ps.*, p.user_id, p.object_id
      FROM plan_stages ps
      JOIN plans p ON p.id = ps.plan_id
      WHERE ps.id = $1;
    `;
    const { rows } = await exec(sql, [stageId]);
    return rows[0] || null;
  }

  async function getStageOptionById(optionId) {
    const sql = `
      SELECT so.*, ps.plan_id
      FROM stage_options so
      JOIN plan_stages ps ON ps.id = so.stage_id
      WHERE so.id = $1;
    `;
    const { rows } = await exec(sql, [optionId]);
    return rows[0] || null;
  }

  async function findPlanByHash({ userId, objectId, hash }) {
    if (!hash) return null;
    const params = [hash];
    let sql = `
      SELECT *
      FROM plans
      WHERE hash = $1
    `;
    let idx = 2;
    if (userId) {
      sql += ` AND user_id = $${idx}`;
      params.push(userId);
      idx += 1;
    }
    if (objectId) {
      sql += ` AND object_id = $${idx}`;
      params.push(objectId);
    }
    sql += ' ORDER BY created_at DESC LIMIT 1;';
    const { rows } = await exec(sql, params);
    return rows[0] || null;
  }

  async function findLatestPlanByObject(objectId, statuses = []) {
    if (!objectId) return null;
    const params = [objectId];
    let sql = `
      SELECT *
      FROM plans
      WHERE object_id = $1
    `;
    if (Array.isArray(statuses) && statuses.length) {
      params.push(statuses);
      sql += ` AND status = ANY($${params.length})`;
    }
    sql += ' ORDER BY created_at DESC LIMIT 1;';
    const { rows } = await exec(sql, params);
    return rows[0] || null;
  }

  async function updatePlanStatus({ planId, status, userId = null }) {
    if (!planId || !status) return null;
    const params = [status, planId];
    let sql = `
      UPDATE plans
      SET status = $1
      WHERE id = $2
    `;
    if (userId) {
      sql += ` AND user_id = $${params.length + 1}`;
      params.push(userId);
    }
    sql += ' RETURNING *;';
    const { rows } = await exec(sql, params);
    return rows[0] || null;
  }

  async function createAutoplanRun(data) {
    const sql = `
      INSERT INTO autoplan_runs (
        user_id,
        plan_id,
        stage_id,
        stage_option_id,
        min_hours_ahead,
        horizon_hours
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *;
    `;
    const params = [
      data.user_id,
      data.plan_id,
      data.stage_id,
      data.stage_option_id || null,
      Number.isFinite(data.min_hours_ahead) ? data.min_hours_ahead : 2,
      Number.isFinite(data.horizon_hours) ? data.horizon_hours : 72,
    ];
    const { rows } = await exec(sql, params);
    return rows[0];
  }

  async function updateAutoplanRun(runId, patch) {
    if (!patch || !Object.keys(patch).length) return null;
    const fields = [];
    const values = [];
    let idx = 1;
    for (const [key, value] of Object.entries(patch)) {
      fields.push(`${key} = $${idx}`);
      values.push(value);
      idx += 1;
    }
    fields.push(`updated_at = NOW()`);
    const sql = `
      UPDATE autoplan_runs
      SET ${fields.join(', ')}
      WHERE id = $${idx}
      RETURNING *;
    `;
    values.push(runId);
    const { rows } = await exec(sql, values);
    return rows[0] || null;
  }

  async function listPendingAutoplanRuns(limit = 5) {
    const sql = `
      SELECT id
      FROM autoplan_runs
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT $1
    `;
    const { rows } = await exec(sql, [limit]);
    return rows;
  }

  async function getAutoplanRunContext(runId) {
    const sql = `
      SELECT
        ar.id                 AS run_id,
        ar.status             AS run_status,
        ar.min_hours_ahead,
        ar.horizon_hours,
        ar.stage_option_id,
        ar.user_id            AS run_user_id,
        ar.plan_id,
        ar.stage_id,
        ar.created_at         AS run_created_at,
        u.tg_id               AS user_tg_id,
        p.title               AS plan_title,
        p.object_id,
        ps.title              AS stage_title,
        ps.kind               AS stage_kind,
        ps.phi_days           AS stage_phi_days,
        ps.meta               AS stage_meta,
        so.product            AS option_product,
        so.ai                 AS option_ai,
        so.dose_value,
        so.dose_unit,
        so.method             AS option_method,
        so.meta               AS option_meta,
        o.name                AS object_name,
        o.meta                AS object_meta,
        o.location_tag        AS object_location_tag
      FROM autoplan_runs ar
      JOIN users u ON u.id = ar.user_id
      JOIN plans p ON p.id = ar.plan_id
      JOIN plan_stages ps ON ps.id = ar.stage_id
      LEFT JOIN stage_options so ON so.id = ar.stage_option_id
      LEFT JOIN objects o ON o.id = p.object_id
      WHERE ar.id = $1
      LIMIT 1;
    `;
    const { rows } = await exec(sql, [runId]);
    if (!rows.length) return null;
    const row = rows[0];
    return {
      run: {
        id: row.run_id,
        status: row.run_status,
        min_hours_ahead: row.min_hours_ahead,
        horizon_hours: row.horizon_hours,
        stage_option_id: row.stage_option_id,
        created_at: row.run_created_at,
      },
      user: {
        id: row.run_user_id,
        tg_id: row.user_tg_id,
      },
      plan: {
        id: row.plan_id,
        title: row.plan_title,
        object_id: row.object_id,
      },
      stage: {
        id: row.stage_id,
        plan_id: row.plan_id,
        title: row.stage_title,
        kind: row.stage_kind,
        phi_days: row.stage_phi_days,
        meta: row.stage_meta || {},
      },
      option: row.stage_option_id
        ? {
            id: row.stage_option_id,
            stage_id: row.stage_id,
            product: row.option_product,
            ai: row.option_ai,
            dose_value: row.dose_value,
            dose_unit: row.dose_unit,
            method: row.option_method,
            meta: row.option_meta || {},
          }
        : null,
      object: row.object_id
        ? {
            id: row.object_id,
            name: row.object_name,
            meta: row.object_meta || {},
            location_tag: row.object_location_tag,
          }
        : null,
    };
  }

  async function upsertTreatmentSlot(slot) {
    const sql = `
      INSERT INTO treatment_slots (
        autoplan_run_id,
        plan_id,
        stage_id,
        stage_option_id,
        slot_start,
        slot_end,
        score,
        reason,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (stage_option_id, slot_start)
      DO UPDATE SET
        autoplan_run_id = EXCLUDED.autoplan_run_id,
        slot_end = EXCLUDED.slot_end,
        score = EXCLUDED.score,
        reason = EXCLUDED.reason,
        status = EXCLUDED.status
      RETURNING *;
    `;
    const reasonPayload = Array.isArray(slot.reason)
      ? slot.reason
      : slot.reason
        ? [slot.reason]
        : [];
    const params = [
      slot.autoplan_run_id || null,
      slot.plan_id,
      slot.stage_id,
      slot.stage_option_id || null,
      slot.slot_start,
      slot.slot_end,
      slot.score ?? null,
      reasonPayload,
      slot.status || 'proposed',
    ];
    const { rows } = await exec(sql, params);
    return rows[0];
  }

  async function getTreatmentSlotContext(slotId) {
    if (!slotId) return null;
    const sql = `
      SELECT
        ts.id                 AS slot_id,
        ts.plan_id            AS slot_plan_id,
        ts.stage_id           AS slot_stage_id,
        ts.stage_option_id    AS slot_option_id,
        ts.autoplan_run_id    AS slot_autoplan_run_id,
        ts.slot_start,
        ts.slot_end,
        ts.score              AS slot_score,
        ts.reason             AS slot_reason,
        ts.status             AS slot_status,
        ts.created_at         AS slot_created_at,
        p.id                  AS plan_id,
        p.user_id             AS plan_user_id,
        p.object_id           AS plan_object_id,
        p.status              AS plan_status,
        p.title               AS plan_title,
        u.id                  AS user_id,
        u.tg_id               AS user_tg_id,
        ps.title              AS stage_title,
        ps.kind               AS stage_kind,
        ps.phi_days           AS stage_phi_days,
        ps.meta               AS stage_meta,
        so.id                 AS option_id,
        so.product            AS option_product,
        so.ai                 AS option_ai,
        so.dose_value         AS option_dose_value,
        so.dose_unit          AS option_dose_unit,
        so.method             AS option_method,
        so.meta               AS option_meta,
        o.id                  AS object_id,
        o.name                AS object_name,
        o.meta                AS object_meta,
        o.location_tag        AS object_location_tag,
        ar.id                 AS run_id,
        ar.status             AS run_status,
        ar.min_hours_ahead    AS run_min_hours_ahead,
        ar.horizon_hours      AS run_horizon_hours
      FROM treatment_slots ts
      JOIN plans p ON p.id = ts.plan_id
      JOIN users u ON u.id = p.user_id
      JOIN plan_stages ps ON ps.id = ts.stage_id
      LEFT JOIN stage_options so ON so.id = ts.stage_option_id
      LEFT JOIN objects o ON o.id = p.object_id
      LEFT JOIN autoplan_runs ar ON ar.id = ts.autoplan_run_id
      WHERE ts.id = $1
      LIMIT 1;
    `;
    const { rows } = await exec(sql, [slotId]);
    const row = rows[0];
    if (!row) return null;
    return {
      slot: {
        id: row.slot_id,
        plan_id: row.slot_plan_id,
        stage_id: row.slot_stage_id,
        stage_option_id: row.slot_option_id,
        autoplan_run_id: row.slot_autoplan_run_id,
        slot_start: row.slot_start,
        slot_end: row.slot_end,
        score: row.slot_score,
        reason: row.slot_reason || [],
        status: row.slot_status,
        created_at: row.slot_created_at,
      },
      plan: {
        id: row.plan_id,
        user_id: row.plan_user_id,
        object_id: row.plan_object_id,
        status: row.plan_status,
        title: row.plan_title,
      },
      user: {
        id: row.user_id,
        tg_id: row.user_tg_id,
      },
      stage: {
        id: row.slot_stage_id,
        plan_id: row.slot_plan_id,
        title: row.stage_title,
        kind: row.stage_kind,
        phi_days: row.stage_phi_days,
        meta: row.stage_meta || {},
      },
      stageOption: row.option_id
        ? {
            id: row.option_id,
            product: row.option_product,
            ai: row.option_ai,
            dose_value: row.option_dose_value,
            dose_unit: row.option_dose_unit,
            method: row.option_method,
            meta: row.option_meta || {},
          }
        : null,
      object: row.object_id
        ? {
            id: row.object_id,
            name: row.object_name,
            meta: row.object_meta || {},
            location_tag: row.object_location_tag,
          }
        : null,
      autoplanRun: row.run_id
        ? {
            id: row.run_id,
            status: row.run_status,
            min_hours_ahead: row.run_min_hours_ahead,
            horizon_hours: row.run_horizon_hours,
          }
        : null,
    };
  }

  async function updateTreatmentSlot(slotId, patch = {}) {
    if (!slotId || !patch || !Object.keys(patch).length) return null;
    const fields = [];
    const values = [];
    let idx = 1;
    for (const [key, value] of Object.entries(patch)) {
      fields.push(`${key} = $${idx}`);
      values.push(value);
      idx += 1;
    }
    const sql = `
      UPDATE treatment_slots
      SET ${fields.join(', ')}
      WHERE id = $${idx}
      RETURNING *;
    `;
    values.push(slotId);
    const { rows } = await exec(sql, values);
    return rows[0] || null;
  }

  async function createEvents(events, client) {
    if (!events?.length) return [];
    const usedClient = client || pool;
    const inserted = [];
    for (const event of events) {
      const sql = `
        INSERT INTO events (
          user_id,
          plan_id,
          stage_id,
          stage_option_id,
          autoplan_run_id,
          type,
          due_at,
          slot_end,
          status,
          completed_at,
          reason,
          source
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING *;
      `;
      const params = [
        event.user_id,
        event.plan_id,
        event.stage_id || null,
        event.stage_option_id || null,
        event.autoplan_run_id || null,
        event.type,
        event.due_at || null,
        event.slot_end || null,
        event.status || 'scheduled',
        event.completed_at || null,
        event.reason || null,
        event.source || null,
      ];
      const { rows } = await exec(sql, params, usedClient);
      inserted.push(rows[0]);
    }
    return inserted;
  }

  async function createReminders(reminders, client) {
    if (!reminders?.length) return [];
    const usedClient = client || pool;
    const inserted = [];
    for (const reminder of reminders) {
      const sql = `
        INSERT INTO reminders (user_id, event_id, fire_at, channel, status, payload)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *;
      `;
      const params = [
        reminder.user_id,
        reminder.event_id,
        reminder.fire_at,
        reminder.channel || 'telegram',
        reminder.status || 'pending',
        json(reminder.payload),
      ];
      const { rows } = await exec(sql, params, usedClient);
      inserted.push(rows[0]);
    }
    return inserted;
  }

  async function dueReminders(now = new Date()) {
    const sql = `
      SELECT
        r.*,
        e.type        AS event_type,
        e.due_at      AS event_due_at,
        e.plan_id,
        e.stage_id,
        e.status      AS event_status,
        p.user_id,
        p.object_id,
        p.title       AS plan_title,
        u.tg_id       AS user_tg_id,
        ps.title      AS stage_title
      FROM reminders r
      JOIN events e ON e.id = r.event_id
      JOIN plans p ON p.id = e.plan_id
      LEFT JOIN plan_stages ps ON ps.id = e.stage_id
      JOIN users u ON u.id = p.user_id
      WHERE r.sent_at IS NULL
        AND r.fire_at <= $1
      ORDER BY r.fire_at ASC, r.id ASC;
    `;
    const { rows } = await exec(sql, [now]);
    return rows;
  }

  async function pendingReminders(after = new Date()) {
    const sql = `
      SELECT
        r.*,
        e.type        AS event_type,
        e.due_at      AS event_due_at,
        e.plan_id,
        e.stage_id,
        e.status      AS event_status,
        p.user_id,
        p.object_id,
        p.title       AS plan_title,
        u.tg_id       AS user_tg_id,
        ps.title      AS stage_title
      FROM reminders r
      JOIN events e ON e.id = r.event_id
      JOIN plans p ON p.id = e.plan_id
      LEFT JOIN plan_stages ps ON ps.id = e.stage_id
      JOIN users u ON u.id = p.user_id
      WHERE r.sent_at IS NULL
        AND r.fire_at > $1
      ORDER BY r.fire_at ASC;
    `;
    const { rows } = await exec(sql, [after]);
    return rows;
  }

  async function markReminderSent(reminderId, messageId = null) {
    const sql = `
      UPDATE reminders
      SET sent_at = NOW(), message_id = $2
      WHERE id = $1
      RETURNING *;
    `;
    const { rows } = await exec(sql, [reminderId, messageId]);
    return rows[0] || null;
  }

  async function updateEventStatus(eventId, status, completedAt = null, dueAt = null) {
    const sql = `
      UPDATE events
      SET status = $2,
          completed_at = COALESCE($3, completed_at),
          due_at = COALESCE($4, due_at)
      WHERE id = $1
      RETURNING *;
    `;
    const { rows } = await exec(sql, [eventId, status, completedAt, dueAt]);
    return rows[0] || null;
  }

  async function getNextScheduledEvent(userId) {
    const sql = `
      SELECT
        e.*,
        ps.title AS stage_title,
        p.title  AS plan_title
      FROM events e
      JOIN plans p ON p.id = e.plan_id
      LEFT JOIN plan_stages ps ON ps.id = e.stage_id
      WHERE e.user_id = $1
        AND e.status = 'scheduled'
      ORDER BY e.due_at ASC NULLS LAST, e.id ASC
      LIMIT 1;
    `;
    const { rows } = await exec(sql, [userId]);
    return rows[0] || null;
  }

  async function getEventByIdForUser(eventId, userId) {
    if (!eventId || !userId) return null;
    const sql = `
      SELECT
        e.*,
        ps.title AS stage_title,
        p.title  AS plan_title
      FROM events e
      JOIN plans p ON p.id = e.plan_id
      LEFT JOIN plan_stages ps ON ps.id = e.stage_id
      WHERE e.id = $1
        AND p.user_id = $2
      LIMIT 1;
    `;
    const { rows } = await exec(sql, [eventId, userId]);
    return rows[0] || null;
  }

  async function logFunnelEvent({
    event,
    userId,
    objectId = null,
    planId = null,
    data = null,
  }) {
    if (!event || !userId) return null;
    const sql = `
      INSERT INTO plan_funnel_events (event, user_id, object_id, plan_id, data)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *;
    `;
    const params = [event, userId, objectId || null, planId || null, json(data || {})];
    const { rows } = await exec(sql, params);
    return rows[0] || null;
  }

  async function getTopCrops(limit = 5, days = 30) {
    const sql = `
      SELECT
        COALESCE(crop, 'unknown') AS name,
        COUNT(*) AS cnt
      FROM cases
      WHERE created_at >= NOW() - INTERVAL '${days} days'
        AND crop IS NOT NULL
        AND crop <> ''
      GROUP BY crop
      ORDER BY cnt DESC
      LIMIT $1;
    `;
    const { rows } = await exec(sql, [limit]);
    return rows || [];
  }

  async function getTopDiseases(limit = 5, days = 30) {
    const sql = `
      SELECT
        COALESCE(disease, 'unknown') AS name,
        COUNT(*) AS cnt
      FROM cases
      WHERE created_at >= NOW() - INTERVAL '${days} days'
        AND disease IS NOT NULL
        AND disease <> ''
      GROUP BY disease
      ORDER BY cnt DESC
      LIMIT $1;
    `;
    const { rows } = await exec(sql, [limit]);
    return rows || [];
  }

  return {
    ensureUser,
    getUserByTgId,
    updateUserLastObject,
    listObjects,
    createObject,
    getObjectById,
    mergeObjects,
    updateObjectMeta,
    createCase,
    createPlan,
    getPlanById,
    getPlanForUser,
    listPlansByObject,
    createPlanStages,
    createStageOptions,
    createStagesWithOptions,
    getPlanStagesWithOptions,
    selectStageOption,
    getStageById,
    getStageOptionById,
    findPlanByHash,
    findLatestPlanByObject,
    updatePlanStatus,
    saveRecentDiagnosis,
    getLatestRecentDiagnosis,
    getRecentDiagnosisById,
    linkRecentDiagnosisToPlan,
    createPlanSession,
    updatePlanSession,
    getPlanSessionByToken,
    getPlanSessionById,
    getLatestPlanSessionForUser,
    getPlanSessionByPlan,
    getLatestTimeSessionForUser,
    deletePlanSession,
    purgeExpiredPlanSessions,
    deletePlanSessionsForUser,
    deletePlanSessionsByPlan,
    listUpcomingEventsByUser,
    listOverdueEventsByUser,
    listOverdueUsersSummary,
    createEvents,
    createReminders,
    dueReminders,
    pendingReminders,
    markReminderSent,
    updateEventStatus,
    getNextScheduledEvent,
    getEventByIdForUser,
    logFunnelEvent,
    getTopCrops,
    getTopDiseases,
    createAutoplanRun,
    updateAutoplanRun,
    listPendingAutoplanRuns,
    getAutoplanRunContext,
    upsertTreatmentSlot,
    getTreatmentSlotContext,
    updateTreatmentSlot,
    withTransaction: (fn) => withTransaction(pool, fn),
  };
}

module.exports = { createDb, withTransaction };
