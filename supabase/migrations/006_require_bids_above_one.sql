-- Enforce the fixed ₹1 starting bid and require every bid to exceed ₹1.
-- Apply once after migrations 001 through 005.

BEGIN;

ALTER TABLE public.auctions
  ALTER COLUMN starting_price SET DEFAULT 1;

CREATE FUNCTION public.enforce_one_rupee_starting_bid()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.starting_price IS DISTINCT FROM 1::numeric THEN
    RAISE EXCEPTION 'New auctions must use a ₹1 starting bid.';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_one_rupee_starting_bid()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER auctions_enforce_one_rupee_starting_bid
  BEFORE INSERT ON public.auctions
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_one_rupee_starting_bid();

ALTER TABLE public.bids
  ADD CONSTRAINT bids_amount_above_one
  CHECK (amount > 1)
  NOT VALID;

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
    OR p_amount > 9999999999.99
    OR p_amount <> round(p_amount, 2)
  THEN
    RAISE EXCEPTION 'A bid must be greater than ₹1 and have at most two decimal places.';
  END IF;

  -- The auction row lock serializes bids and cancellation for this auction.
  SELECT a.seller_id, a.closes_at, a.status
  INTO v_seller_id, v_closes_at, v_status
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
    SELECT GREATEST(a.starting_price, 2::numeric)
    INTO v_minimum
    FROM public.auctions AS a
    WHERE a.id = p_auction_id;
  ELSE
    SELECT v_highest_amount + a.min_increment
    INTO v_minimum
    FROM public.auctions AS a
    WHERE a.id = p_auction_id;
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
