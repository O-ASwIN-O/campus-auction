-- Restore seller-selected starting prices and remove the fixed bid ceiling.
-- Apply after migrations 001 through 006; do not apply migration 006 afterward.

BEGIN;

DROP TRIGGER IF EXISTS auctions_enforce_one_rupee_starting_bid
  ON public.auctions;
DROP FUNCTION IF EXISTS public.enforce_one_rupee_starting_bid();

ALTER TABLE public.auctions
  ALTER COLUMN starting_price DROP DEFAULT;

DROP VIEW public.public_bid_history;

ALTER TABLE public.bids
  ALTER COLUMN amount TYPE numeric
  USING amount::numeric;

CREATE VIEW public.public_bid_history
WITH (security_barrier = true, security_invoker = true)
AS
SELECT
  b.id AS bid_id,
  b.auction_id,
  b.amount,
  b.created_at,
  a.status::text AS auction_status
FROM public.bids AS b
JOIN public.auctions AS a ON a.id = b.auction_id
WHERE a.status IN (
  'published',
  'cancelled',
  'awaiting_seller_decision',
  'approved',
  'rejected',
  'completed',
  'ended_no_bids'
);

GRANT SELECT ON public.public_bid_history TO anon, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.bids'::regclass
      AND conname = 'bids_amount_above_one'
  ) THEN
    ALTER TABLE public.bids
      ADD CONSTRAINT bids_amount_above_one
      CHECK (amount > 1)
      NOT VALID;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.place_bid(
  p_auction_id uuid,
  p_amount numeric
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_bidder_id uuid := auth.uid();
  v_seller_id uuid;
  v_closes_at timestamptz;
  v_status public.auction_status;
  v_starting_price numeric;
  v_min_increment numeric;
  v_highest_amount numeric;
  v_previous_bidder_id uuid;
  v_bid_id uuid;
  v_minimum numeric;
BEGIN
  IF v_bidder_id IS NULL THEN
    RAISE EXCEPTION 'Sign in before placing a bid.';
  END IF;

  IF p_amount IS NULL
    OR p_amount <= 1
    OR p_amount <> round(p_amount, 2)
  THEN
    RAISE EXCEPTION 'A bid must be greater than ₹1 and have at most two decimal places.';
  END IF;

  -- The auction row lock serializes bids and cancellation for this auction.
  SELECT
    a.seller_id,
    a.closes_at,
    a.status,
    a.starting_price,
    a.min_increment
  INTO
    v_seller_id,
    v_closes_at,
    v_status,
    v_starting_price,
    v_min_increment
  FROM public.auctions AS a
  WHERE a.id = p_auction_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Auction not found.';
  END IF;

  IF v_seller_id = v_bidder_id THEN
    RAISE EXCEPTION 'You cannot bid on your own listing.';
  END IF;

  IF v_status <> 'published' THEN
    RAISE EXCEPTION 'This auction is not accepting bids.';
  END IF;

  IF NOT isfinite(v_closes_at)
    OR v_closes_at <= clock_timestamp()
  THEN
    RAISE EXCEPTION 'This auction has closed.';
  END IF;

  SELECT b.amount, b.bidder_id
  INTO v_highest_amount, v_previous_bidder_id
  FROM public.bids AS b
  WHERE b.auction_id = p_auction_id
  ORDER BY b.amount DESC, b.created_at ASC, b.id ASC
  LIMIT 1;

  IF v_highest_amount IS NULL THEN
    v_minimum := GREATEST(v_starting_price + 0.01, 2::numeric);
  ELSE
    IF p_amount <= v_highest_amount THEN
      RAISE EXCEPTION 'Your bid must be greater than the current highest bid of ₹%.',
        v_highest_amount;
    END IF;

    v_minimum := v_highest_amount + v_min_increment;
  END IF;

  IF p_amount < v_minimum THEN
    RAISE EXCEPTION 'The minimum valid bid is ₹%.', v_minimum;
  END IF;

  IF v_closes_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'This auction has closed.';
  END IF;

  INSERT INTO public.bids (auction_id, bidder_id, amount)
  VALUES (p_auction_id, v_bidder_id, p_amount)
  RETURNING id INTO v_bid_id;

  INSERT INTO public.notifications (
    user_id, auction_id, bid_id, notification_type, message
  )
  VALUES (
    v_seller_id,
    p_auction_id,
    v_bid_id,
    'new_bid',
    'A new bid was placed on your auction.'
  );

  IF v_previous_bidder_id IS NOT NULL
    AND v_previous_bidder_id <> v_bidder_id
  THEN
    INSERT INTO public.notifications (
      user_id, auction_id, bid_id, notification_type, message
    )
    VALUES (
      v_previous_bidder_id,
      p_auction_id,
      v_bid_id,
      'outbid',
      'A higher bid was placed on an auction you bid on.'
    );
  END IF;

  RETURN v_bid_id;
END;
$$;

REVOKE ALL ON FUNCTION public.place_bid(uuid, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.place_bid(uuid, numeric)
  TO authenticated;

COMMIT;
