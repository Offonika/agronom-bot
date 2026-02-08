"""add analytics views for Power BI

Revision ID: 20260110_add_analytics_views
Revises: 20260110_merge_payment_utm_heads
Create Date: 2026-01-10 13:00:00.000000
"""

from alembic import op
import sqlalchemy as sa  # noqa: F401


revision = "20260110_add_analytics_views"
down_revision = "20260110_merge_payment_utm_heads"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index("ix_analytics_events_ts", "analytics_events", ["ts"])
    op.create_index(
        "ix_analytics_events_event_ts",
        "analytics_events",
        ["event", "ts"],
    )
    op.create_index(
        "ix_analytics_events_utm",
        "analytics_events",
        ["utm_source", "utm_medium", "utm_campaign"],
    )

    op.execute(
        """
        CREATE OR REPLACE VIEW vw_funnel_daily AS
        WITH ae_base AS (
          SELECT
            date_trunc('day', ts)::date AS day,
            user_id,
            COALESCE(NULLIF(utm_source, ''), 'direct') AS utm_source,
            COALESCE(NULLIF(utm_medium, ''), 'organic') AS utm_medium,
            COALESCE(NULLIF(utm_campaign, ''), 'none') AS utm_campaign,
            event
          FROM analytics_events
          WHERE event IN ('start', 'photo_sent', 'paywall_shown', 'payment_success')
        ),
        ae_counts AS (
          SELECT
            day,
            utm_source,
            utm_medium,
            utm_campaign,
            COUNT(DISTINCT CASE WHEN event = 'start' THEN user_id END) AS starts,
            COUNT(DISTINCT CASE WHEN event = 'photo_sent' THEN user_id END) AS photo_sent_users,
            COUNT(DISTINCT CASE WHEN event = 'paywall_shown' THEN user_id END) AS paywall_users,
            COUNT(DISTINCT CASE WHEN event = 'payment_success' THEN user_id END) AS paid_users
          FROM ae_base
          GROUP BY day, utm_source, utm_medium, utm_campaign
        ),
        utm_by_day_user AS (
          SELECT DISTINCT ON (day, user_id)
            day,
            user_id,
            COALESCE(NULLIF(utm_source, ''), 'direct') AS utm_source,
            COALESCE(NULLIF(utm_medium, ''), 'organic') AS utm_medium,
            COALESCE(NULLIF(utm_campaign, ''), 'none') AS utm_campaign
          FROM (
            SELECT
              date_trunc('day', ts)::date AS day,
              user_id,
              utm_source,
              utm_medium,
              utm_campaign,
              ts
            FROM analytics_events
          ) t
          ORDER BY day, user_id, ts
        ),
        plan_base AS (
          SELECT
            date_trunc('day', created_at)::date AS day,
            user_id
          FROM plan_funnel_events
          WHERE event = 'diagnosis_shown'
        ),
        plan_with_utm AS (
          SELECT
            p.day,
            p.user_id,
            COALESCE(u.utm_source, 'direct') AS utm_source,
            COALESCE(u.utm_medium, 'organic') AS utm_medium,
            COALESCE(u.utm_campaign, 'none') AS utm_campaign
          FROM plan_base p
          LEFT JOIN utm_by_day_user u
            ON u.day = p.day
           AND u.user_id = p.user_id
        ),
        plan_counts AS (
          SELECT
            day,
            utm_source,
            utm_medium,
            utm_campaign,
            COUNT(DISTINCT user_id) AS diagnosis_shown_users
          FROM plan_with_utm
          GROUP BY day, utm_source, utm_medium, utm_campaign
        )
        SELECT
          COALESCE(ae.day, pc.day) AS day,
          COALESCE(ae.utm_source, pc.utm_source, 'direct') AS utm_source,
          COALESCE(ae.utm_medium, pc.utm_medium, 'organic') AS utm_medium,
          COALESCE(ae.utm_campaign, pc.utm_campaign, 'none') AS utm_campaign,
          COALESCE(ae.starts, 0) AS starts,
          COALESCE(ae.photo_sent_users, 0) AS photo_sent_users,
          COALESCE(pc.diagnosis_shown_users, 0) AS diagnosis_shown_users,
          COALESCE(ae.paywall_users, 0) AS paywall_users,
          COALESCE(ae.paid_users, 0) AS paid_users
        FROM ae_counts ae
        FULL OUTER JOIN plan_counts pc
          ON ae.day = pc.day
         AND ae.utm_source = pc.utm_source
         AND ae.utm_medium = pc.utm_medium
         AND ae.utm_campaign = pc.utm_campaign;
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

    op.execute(
        """
        CREATE OR REPLACE VIEW vw_retention_cohorts AS
        WITH activation AS (
          SELECT DISTINCT ON (user_id)
            user_id,
            date_trunc('day', ts)::date AS cohort_day,
            COALESCE(NULLIF(utm_source, ''), 'direct') AS utm_source,
            COALESCE(NULLIF(utm_medium, ''), 'organic') AS utm_medium,
            COALESCE(NULLIF(utm_campaign, ''), 'none') AS utm_campaign
          FROM analytics_events
          WHERE event = 'photo_sent'
          ORDER BY user_id, ts
        ),
        activity AS (
          SELECT DISTINCT
            user_id,
            date_trunc('day', ts)::date AS day
          FROM analytics_events
        ),
        cohort_activity AS (
          SELECT
            a.cohort_day,
            a.utm_source,
            a.utm_medium,
            a.utm_campaign,
            a.user_id,
            (act1.user_id IS NOT NULL) AS has_d1,
            (act7.user_id IS NOT NULL) AS has_d7
          FROM activation a
          LEFT JOIN activity act1
            ON act1.user_id = a.user_id
           AND act1.day = a.cohort_day + INTERVAL '1 day'
          LEFT JOIN activity act7
            ON act7.user_id = a.user_id
           AND act7.day = a.cohort_day + INTERVAL '7 days'
        )
        SELECT
          cohort_day,
          utm_source,
          utm_medium,
          utm_campaign,
          COUNT(*) AS cohort_users,
          COUNT(*) FILTER (WHERE has_d1) AS d1_users,
          COUNT(*) FILTER (WHERE has_d7) AS d7_users,
          ROUND(100.0 * COUNT(*) FILTER (WHERE has_d1) / NULLIF(COUNT(*), 0), 2) AS d1_retention_pct,
          ROUND(100.0 * COUNT(*) FILTER (WHERE has_d7) / NULLIF(COUNT(*), 0), 2) AS d7_retention_pct
        FROM cohort_activity
        GROUP BY cohort_day, utm_source, utm_medium, utm_campaign;
        """
    )


def downgrade() -> None:
    op.execute("DROP VIEW IF EXISTS vw_retention_cohorts")
    op.execute("DROP VIEW IF EXISTS vw_campaign_summary_30d")
    op.execute("DROP VIEW IF EXISTS vw_campaign_summary_7d")
    op.execute("DROP VIEW IF EXISTS vw_funnel_daily")

    op.drop_index("ix_analytics_events_utm", table_name="analytics_events")
    op.drop_index("ix_analytics_events_event_ts", table_name="analytics_events")
    op.drop_index("ix_analytics_events_ts", table_name="analytics_events")
