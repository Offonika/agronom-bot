"""update analytics views to align funnel steps

Revision ID: 20260111_update_analytics_views
Revises: 20260110_add_analytics_views
Create Date: 2026-01-11 09:00:00.000000
"""

from alembic import op
import sqlalchemy as sa  # noqa: F401


revision = "20260111_update_analytics_views"
down_revision = "20260110_add_analytics_views"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE OR REPLACE VIEW vw_funnel_daily AS
        WITH start_raw AS (
          SELECT
            date_trunc('day', ts)::date AS day,
            user_id,
            COALESCE(NULLIF(utm_source, ''), 'direct') AS utm_source,
            COALESCE(NULLIF(utm_medium, ''), 'organic') AS utm_medium,
            COALESCE(NULLIF(utm_campaign, ''), 'none') AS utm_campaign,
            ts
          FROM analytics_events
          WHERE event = 'start'
        ),
        start_users AS (
          SELECT DISTINCT ON (day, user_id)
            day,
            user_id,
            utm_source,
            utm_medium,
            utm_campaign
          FROM start_raw
          ORDER BY day, user_id, ts
        ),
        photo_events AS (
          SELECT DISTINCT
            date_trunc('day', ts)::date AS day,
            user_id
          FROM analytics_events
          WHERE event = 'photo_sent'
        ),
        paywall_events AS (
          SELECT DISTINCT
            date_trunc('day', ts)::date AS day,
            user_id
          FROM analytics_events
          WHERE event = 'paywall_shown'
        ),
        paid_events AS (
          SELECT DISTINCT
            date_trunc('day', ts)::date AS day,
            user_id
          FROM analytics_events
          WHERE event = 'payment_success'
        ),
        diagnosis_events AS (
          SELECT DISTINCT
            date_trunc('day', created_at)::date AS day,
            user_id
          FROM plan_funnel_events
          WHERE event = 'diagnosis_shown'
        )
        SELECT
          s.day,
          s.utm_source,
          s.utm_medium,
          s.utm_campaign,
          COUNT(DISTINCT s.user_id) AS starts,
          COUNT(DISTINCT CASE WHEN p.user_id IS NOT NULL THEN s.user_id END) AS photo_sent_users,
          COUNT(DISTINCT CASE WHEN d.user_id IS NOT NULL THEN s.user_id END) AS diagnosis_shown_users,
          COUNT(DISTINCT CASE WHEN pw.user_id IS NOT NULL THEN s.user_id END) AS paywall_users,
          COUNT(DISTINCT CASE WHEN pay.user_id IS NOT NULL THEN s.user_id END) AS paid_users
        FROM start_users s
        LEFT JOIN photo_events p
          ON p.day = s.day
         AND p.user_id = s.user_id
        LEFT JOIN diagnosis_events d
          ON d.day = s.day
         AND d.user_id = s.user_id
        LEFT JOIN paywall_events pw
          ON pw.day = s.day
         AND pw.user_id = s.user_id
        LEFT JOIN paid_events pay
          ON pay.day = s.day
         AND pay.user_id = s.user_id
        GROUP BY s.day, s.utm_source, s.utm_medium, s.utm_campaign;
        """
    )

    op.execute(
        """
        CREATE OR REPLACE VIEW vw_campaign_summary_7d AS
        SELECT
          utm_source,
          utm_medium,
          utm_campaign,
          SUM(starts) AS starts,
          SUM(photo_sent_users) AS photo_sent_users,
          SUM(diagnosis_shown_users) AS diagnosis_shown_users,
          SUM(paywall_users) AS paywall_users,
          SUM(paid_users) AS paid_users,
          ROUND(100.0 * SUM(photo_sent_users) / NULLIF(SUM(starts), 0), 2) AS cr_start_to_photo_pct,
          ROUND(100.0 * SUM(paid_users) / NULLIF(SUM(starts), 0), 2) AS cr_start_to_pay_pct,
          ROUND(100.0 * SUM(paid_users) / NULLIF(SUM(photo_sent_users), 0), 2) AS cr_photo_to_pay_pct
        FROM vw_funnel_daily
        WHERE day >= CURRENT_DATE - INTERVAL '6 days'
        GROUP BY utm_source, utm_medium, utm_campaign;
        """
    )

    op.execute(
        """
        CREATE OR REPLACE VIEW vw_campaign_summary_30d AS
        SELECT
          utm_source,
          utm_medium,
          utm_campaign,
          SUM(starts) AS starts,
          SUM(photo_sent_users) AS photo_sent_users,
          SUM(diagnosis_shown_users) AS diagnosis_shown_users,
          SUM(paywall_users) AS paywall_users,
          SUM(paid_users) AS paid_users,
          ROUND(100.0 * SUM(photo_sent_users) / NULLIF(SUM(starts), 0), 2) AS cr_start_to_photo_pct,
          ROUND(100.0 * SUM(paid_users) / NULLIF(SUM(starts), 0), 2) AS cr_start_to_pay_pct,
          ROUND(100.0 * SUM(paid_users) / NULLIF(SUM(photo_sent_users), 0), 2) AS cr_photo_to_pay_pct
        FROM vw_funnel_daily
        WHERE day >= CURRENT_DATE - INTERVAL '29 days'
        GROUP BY utm_source, utm_medium, utm_campaign;
        """
    )


def downgrade() -> None:
    pass
