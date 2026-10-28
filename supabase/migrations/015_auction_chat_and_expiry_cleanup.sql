-- Private buyer/seller conversations with access bounded by closes_at.
-- Apply after migrations 001-014; requires pg_cron from migration 011.

BEGIN;

CREATE TABLE public.auction_chat_conversations (
  conversation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id uuid NOT NULL
    REFERENCES public.auctions (id) ON DELETE CASCADE,
  buyer_id uuid NOT NULL
    REFERENCES public.profiles (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT auction_chat_conversations_auction_buyer_unique
    UNIQUE (auction_id, buyer_id)
);

CREATE TABLE public.auction_chat_messages (
  message_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL
    REFERENCES public.auction_chat_conversations (conversation_id)
    ON DELETE CASCADE,
  sender_id uuid NOT NULL
    REFERENCES public.profiles (id) ON DELETE CASCADE,
  message_text text NOT NULL CHECK (
    char_length(btrim(message_text)) BETWEEN 1 AND 500
  ),
  idempotency_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT auction_chat_messages_sender_request_unique
    UNIQUE (sender_id, idempotency_key)
);

CREATE INDEX auction_chat_conversations_auction_idx
  ON public.auction_chat_conversations (auction_id, created_at DESC);
CREATE INDEX auction_chat_messages_conversation_created_idx
  ON public.auction_chat_messages (
    conversation_id,
    created_at,
    message_id
  );
CREATE INDEX auctions_closes_at_chat_cleanup_idx
  ON public.auctions (closes_at);

ALTER TABLE public.auction_chat_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auction_chat_messages ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.auction_chat_conversations
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.auction_chat_messages
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.open_auction_chat(p_auction_id uuid)
RETURNS TABLE (conversation_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := auth.uid();
  v_seller_id uuid;
  v_status text;
  v_closes_at timestamptz;
  v_conversation_id uuid;
BEGIN
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Sign in to message the seller.';
  END IF;

  SELECT a.seller_id, a.status::text, a.closes_at
  INTO v_seller_id, v_status, v_closes_at
  FROM public.auctions AS a
  WHERE a.id = p_auction_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This auction is no longer available.';
  END IF;

  IF v_seller_id = v_actor_id THEN
    RAISE EXCEPTION 'You cannot chat with yourself about your own auction.';
  END IF;

  IF v_status <> 'published'
    OR NOT isfinite(v_closes_at)
    OR v_closes_at <= clock_timestamp()
  THEN
    RAISE EXCEPTION 'Chat is available only while the auction is open.';
  END IF;

  INSERT INTO public.auction_chat_conversations AS c (auction_id, buyer_id)
  VALUES (p_auction_id, v_actor_id)
  ON CONFLICT (auction_id, buyer_id) DO NOTHING
  RETURNING c.conversation_id INTO v_conversation_id;

  IF v_conversation_id IS NULL THEN
    SELECT c.conversation_id
    INTO v_conversation_id
    FROM public.auction_chat_conversations AS c
    WHERE c.auction_id = p_auction_id
      AND c.buyer_id = v_actor_id;
  END IF;

  RETURN QUERY SELECT v_conversation_id;
END;
$$;

CREATE FUNCTION public.list_auction_chat_conversations(p_auction_id uuid)
RETURNS TABLE (
  conversation_id uuid,
  buyer_display_name text,
  last_message_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := auth.uid();
BEGIN
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Sign in to view auction conversations.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.auctions AS a
    WHERE a.id = p_auction_id
      AND a.seller_id = v_actor_id
      AND a.status = 'published'
      AND isfinite(a.closes_at)
      AND a.closes_at > clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'Conversations are available only to the seller while the auction is open.';
  END IF;

  RETURN QUERY
  SELECT
    c.conversation_id,
    COALESCE(NULLIF(btrim(p.display_name), ''), 'Buyer'),
    max(m.created_at)
  FROM public.auction_chat_conversations AS c
  JOIN public.auctions AS a ON a.id = c.auction_id
  LEFT JOIN public.profiles AS p ON p.id = c.buyer_id
  LEFT JOIN public.auction_chat_messages AS m
    ON m.conversation_id = c.conversation_id
  WHERE c.auction_id = p_auction_id
    AND a.seller_id = v_actor_id
    AND a.status = 'published'
    AND isfinite(a.closes_at)
    AND a.closes_at > clock_timestamp()
  GROUP BY c.conversation_id, p.display_name
  ORDER BY max(m.created_at) DESC NULLS LAST, c.conversation_id;
END;
$$;

CREATE FUNCTION public.read_auction_chat(p_conversation_id uuid)
RETURNS TABLE (
  message_id uuid,
  message_text text,
  created_at timestamptz,
  is_mine boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := auth.uid();
  v_seller_id uuid;
  v_buyer_id uuid;
  v_status text;
  v_closes_at timestamptz;
BEGIN
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Sign in to read this conversation.';
  END IF;

  SELECT a.seller_id, c.buyer_id, a.status::text, a.closes_at
  INTO v_seller_id, v_buyer_id, v_status, v_closes_at
  FROM public.auction_chat_conversations AS c
  JOIN public.auctions AS a ON a.id = c.auction_id
  WHERE c.conversation_id = p_conversation_id;

  IF NOT FOUND
    OR (v_actor_id <> v_seller_id AND v_actor_id <> v_buyer_id)
  THEN
    RAISE EXCEPTION 'This conversation is not available to your account.';
  END IF;

  IF v_status <> 'published'
    OR NOT isfinite(v_closes_at)
    OR v_closes_at <= clock_timestamp()
  THEN
    RAISE EXCEPTION 'This conversation is no longer available because the auction has ended.';
  END IF;

  RETURN QUERY
  SELECT
    m.message_id,
    m.message_text,
    m.created_at,
    m.sender_id = v_actor_id
  FROM public.auction_chat_messages AS m
  WHERE m.conversation_id = p_conversation_id
  ORDER BY m.created_at, m.message_id;
END;
$$;

CREATE FUNCTION public.send_auction_chat_message(
  p_conversation_id uuid,
  p_message text,
  p_idempotency_key uuid
)
RETURNS TABLE (
  message_id uuid,
  message_text text,
  created_at timestamptz,
  is_mine boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := auth.uid();
  v_seller_id uuid;
  v_buyer_id uuid;
  v_auction_id uuid;
  v_auction_title text;
  v_status text;
  v_closes_at timestamptz;
  v_message_text text := btrim(COALESCE(p_message, ''));
  v_message_id uuid;
  v_created_at timestamptz;
  v_existing public.auction_chat_messages%ROWTYPE;
  v_recipient_id uuid;
BEGIN
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Sign in to send a message.';
  END IF;

  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'A message request key is required. Please try again.';
  END IF;

  IF char_length(v_message_text) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'A message must contain between 1 and 500 characters.';
  END IF;

  SELECT
    a.seller_id,
    c.buyer_id,
    a.id,
    a.title,
    a.status::text,
    a.closes_at
  INTO v_seller_id, v_buyer_id, v_auction_id, v_auction_title,
       v_status, v_closes_at
  FROM public.auction_chat_conversations AS c
  JOIN public.auctions AS a ON a.id = c.auction_id
  WHERE c.conversation_id = p_conversation_id
  FOR UPDATE OF a;

  IF NOT FOUND
    OR (v_actor_id <> v_seller_id AND v_actor_id <> v_buyer_id)
  THEN
    RAISE EXCEPTION 'This conversation is not available to your account.';
  END IF;

  IF v_status <> 'published'
    OR NOT isfinite(v_closes_at)
    OR v_closes_at <= clock_timestamp()
  THEN
    RAISE EXCEPTION 'Messages can be sent only while the auction is open.';
  END IF;

  SELECT m.*
  INTO v_existing
  FROM public.auction_chat_messages AS m
  WHERE m.sender_id = v_actor_id
    AND m.idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_existing.conversation_id IS DISTINCT FROM p_conversation_id
      OR v_existing.message_text IS DISTINCT FROM v_message_text
    THEN
      RAISE EXCEPTION 'This message request key was already used. Start a new message.';
    END IF;

    RETURN QUERY
    SELECT
      v_existing.message_id,
      v_existing.message_text,
      v_existing.created_at,
      true;
    RETURN;
  END IF;

  INSERT INTO public.auction_chat_messages AS m (
    conversation_id,
    sender_id,
    message_text,
    idempotency_key
  )
  VALUES (
    p_conversation_id,
    v_actor_id,
    v_message_text,
    p_idempotency_key
  )
  ON CONFLICT (sender_id, idempotency_key) DO NOTHING
  RETURNING m.message_id, m.created_at
  INTO v_message_id, v_created_at;

  IF NOT FOUND THEN
    SELECT m.*
    INTO v_existing
    FROM public.auction_chat_messages AS m
    WHERE m.sender_id = v_actor_id
      AND m.idempotency_key = p_idempotency_key;

    IF NOT FOUND
      OR v_existing.conversation_id IS DISTINCT FROM p_conversation_id
      OR v_existing.message_text IS DISTINCT FROM v_message_text
    THEN
      RAISE EXCEPTION 'This message request key was already used. Start a new message.';
    END IF;

    RETURN QUERY
    SELECT
      v_existing.message_id,
      v_existing.message_text,
      v_existing.created_at,
      true;
    RETURN;
  END IF;

  v_recipient_id := CASE
    WHEN v_actor_id = v_seller_id THEN v_buyer_id
    ELSE v_seller_id
  END;

  INSERT INTO public.notifications (
    user_id,
    auction_id,
    notification_type,
    message
  )
  VALUES (
    v_recipient_id,
    v_auction_id,
    'auction_chat_message',
    'New message about "' || v_auction_title
      || '". Open the auction to reply.'
  );

  RETURN QUERY
  SELECT v_message_id, v_message_text, v_created_at, true;
END;
$$;

CREATE FUNCTION public.cleanup_expired_auction_chats()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.auction_chat_conversations AS c
  USING public.auctions AS a
  WHERE c.auction_id = a.id
    AND isfinite(a.closes_at)
    AND a.closes_at <= clock_timestamp();

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.open_auction_chat(uuid)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.list_auction_chat_conversations(uuid)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.read_auction_chat(uuid)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.send_auction_chat_message(uuid, text, uuid)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.cleanup_expired_auction_chats()
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.open_auction_chat(uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_auction_chat_conversations(uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.read_auction_chat(uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.send_auction_chat_message(uuid, text, uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_auction_chats()
  TO postgres;

CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$
DECLARE
  v_job_id bigint;
BEGIN
  FOR v_job_id IN
    SELECT jobid
    FROM cron.job
    WHERE jobname = 'campus-auction-chat-cleanup'
  LOOP
    PERFORM cron.unschedule(v_job_id);
  END LOOP;

  PERFORM cron.schedule(
    'campus-auction-chat-cleanup',
    '* * * * *',
    'SELECT public.cleanup_expired_auction_chats();'
  );
END;
$$;

COMMIT;
