-- ============================================================
-- 050_channel_health.sql
--
-- Estado de saúde do canal para o vigia (cron) e o aviso de queda.
-- `status` (connected/disconnected) já existe e é espelho do provedor;
-- `health_state` é o que o aviso usa para decidir "isto é uma TRANSIÇÃO,
-- vale avisar" sem mandar o mesmo alerta a cada leitura.
-- Idempotente.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS health_state TEXT NOT NULL DEFAULT 'unknown'
    CHECK (health_state IN ('unknown', 'up', 'down')),
  ADD COLUMN IF NOT EXISTS health_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS down_reminded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS silence_alerted_at TIMESTAMPTZ;
