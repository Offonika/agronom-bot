#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');
require('dotenv').config();

const filePath = process.argv[2];
const shouldTruncate = process.argv.includes('--truncate');

if (!filePath) {
  console.error('Usage: node scripts/seed_product_rules.js <rules.(csv|json)> [--truncate]');
  process.exitCode = 1;
  process.exit();
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

function parseCsv(content) {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return [];
  const headers = splitCsvLine(lines.shift()).map((h) => h.trim());
  return lines.map((line, idx) => {
    const cells = splitCsvLine(line);
    const row = {};
    headers.forEach((header, i) => {
      row[header] = cells[i] !== undefined ? cells[i] : '';
    });
    row.__line = idx + 2; // account for header line
    return row;
  });
}

function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === ',' && !inQuotes) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function parseJsonField(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    console.warn(`⚠️  Could not parse JSON field: ${value}`);
    return {};
  }
}

function normalizeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

async function loadRules(file) {
  const absolute = path.resolve(process.cwd(), file);
  const content = await fs.readFile(absolute, 'utf8');
  if (absolute.endsWith('.json')) {
    const data = JSON.parse(content);
    if (!Array.isArray(data)) {
      throw new Error('JSON file must contain an array of rules');
    }
    return data;
  }
  if (absolute.endsWith('.csv')) {
    return parseCsv(content);
  }
  throw new Error('Unsupported file type. Use .csv or .json');
}

async function main() {
  const rules = await loadRules(filePath);
  if (!rules.length) {
    console.log('No rules found in file.');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (shouldTruncate) {
      await client.query('TRUNCATE product_rules RESTART IDENTITY CASCADE;');
    }
    let insertedRules = 0;
    for (const entry of rules) {
      if (!entry.crop || !entry.disease || !entry.product) {
        console.warn(`⚠️  Skip row (line ${entry.__line ?? '?'}) - missing crop/disease/product`);
        continue;
      }
      const productRes = await client.query(
        `
          INSERT INTO products (product, ai, form, constraints)
          VALUES ($1, $2, $3, $4::jsonb)
          ON CONFLICT (product)
          DO UPDATE
            SET ai = EXCLUDED.ai,
                form = COALESCE(EXCLUDED.form, products.form),
                constraints = COALESCE(EXCLUDED.constraints, products.constraints)
          RETURNING id;
        `,
        [
          entry.product,
          entry.ai || null,
          entry.form || null,
          JSON.stringify(parseJsonField(entry.constraints)),
        ],
      );
      const productId = productRes.rows[0].id;
      await client.query(
        `
          INSERT INTO product_rules (crop, disease, region, product_id, dose_value, dose_unit, phi_days, safety, meta)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
          ON CONFLICT (crop, disease, COALESCE(region, ''), product_id)
          DO UPDATE
            SET dose_value = EXCLUDED.dose_value,
                dose_unit = EXCLUDED.dose_unit,
                phi_days = EXCLUDED.phi_days,
                safety = EXCLUDED.safety,
                meta = EXCLUDED.meta,
                region = EXCLUDED.region
          ;
        `,
        [
          entry.crop,
          entry.disease,
          entry.region || null,
          productId,
          normalizeNumber(entry.dose_value),
          entry.dose_unit || null,
          normalizeNumber(entry.phi_days),
          JSON.stringify(parseJsonField(entry.safety)),
          JSON.stringify(parseJsonField(entry.meta)),
        ],
      );
      insertedRules += 1;
    }
    await client.query('COMMIT');
    console.log(`Imported ${insertedRules} rules from ${filePath}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    pool.end();
  });
