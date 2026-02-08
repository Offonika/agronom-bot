-- Beta houseplants MVP metrics/export helpers.
-- Adjust date filters as needed.

-- 1) Testers total
SELECT COUNT(*) AS beta_testers
FROM users
WHERE is_beta = TRUE;

-- 2) Testers with at least one photo
SELECT COUNT(DISTINCT p.user_id) AS beta_users_with_photo
FROM photos p
JOIN users u ON u.id = p.user_id
WHERE u.is_beta = TRUE;

-- 3) Testers with at least one diagnosis case
SELECT COUNT(DISTINCT c.user_id) AS beta_users_with_case
FROM cases c
JOIN users u ON u.id = c.user_id
WHERE u.is_beta = TRUE;

-- 4) Survey completed (Q1 + Q2)
SELECT COUNT(DISTINCT f.user_id) AS beta_users_survey_completed
FROM diagnosis_feedback f
JOIN users u ON u.id = f.user_id
WHERE u.is_beta = TRUE
  AND f.q1_confidence_score IS NOT NULL
  AND f.q2_clarity_score IS NOT NULL;

-- 5) Follow-up answered
SELECT COUNT(DISTINCT f.user_id) AS beta_users_followup_answered
FROM followup_feedback f
JOIN users u ON u.id = f.user_id
WHERE u.is_beta = TRUE
  AND f.answered_at IS NOT NULL;

-- Raw exports
SELECT * FROM diagnosis_feedback ORDER BY created_at DESC;
SELECT * FROM followup_feedback ORDER BY created_at DESC;
SELECT * FROM beta_events ORDER BY created_at DESC;
