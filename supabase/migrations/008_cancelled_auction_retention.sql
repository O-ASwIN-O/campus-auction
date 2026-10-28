-- Delete cancelled auctions, their bids, and owned listing photos after 24 hours.
-- Apply after migrations 001 through 007. The Edge Function must be deployed
-- and the two Vault secrets configured before the scheduled job can run.

BEGIN;

ALTER TABLE public.auctions
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cleanup_attempted_at timestamptz;

-- Older cancelled rows have no reliable historical cancellation timestamp.
-- Start their retention window at rollout rather than deleting them early.
UPDATE public.auctions
SET cancelled_at = clock_timestamp()
WHERE status = 'cancelled'
  AND cancelled_at IS NULL;

CREATE INDEX auctions_cancelled_at_cleanup_idx
  ON public.auctions (
    cleanup_attempted_at ASC NULLS FIRST,
    cancelled_at ASC
  )
  WHERE status = 'cancelled';

CREATE FUNCTION public.set_auction_cancelled_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.status = 'cancelled' THEN
    IF TG_OP = 'INSERT'
      OR OLD.status IS DISTINCT FROM 'cancelled'
      OR OLD.cancelled_at IS NULL
    THEN
      NEW.cancelled_at := clock_timestamp();
    END IF;
  ELSE
    NEW.cancelled_at := NULL;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.set_auction_cancelled_at()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER auctions_set_cancelled_at
  BEFORE INSERT OR UPDATE OF status
  ON public.auctions
  FOR EACH ROW
  EXECUTE FUNCTION public.set_auction_cancelled_at();

CREATE FUNCTION public.get_expired_cancelled_auctions()
RETURNS TABLE (
  auction_id uuid,
  seller_id uuid,
  photo_paths text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'This cleanup operation is restricted to the scheduled service.';
  END IF;

  RETURN QUERY
  SELECT a.id, a.seller_id, a.photo_paths
  FROM public.auctions AS a
  WHERE a.status = 'cancelled'
    AND a.cancelled_at <= clock_timestamp() - interval '24 hours'
  ORDER BY a.cleanup_attempted_at NULLS FIRST, a.cancelled_at
  LIMIT 100;
END;
$$;

REVOKE ALL ON FUNCTION public.get_expired_cancelled_auctions()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_expired_cancelled_auctions()
  TO service_role;

CREATE FUNCTION public.mark_cancelled_auction_cleanup_attempt(
  p_auction_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'This cleanup operation is restricted to the scheduled service.';
  END IF;

  UPDATE public.auctions AS a
  SET cleanup_attempted_at = clock_timestamp()
  WHERE a.id = p_auction_id
    AND a.status = 'cancelled'
    AND a.cancelled_at <= clock_timestamp() - interval '24 hours';

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_cancelled_auction_cleanup_attempt(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_cancelled_auction_cleanup_attempt(uuid)
  TO service_role;

CREATE FUNCTION public.finalize_cancelled_auction_cleanup(
  p_auction_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_auction public.auctions%ROWTYPE;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'This cleanup operation is restricted to the scheduled service.';
  END IF;

  SELECT a.*
  INTO v_auction
  FROM public.auctions AS a
  WHERE a.id = p_auction_id
  FOR UPDATE;

  IF NOT FOUND
    OR v_auction.status <> 'cancelled'
    OR v_auction.cancelled_at IS NULL
    OR v_auction.cancelled_at > clock_timestamp() - interval '24 hours'
  THEN
    RETURN false;
  END IF;

  IF v_auction.winning_bid_id IS NOT NULL THEN
    RAISE EXCEPTION 'A cancelled auction unexpectedly has a winning bid.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM storage.objects AS o
    WHERE o.bucket_id = 'listing-photos'
      AND o.name = ANY(COALESCE(v_auction.photo_paths, ARRAY[]::text[]))
  ) THEN
    RAISE EXCEPTION 'Listing photos must be removed before the auction can be deleted.';
  END IF;

  DELETE FROM public.bids AS b
  WHERE b.auction_id = p_auction_id;

  DELETE FROM public.auctions AS a
  WHERE a.id = p_auction_id
    AND a.status = 'cancelled'
    AND a.cancelled_at <= clock_timestamp() - interval '24 hours';

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_cancelled_auction_cleanup(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_cancelled_auction_cleanup(uuid)
  TO service_role;

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE FUNCTION public.schedule_cancelled_auction_cleanup()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_vault_ready boolean := false;
  v_job_id bigint;
BEGIN
  IF to_regclass('vault.decrypted_secrets') IS NOT NULL THEN
    EXECUTE $query$
      SELECT count(*) = 2
      FROM vault.decrypted_secrets
      WHERE name IN (
        'campus_auction_project_url',
        'campus_auction_cleanup_token'
      )
    $query$
    INTO v_vault_ready;
  END IF;

  IF NOT v_vault_ready THEN
    RAISE EXCEPTION 'Configure the project URL and cleanup token in Supabase Vault before scheduling cleanup.';
  END IF;

  FOR v_job_id IN
    SELECT jobid
    FROM cron.job
    WHERE jobname = 'campus-auction-cancelled-cleanup'
  LOOP
    PERFORM cron.unschedule(v_job_id);
  END LOOP;

  PERFORM cron.schedule(
    'campus-auction-cancelled-cleanup',
    '*/15 * * * *',
    $job$
      SELECT net.http_post(
        url := (
          SELECT decrypted_secret
          FROM vault.decrypted_secrets
          WHERE name = 'campus_auction_project_url'
        ) || '/functions/v1/cleanup-cancelled-auctions',
        headers := jsonb_build_object(
          'Content-Type',
          'application/json',
          'Authorization',
          'Bearer ' || (
            SELECT decrypted_secret
            FROM vault.decrypted_secrets
            WHERE name = 'campus_auction_cleanup_token'
          )
        ),
        body := '{}'::jsonb
      );
    $job$
  );
END;
$$;

REVOKE ALL ON FUNCTION public.schedule_cancelled_auction_cleanup()
  FROM PUBLIC, anon, authenticated, service_role;

DO $$
DECLARE
  v_vault_ready boolean := false;
BEGIN
  IF to_regclass('vault.decrypted_secrets') IS NOT NULL THEN
    EXECUTE $query$
      SELECT count(*) = 2
      FROM vault.decrypted_secrets
      WHERE name IN (
        'campus_auction_project_url',
        'campus_auction_cleanup_token'
      )
    $query$
    INTO v_vault_ready;
  END IF;

  IF v_vault_ready THEN
    PERFORM public.schedule_cancelled_auction_cleanup();
  ELSE
    RAISE NOTICE
      'Cancelled-auction cleanup was not scheduled: configure the two Vault secrets, then schedule the cron job described in migration 008.';
  END IF;
END;
$$;

COMMIT;
