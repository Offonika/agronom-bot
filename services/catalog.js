'use strict';

const { Pool } = require('pg');

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null) return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

const DEFAULT_STAGE_TEMPLATES = [
  {
    title: 'До цветения',
    kind: 'season',
    phi_days: 7,
    note: 'Зафиксируйте первую профилактическую обработку перед раскрытием бутонов.',
    meta: { window: 'pre_bloom' },
  },
  {
    title: 'После осадков >10 мм',
    kind: 'trigger',
    phi_days: 7,
    note: 'Запускайте повтор при сильном дожде или смыве рабочего раствора.',
    meta: { trigger: 'rain_mm>10' },
  },
  {
    title: 'При первых симптомах',
    kind: 'adhoc',
    phi_days: 7,
    note: 'Используйте при точечных вспышках или рецидиве заболевания.',
    meta: {},
  },
];

function ensurePool(pool) {
  if (pool instanceof Pool) return pool;
  throw new Error('services/catalog requires an instance of pg.Pool');
}

function createCatalog(poolInstance) {
  const useProductRules = parseBoolean(process.env.PLAN_USE_PRODUCT_RULES, false);
  const pool = useProductRules ? ensurePool(poolInstance) : null;
  const exec =
    pool && useProductRules ? (text, params = []) => pool.query(text, params) : null;

  async function suggestStages({ crop, disease } = {}) {
    // На MVP используем шаблон, но оставляем возможность донастройки в meta JSON.
    return DEFAULT_STAGE_TEMPLATES.map((stage, idx) => ({
      ...stage,
      title: stage.title,
      order: idx + 1,
      meta: {
        ...stage.meta,
        crop: crop || null,
        disease: disease || null,
      },
    }));
  }

  async function suggestOptions({ crop, disease, region = null, stageKind = null, limit = 3 } = {}) {
    if (!useProductRules || !exec) {
      return [];
    }
    const sql = `
      SELECT
        pr.*,
        p.product,
        p.ai,
        p.form
      FROM product_rules pr
      JOIN products p ON p.id = pr.product_id
      WHERE pr.crop = $1
        AND pr.disease = $2
        AND (pr.region IS NULL OR pr.region = $3)
      ORDER BY
        CASE
          WHEN pr.region = $3 THEN 0
          WHEN pr.region IS NULL THEN 1
          ELSE 2
        END,
        COALESCE( (pr.safety ->> 'score')::INT, 0 ) DESC,
        COALESCE(pr.phi_days, 9999),
        p.product ASC
      LIMIT $4;
    `;
    const params = [crop, disease, region, Math.max(limit, 1)];
    const { rows } = await exec(sql, params);
    return rows.map((row) => ({
      stage_kind: stageKind,
      product: row.product,
      ai: row.ai,
      form: row.form,
      dose_value: row.dose_value,
      dose_unit: row.dose_unit,
      phi_days: row.phi_days,
      safety: row.safety,
      meta: {
        ...row.meta,
        rule_id: row.id,
        region: row.region,
      },
    }));
  }

  return { suggestStages, suggestOptions, productRulesEnabled: useProductRules };
}

module.exports = { createCatalog, DEFAULT_STAGE_TEMPLATES };
