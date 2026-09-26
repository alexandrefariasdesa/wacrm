-- Teste da migration 048. Uso: node dbq.mjs supabase/tests/048_quick_reply_sequences.test.sql
BEGIN;

DO $t$
DECLARE
  acct uuid; usr uuid; n int;
  one_step jsonb := '[{"type":"text","text":"oi","delay_seconds":0}]'::jsonb;
BEGIN
  SELECT id, owner_user_id INTO acct, usr FROM accounts LIMIT 1;
  IF acct IS NULL THEN RAISE EXCEPTION 'precisa de 1 conta'; END IF;

  -- 1. sequência válida (1 passo) entra
  INSERT INTO quick_replies (account_id, user_id, title, kind, steps) VALUES (acct, usr, 'seq ok', 'sequence', one_step);

  -- 2. 10 passos entram
  INSERT INTO quick_replies (account_id, user_id, title, kind, steps)
  VALUES (acct, usr, 'seq 10', 'sequence', (SELECT jsonb_agg(one_step->0) FROM generate_series(1,10)));

  -- 3. sequência sem steps, com [] e com 11 passos são recusadas
  BEGIN
    INSERT INTO quick_replies (account_id, user_id, title, kind) VALUES (acct, usr, 'sem steps', 'sequence');
    RAISE EXCEPTION 'sequência sem steps deveria falhar';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO quick_replies (account_id, user_id, title, kind, steps) VALUES (acct, usr, 'vazia', 'sequence', '[]'::jsonb);
    RAISE EXCEPTION 'sequência vazia deveria falhar';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO quick_replies (account_id, user_id, title, kind, steps)
    VALUES (acct, usr, 'onze', 'sequence', (SELECT jsonb_agg(one_step->0) FROM generate_series(1,11)));
    RAISE EXCEPTION '11 passos deveria falhar';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- 4. steps que não é array é recusado
  BEGIN
    INSERT INTO quick_replies (account_id, user_id, title, kind, steps) VALUES (acct, usr, 'objeto', 'sequence', '{"a":1}'::jsonb);
    RAISE EXCEPTION 'steps objeto deveria falhar';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- 5. kind inválido continua recusado; text sem steps continua valendo
  BEGIN
    INSERT INTO quick_replies (account_id, user_id, title, kind) VALUES (acct, usr, 'x', 'banana');
    RAISE EXCEPTION 'kind inválido deveria falhar';
  EXCEPTION WHEN check_violation THEN NULL; END;
  INSERT INTO quick_replies (account_id, user_id, title, kind, content_text) VALUES (acct, usr, 'texto', 'text', 'oi');

  -- 6. buckets em 50 MB
  SELECT count(*) INTO n FROM storage.buckets WHERE id IN ('chat-media','flow-media') AND file_size_limit = 52428800;
  IF n <> 2 THEN RAISE EXCEPTION 'buckets deveriam ter 52428800, têm % ok', n; END IF;

  RAISE NOTICE 'OK: 048_quick_reply_sequences';
END
$t$;

ROLLBACK;
