-- Listing photos are private objects. Signed reads are allowed for a seller's
-- own uploads or objects attached to a public auction.
BEGIN;

INSERT INTO storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
VALUES (
  'listing-photos',
  'listing-photos',
  false,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp']::text[]
)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS listing_photos_public_read ON storage.objects;
DROP POLICY IF EXISTS listing_photos_visible_read ON storage.objects;
CREATE POLICY listing_photos_visible_read
  ON storage.objects
  FOR SELECT TO anon, authenticated
  USING (
    bucket_id = 'listing-photos'
    AND (
      (storage.foldername(name))[1] = (SELECT auth.uid())::text
      OR EXISTS (
        SELECT 1
        FROM public.auctions AS a
        WHERE a.photo_paths @> ARRAY[storage.objects.name]
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
    )
  );

DROP POLICY IF EXISTS listing_photos_owner_upload ON storage.objects;
CREATE POLICY listing_photos_owner_upload
  ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'listing-photos'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );

DROP POLICY IF EXISTS listing_photos_owner_delete ON storage.objects;
CREATE POLICY listing_photos_owner_delete
  ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'listing-photos'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );

CREATE OR REPLACE FUNCTION public.validate_auction_photo_paths()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_path text;
BEGIN
  FOREACH v_path IN ARRAY NEW.photo_paths
  LOOP
    IF v_path IS NULL
      OR v_path !~ ('^' || NEW.seller_id::text || '/[^/]+/[^/]+$')
    THEN
      RAISE EXCEPTION 'Auction photos must be stored under the listing seller folder.';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.validate_auction_photo_paths()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS auctions_validate_photo_paths ON public.auctions;
CREATE TRIGGER auctions_validate_photo_paths
  BEFORE INSERT OR UPDATE OF seller_id, photo_paths
  ON public.auctions
  FOR EACH ROW EXECUTE FUNCTION public.validate_auction_photo_paths();

COMMIT;
