-- Deletion is staged so Storage cleanup can use the Storage API before the
-- auction row is removed. A failed cleanup can be retried by the seller.
BEGIN;

CREATE TABLE public.auction_deletion_requests (
  auction_id uuid PRIMARY KEY
    REFERENCES public.auctions (id) ON DELETE CASCADE,
  seller_id uuid NOT NULL
    REFERENCES public.profiles (id) ON DELETE RESTRICT,
  photo_paths text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE public.auction_deletion_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY auction_deletion_requests_read_own
  ON public.auction_deletion_requests
  FOR SELECT TO authenticated
  USING (seller_id = auth.uid());

REVOKE ALL ON TABLE public.auction_deletion_requests
  FROM PUBLIC, anon, authenticated;
GRANT SELECT (auction_id)
  ON public.auction_deletion_requests TO authenticated;

CREATE FUNCTION public.begin_auction_deletion(p_auction_id uuid)
RETURNS text[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_seller_id uuid := auth.uid();
  v_auction public.auctions%ROWTYPE;
  v_photo_paths text[];
  v_existing_seller_id uuid;
  v_path text;
BEGIN
  IF v_seller_id IS NULL THEN
    RAISE EXCEPTION 'Sign in before deleting a listing.';
  END IF;

  SELECT a.*
  INTO v_auction
  FROM public.auctions AS a
  WHERE a.id = p_auction_id
  FOR UPDATE;

  IF NOT FOUND OR v_auction.seller_id IS DISTINCT FROM v_seller_id THEN
    RAISE EXCEPTION 'Listing not found.';
  END IF;

  SELECT r.seller_id, r.photo_paths
  INTO v_existing_seller_id, v_photo_paths
  FROM public.auction_deletion_requests AS r
  WHERE r.auction_id = p_auction_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing_seller_id IS DISTINCT FROM v_seller_id THEN
      RAISE EXCEPTION 'Listing not found.';
    END IF;
    RETURN v_photo_paths;
  END IF;

  IF v_auction.status <> 'published'
    OR NOT isfinite(v_auction.closes_at)
    OR v_auction.closes_at <= clock_timestamp()
  THEN
    RAISE EXCEPTION 'Only an unexpired, published listing can be deleted.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.bids AS b WHERE b.auction_id = p_auction_id
  ) THEN
    RAISE EXCEPTION 'A listing with bids cannot be deleted.';
  END IF;

  v_photo_paths := COALESCE(v_auction.photo_paths, ARRAY[]::text[]);
  FOREACH v_path IN ARRAY v_photo_paths
  LOOP
    IF v_path IS NULL
      OR v_path !~ ('^' || v_seller_id::text || '/[^/]+/[^/]+$')
    THEN
      RAISE EXCEPTION 'A listing photo is outside your storage folder.';
    END IF;
  END LOOP;

  INSERT INTO public.auction_deletion_requests (
    auction_id, seller_id, photo_paths
  )
  VALUES (p_auction_id, v_seller_id, v_photo_paths);

  UPDATE public.auctions
  SET status = 'cancelled'
  WHERE id = p_auction_id;

  RETURN v_photo_paths;
END;
$$;

CREATE FUNCTION public.finalize_auction_deletion(p_auction_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_seller_id uuid := auth.uid();
  v_auction public.auctions%ROWTYPE;
  v_request_seller_id uuid;
  v_photo_paths text[];
BEGIN
  IF v_seller_id IS NULL THEN
    RAISE EXCEPTION 'Sign in before deleting a listing.';
  END IF;

  SELECT a.*
  INTO v_auction
  FROM public.auctions AS a
  WHERE a.id = p_auction_id
  FOR UPDATE;

  IF NOT FOUND OR v_auction.seller_id IS DISTINCT FROM v_seller_id THEN
    RAISE EXCEPTION 'Listing not found.';
  END IF;

  SELECT r.seller_id, r.photo_paths
  INTO v_request_seller_id, v_photo_paths
  FROM public.auction_deletion_requests AS r
  WHERE r.auction_id = p_auction_id
  FOR UPDATE;

  IF NOT FOUND OR v_request_seller_id IS DISTINCT FROM v_seller_id THEN
    RAISE EXCEPTION 'This listing has no deletion request.';
  END IF;

  IF v_auction.status <> 'cancelled'
    OR EXISTS (
      SELECT 1 FROM public.bids AS b WHERE b.auction_id = p_auction_id
    )
  THEN
    RAISE EXCEPTION 'This listing is not eligible for deletion.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM storage.objects AS o
    WHERE o.bucket_id = 'listing-photos'
      AND o.name = ANY(v_photo_paths)
  ) THEN
    RAISE EXCEPTION 'Listing photos must be removed before the listing can be deleted.';
  END IF;

  DELETE FROM public.auctions
  WHERE id = p_auction_id;
END;
$$;

REVOKE ALL ON FUNCTION public.begin_auction_deletion(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_auction_deletion(uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.begin_auction_deletion(uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_auction_deletion(uuid)
  TO authenticated;

COMMIT;
