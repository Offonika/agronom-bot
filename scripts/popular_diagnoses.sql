-- Popular crops/diseases analytics for hints.
-- Uses cases as the primary source of confirmed diagnoses.

-- Top crops in the last 30 days.
SELECT
  COALESCE(crop, 'unknown') AS crop,
  COUNT(*) AS total_cases,
  COUNT(DISTINCT user_id) AS unique_users
FROM cases
WHERE created_at >= NOW() - INTERVAL '30 days'
GROUP BY COALESCE(crop, 'unknown')
ORDER BY total_cases DESC
LIMIT 20;

-- Top diseases in the last 30 days.
SELECT
  COALESCE(disease, 'unknown') AS disease,
  COUNT(*) AS total_cases,
  COUNT(DISTINCT user_id) AS unique_users
FROM cases
WHERE created_at >= NOW() - INTERVAL '30 days'
GROUP BY COALESCE(disease, 'unknown')
ORDER BY total_cases DESC
LIMIT 20;

-- Top crop + disease pairs in the last 30 days.
SELECT
  COALESCE(crop, 'unknown') AS crop,
  COALESCE(disease, 'unknown') AS disease,
  COUNT(*) AS total_cases
FROM cases
WHERE created_at >= NOW() - INTERVAL '30 days'
GROUP BY COALESCE(crop, 'unknown'), COALESCE(disease, 'unknown')
ORDER BY total_cases DESC
LIMIT 30;

-- All-time crop distribution (for long-term hint tuning).
SELECT
  COALESCE(crop, 'unknown') AS crop,
  COUNT(*) AS total_cases,
  COUNT(DISTINCT user_id) AS unique_users
FROM cases
GROUP BY COALESCE(crop, 'unknown')
ORDER BY total_cases DESC
LIMIT 50;
