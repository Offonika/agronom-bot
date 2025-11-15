# План-фанел и аналитика

Таблица `plan_funnel_events` хранит ключевые шаги пользовательского пути «Фото → Диагноз → План → Время».

| Поле       | Описание                                                 |
|------------|-----------------------------------------------------------|
| `event`    | Ключ события (`photo_received`, `diagnosis_shown`, `plan_treatment_clicked`, `object_selected`, `option_picked`, `slot_confirmed`). |
| `user_id`  | Внутренний `users.id`.                                    |
| `object_id`| Текущий объект (если уже выбран).                         |
| `plan_id`  | План, к которому относится событие (когда доступен).      |
| `data`     | JSON с дополнительными метками (confidence, optionId и т.д.). |
| `created_at` | Время фиксации события (UTC).                           |

### Пример воронки за последние 7 дней

```sql
WITH base AS (
  SELECT
    event,
    user_id,
    plan_id,
    created_at::date AS day
  FROM plan_funnel_events
  WHERE created_at >= NOW() - INTERVAL '7 days'
)
, per_day AS (
  SELECT
    day,
    event,
    COUNT(DISTINCT user_id) AS users
  FROM base
  GROUP BY day, event
)
SELECT
  day,
  MAX(CASE WHEN event = 'photo_received' THEN users END) AS photo_users,
  MAX(CASE WHEN event = 'diagnosis_shown' THEN users END) AS diagnosis_users,
  MAX(CASE WHEN event = 'plan_treatment_clicked' THEN users END) AS plan_users,
  MAX(CASE WHEN event = 'object_selected' THEN users END) AS object_users,
  MAX(CASE WHEN event = 'option_picked' THEN users END) AS option_users,
  MAX(CASE WHEN event = 'slot_confirmed' THEN users END) AS slot_users
FROM per_day
GROUP BY day
ORDER BY day DESC;
```

Эта выборка показывает дневную конверсию по каждому шагу и служит базой для дашборда в Metabase/Grafana.
