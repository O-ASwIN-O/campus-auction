-- Notify both parties during result review and approval, and expose the
-- counterpart's Auth email only through an authorization-checked RPC.
-- Apply after migrations 001 through 008.

BEGIN;

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
  v_auction public.auctions%ROWTYPE;
  v_winning_bid_id uuid;
  v_winner_id uuid;
  v_winning_amount numeric;
  v_new_status public.auction_status;
BEGIN
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Sign in before closing an auction for review.';
  END IF;

  SELECT a.*
  INTO v_auction
  FROM public.auctions AS a
  WHERE a.id = p_auction_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Auction not found.';
  END IF;

  IF v_auction.seller_id IS DISTINCT FROM v_actor_id THEN
    RAISE EXCEPTION 'Only the seller can close this auction for review.';
  END IF;

  IF v_auction.status <> 'published'
    OR NOT isfinite(v_auction.closes_at)
    OR v_auction.closes_at > clock_timestamp()
  THEN
    RAISE EXCEPTION 'Only an expired, published auction can be closed for review.';
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
  ELSE
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
        'Auction "' || v_auction.title || '" closed with a highest bid of ₹'
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
          || '. The seller must approve the result.'
      )
    ON CONFLICT DO NOTHING;
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
  v_new_status public.auction_status;
  v_decision_message text;
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
    v_new_status := 'approved';
    v_decision_message :=
      'The seller approved the result for "' || v_auction.title
      || '" at ₹' || v_winning_amount::text
      || '. Contact details are now available in the auction result.';

    UPDATE public.auctions
    SET status = v_new_status
    WHERE id = p_auction_id;
  ELSE
    v_new_status := 'rejected';
    v_decision_message :=
      'The seller rejected the provisional result for "'
      || v_auction.title || '". Contact details are not available.';

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
      v_decision_message
    ),
    (
      v_winner_id,
      p_auction_id,
      v_auction.winning_bid_id,
      CASE
        WHEN p_approve THEN 'result_approved'::public.notification_type
        ELSE 'result_rejected'::public.notification_type
      END,
      v_decision_message
    )
  ON CONFLICT DO NOTHING;

  RETURN v_new_status;
END;
$$;

CREATE FUNCTION public.get_auction_contact(
  p_auction_id uuid
)
RETURNS TABLE (
  contact_email text,
  contact_display_name text,
  contact_role text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := auth.uid();
  v_auction public.auctions%ROWTYPE;
  v_winner_id uuid;
BEGIN
  IF v_actor_id IS NULL THEN
    RETURN;
  END IF;

  SELECT a.*
  INTO v_auction
  FROM public.auctions AS a
  WHERE a.id = p_auction_id;

  IF NOT FOUND
    OR v_auction.status NOT IN ('approved', 'completed')
    OR v_auction.winning_bid_id IS NULL
  THEN
    RETURN;
  END IF;

  SELECT b.bidder_id
  INTO v_winner_id
  FROM public.bids AS b
  WHERE b.id = v_auction.winning_bid_id
    AND b.auction_id = p_auction_id;

  IF v_winner_id IS NULL THEN
    RETURN;
  END IF;

  IF v_actor_id = v_auction.seller_id THEN
    RETURN QUERY
    SELECT
      winner.email::text,
      COALESCE(winner_profile.display_name, 'Campus buyer'),
      'buyer'::text
    FROM auth.users AS winner
    LEFT JOIN public.profiles AS winner_profile
      ON winner_profile.id = winner.id
    WHERE winner.id = v_winner_id
      AND winner.email IS NOT NULL;
  ELSIF v_actor_id = v_winner_id THEN
    RETURN QUERY
    SELECT
      seller.email::text,
      COALESCE(seller_profile.display_name, 'Campus seller'),
      'seller'::text
    FROM auth.users AS seller
    LEFT JOIN public.profiles AS seller_profile
      ON seller_profile.id = seller.id
    WHERE seller.id = v_auction.seller_id
      AND seller.email IS NOT NULL;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.close_auction_for_review(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.decide_auction_result(uuid, boolean)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_auction_contact(uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.close_auction_for_review(uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.decide_auction_result(uuid, boolean)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_auction_contact(uuid)
  TO authenticated;

-- Fill missing notifications for auctions that were already awaiting approval
-- or approved before this migration, without duplicating matching notices.
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
CROSS JOIN LATERAL (
  SELECT
    a.seller_id AS user_id,
    CASE
      WHEN a.status = 'approved' THEN 'result_approved'::public.notification_type
      ELSE 'result_pending'::public.notification_type
    END AS notification_type,
    CASE
      WHEN a.status = 'approved' THEN
        'The seller approved the result for "' || a.title
          || '" at ₹' || winning_bid.amount::text
          || '. Contact details are now available in the auction result.'
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
      WHEN a.status = 'approved' THEN
        'The seller approved the result for "' || a.title
          || '" at ₹' || winning_bid.amount::text
          || '. Contact details are now available in the auction result.'
      ELSE
        'You are the provisional winner of "' || a.title
          || '" with a bid of ₹' || winning_bid.amount::text
          || '. The seller must approve the result.'
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

COMMIT;
