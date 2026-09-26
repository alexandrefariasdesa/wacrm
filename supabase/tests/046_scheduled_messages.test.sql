-- Teste da migration 046. Roda dentro de BEGIN…ROLLBACK: não deixa nada no banco.
-- Uso: node dbq.mjs supabase/tests/046_scheduled_messages.test.sql
BEGIN;

DO $t$
DECLARE
  acct_a uuid; conv_a uuid; acct_b uuid; n int; r record;
BEGIN
  SELECT c.account_id, c.id INTO acct_a, conv_a
    FROM conversations c ORDER BY c.created_at LIMIT 1;
  SELECT id INTO acct_b FROM accounts WHERE id <> acct_a LIMIT 1;
  -- sem 2ª conta, cria uma só dentro desta transação (some no ROLLBACK)
  IF acct_b IS NULL THEN
    INSERT INTO accounts (name, owner_user_id)
    SELECT 'conta-teste-rollback', u.id FROM auth.users u
     WHERE u.id NOT IN (SELECT owner_user_id FROM accounts) LIMIT 1
    RETURNING id INTO acct_b;
  END IF;
  IF acct_a IS NULL THEN RAISE EXCEPTION 'precisa de ao menos 1 conversa'; END IF;

  -- fixtures (postgres, sem RLS). O trigger de INSERT exige horário futuro,
  -- então a "vencida" nasce no futuro e é envelhecida por UPDATE.
  INSERT INTO scheduled_messages (account_id, conversation_id, body, scheduled_for)
  VALUES (acct_a, conv_a, 'vencida', now() + interval '1 hour'),
         (acct_a, conv_a, 'futura',  now() + interval '1 hour');
  UPDATE scheduled_messages SET scheduled_for = now() - interval '2 minutes' WHERE body = 'vencida';

  -- 1. claim pega só a vencida
  SELECT count(*) INTO n FROM claim_due_scheduled_messages(20);
  IF n <> 1 THEN RAISE EXCEPTION 'claim deveria pegar 1, pegou %', n; END IF;

  -- 2. segunda chamada não pega de novo (já está sending)
  SELECT count(*) INTO n FROM claim_due_scheduled_messages(20);
  IF n <> 0 THEN RAISE EXCEPTION 'claim repetido deveria pegar 0, pegou %', n; END IF;

  -- 3. attempts incrementou e claimed_at foi gravado
  SELECT attempts, claimed_at INTO r FROM scheduled_messages WHERE body = 'vencida';
  IF r.attempts <> 1 OR r.claimed_at IS NULL THEN
    RAISE EXCEPTION 'attempts/claimed_at errados: %', r;
  END IF;

  -- 4. recuperação: sending há > 5 min volta a pending e é reclamada de novo
  UPDATE scheduled_messages SET claimed_at = now() - interval '6 minutes' WHERE body = 'vencida';
  SELECT count(*) INTO n FROM claim_due_scheduled_messages(20);
  IF n <> 1 THEN RAISE EXCEPTION 'travada deveria ser reclamada de novo, n=%', n; END IF;

  -- 5. travada com 3 tentativas vira failed, não reenvia
  UPDATE scheduled_messages SET attempts = 3, status = 'sending',
         claimed_at = now() - interval '6 minutes' WHERE body = 'vencida';
  SELECT count(*) INTO n FROM claim_due_scheduled_messages(20);
  SELECT status INTO r FROM scheduled_messages WHERE body = 'vencida';
  IF n <> 0 OR r.status <> 'failed' THEN
    RAISE EXCEPTION 'travada esgotada deveria virar failed sem reenvio: n=%, status=%', n, r.status;
  END IF;

  -- 6. trigger recusa horário no passado
  BEGIN
    INSERT INTO scheduled_messages (account_id, conversation_id, body, scheduled_for)
    VALUES (acct_a, conv_a, 'passado', now() - interval '1 hour');
    RAISE EXCEPTION 'insert no passado deveria falhar';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 7. conversa de outra conta é recusada (só roda se existir uma 2ª conta)
  IF acct_b IS NOT NULL THEN
    BEGIN
      INSERT INTO scheduled_messages (account_id, conversation_id, body, scheduled_for)
      VALUES (acct_b, conv_a, 'cruzada', now() + interval '1 hour');
      RAISE EXCEPTION 'conversa de outra conta deveria falhar';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  ELSE
    RAISE NOTICE 'sem 2ª conta: caso 7 (conversa cruzada) não exercitado';
  END IF;

  -- 8. controle negativo: authenticated/anon não executam o claim
  IF has_function_privilege('authenticated', 'claim_due_scheduled_messages(int)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated não pode executar claim_due_scheduled_messages';
  END IF;
  IF has_function_privilege('anon', 'claim_due_scheduled_messages(int)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon não pode executar claim_due_scheduled_messages';
  END IF;

  RAISE NOTICE 'OK: 046_scheduled_messages';
END
$t$;

ROLLBACK;
