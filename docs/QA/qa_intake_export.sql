-- Экспорт QA кейсов, собранных через /qa в Telegram-группе
-- Фильтр: beta_events.event_type = 'qa_case_logged'

SELECT
  be.payload ->> 'case_id'                  AS "ID кейса",
  COALESCE(be.payload ->> 'tester_username', '') AS "Telegram username тестера",
  be.payload ->> 'tester_tg_id'             AS "Telegram ID тестера",
  be.payload ->> 'created_at_msk'           AS "Дата/время (МСК)",
  be.payload ->> 'plant'                    AS "Растение",
  be.payload ->> 'scenario'                 AS "Сценарий",
  be.payload ->> 'confidence'               AS "Уверенность",
  be.payload ->> 'error_type'               AS "Тип ошибки",
  be.payload ->> 'severity'                 AS "Критичность",
  be.payload ->> 'expected'                 AS "Ожидаемое поведение",
  be.payload ->> 'actual'                   AS "Фактическое поведение",
  be.payload ->> 'message_link'             AS "Ссылка на сообщение",
  be.payload ->> 'notes'                    AS "Заметки",
  be.payload ->> 'raw_text'                 AS "Raw текст"
FROM beta_events be
WHERE be.event_type = 'qa_case_logged'
ORDER BY be.created_at DESC;
