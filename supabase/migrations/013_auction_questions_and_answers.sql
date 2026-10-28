-- Store public auction questions and one seller reply per question.
-- Apply only after migration 012 has completed successfully.

BEGIN;

CREATE TABLE public.auction_questions (
  question_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id uuid NOT NULL
    REFERENCES public.auctions (id) ON DELETE CASCADE,
  author_id uuid NOT NULL
    REFERENCES public.profiles (id) ON DELETE CASCADE,
  question_text text NOT NULL CHECK (
    char_length(btrim(question_text)) BETWEEN 1 AND 500
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  seller_reply text CHECK (
    seller_reply IS NULL
    OR char_length(btrim(seller_reply)) BETWEEN 1 AND 500
  ),
  replied_at timestamptz,
  idempotency_key uuid NOT NULL,
  CONSTRAINT auction_questions_author_idempotency_unique
    UNIQUE (author_id, idempotency_key),
  CONSTRAINT auction_questions_reply_consistency CHECK (
    (seller_reply IS NULL AND replied_at IS NULL)
    OR (seller_reply IS NOT NULL AND replied_at IS NOT NULL)
  )
);

CREATE INDEX auction_questions_auction_created_at_idx
  ON public.auction_questions (auction_id, created_at, question_id);

ALTER TABLE public.auction_questions ENABLE ROW LEVEL SECURITY;

CREATE POLICY auction_questions_public_read
  ON public.auction_questions
  FOR SELECT TO anon, authenticated
  USING (true);

REVOKE ALL ON TABLE public.auction_questions
  FROM PUBLIC, anon, authenticated;

GRANT SELECT (
  question_id,
  auction_id,
  question_text,
  created_at,
  seller_reply,
  replied_at
) ON public.auction_questions TO anon, authenticated;

CREATE VIEW public.public_auction_questions
WITH (security_barrier = true, security_invoker = true)
AS
SELECT
  q.question_id,
  q.auction_id,
  q.question_text,
  q.created_at,
  q.seller_reply,
  q.replied_at
FROM public.auction_questions AS q;

REVOKE ALL ON TABLE public.public_auction_questions
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.public_auction_questions
  TO anon, authenticated;

CREATE FUNCTION public.submit_auction_question(
  p_auction_id uuid,
  p_question text,
  p_idempotency_key uuid
)
RETURNS TABLE (
  question_id uuid,
  auction_id uuid,
  question_text text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_author_id uuid := auth.uid();
  v_auction public.auctions%ROWTYPE;
  v_existing public.auction_questions%ROWTYPE;
  v_question_id uuid;
  v_created_at timestamptz;
  v_question_text text := btrim(COALESCE(p_question, ''));
BEGIN
  IF v_author_id IS NULL THEN
    RAISE EXCEPTION 'Sign in before asking a question.';
  END IF;

  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'A question request key is required. Please try again.';
  END IF;

  IF char_length(v_question_text) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'A question must contain between 1 and 500 characters.';
  END IF;

  SELECT q.*
  INTO v_existing
  FROM public.auction_questions AS q
  WHERE q.author_id = v_author_id
    AND q.idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_existing.auction_id IS DISTINCT FROM p_auction_id
      OR v_existing.question_text IS DISTINCT FROM v_question_text
    THEN
      RAISE EXCEPTION 'This question request key was already used. Start a new question.';
    END IF;

    RETURN QUERY
    SELECT
      v_existing.question_id,
      v_existing.auction_id,
      v_existing.question_text,
      v_existing.created_at;
    RETURN;
  END IF;

  SELECT a.*
  INTO v_auction
  FROM public.auctions AS a
  WHERE a.id = p_auction_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This auction is no longer available.';
  END IF;

  IF v_auction.status <> 'published'
    OR NOT isfinite(v_auction.closes_at)
    OR v_auction.closes_at <= clock_timestamp()
  THEN
    RAISE EXCEPTION 'Questions are available only while an auction is open.';
  END IF;

  IF v_auction.seller_id = v_author_id THEN
    RAISE EXCEPTION 'You cannot ask a question on your own auction.';
  END IF;

  INSERT INTO public.auction_questions AS q (
    auction_id,
    author_id,
    question_text,
    idempotency_key
  )
  VALUES (
    p_auction_id,
    v_author_id,
    v_question_text,
    p_idempotency_key
  )
  ON CONFLICT (author_id, idempotency_key) DO NOTHING
  RETURNING q.question_id, q.question_text, q.created_at
  INTO v_question_id, v_question_text, v_created_at;

  IF NOT FOUND THEN
    SELECT q.*
    INTO v_existing
    FROM public.auction_questions AS q
    WHERE q.author_id = v_author_id
      AND q.idempotency_key = p_idempotency_key;

    IF NOT FOUND
      OR v_existing.auction_id IS DISTINCT FROM p_auction_id
      OR v_existing.question_text IS DISTINCT FROM btrim(p_question)
    THEN
      RAISE EXCEPTION 'This question request key was already used. Start a new question.';
    END IF;

    RETURN QUERY
    SELECT
      v_existing.question_id,
      v_existing.auction_id,
      v_existing.question_text,
      v_existing.created_at;
    RETURN;
  END IF;

  INSERT INTO public.notifications (
    user_id,
    auction_id,
    notification_type,
    message
  )
  VALUES (
    v_auction.seller_id,
    p_auction_id,
    'auction_question',
    'A buyer asked a question about "' || v_auction.title || '".'
  );

  RETURN QUERY
  SELECT
    v_question_id,
    p_auction_id,
    v_question_text,
    v_created_at;
END;
$$;

CREATE FUNCTION public.reply_to_auction_question(
  p_question_id uuid,
  p_reply text
)
RETURNS TABLE (
  question_id uuid,
  auction_id uuid,
  seller_reply text,
  replied_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_seller_id uuid := auth.uid();
  v_auction_id uuid;
  v_auction public.auctions%ROWTYPE;
  v_question public.auction_questions%ROWTYPE;
  v_reply text := btrim(COALESCE(p_reply, ''));
  v_replied_at timestamptz;
BEGIN
  IF v_seller_id IS NULL THEN
    RAISE EXCEPTION 'Sign in before replying to a question.';
  END IF;

  IF char_length(v_reply) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'A reply must contain between 1 and 500 characters.';
  END IF;

  SELECT q.auction_id
  INTO v_auction_id
  FROM public.auction_questions AS q
  WHERE q.question_id = p_question_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This question is no longer available.';
  END IF;

  SELECT a.*
  INTO v_auction
  FROM public.auctions AS a
  WHERE a.id = v_auction_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This auction is no longer available.';
  END IF;

  IF v_auction.seller_id IS DISTINCT FROM v_seller_id THEN
    RAISE EXCEPTION 'Only this auction''s seller can reply.';
  END IF;

  SELECT q.*
  INTO v_question
  FROM public.auction_questions AS q
  WHERE q.question_id = p_question_id
    AND q.auction_id = v_auction_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This question is no longer available.';
  END IF;

  IF v_question.seller_reply IS NOT NULL THEN
    IF v_question.seller_reply IS DISTINCT FROM v_reply THEN
      RAISE EXCEPTION 'This question already has a seller reply.';
    END IF;

    RETURN QUERY
    SELECT
      v_question.question_id,
      v_question.auction_id,
      v_question.seller_reply,
      v_question.replied_at;
    RETURN;
  END IF;

  IF v_auction.status NOT IN ('published', 'awaiting_seller_decision') THEN
    RAISE EXCEPTION 'Replies are not available for this auction.';
  END IF;

  UPDATE public.auction_questions AS q
  SET seller_reply = v_reply,
      replied_at = clock_timestamp()
  WHERE q.question_id = p_question_id
    AND q.seller_reply IS NULL
  RETURNING q.replied_at INTO v_replied_at;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This question already has a seller reply.';
  END IF;

  INSERT INTO public.notifications (
    user_id,
    auction_id,
    notification_type,
    message
  )
  VALUES (
    v_question.author_id,
    v_auction_id,
    'auction_question_reply',
    'The seller answered your question about "' || v_auction.title || '".'
  );

  RETURN QUERY
  SELECT
    v_question.question_id,
    v_question.auction_id,
    v_reply,
    v_replied_at;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_auction_question(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reply_to_auction_question(uuid, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.submit_auction_question(uuid, text, uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.reply_to_auction_question(uuid, text)
  TO authenticated;

COMMIT;
