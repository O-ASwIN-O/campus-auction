-- Extend active auctions when an accepted bid arrives during the final
-- 30 seconds. The bid insert and deadline update share the same transaction.

BEGIN;

CREATE FUNCTION public.extend_auction_after_last_minute_bid()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_closes_at timestamptz;
  v_status public.auction_status;
BEGIN
  SELECT a.closes_at, a.status
  INTO v_closes_at, v_status
  FROM public.auctions AS a
  WHERE a.id = NEW.auction_id
  FOR UPDATE;

  IF NOT FOUND
    OR v_status <> 'published'
    OR NOT isfinite(v_closes_at)
    OR NEW.created_at >= v_closes_at
    OR NEW.created_at < v_closes_at - interval '30 seconds'
  THEN
    RETURN NEW;
  END IF;

  UPDATE public.auctions AS a
  SET closes_at = NEW.created_at + interval '60 seconds'
  WHERE a.id = NEW.auction_id
    AND a.status = 'published'
    AND a.closes_at = v_closes_at;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.extend_auction_after_last_minute_bid()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER bids_extend_auction_after_last_minute_bid
  AFTER INSERT ON public.bids
  FOR EACH ROW
  EXECUTE FUNCTION public.extend_auction_after_last_minute_bid();

COMMIT;
