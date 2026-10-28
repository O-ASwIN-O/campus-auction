-- Process expired auctions on the database server and notify the affected users.
-- Apply after migrations 001 through 010.

BEGIN;

CREATE FUNCTION public._process_expired_auction(
  p_auction_id uuid
)
RETURNS public.auction_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_auction public.auctions%ROWTYPE;
  v_winning_bid_id uuid;
  v_winner_id uuid;
  v_winning_amount numeric;
  v_new_status public.auction_status;
BEGIN
  SELECT a.*
  INTO v_auction
  FROM public.auctions AS a
  WHERE a.id = p_auction_id
  FOR UPDATE;

  IF NOT FOUND
    OR v_auction.status <> 'published'
    OR NOT isfinite(v_auction.closes_at)
    OR v_auction.closes_at > clock_timestamp()
  THEN
    RETURN NULL;
  END IF;

  SELECT b.id, b.bidder_id, b.amount
  INTO v_winning_bid_id, v_winner_id, v_winning_amount
  FROM public.bids AS b
  WHERE b.auction_id = p_auction_id
  ORDER BY b.amount DESC, b.created_at ASC, b.id ASC
  LIMIT 1;

  IF v_winning_bid_id IS NULL THEN
    v_new_status := 'ended_no_bids';
    UPDATE public.auctions
    SET status = v_new_status
    WHERE id = p_auction_id;

    INSERT INTO public.notifications (
      user_id, auction_id, notification_type, message
    )
    VALUES (
      v_auction.seller_id,
      p_auction_id,
      'auction_ended_no_bids',
      'Auction "' || v_auction.title
        || '" ended without bids. No winner was selected.'
    );

    RETURN v_new_status;
  END IF;

  v_new_status := 'awaiting_seller_decision';
  UPDATE public.auctions
  SET status = v_new_status,
      winning_bid_id = v_winning_bid_id
  WHERE id = p_auction_id;

  INSERT INTO public.notifications (
    user_id, auction_id, bid_id, notification_type, message
  )
  VALUES
    (
      v_auction.seller_id,
      p_auction_id,
      v_winning_bid_id,
      'result_pending',
      'Auction "' || v_auction.title || '" ended with a highest bid of ₹'
        || v_winning_amount::text
        || '. Review the provisional result in your listings.'
    ),
    (
      v_winner_id,
      p_auction_id,
      v_winning_bid_id,
      'result_pending',
      'You are the provisional winner of "' || v_auction.title
        || '" with a bid of ₹' || v_winning_amount::text
        || '. Seller approval is pending.'
    );

  RETURN v_new_status;
END;
$$;

REVOKE ALL ON FUNCTION public._process_expired_auction(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.close_auction_for_review(
  p_auction_id uuid
)
RETURNS public.auction_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := auth.uid();
  v_seller_id uuid;
  v_new_status public.auction_status;
BEGIN
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Sign in before closing an auction for review.';
  END IF;

  SELECT a.seller_id
  INTO v_seller_id
  FROM public.auctions AS a
  WHERE a.id = p_auction_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Auction not found.';
  END IF;

  IF v_seller_id IS DISTINCT FROM v_actor_id THEN
    RAISE EXCEPTION 'Only the seller can close this auction for review.';
  END IF;

  v_new_status := public._process_expired_auction(p_auction_id);
  IF v_new_status IS NULL THEN
    RAISE EXCEPTION 'Only an expired, published auction can be closed for review.';
  END IF;

  RETURN v_new_status;
END;
$$;

CREATE OR REPLACE FUNCTION public.decide_auction_result(
  p_auction_id uuid,
  p_approve boolean
)
RETURNS public.auction_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_seller_id uuid := auth.uid();
  v_auction public.auctions%ROWTYPE;
  v_winner_id uuid;
  v_winning_amount numeric;
  v_seller_email text;
  v_winner_email text;
  v_new_status public.auction_status;
BEGIN
  IF v_seller_id IS NULL THEN
    RAISE EXCEPTION 'Sign in before managing a listing.';
  END IF;

  IF p_approve IS NULL THEN
    RAISE EXCEPTION 'Choose whether to approve or reject the result.';
  END IF;

  SELECT a.*
  INTO v_auction
  FROM public.auctions AS a
  WHERE a.id = p_auction_id
  FOR UPDATE;

  IF NOT FOUND
    OR v_auction.seller_id IS DISTINCT FROM v_seller_id
    OR v_auction.status <> 'awaiting_seller_decision'
  THEN
    RAISE EXCEPTION 'This auction is not awaiting your decision.';
  END IF;

  SELECT b.bidder_id, b.amount
  INTO v_winner_id, v_winning_amount
  FROM public.bids AS b
  WHERE b.id = v_auction.winning_bid_id
    AND b.auction_id = p_auction_id;

  IF v_winner_id IS NULL THEN
    RAISE EXCEPTION 'The provisional winning bid could not be found.';
  END IF;

  IF p_approve THEN
    SELECT seller.email::text, winner.email::text
    INTO v_seller_email, v_winner_email
    FROM auth.users AS seller
    JOIN auth.users AS winner ON winner.id = v_winner_id
    WHERE seller.id = v_auction.seller_id;

    v_new_status := 'approved';
    UPDATE public.auctions
    SET status = v_new_status
    WHERE id = p_auction_id;
  ELSE
    v_new_status := 'rejected';
    UPDATE public.auctions
    SET status = v_new_status,
        winning_bid_id = NULL
    WHERE id = p_auction_id;
  END IF;

  INSERT INTO public.notifications (
    user_id, auction_id, bid_id, notification_type, message
  )
  VALUES
    (
      v_seller_id,
      p_auction_id,
      v_auction.winning_bid_id,
      CASE
        WHEN p_approve THEN 'result_approved'::public.notification_type
        ELSE 'result_rejected'::public.notification_type
      END,
      CASE
        WHEN p_approve AND v_winner_email IS NOT NULL THEN
          v_winner_email || ' won your auction "' || v_auction.title
            || '" for ₹' || v_winning_amount::text || '.'
        WHEN p_approve THEN
          'The result for "' || v_auction.title
            || '" is confirmed. Contact details are available in the auction result.'
        ELSE
          'The seller rejected the provisional result for "'
            || v_auction.title || '". Contact details are not available.'
      END
    ),
    (
      v_winner_id,
      p_auction_id,
      v_auction.winning_bid_id,
      CASE
        WHEN p_approve THEN 'result_approved'::public.notification_type
        ELSE 'result_rejected'::public.notification_type
      END,
      CASE
        WHEN p_approve AND v_seller_email IS NOT NULL THEN
          'You won "' || v_auction.title || '" for ₹'
            || v_winning_amount::text || '. Contact your seller at '
            || v_seller_email || '.'
        WHEN p_approve THEN
          'You won "' || v_auction.title
            || '". Contact details are available in the auction result.'
        ELSE
          'The seller rejected the provisional result for "'
            || v_auction.title || '". Contact details are not available.'
      END
    );

  RETURN v_new_status;
END;
$$;

CREATE OR REPLACE FUNCTION public.process_expired_auctions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_auction_id uuid;
  v_new_status public.auction_status;
  v_processed integer := 0;
BEGIN
  FOR v_auction_id IN
    SELECT a.id
    FROM public.auctions AS a
    WHERE a.status = 'published'
      AND isfinite(a.closes_at)
      AND a.closes_at <= clock_timestamp()
    ORDER BY a.closes_at
    LIMIT 100
    FOR UPDATE SKIP LOCKED
  LOOP
    v_new_status := public._process_expired_auction(v_auction_id);
    IF v_new_status IS NOT NULL THEN
      v_processed := v_processed + 1;
    END IF;
  END LOOP;

  RETURN v_processed;
END;
$$;

REVOKE ALL ON FUNCTION public.close_auction_for_review(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.decide_auction_result(uuid, boolean)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.process_expired_auctions()
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.close_auction_for_review(uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.decide_auction_result(uuid, boolean)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.process_expired_auctions()
  TO service_role;

-- Refresh existing approved-result notices without exposing either email to
-- users who are not already entitled to read that specific notification.
UPDATE public.notifications AS n
SET message = CASE
  WHEN n.user_id = a.seller_id AND winner.email IS NOT NULL THEN
    winner.email || ' won your auction "' || a.title || '" for ₹'
      || winning_bid.amount::text || '.'
  WHEN n.user_id = winning_bid.bidder_id AND seller.email IS NOT NULL THEN
    'You won "' || a.title || '" for ₹' || winning_bid.amount::text
      || '. Contact your seller at ' || seller.email || '.'
  WHEN n.user_id = a.seller_id THEN
    'The result for "' || a.title
      || '" is confirmed. Contact details are available in the auction result.'
  ELSE
    'You won "' || a.title
      || '". Contact details are available in the auction result.'
END
FROM public.auctions AS a
JOIN public.bids AS winning_bid
  ON winning_bid.id = a.winning_bid_id
 AND winning_bid.auction_id = a.id
JOIN auth.users AS seller ON seller.id = a.seller_id
JOIN auth.users AS winner ON winner.id = winning_bid.bidder_id
WHERE n.auction_id = a.id
  AND n.bid_id = winning_bid.id
  AND n.notification_type = 'result_approved'
  AND a.status = 'approved'
  AND n.user_id IN (a.seller_id, winning_bid.bidder_id);

-- Fill missing notices for results processed before this migration.
INSERT INTO public.notifications (
  user_id, auction_id, bid_id, notification_type, message
)
SELECT
  a.seller_id,
  a.id,
  NULL,
  'auction_ended_no_bids',
  'Auction "' || a.title || '" ended without bids. No winner was selected.'
FROM public.auctions AS a
WHERE a.status = 'ended_no_bids'
  AND NOT EXISTS (
    SELECT 1
    FROM public.notifications AS n
    WHERE n.user_id = a.seller_id
      AND n.auction_id = a.id
      AND n.notification_type = 'auction_ended_no_bids'
  );

INSERT INTO public.notifications (
  user_id, auction_id, bid_id, notification_type, message
)
SELECT
  recipients.user_id,
  a.id,
  a.winning_bid_id,
  recipients.notification_type,
  recipients.message
FROM public.auctions AS a
JOIN public.bids AS winning_bid
  ON winning_bid.id = a.winning_bid_id
 AND winning_bid.auction_id = a.id
JOIN auth.users AS seller ON seller.id = a.seller_id
JOIN auth.users AS winner ON winner.id = winning_bid.bidder_id
CROSS JOIN LATERAL (
  SELECT
    a.seller_id AS user_id,
    CASE
      WHEN a.status = 'approved' THEN 'result_approved'::public.notification_type
      ELSE 'result_pending'::public.notification_type
    END AS notification_type,
    CASE
      WHEN a.status = 'approved' AND winner.email IS NOT NULL THEN
        winner.email || ' won your auction "' || a.title || '" for ₹'
          || winning_bid.amount::text || '.'
      WHEN a.status = 'approved' THEN
        'The result for "' || a.title
          || '" is confirmed. Contact details are available in the auction result.'
      ELSE
        'Auction "' || a.title || '" closed with a highest bid of ₹'
          || winning_bid.amount::text
          || '. Review the provisional result in your listings.'
    END AS message
  UNION ALL
  SELECT
    winning_bid.bidder_id,
    CASE
      WHEN a.status = 'approved' THEN 'result_approved'::public.notification_type
      ELSE 'result_pending'::public.notification_type
    END,
    CASE
      WHEN a.status = 'approved' AND seller.email IS NOT NULL THEN
        'You won "' || a.title || '" for ₹' || winning_bid.amount::text
          || '. Contact your seller at ' || seller.email || '.'
      WHEN a.status = 'approved' THEN
        'You won "' || a.title
          || '". Contact details are available in the auction result.'
      ELSE
        'You are the provisional winner of "' || a.title
          || '" with a bid of ₹' || winning_bid.amount::text
          || '. Seller approval is pending.'
    END
) AS recipients
WHERE a.status IN ('awaiting_seller_decision', 'approved')
  AND NOT EXISTS (
    SELECT 1
    FROM public.notifications AS existing
    WHERE existing.user_id = recipients.user_id
      AND existing.auction_id = a.id
      AND existing.bid_id = a.winning_bid_id
      AND existing.notification_type = recipients.notification_type
  )
ON CONFLICT DO NOTHING;

CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$
DECLARE
  v_job_id bigint;
BEGIN
  FOR v_job_id IN
    SELECT jobid
    FROM cron.job
    WHERE jobname = 'campus-auction-expired-results'
  LOOP
    PERFORM cron.unschedule(v_job_id);
  END LOOP;

  PERFORM cron.schedule(
    'campus-auction-expired-results',
    '* * * * *',
    'SELECT public.process_expired_auctions();'
  );
END;
$$;

COMMIT;
