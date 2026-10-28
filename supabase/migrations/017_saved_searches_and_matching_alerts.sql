-- Store private user search criteria and notify matching users when auctions
-- are first published.

BEGIN;

CREATE TABLE public.saved_searches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid()
    REFERENCES public.profiles (id) ON DELETE CASCADE,
  keywords text CHECK (
    keywords IS NULL
    OR (
      keywords = btrim(keywords)
      AND char_length(keywords) BETWEEN 1 AND 200
    )
  ),
  category text CHECK (
    category IS NULL
    OR (
      category = btrim(category)
      AND char_length(category) BETWEEN 1 AND 80
    )
  ),
  max_price numeric(12, 2) CHECK (
    max_price IS NULL OR max_price > 0
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT saved_searches_has_criteria CHECK (
    keywords IS NOT NULL OR category IS NOT NULL OR max_price IS NOT NULL
  )
);

CREATE INDEX saved_searches_user_created_at_idx
  ON public.saved_searches (user_id, created_at DESC);
CREATE INDEX saved_searches_category_idx
  ON public.saved_searches (category)
  WHERE category IS NOT NULL;
CREATE INDEX saved_searches_max_price_idx
  ON public.saved_searches (max_price)
  WHERE max_price IS NOT NULL;

CREATE UNIQUE INDEX saved_searches_user_criteria_unique
  ON public.saved_searches (
    user_id,
    lower(regexp_replace(COALESCE(keywords, ''), '[[:space:]]+', ' ', 'g')),
    COALESCE(category, ''),
    COALESCE(max_price, 0)
  );

CREATE TRIGGER saved_searches_set_updated_at
  BEFORE UPDATE ON public.saved_searches
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.saved_searches ENABLE ROW LEVEL SECURITY;

CREATE POLICY saved_searches_read_own
  ON public.saved_searches
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY saved_searches_insert_own
  ON public.saved_searches
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY saved_searches_update_own
  ON public.saved_searches
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY saved_searches_delete_own
  ON public.saved_searches
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));

REVOKE ALL ON TABLE public.saved_searches
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.saved_searches TO authenticated;

ALTER TABLE public.notifications
  ADD COLUMN saved_search_id uuid
    REFERENCES public.saved_searches (id) ON DELETE SET NULL;

CREATE UNIQUE INDEX notifications_saved_search_match_unique
  ON public.notifications (user_id, auction_id, saved_search_id)
  WHERE notification_type = 'saved_search_match'
    AND saved_search_id IS NOT NULL;

CREATE FUNCTION public.notify_saved_search_matches()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.status <> 'published'
    OR NOT isfinite(NEW.closes_at)
    OR NEW.closes_at <= clock_timestamp()
  THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
      RETURN NEW;
    END IF;
  END IF;

  INSERT INTO public.notifications (
    user_id,
    auction_id,
    saved_search_id,
    notification_type,
    message
  )
  SELECT
    saved_search.user_id,
    NEW.id,
    saved_search.id,
    'saved_search_match'::public.notification_type,
    'New auction "' || NEW.title || '" matches your saved search "'
      || concat_ws(
        ' / ',
        saved_search.keywords,
        saved_search.category,
        CASE
          WHEN saved_search.max_price IS NOT NULL
            THEN 'up to ₹' || saved_search.max_price::text
          ELSE NULL
        END
      )
      || '".'
  FROM public.saved_searches AS saved_search
  WHERE saved_search.user_id <> NEW.seller_id
    AND (
      saved_search.keywords IS NULL
      OR strpos(
        lower(NEW.title || ' ' || NEW.description || ' ' || NEW.category),
        lower(saved_search.keywords)
      ) > 0
    )
    AND (
      saved_search.category IS NULL
      OR saved_search.category = NEW.category
    )
    AND (
      saved_search.max_price IS NULL
      OR NEW.starting_price <= saved_search.max_price
    )
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.notify_saved_search_matches()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER auctions_notify_saved_search_matches
  AFTER INSERT OR UPDATE OF status ON public.auctions
  FOR EACH ROW EXECUTE FUNCTION public.notify_saved_search_matches();

COMMIT;
