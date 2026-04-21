-- QA quality metrics for bot response improvements
-- Source: beta_events.event_type = 'qa_case_logged'
-- Usage:
--   1) Set release date once per rollout in params.release_date_msk
--   2) Compare baseline (14d before) vs control (14d after)

WITH params AS (
  SELECT
    TIMESTAMP '2026-02-20 00:00:00' AS release_date_msk
),
cases AS (
  SELECT
    be.created_at,
    COALESCE(be.payload ->> 'scenario', 'unknown') AS scenario,
    COALESCE(be.payload ->> 'error_type', 'unknown') AS error_type,
    COALESCE(be.payload ->> 'severity', 'unknown') AS severity
  FROM beta_events be
  WHERE be.event_type = 'qa_case_logged'
),
windowed AS (
  SELECT
    c.*,
    CASE
      WHEN c.created_at >= p.release_date_msk - INTERVAL '14 days'
       AND c.created_at <  p.release_date_msk THEN 'baseline'
      WHEN c.created_at >= p.release_date_msk
       AND c.created_at <  p.release_date_msk + INTERVAL '14 days' THEN 'control'
      ELSE NULL
    END AS period
  FROM cases c
  CROSS JOIN params p
)

-- 1) Daily S1/S2 share by scenario (main KPI monitor)
SELECT
  DATE(created_at) AS day,
  scenario,
  COUNT(*) AS total_cases,
  SUM(CASE WHEN severity IN ('S1', 'S2') THEN 1 ELSE 0 END) AS s1_s2_cases,
  ROUND(
    100.0 * SUM(CASE WHEN severity IN ('S1', 'S2') THEN 1 ELSE 0 END)::numeric
    / NULLIF(COUNT(*), 0),
    2
  ) AS s1_s2_share_pct
FROM windowed
WHERE period IS NOT NULL
GROUP BY DATE(created_at), scenario
ORDER BY day DESC, scenario;

-- 2) Baseline vs control comparison for S1/S2 (target: >=30% reduction)
WITH summary AS (
  SELECT
    period,
    COUNT(*) AS total_cases,
    SUM(CASE WHEN severity IN ('S1', 'S2') THEN 1 ELSE 0 END) AS s1_s2_cases
  FROM windowed
  WHERE period IN ('baseline', 'control')
  GROUP BY period
)
SELECT
  period,
  total_cases,
  s1_s2_cases,
  ROUND(100.0 * s1_s2_cases::numeric / NULLIF(total_cases, 0), 2) AS s1_s2_share_pct
FROM summary
ORDER BY period;

-- 3) Top error types baseline vs control (for weekly Tonya review)
SELECT
  period,
  error_type,
  COUNT(*) AS cases_count
FROM windowed
WHERE period IN ('baseline', 'control')
GROUP BY period, error_type
ORDER BY period, cases_count DESC;

-- 4) Guardrail: context_lost / ux_dead_end should not grow
SELECT
  period,
  error_type,
  COUNT(*) AS cases_count
FROM windowed
WHERE period IN ('baseline', 'control')
  AND error_type IN ('context_lost', 'ux_dead_end')
GROUP BY period, error_type
ORDER BY error_type, period;
