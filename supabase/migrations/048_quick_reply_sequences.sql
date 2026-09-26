-- ============================================================
-- 048_quick_reply_sequences.sql
--
-- Sequências: uma mensagem rápida com vários passos (texto, imagem,
-- vídeo, documento) e espera entre eles, enviada com um clique.
-- Também sobe o limite dos buckets de mídia para 50 MB (o teto de
-- 16 MB era da API oficial da Meta; o Evolution não tem esse limite).
-- Idempotente.
-- ============================================================

ALTER TABLE quick_replies DROP CONSTRAINT IF EXISTS quick_replies_kind_check;
ALTER TABLE quick_replies
  ADD CONSTRAINT quick_replies_kind_check CHECK (kind IN ('text', 'interactive', 'sequence'));

ALTER TABLE quick_replies ADD COLUMN IF NOT EXISTS steps JSONB;

ALTER TABLE quick_replies DROP CONSTRAINT IF EXISTS quick_replies_steps_check;
ALTER TABLE quick_replies
  ADD CONSTRAINT quick_replies_steps_check CHECK (
    kind <> 'sequence'
    OR (
      steps IS NOT NULL
      AND jsonb_typeof(steps) = 'array'
      AND jsonb_array_length(steps) BETWEEN 1 AND 10
    )
  );

UPDATE storage.buckets
   SET file_size_limit = 52428800
 WHERE id IN ('chat-media', 'flow-media');
