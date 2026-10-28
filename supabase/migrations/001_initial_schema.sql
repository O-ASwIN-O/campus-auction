-- Initial Campus Auction schema.
-- Run once in the Supabase SQL Editor after reviewing this migration.

BEGIN;

CREATE TYPE public.auction_status AS ENUM (
  'published',
  'cancelled',
  'awaiting_seller_decision',
  'approved',
  'rejected',
  'completed',
  'ended_no_bids'
);

CREATE TYPE public.notification_type AS ENUM (
  'new_bid',
  'outbid',
  'result_pending',
  'result_approved',
  'result_rejected',
  'handover_completed'
);

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  display_name text CHECK (
    display_name IS NULL
    OR char_length(btrim(display_name)) BETWEEN 1 AND 80
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.auctions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id uuid NOT NULL DEFAULT auth.uid()
    REFERENCES public.profiles (id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 100),
  description text NOT NULL CHECK (
    char_length(btrim(description)) BETWEEN 1 AND 5000
  ),
  category text NOT NULL CHECK (char_length(btrim(category)) BETWEEN 1 AND 80),
  item_condition text NOT NULL CHECK (
    char_length(btrim(item_condition)) BETWEEN 1 AND 40
  ),
  starting_price numeric(12, 2) NOT NULL CHECK (starting_price > 0),
  min_increment numeric(12, 2) NOT NULL CHECK (min_increment > 0),
  closes_at timestamptz NOT NULL,
  -- Paths and count only; Storage bucket and object policies are configured separately.
  photo_paths text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(photo_paths) <= 5),
  status public.auction_status NOT NULL DEFAULT 'published',
  winning_bid_id uuid,
  seller_handover_confirmed_at timestamptz,
  winner_handover_confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT auctions_closes_after_creation
    CHECK (isfinite(closes_at) AND closes_at > created_at),
  CONSTRAINT auctions_winning_bid_matches_status
    CHECK (
      (
        status IN ('awaiting_seller_decision', 'approved', 'completed')
        AND winning_bid_id IS NOT NULL
      )
      OR (
        status NOT IN ('awaiting_seller_decision', 'approved', 'completed')
        AND winning_bid_id IS NULL
      )
    ),
  CONSTRAINT auctions_handover_confirmations_match_status
    CHECK (
      (
        seller_handover_confirmed_at IS NULL
        AND winner_handover_confirmed_at IS NULL
      )
      OR status IN ('approved', 'completed')
    ),
  CONSTRAINT auctions_completed_handover_confirmed
    CHECK (
      status <> 'completed'
      OR (
        seller_handover_confirmed_at IS NOT NULL
        AND winner_handover_confirmed_at IS NOT NULL
      )
    ),
  CONSTRAINT auctions_id_winning_bid_unique UNIQUE (id, winning_bid_id)
);

CREATE TABLE public.bids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id uuid NOT NULL
    REFERENCES public.auctions (id) ON DELETE RESTRICT,
  bidder_id uuid NOT NULL
    REFERENCES public.profiles (id) ON DELETE RESTRICT,
  amount numeric(12, 2) NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT bids_auction_id_id_unique UNIQUE (auction_id, id)
);

ALTER TABLE public.auctions
  ADD CONSTRAINT auctions_winning_bid_same_auction_fk
  FOREIGN KEY (id, winning_bid_id)
  REFERENCES public.bids (auction_id, id)
  ON DELETE RESTRICT;

CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL
    REFERENCES public.profiles (id) ON DELETE CASCADE,
  auction_id uuid REFERENCES public.auctions (id) ON DELETE SET NULL,
  bid_id uuid REFERENCES public.bids (id) ON DELETE SET NULL,
  notification_type public.notification_type NOT NULL,
  message text NOT NULL CHECK (char_length(btrim(message)) BETWEEN 1 AND 500),
  is_read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX auctions_status_closes_at_idx
  ON public.auctions (status, closes_at);
CREATE INDEX auctions_seller_status_created_at_idx
  ON public.auctions (seller_id, status, created_at DESC);
CREATE INDEX auctions_category_idx
  ON public.auctions (category);
CREATE INDEX auctions_item_condition_idx
  ON public.auctions (item_condition);
CREATE INDEX bids_auction_amount_created_at_idx
  ON public.bids (auction_id, amount DESC, created_at ASC);
CREATE INDEX bids_bidder_created_at_idx
  ON public.bids (bidder_id, created_at DESC);
CREATE INDEX notifications_user_created_at_idx
  ON public.notifications (user_id, created_at DESC);
CREATE INDEX notifications_user_unread_created_at_idx
  ON public.notifications (user_id, created_at DESC)
  WHERE is_read = false;

CREATE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER profiles_set_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER auctions_set_updated_at
  BEFORE UPDATE ON public.auctions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE FUNCTION public.handle_new_campus_auction_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (
    NEW.id,
    NULLIF(
      btrim(left(COALESCE(NEW.raw_user_meta_data ->> 'display_name', ''), 80)),
      ''
    )
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created_campus_auction
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_campus_auction_user();

CREATE FUNCTION public.place_bid(
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
    OR p_amount <= 0
    OR p_amount > 9999999999.99
    OR p_amount <> round(p_amount, 2)
  THEN
    RAISE EXCEPTION 'Enter a valid bid amount with at most two decimal places.';
  END IF;

  -- Serializes all bids for this auction so each one validates against the
  -- latest committed bid, rather than a stale client-side price.
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

  IF v_closes_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'This auction has closed.';
  END IF;

  SELECT b.amount, b.bidder_id
  INTO v_highest_amount, v_previous_bidder_id
  FROM public.bids AS b
  WHERE b.auction_id = p_auction_id
  ORDER BY b.amount DESC, b.created_at ASC, b.id ASC
  LIMIT 1;

  IF v_highest_amount IS NULL THEN
    SELECT a.starting_price
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
    RAISE EXCEPTION 'The minimum valid bid is %.', v_minimum;
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

CREATE FUNCTION public.update_auction_listing(
  p_auction_id uuid,
  p_title text,
  p_description text,
  p_category text,
  p_item_condition text,
  p_starting_price numeric,
  p_min_increment numeric,
  p_closes_at timestamptz,
  p_photo_paths text[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_seller_id uuid := auth.uid();
  v_auction public.auctions%ROWTYPE;
BEGIN
  IF v_seller_id IS NULL THEN
    RAISE EXCEPTION 'Sign in before managing a listing.';
  END IF;

  SELECT a.*
  INTO v_auction
  FROM public.auctions AS a
  WHERE a.id = p_auction_id
  FOR UPDATE;

  IF NOT FOUND OR v_auction.seller_id IS DISTINCT FROM v_seller_id THEN
    RAISE EXCEPTION 'Auction not found.';
  END IF;

  IF v_auction.status <> 'published'
    OR v_auction.closes_at <= clock_timestamp()
  THEN
    RAISE EXCEPTION 'This listing can no longer be edited.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.bids AS b WHERE b.auction_id = p_auction_id
  ) THEN
    RAISE EXCEPTION 'A listing cannot be edited after it receives a bid.';
  END IF;

  IF p_starting_price IS NULL
    OR p_starting_price <= 0
    OR p_starting_price > 9999999999.99
    OR p_starting_price <> round(p_starting_price, 2)
    OR p_min_increment IS NULL
    OR p_min_increment <= 0
    OR p_min_increment > 9999999999.99
    OR p_min_increment <> round(p_min_increment, 2)
  THEN
    RAISE EXCEPTION 'Enter valid prices with at most two decimal places.';
  END IF;

  IF p_closes_at IS NULL
    OR NOT isfinite(p_closes_at)
    OR p_closes_at <= clock_timestamp()
  THEN
    RAISE EXCEPTION 'Choose a closing time in the future.';
  END IF;

  UPDATE public.auctions
  SET title = p_title,
      description = p_description,
      category = p_category,
      item_condition = p_item_condition,
      starting_price = p_starting_price,
      min_increment = p_min_increment,
      closes_at = p_closes_at,
      photo_paths = p_photo_paths
  WHERE id = p_auction_id;
END;
$$;

CREATE FUNCTION public.cancel_auction(p_auction_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_seller_id uuid := auth.uid();
  v_auction public.auctions%ROWTYPE;
BEGIN
  IF v_seller_id IS NULL THEN
    RAISE EXCEPTION 'Sign in before managing a listing.';
  END IF;

  SELECT a.*
  INTO v_auction
  FROM public.auctions AS a
  WHERE a.id = p_auction_id
  FOR UPDATE;

  IF NOT FOUND
    OR v_auction.seller_id IS DISTINCT FROM v_seller_id
    OR v_auction.status <> 'published'
    OR v_auction.closes_at <= clock_timestamp()
    OR EXISTS (
      SELECT 1 FROM public.bids AS b WHERE b.auction_id = p_auction_id
    )
  THEN
    RAISE EXCEPTION 'This listing cannot be cancelled.';
  END IF;

  UPDATE public.auctions
  SET status = 'cancelled'
  WHERE id = p_auction_id;
END;
$$;

-- This RPC records expiry when the seller invokes it; it does not schedule
-- itself or change auction status merely because wall-clock time has passed.
CREATE FUNCTION public.close_auction_for_review(p_auction_id uuid)
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

  SELECT b.id, b.bidder_id
  INTO v_winning_bid_id, v_winner_id
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
    VALUES (
      v_winner_id,
      p_auction_id,
      v_winning_bid_id,
      'result_pending',
      'The auction has ended and the seller is reviewing the result.'
    );
  END IF;

  RETURN v_new_status;
END;
$$;

CREATE FUNCTION public.decide_auction_result(
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

  SELECT b.bidder_id
  INTO v_winner_id
  FROM public.bids AS b
  WHERE b.id = v_auction.winning_bid_id
    AND b.auction_id = p_auction_id;

  IF v_winner_id IS NULL THEN
    RAISE EXCEPTION 'The provisional winning bid could not be found.';
  END IF;

  IF p_approve THEN
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
  VALUES (
    v_winner_id,
    p_auction_id,
    CASE WHEN p_approve THEN v_auction.winning_bid_id ELSE NULL END,
    CASE
      WHEN p_approve THEN 'result_approved'::public.notification_type
      ELSE 'result_rejected'::public.notification_type
    END,
    CASE
      WHEN p_approve THEN 'The seller approved the auction result.'
      ELSE 'The seller rejected the auction result.'
    END
  );

  RETURN v_new_status;
END;
$$;

CREATE FUNCTION public.confirm_auction_handover(p_auction_id uuid)
RETURNS public.auction_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := auth.uid();
  v_auction public.auctions%ROWTYPE;
  v_winner_id uuid;
  v_new_status public.auction_status;
BEGIN
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Sign in before confirming handover.';
  END IF;

  SELECT a.*
  INTO v_auction
  FROM public.auctions AS a
  WHERE a.id = p_auction_id
  FOR UPDATE;

  IF NOT FOUND OR v_auction.status <> 'approved' THEN
    RAISE EXCEPTION 'This auction is not awaiting handover.';
  END IF;

  SELECT b.bidder_id
  INTO v_winner_id
  FROM public.bids AS b
  WHERE b.id = v_auction.winning_bid_id
    AND b.auction_id = p_auction_id;

  IF v_actor_id <> v_auction.seller_id AND v_actor_id <> v_winner_id THEN
    RAISE EXCEPTION 'Only the seller or approved winner can confirm handover.';
  END IF;

  UPDATE public.auctions AS a
  SET seller_handover_confirmed_at = CASE
        WHEN v_actor_id = v_auction.seller_id
          THEN COALESCE(a.seller_handover_confirmed_at, clock_timestamp())
        ELSE a.seller_handover_confirmed_at
      END,
      winner_handover_confirmed_at = CASE
        WHEN v_actor_id = v_winner_id
          THEN COALESCE(a.winner_handover_confirmed_at, clock_timestamp())
        ELSE a.winner_handover_confirmed_at
      END,
      status = CASE
        WHEN (
          v_actor_id = v_auction.seller_id
          OR a.seller_handover_confirmed_at IS NOT NULL
        )
        AND (
          v_actor_id = v_winner_id
          OR a.winner_handover_confirmed_at IS NOT NULL
        )
          THEN 'completed'::public.auction_status
        ELSE 'approved'::public.auction_status
      END
  WHERE a.id = p_auction_id
  RETURNING a.status INTO v_new_status;

  IF v_new_status = 'completed' THEN
    INSERT INTO public.notifications (
      user_id, auction_id, notification_type, message
    )
    VALUES
      (
        v_auction.seller_id,
        p_auction_id,
        'handover_completed',
        'Both parties confirmed handover. The auction is complete.'
      ),
      (
        v_winner_id,
        p_auction_id,
        'handover_completed',
        'Both parties confirmed handover. The auction is complete.'
      );
  END IF;

  RETURN v_new_status;
END;
$$;

-- Bidder identity is intentionally omitted from the public history view.
CREATE VIEW public.public_bid_history
WITH (security_barrier = true, security_invoker = true)
AS
SELECT
  b.id AS bid_id,
  b.auction_id,
  b.amount,
  b.created_at
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

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auctions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bids ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY profiles_read_own
  ON public.profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid());

CREATE POLICY profiles_read_public_seller_names
  ON public.profiles
  FOR SELECT TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.auctions AS a
      WHERE a.seller_id = profiles.id
        AND a.status IN (
          'published',
          'cancelled',
          'awaiting_seller_decision',
          'approved',
          'rejected',
          'completed',
          'ended_no_bids'
        )
    )
  );

CREATE POLICY profiles_update_own
  ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

CREATE POLICY auctions_public_read
  ON public.auctions
  FOR SELECT TO anon, authenticated
  USING (status IN (
    'published',
    'cancelled',
    'awaiting_seller_decision',
    'approved',
    'rejected',
    'completed',
    'ended_no_bids'
  ));

CREATE POLICY auctions_insert_own
  ON public.auctions
  FOR INSERT TO authenticated
  WITH CHECK (
    seller_id = auth.uid()
    AND status = 'published'
    AND closes_at > clock_timestamp()
  );

-- Public bid-history columns are read-only and omit bidder_id. Clients cannot
-- insert, update, or delete bids; bidding is available only by RPC.
CREATE POLICY bids_read_public_history
  ON public.bids
  FOR SELECT TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.auctions AS a
      WHERE a.id = bids.auction_id
        AND a.status IN (
          'published',
          'cancelled',
          'awaiting_seller_decision',
          'approved',
          'rejected',
          'completed',
          'ended_no_bids'
        )
    )
  );

CREATE POLICY notifications_read_own
  ON public.notifications
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY notifications_mark_own_read
  ON public.notifications
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

REVOKE ALL ON TABLE
  public.profiles,
  public.auctions,
  public.bids,
  public.notifications,
  public.public_bid_history
FROM PUBLIC, anon, authenticated;

GRANT USAGE ON SCHEMA public TO anon, authenticated;
REVOKE ALL ON TYPE public.auction_status, public.notification_type
  FROM PUBLIC, anon, authenticated;
GRANT USAGE ON TYPE public.auction_status, public.notification_type
  TO anon, authenticated;

GRANT SELECT (id, display_name)
  ON public.profiles TO anon, authenticated;
GRANT UPDATE (display_name) ON public.profiles TO authenticated;

GRANT SELECT ON public.auctions TO anon, authenticated;
GRANT INSERT (
  title,
  description,
  category,
  item_condition,
  starting_price,
  min_increment,
  closes_at,
  photo_paths
) ON public.auctions TO authenticated;
GRANT SELECT (id, auction_id, amount, created_at)
  ON public.bids TO anon, authenticated;
GRANT SELECT ON public.public_bid_history TO anon, authenticated;

GRANT SELECT ON public.notifications TO authenticated;
GRANT UPDATE (is_read) ON public.notifications TO authenticated;

REVOKE ALL ON FUNCTION public.set_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.handle_new_campus_auction_user()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.place_bid(uuid, numeric)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_auction_listing(
  uuid, text, text, text, text, numeric, numeric, timestamptz, text[]
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cancel_auction(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.close_auction_for_review(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.decide_auction_result(uuid, boolean)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.confirm_auction_handover(uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.place_bid(uuid, numeric)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_auction_listing(
  uuid, text, text, text, text, numeric, numeric, timestamptz, text[]
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_auction(uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.close_auction_for_review(uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.decide_auction_result(uuid, boolean)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_auction_handover(uuid)
  TO authenticated;

COMMIT;
