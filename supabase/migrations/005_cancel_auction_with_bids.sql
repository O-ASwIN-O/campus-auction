-- Allow sellers to cancel published auctions without removing bid history.
-- Apply after migrations 001, 002, 003, and 004.

BEGIN;

CREATE OR REPLACE FUNCTION public.cancel_auction(p_auction_id uuid)
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
  THEN
    RAISE EXCEPTION 'Only the owner can cancel a published auction.';
  END IF;

  UPDATE public.auctions
  SET status = 'cancelled'
  WHERE id = p_auction_id;

  INSERT INTO public.notifications (
    user_id,
    auction_id,
    notification_type,
    message
  )
  SELECT DISTINCT
    b.bidder_id,
    p_auction_id,
    'auction_cancelled'::public.notification_type,
    'The auction "' || v_auction.title
      || '" was cancelled by the seller. Your bid history remains recorded.'
  FROM public.bids AS b
  WHERE b.auction_id = p_auction_id
    AND b.bidder_id <> v_seller_id;
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_auction(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_auction(uuid)
  TO authenticated;

CREATE OR REPLACE VIEW public.public_bid_history
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

COMMIT;
