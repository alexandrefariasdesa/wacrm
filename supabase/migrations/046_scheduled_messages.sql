-- ============================================================
-- 046_scheduled_messages.sql
--
-- Agendador de mensagens: texto livre com data/hora, enviado pelo
-- worker (GET /api/whatsapp/scheduled/cron) via pg_cron.
-- Só o worker (service_role) muda status além de pending -> cancelled.
-- Idempotente.
-- ============================================================

CREATE TABLE IF NOT EXISTS scheduled_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  body            TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4096),
  scheduled_for   TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','sending','sent','failed','missed','cancelled')),
  attempts        INT NOT NULL DEFAULT 0,
  last_error      TEXT,
  message_id      UUID REFERENCES messages(id) ON DELETE SET NULL,
  sent_at         TIMESTAMPTZ,
  claimed_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scheduled_messages_due_idx
  ON scheduled_messages (scheduled_for) WHERE status IN ('pending','sending');
CREATE INDEX IF NOT EXISTS scheduled_messages_conv_idx
  ON scheduled_messages (conversation_id, scheduled_for);

-- INSERT: horário futuro e conversa da MESMA conta (sem isso, um agente
-- agendaria mensagem para a conversa de outra conta).
CREATE OR REPLACE FUNCTION scheduled_messages_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.scheduled_for <= now() THEN
    RAISE EXCEPTION 'scheduled_for deve ser futuro' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM conversations c
     WHERE c.id = NEW.conversation_id AND c.account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'conversa não pertence à conta' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS scheduled_messages_guard ON scheduled_messages;
CREATE TRIGGER scheduled_messages_guard BEFORE INSERT ON scheduled_messages
  FOR EACH ROW EXECUTE FUNCTION scheduled_messages_guard();

ALTER TABLE scheduled_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scheduled_messages_select ON scheduled_messages;
CREATE POLICY scheduled_messages_select ON scheduled_messages
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS scheduled_messages_insert ON scheduled_messages;
CREATE POLICY scheduled_messages_insert ON scheduled_messages
  FOR INSERT WITH CHECK (
    is_account_member(account_id, 'agent')
    AND created_by = auth.uid()
    AND status = 'pending'
  );

DROP POLICY IF EXISTS scheduled_messages_cancel ON scheduled_messages;
CREATE POLICY scheduled_messages_cancel ON scheduled_messages
  FOR UPDATE
  USING (is_account_member(account_id, 'agent') AND status = 'pending')
  WITH CHECK (is_account_member(account_id, 'agent') AND status = 'cancelled');

-- O navegador só pode mexer na coluna status (cancelar); nada de editar body/horário.
REVOKE UPDATE ON scheduled_messages FROM authenticated;
GRANT  UPDATE (status) ON scheduled_messages TO authenticated;

-- Pega as vencidas sem duplicar (SKIP LOCKED) e recupera as travadas.
DROP FUNCTION IF EXISTS claim_due_scheduled_messages(int);
CREATE FUNCTION claim_due_scheduled_messages(batch int DEFAULT 20)
RETURNS SETOF scheduled_messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  -- Travada em 'sending' há > 5 min: volta a pending, ou falha se já esgotou.
  UPDATE scheduled_messages
     SET status     = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'pending' END,
         last_error = CASE WHEN attempts >= 3 THEN 'travou durante o envio' ELSE last_error END
   WHERE status = 'sending' AND claimed_at < now() - interval '5 minutes';

  RETURN QUERY
  WITH due AS (
    SELECT id FROM scheduled_messages
     WHERE status = 'pending' AND scheduled_for <= now()
     ORDER BY scheduled_for
     LIMIT batch
     FOR UPDATE SKIP LOCKED
  )
  UPDATE scheduled_messages s
     SET status = 'sending', attempts = s.attempts + 1, claimed_at = now()
    FROM due
   WHERE s.id = due.id
  RETURNING s.*;
END;
$fn$;

REVOKE ALL ON FUNCTION claim_due_scheduled_messages(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_due_scheduled_messages(int) TO service_role;
