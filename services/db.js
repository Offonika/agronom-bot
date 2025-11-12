'use strict';

const { Pool } = require('pg');

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
      INSERT INTO plans (user_id, object_id, case_id, title)
      VALUES ($1, $2, $3, $4)
      RETURNING *;
    `;
    const params = [plan.user_id, plan.object_id, plan.case_id || null, plan.title];
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
        SELECT ps.id, ps.plan_id, p.user_id
        FROM plan_stages ps
        JOIN plans p ON p.id = ps.plan_id
        WHERE ps.id = $1;
      `;
      const stageRes = await exec(stageSql, [stageId], client);
      const stage = stageRes.rows[0];
      if (!stage) throw new Error('stage_not_found');
      if (planId && stage.plan_id !== planId) throw new Error('plan_mismatch');
      if (stage.user_id !== userId) throw new Error('forbidden');

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
      SELECT ps.*, p.user_id
      FROM plan_stages ps
      JOIN plans p ON p.id = ps.plan_id
      WHERE ps.id = $1;
    `;
    const { rows } = await exec(sql, [stageId]);
    return rows[0] || null;
  }

  async function createEvents(events, client) {
    if (!events?.length) return [];
    const usedClient = client || pool;
    const inserted = [];
    for (const event of events) {
      const sql = `
        INSERT INTO events (user_id, plan_id, stage_id, type, due_at, status)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *;
      `;
      const params = [
        event.user_id,
        event.plan_id,
        event.stage_id || null,
        event.type,
        event.due_at || null,
        event.status || 'scheduled',
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
        INSERT INTO reminders (user_id, event_id, fire_at, payload)
        VALUES ($1, $2, $3, $4)
        RETURNING *;
      `;
      const params = [reminder.user_id, reminder.event_id, reminder.fire_at, json(reminder.payload)];
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

  async function updateEventStatus(eventId, status, completedAt = null) {
    const sql = `
      UPDATE events
      SET status = $2,
          completed_at = COALESCE($3, completed_at)
      WHERE id = $1
      RETURNING *;
    `;
    const { rows } = await exec(sql, [eventId, status, completedAt]);
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

  return {
    ensureUser,
    getUserByTgId,
    updateUserLastObject,
    listObjects,
    createObject,
    getObjectById,
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
    createEvents,
    createReminders,
    dueReminders,
    markReminderSent,
    updateEventStatus,
    getNextScheduledEvent,
    withTransaction: (fn) => withTransaction(pool, fn),
  };
}

module.exports = { createDb, withTransaction };
