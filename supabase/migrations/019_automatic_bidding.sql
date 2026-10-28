-- Store private automatic-bid limits and process a single proxy response
-- atomically with each manual bid.

BEGIN;

CREATE TABLE public.automatic_bid_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id uuid NOT NULL
    REFERENCES public.auctions (id) ON DELETE CASCADE,
  user_id uuid NOT NULL DEFAULT auth.uid()
    REFERENCES public.profiles (id) ON DELETE CASCADE,
  max_amount numeric(12, 2) NOT NULL CHECK (max_amount > 0),
  is_enabled boolean NOT NULL DEFAULT true,
  activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT automatic_bid_limits_auction_user_unique
    UNIQUE (auction_id, user_id)
);

CREATE INDEX automatic_bid_limits_response_idx
  ON public.automatic_bid_limits (
    auction_id,
    max_amount DESC,
    activated_at,
    user_id
  )
  WHERE is_enabled;

CREATE TRIGGER automatic_bid_limits_set_updated_at
  BEFORE UPDATE ON public.automatic_bid_limits
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.automatic_bid_limits ENABLE ROW LEVEL SECURITY;

CREATE POLICY automatic_bid_limits_read_own
  ON public.automatic_bid_limits
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

REVOKE ALL ON TABLE public.automatic_bid_limits
  FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.bids
  ADD COLUMN is_automatic boolean NOT NULL DEFAULT false;

CREATE FUNCTION public._run_automatic_bid_response(p_auction_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_seller_id uuid;
  v_status public.auction_status;
  v_closes_at timestamptz;
  v_min_increment numeric;
  v_highest_amount numeric;
  v_leading_bidder_id uuid;
  v_auto_bidder_id uuid;
  v_auto_activated_at timestamptz;
  v_auto_maximum numeric;
  v_competing_maximum numeric;
  v_competing_activated_at timestamptz;
  v_competing_bidder_id uuid;
  v_required_amount numeric;
  v_new_bid_id uuid;
BEGIN
  SELECT a.seller_id, a.status, a.closes_at, a.min_increment
  INTO v_seller_id, v_status, v_closes_at, v_min_increment
  FROM public.auctions AS a
  WHERE a.id = p_auction_id
  FOR UPDATE;

  IF NOT FOUND
    OR v_status <> 'published'
    OR NOT isfinite(v_closes_at)
    OR v_closes_at <= clock_timestamp()
  THEN
    RETURN NULL;
  END IF;

  SELECT b.amount, b.bidder_id
  INTO v_highest_amount, v_leading_bidder_id
  FROM public.bids AS b
  WHERE b.auction_id = p_auction_id
  ORDER BY b.amount DESC, b.created_at ASC, b.id ASC
  LIMIT 1;

  IF v_highest_amount IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT c.user_id, c.max_amount, c.activated_at
  INTO v_auto_bidder_id, v_auto_maximum, v_auto_activated_at
  FROM public.automatic_bid_limits AS c
  WHERE c.auction_id = p_auction_id
    AND c.is_enabled
    AND c.user_id <> v_seller_id
    AND c.user_id <> v_leading_bidder_id
  ORDER BY c.max_amount DESC, c.activated_at ASC, c.user_id ASC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT c.max_amount, c.activated_at, c.user_id
  INTO v_competing_maximum, v_competing_activated_at, v_competing_bidder_id
  FROM public.automatic_bid_limits AS c
  WHERE c.auction_id = p_auction_id
    AND c.is_enabled
    AND c.user_id <> v_seller_id
    AND c.user_id <> v_auto_bidder_id
  ORDER BY c.max_amount DESC, c.activated_at ASC, c.user_id ASC
  LIMIT 1;

  IF FOUND
    AND v_competing_maximum = v_auto_maximum
    AND (
      v_competing_activated_at < v_auto_activated_at
      OR (
        v_competing_activated_at = v_auto_activated_at
        AND v_competing_bidder_id < v_auto_bidder_id
      )
    )
  THEN
    RETURN NULL;
  END IF;

  IF v_competing_maximum IS NOT NULL
    AND v_competing_maximum > v_auto_maximum
  THEN
    RETURN NULL;
  END IF;

  v_required_amount := v_highest_amount + v_min_increment;
  IF v_competing_maximum IS NOT NULL THEN
    IF v_competing_maximum = v_auto_maximum THEN
      v_required_amount := GREATEST(v_required_amount, v_auto_maximum);
    ELSE
      v_required_amount := GREATEST(
        v_required_amount,
        v_competing_maximum + v_min_increment
      );
    END IF;
  END IF;

  IF v_required_amount > v_auto_maximum
    OR v_required_amount <= 1
    OR v_required_amount <> round(v_required_amount, 2)
    OR v_closes_at <= clock_timestamp()
  THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.bids (auction_id, bidder_id, amount, is_automatic)
  VALUES (
    p_auction_id,
    v_auto_bidder_id,
    v_required_amount,
    true
  )
  RETURNING id INTO v_new_bid_id;

  RETURN v_new_bid_id;
END;
$$;

REVOKE ALL ON FUNCTION public._run_automatic_bid_response(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

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
  v_final_bid_id uuid;
  v_final_bidder_id uuid;
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

  PERFORM public._run_automatic_bid_response(p_auction_id);

  SELECT b.id, b.bidder_id
  INTO v_final_bid_id, v_final_bidder_id
  FROM public.bids AS b
  WHERE b.auction_id = p_auction_id
  ORDER BY b.amount DESC, b.created_at ASC, b.id ASC
  LIMIT 1;

  INSERT INTO public.notifications (
    user_id, auction_id, bid_id, notification_type, message
  )
  VALUES (
    v_seller_id,
    p_auction_id,
    v_final_bid_id,
    'new_bid',
    'A new bid was placed on your auction.'
  );

  IF v_bidder_id <> v_final_bidder_id THEN
    INSERT INTO public.notifications (
      user_id, auction_id, bid_id, notification_type, message
    )
    VALUES (
      v_bidder_id,
      p_auction_id,
      v_final_bid_id,
      'outbid',
      'A higher bid was placed on an auction you bid on.'
    );
  END IF;

  IF v_previous_bidder_id IS NOT NULL
    AND v_previous_bidder_id <> v_bidder_id
    AND v_previous_bidder_id <> v_final_bidder_id
  THEN
    INSERT INTO public.notifications (
      user_id, auction_id, bid_id, notification_type, message
    )
    VALUES (
      v_previous_bidder_id,
      p_auction_id,
      v_final_bid_id,
      'outbid',
      'A higher bid was placed on an auction you bid on.'
    );
  END IF;

  RETURN v_bid_id;
END;
$$;

CREATE FUNCTION public.get_my_automatic_bid(p_auction_id uuid)
RETURNS TABLE (
  max_amount numeric,
  is_active boolean,
  reached_limit boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := auth.uid();
  v_limit public.automatic_bid_limits%ROWTYPE;
  v_status public.auction_status;
  v_closes_at timestamptz;
  v_starting_price numeric;
  v_min_increment numeric;
  v_highest_amount numeric;
  v_leading_bidder_id uuid;
  v_minimum numeric;
BEGIN
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Sign in to view your automatic-bid settings.';
  END IF;

  SELECT c.*
  INTO v_limit
  FROM public.automatic_bid_limits AS c
  WHERE c.auction_id = p_auction_id
    AND c.user_id = v_actor_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT a.status, a.closes_at, a.starting_price, a.min_increment
  INTO v_status, v_closes_at, v_starting_price, v_min_increment
  FROM public.auctions AS a
  WHERE a.id = p_auction_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT b.amount, b.bidder_id
  INTO v_highest_amount, v_leading_bidder_id
  FROM public.bids AS b
  WHERE b.auction_id = p_auction_id
  ORDER BY b.amount DESC, b.created_at ASC, b.id ASC
  LIMIT 1;

  v_minimum := CASE
    WHEN v_highest_amount IS NULL
      THEN GREATEST(v_starting_price + 0.01, 2::numeric)
    ELSE v_highest_amount + v_min_increment
  END;

  RETURN QUERY
  SELECT
    v_limit.max_amount,
    v_limit.is_enabled
      AND v_status = 'published'
      AND isfinite(v_closes_at)
      AND v_closes_at > clock_timestamp()
      AND v_actor_id <> (
        SELECT a.seller_id
        FROM public.auctions AS a
        WHERE a.id = p_auction_id
      ),
    v_limit.max_amount < v_minimum;
END;
$$;

CREATE FUNCTION public.configure_automatic_bid(
  p_auction_id uuid,
  p_max_amount numeric
)
RETURNS TABLE (
  max_amount numeric,
  is_active boolean,
  reached_limit boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := auth.uid();
  v_seller_id uuid;
  v_status public.auction_status;
  v_closes_at timestamptz;
  v_starting_price numeric;
  v_min_increment numeric;
  v_highest_amount numeric;
  v_previous_leader_id uuid;
  v_challenge_bid_id uuid;
  v_response_bid_id uuid;
  v_final_bid_id uuid;
  v_final_bidder_id uuid;
  v_required_amount numeric;
  v_minimum numeric;
BEGIN
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Sign in before enabling automatic bidding.';
  END IF;

  IF p_max_amount IS NULL
    OR p_max_amount <= 0
    OR p_max_amount > 9999999999.99
    OR p_max_amount <> round(p_max_amount, 2)
  THEN
    RAISE EXCEPTION 'Enter a positive maximum with at most two decimal places.';
  END IF;

  SELECT a.seller_id, a.status, a.closes_at, a.starting_price, a.min_increment
  INTO v_seller_id, v_status, v_closes_at, v_starting_price, v_min_increment
  FROM public.auctions AS a
  WHERE a.id = p_auction_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Auction not found.';
  END IF;

  IF v_seller_id = v_actor_id THEN
    RAISE EXCEPTION 'You cannot enable automatic bidding on your own auction.';
  END IF;

  IF v_status <> 'published'
    OR NOT isfinite(v_closes_at)
    OR v_closes_at <= clock_timestamp()
  THEN
    RAISE EXCEPTION 'Automatic bidding is available only while the auction is open.';
  END IF;

  SELECT b.amount, b.bidder_id
  INTO v_highest_amount, v_previous_leader_id
  FROM public.bids AS b
  WHERE b.auction_id = p_auction_id
  ORDER BY b.amount DESC, b.created_at ASC, b.id ASC
  LIMIT 1;

  INSERT INTO public.automatic_bid_limits AS existing (
    auction_id,
    user_id,
    max_amount,
    is_enabled,
    activated_at
  )
  VALUES (
    p_auction_id,
    v_actor_id,
    p_max_amount,
    true,
    clock_timestamp()
  )
  ON CONFLICT (auction_id, user_id)
  DO UPDATE SET
    max_amount = EXCLUDED.max_amount,
    is_enabled = true,
    activated_at = clock_timestamp();

  IF v_highest_amount IS NOT NULL
    AND v_previous_leader_id <> v_actor_id
  THEN
    v_required_amount := v_highest_amount + v_min_increment;
    IF v_required_amount <= p_max_amount
      AND v_required_amount > 1
      AND v_required_amount = round(v_required_amount, 2)
    THEN
      INSERT INTO public.bids (
        auction_id,
        bidder_id,
        amount,
        is_automatic
      )
      VALUES (
        p_auction_id,
        v_actor_id,
        v_required_amount,
        true
      )
      RETURNING id INTO v_challenge_bid_id;
    END IF;
  END IF;

  IF v_challenge_bid_id IS NOT NULL THEN
    v_response_bid_id :=
      public._run_automatic_bid_response(p_auction_id);
  END IF;

  IF v_challenge_bid_id IS NOT NULL OR v_response_bid_id IS NOT NULL THEN
    SELECT b.id, b.bidder_id, b.amount
    INTO v_final_bid_id, v_final_bidder_id, v_highest_amount
    FROM public.bids AS b
    WHERE b.auction_id = p_auction_id
    ORDER BY b.amount DESC, b.created_at ASC, b.id ASC
    LIMIT 1;

    INSERT INTO public.notifications (
      user_id, auction_id, bid_id, notification_type, message
    )
    VALUES (
      v_seller_id,
      p_auction_id,
      v_final_bid_id,
      'new_bid',
      'A new bid was placed on your auction.'
    );

    IF v_previous_leader_id IS NOT NULL
      AND v_previous_leader_id <> v_final_bidder_id
    THEN
      INSERT INTO public.notifications (
        user_id, auction_id, bid_id, notification_type, message
      )
      VALUES (
        v_previous_leader_id,
        p_auction_id,
        v_final_bid_id,
        'outbid',
        'A higher bid was placed on an auction you bid on.'
      );
    END IF;

    IF v_actor_id <> v_final_bidder_id
      AND v_actor_id <> v_previous_leader_id
    THEN
      INSERT INTO public.notifications (
        user_id, auction_id, bid_id, notification_type, message
      )
      VALUES (
        v_actor_id,
        p_auction_id,
        v_final_bid_id,
        'outbid',
        'A higher bid was placed on an auction you bid on.'
      );
    END IF;
  END IF;

  SELECT b.amount, b.bidder_id
  INTO v_highest_amount, v_final_bidder_id
  FROM public.bids AS b
  WHERE b.auction_id = p_auction_id
  ORDER BY b.amount DESC, b.created_at ASC, b.id ASC
  LIMIT 1;

  v_minimum := CASE
    WHEN v_highest_amount IS NULL
      THEN GREATEST(v_starting_price + 0.01, 2::numeric)
    ELSE v_highest_amount + v_min_increment
  END;

  RETURN QUERY
  SELECT
    c.max_amount,
    c.is_enabled
      AND v_status = 'published'
      AND isfinite(v_closes_at)
      AND v_closes_at > clock_timestamp(),
    c.max_amount < v_minimum
  FROM public.automatic_bid_limits AS c
  WHERE c.auction_id = p_auction_id
    AND c.user_id = v_actor_id;
END;
$$;

CREATE FUNCTION public.disable_automatic_bid(p_auction_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := auth.uid();
  v_updated boolean;
BEGIN
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Sign in before changing automatic bidding.';
  END IF;

  PERFORM 1
  FROM public.auctions AS a
  WHERE a.id = p_auction_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Auction not found.';
  END IF;

  UPDATE public.automatic_bid_limits AS c
  SET is_enabled = false
  WHERE c.auction_id = p_auction_id
    AND c.user_id = v_actor_id
    AND c.is_enabled;

  v_updated := FOUND;
  RETURN v_updated;
END;
$$;

REVOKE ALL ON FUNCTION public.place_bid(uuid, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.place_bid(uuid, numeric)
  TO authenticated;

REVOKE ALL ON FUNCTION public.get_my_automatic_bid(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_automatic_bid(uuid)
  TO authenticated;

REVOKE ALL ON FUNCTION public.configure_automatic_bid(uuid, numeric)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.configure_automatic_bid(uuid, numeric)
  TO authenticated;

REVOKE ALL ON FUNCTION public.disable_automatic_bid(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.disable_automatic_bid(uuid)
  TO authenticated;

COMMIT;
