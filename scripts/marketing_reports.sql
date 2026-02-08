-- Marketing Reports for Plan v2.4
-- Usage: psql -f scripts/marketing_reports.sql

-- ============================================================
-- MARK-009: Retention Cohorts D1/D7/D14
-- ============================================================

-- Daily cohort retention report
-- Shows what percentage of users who started on a given date 
-- returned on D1, D7, D14

WITH cohorts AS (
  SELECT 
    u.id AS user_id,
    DATE(u.created_at) AS cohort_date
  FROM users u
  WHERE u.created_at >= CURRENT_DATE - INTERVAL '30 days'
),
user_activity AS (
  SELECT 
    ae.user_id,
    DATE(ae.ts) AS activity_date
  FROM analytics_events ae
  WHERE ae.event IN ('diagnosis_shown', 'photo_received', 'plan_treatment_clicked')
    AND ae.ts >= CURRENT_DATE - INTERVAL '45 days'
  GROUP BY ae.user_id, DATE(ae.ts)
),
retention AS (
  SELECT
    c.cohort_date,
    c.user_id,
    -- D1: returned next day
    CASE WHEN EXISTS (
      SELECT 1 FROM user_activity ua 
      WHERE ua.user_id = c.user_id 
        AND ua.activity_date = c.cohort_date + INTERVAL '1 day'
    ) THEN 1 ELSE 0 END AS d1,
    -- D7: returned on day 7
    CASE WHEN EXISTS (
      SELECT 1 FROM user_activity ua 
      WHERE ua.user_id = c.user_id 
        AND ua.activity_date = c.cohort_date + INTERVAL '7 days'
    ) THEN 1 ELSE 0 END AS d7,
    -- D14: returned on day 14
    CASE WHEN EXISTS (
      SELECT 1 FROM user_activity ua 
      WHERE ua.user_id = c.user_id 
        AND ua.activity_date = c.cohort_date + INTERVAL '14 days'
    ) THEN 1 ELSE 0 END AS d14
  FROM cohorts c
)
SELECT
  cohort_date,
  COUNT(DISTINCT user_id) AS cohort_size,
  ROUND(100.0 * SUM(d1) / NULLIF(COUNT(*), 0), 1) AS d1_pct,
  ROUND(100.0 * SUM(d7) / NULLIF(COUNT(*), 0), 1) AS d7_pct,
  ROUND(100.0 * SUM(d14) / NULLIF(COUNT(*), 0), 1) AS d14_pct
FROM retention
GROUP BY cohort_date
ORDER BY cohort_date DESC;


-- ============================================================
-- MARK-010: Low Confidence % by Day
-- ============================================================

-- Shows percentage of diagnoses with confidence < 0.6 (low confidence)
-- These diagnoses don't consume a case in the new model

WITH daily_diagnoses AS (
  SELECT
    DATE(p.ts) AS diagnosis_date,
    COUNT(*) AS total_diagnoses,
    COUNT(*) FILTER (WHERE p.confidence < 0.6) AS low_confidence_count,
    COUNT(*) FILTER (WHERE p.confidence >= 0.6) AS high_confidence_count
  FROM photos p
  WHERE p.ts >= CURRENT_DATE - INTERVAL '30 days'
    AND p.status = 'ok'
  GROUP BY DATE(p.ts)
)
SELECT
  diagnosis_date,
  total_diagnoses,
  low_confidence_count,
  high_confidence_count,
  ROUND(100.0 * low_confidence_count / NULLIF(total_diagnoses, 0), 1) AS low_confidence_pct
FROM daily_diagnoses
ORDER BY diagnosis_date DESC;


-- ============================================================
-- Daily Funnel Report
-- ============================================================

-- Acquisition -> Activation -> Diagnosis -> Free->Pro Conversion

WITH daily_stats AS (
  SELECT
    DATE(ts) AS report_date,
    COUNT(*) FILTER (WHERE event = 'start') AS starts,
    COUNT(*) FILTER (WHERE event = 'photo_received') AS photos_received,
    COUNT(*) FILTER (WHERE event = 'diagnosis_shown') AS diagnoses_shown,
    COUNT(*) FILTER (WHERE event = 'paywall_shown') AS paywall_shown,
    COUNT(*) FILTER (WHERE event = 'payment_success') AS payments
  FROM analytics_events
  WHERE ts >= CURRENT_DATE - INTERVAL '30 days'
  GROUP BY DATE(ts)
)
SELECT
  report_date,
  starts,
  photos_received,
  diagnoses_shown,
  paywall_shown,
  payments,
  ROUND(100.0 * diagnoses_shown / NULLIF(starts, 0), 1) AS activation_rate,
  ROUND(100.0 * payments / NULLIF(paywall_shown, 0), 1) AS conversion_rate
FROM daily_stats
ORDER BY report_date DESC;


-- ============================================================
-- UTM Campaign Performance
-- ============================================================

-- Shows performance by UTM source/medium/campaign

SELECT
  COALESCE(u.utm_source, '(direct)') AS source,
  COALESCE(u.utm_medium, '(none)') AS medium,
  COALESCE(u.utm_campaign, '(none)') AS campaign,
  COUNT(*) AS users,
  COUNT(*) FILTER (WHERE u.pro_expires_at > NOW()) AS pro_users,
  ROUND(100.0 * COUNT(*) FILTER (WHERE u.pro_expires_at > NOW()) / NULLIF(COUNT(*), 0), 1) AS pro_pct
FROM users u
WHERE u.created_at >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY u.utm_source, u.utm_medium, u.utm_campaign
ORDER BY users DESC
LIMIT 20;


-- ============================================================
-- Weekly Case Usage Summary
-- ============================================================

-- Shows case usage distribution for current week

SELECT
  cu.week,
  COUNT(DISTINCT cu.user_id) AS active_users,
  SUM(cu.cases_used) AS total_cases,
  ROUND(AVG(cu.cases_used), 2) AS avg_cases_per_user,
  COUNT(*) FILTER (WHERE cu.cases_used >= 1) AS users_at_limit
FROM case_usage cu
GROUP BY cu.week
ORDER BY cu.week DESC
LIMIT 8;


-- ============================================================
-- Trial Period Effectiveness
-- ============================================================

-- Shows how many trial users convert to Pro

WITH trial_users AS (
  SELECT
    u.id,
    u.trial_ends_at,
    u.pro_expires_at,
    u.created_at,
    CASE 
      WHEN u.pro_expires_at > NOW() THEN 'converted'
      WHEN u.trial_ends_at < NOW() THEN 'expired'
      ELSE 'active_trial'
    END AS status
  FROM users u
  WHERE u.trial_ends_at IS NOT NULL
    AND u.created_at >= CURRENT_DATE - INTERVAL '30 days'
)
SELECT
  status,
  COUNT(*) AS user_count,
  ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS pct
FROM trial_users
GROUP BY status
ORDER BY user_count DESC;


-- ============================================================
-- Share Button Analytics
-- ============================================================

-- Shows share button click rate and virality

SELECT
  DATE(ae.ts) AS report_date,
  COUNT(*) FILTER (WHERE ae.event = 'diagnosis_shown') AS diagnoses,
  COUNT(*) FILTER (WHERE ae.event = 'share_clicked') AS shares,
  ROUND(100.0 * COUNT(*) FILTER (WHERE ae.event = 'share_clicked') / 
        NULLIF(COUNT(*) FILTER (WHERE ae.event = 'diagnosis_shown'), 0), 1) AS share_rate
FROM analytics_events ae
WHERE ae.ts >= CURRENT_DATE - INTERVAL '14 days'
  AND ae.event IN ('diagnosis_shown', 'share_clicked')
GROUP BY DATE(ae.ts)
ORDER BY report_date DESC;






