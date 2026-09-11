-- ============================================================
-- 043_multi_channel.sql
--
-- MULTICANAL: a conta deixa de ter "a" conexão do WhatsApp e passa a
-- ter uma por TIPO de canal.
--
-- Por que
-- -------
-- O desenho até aqui era um canal por conta — `UNIQUE (account_id)` em
-- `whatsapp_config`, com as credenciais da Cloud API embutidas na
-- própria linha. O uso que precisamos é outro: um número na API oficial
-- para DISPARO (template aprovado, sem risco de banimento) e um segundo
-- número em conexão não-oficial (Evolution API / Baileys, pareado por
-- QR) para o RECEPTIVO.
--
-- Não dá para ser o mesmo número: registrar na Cloud API exige tirar o
-- número do app comum do WhatsApp, e a conexão por QR é justamente uma
-- emulação do WhatsApp Web, que precisa do número no app. São estados
-- mutuamente exclusivos. Por isso são dois números, dois canais, e a
-- caixa de entrada passa a somar os dois.
--
-- O que esta migration NÃO faz
-- ----------------------------
-- Não renomeia `whatsapp_config` para `channels`. A tabela já é lida em
-- 28 arquivos e o webhook já resolve a conta por `phone_number_id` — o
-- encaixe existe. Renomear seria um diff enorme sem ganho funcional; o
-- nome fica, o significado passa a ser "um canal".
--
-- Idempotente — seguro rodar mais de uma vez.
-- ============================================================

-- ------------------------------------------------------------
-- 1. kind — o que esta linha é
-- ------------------------------------------------------------
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'cloud_api';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'whatsapp_config'::regclass AND conname = 'whatsapp_config_kind_check'
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_kind_check
      CHECK (kind IN ('cloud_api', 'unofficial'));
  END IF;
END $$;

-- Rótulo e número legível — a inbox precisa dizer POR QUAL número a
-- conversa entrou, e `phone_number_id` é um id opaco da Meta.
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS label          TEXT,
  ADD COLUMN IF NOT EXISTS display_number TEXT;

-- ------------------------------------------------------------
-- 2. Credenciais do canal não-oficial (Evolution API)
--
-- `provider_api_key` é cifrada com o mesmo AES-256-GCM de
-- `access_token` (src/lib/whatsapp/encryption.ts). `webhook_secret` é
-- o que autentica o callback do Evolution: ele não assina o corpo como
-- a Meta faz, então a única prova de origem é um segredo que só nós e a
-- instância conhecemos, comparado em tempo constante.
-- ------------------------------------------------------------
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider_base_url TEXT,
  ADD COLUMN IF NOT EXISTS provider_instance TEXT,
  ADD COLUMN IF NOT EXISTS provider_api_key  TEXT,
  ADD COLUMN IF NOT EXISTS webhook_secret    TEXT;

-- ------------------------------------------------------------
-- 3. Colunas que só o canal oficial tem
--
-- `phone_number_id` e `access_token` nasceram NOT NULL porque só existia
-- Cloud API. O canal não-oficial não tem nenhum dos dois. Afrouxamos a
-- coluna e devolvemos a exigência num CHECK por tipo — assim o banco
-- continua recusando um canal oficial pela metade.
-- ------------------------------------------------------------
ALTER TABLE whatsapp_config ALTER COLUMN phone_number_id DROP NOT NULL;
ALTER TABLE whatsapp_config ALTER COLUMN access_token    DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'whatsapp_config'::regclass AND conname = 'whatsapp_config_kind_fields_check'
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_kind_fields_check CHECK (
        (kind = 'cloud_api'
          AND phone_number_id IS NOT NULL
          AND access_token    IS NOT NULL)
        OR
        (kind = 'unofficial'
          AND provider_base_url IS NOT NULL
          AND provider_instance IS NOT NULL)
      );
  END IF;
END $$;

-- `status` ganha o estado intermediário do pareamento por QR: o
-- Evolution reporta close/connecting/open, e "connecting" é onde a tela
-- do QR vive. Sem isso o pareamento não teria como ser representado.
ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_status_check;
ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_status_check
  CHECK (status IN ('connected', 'disconnected', 'connecting'));

-- ------------------------------------------------------------
-- 4. Unicidade: um canal de cada TIPO por conta
--
-- Sai o `UNIQUE (account_id)` (era o teto de um canal por conta) e
-- entra `(account_id, kind)`. O `UNIQUE (phone_number_id)` vira
-- parcial: vários canais não-oficiais teriam NULL ali, e no Postgres
-- NULLs não colidem num índice único — mas a intenção fica explícita.
-- ------------------------------------------------------------
ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_account_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_config_account_kind_key
  ON whatsapp_config (account_id, kind);

ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_phone_number_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_config_phone_number_id_key
  ON whatsapp_config (phone_number_id)
  WHERE phone_number_id IS NOT NULL;

-- A instância do Evolution também é única: duas linhas apontando para a
-- mesma instância significariam duas contas disputando a mesma sessão.
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_config_provider_instance_key
  ON whatsapp_config (provider_base_url, provider_instance)
  WHERE provider_instance IS NOT NULL;

-- ------------------------------------------------------------
-- 5. Por qual canal a conversa/mensagem passou
--
-- ON DELETE SET NULL de propósito: desconectar um canal não pode apagar
-- o histórico de atendimento que passou por ele. A conversa fica órfã de
-- canal e a inbox a mostra como "canal removido" — nunca some.
-- ------------------------------------------------------------
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL;
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_channel_id ON conversations(channel_id);
CREATE INDEX IF NOT EXISTS idx_messages_channel_id      ON messages(channel_id);

-- Backfill: tudo que existe hoje entrou pelo único canal que existia.
UPDATE conversations c
   SET channel_id = w.id
  FROM whatsapp_config w
 WHERE c.channel_id IS NULL
   AND w.account_id = c.account_id
   AND w.kind = 'cloud_api';

UPDATE messages m
   SET channel_id = c.channel_id
  FROM conversations c
 WHERE m.channel_id IS NULL
   AND c.id = m.conversation_id;

-- ------------------------------------------------------------
-- 6. Rótulo do canal existente
--
-- Sem isso o canal que já está configurado apareceria sem nome na
-- seleção da inbox.
-- ------------------------------------------------------------
UPDATE whatsapp_config
   SET label = COALESCE(label, 'API oficial')
 WHERE kind = 'cloud_api';
