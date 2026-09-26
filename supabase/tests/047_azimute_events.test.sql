-- Teste da migration 047. Roda dentro de BEGIN…ROLLBACK: não deixa nada no banco.
-- Uso: node dbq.mjs supabase/tests/047_azimute_events.test.sql
BEGIN;

DO $t$
DECLARE
  d record; qstage uuid; n int; r record;
BEGIN
  -- um negócio ainda NÃO qualificado, num funil com etapa de qualificação
  SELECT de.id, de.pipeline_id, de.stage_id INTO d
    FROM deals de
   WHERE de.qualified_at IS NULL
     AND EXISTS (SELECT 1 FROM pipeline_stages s WHERE s.pipeline_id = de.pipeline_id AND s.is_qualification)
   LIMIT 1;
  IF d.id IS NULL THEN RAISE EXCEPTION 'precisa de 1 negócio não qualificado num funil com etapa de qualificação'; END IF;

  SELECT id INTO qstage FROM pipeline_stages
   WHERE pipeline_id = d.pipeline_id AND is_qualification LIMIT 1;

  -- 1. sem qualificar, nada na fila
  SELECT count(*) INTO n FROM azimute_events WHERE deal_id = d.id;
  IF n <> 0 THEN RAISE EXCEPTION 'não deveria haver evento antes de qualificar'; END IF;

  -- 2. mover para a etapa de qualificação enfileira 1 evento 'qualified'
  UPDATE deals SET stage_id = qstage WHERE id = d.id;
  SELECT count(*) INTO n FROM azimute_events WHERE deal_id = d.id AND kind = 'qualified' AND status = 'pending';
  IF n <> 1 THEN RAISE EXCEPTION 'deveria ter 1 evento pending, tem %', n; END IF;

  -- 3. atualizar de novo (qualified_at já preenchido) não duplica
  UPDATE deals SET notes = coalesce(notes, '') || ' x' WHERE id = d.id;
  SELECT count(*) INTO n FROM azimute_events WHERE deal_id = d.id;
  IF n <> 1 THEN RAISE EXCEPTION 'update posterior não pode duplicar, tem %', n; END IF;

  -- 4. claim pega o evento (vencido), marca sending e conta a tentativa
  SELECT count(*) INTO n FROM claim_azimute_events(20) WHERE deal_id = d.id;
  IF n <> 1 THEN RAISE EXCEPTION 'claim deveria pegar 1, pegou %', n; END IF;
  SELECT attempts, status INTO r FROM azimute_events WHERE deal_id = d.id;
  IF r.attempts <> 1 OR r.status <> 'sending' THEN RAISE EXCEPTION 'attempts/status errados: %', r; END IF;

  -- 5. segunda chamada não pega de novo
  SELECT count(*) INTO n FROM claim_azimute_events(20) WHERE deal_id = d.id;
  IF n <> 0 THEN RAISE EXCEPTION 'claim repetido deveria pegar 0'; END IF;

  -- 6. só pega o que já venceu (next_attempt_at no futuro fica de fora)
  UPDATE azimute_events SET status = 'pending', next_attempt_at = now() + interval '1 hour' WHERE deal_id = d.id;
  SELECT count(*) INTO n FROM claim_azimute_events(20) WHERE deal_id = d.id;
  IF n <> 0 THEN RAISE EXCEPTION 'evento com atraso futuro não pode ser pego'; END IF;

  -- 7. travado em sending > 5 min: volta a pending e é reclamado de novo; com 5 tentativas vira failed
  UPDATE azimute_events SET status = 'sending', attempts = 2, claimed_at = now() - interval '6 minutes',
         next_attempt_at = now() WHERE deal_id = d.id;
  SELECT count(*) INTO n FROM claim_azimute_events(20) WHERE deal_id = d.id;
  IF n <> 1 THEN RAISE EXCEPTION 'travada com 2 tentativas deveria ser reclamada de novo, n=%', n; END IF;
  UPDATE azimute_events SET status = 'sending', attempts = 5, claimed_at = now() - interval '6 minutes' WHERE deal_id = d.id;
  SELECT count(*) INTO n FROM claim_azimute_events(20) WHERE deal_id = d.id;
  SELECT status INTO r FROM azimute_events WHERE deal_id = d.id;
  IF n <> 0 OR r.status <> 'failed' THEN RAISE EXCEPTION 'travada esgotada deveria virar failed sem reenvio, n=%, status=%', n, r.status; END IF;

  -- 8. controle negativo: authenticated/anon não executam o claim
  IF has_function_privilege('authenticated', 'claim_azimute_events(int)', 'EXECUTE')
     OR has_function_privilege('anon', 'claim_azimute_events(int)', 'EXECUTE') THEN
    RAISE EXCEPTION 'claim_azimute_events não pode ser executável por authenticated/anon';
  END IF;

  RAISE NOTICE 'OK: 047_azimute_events';
END
$t$;

ROLLBACK;
