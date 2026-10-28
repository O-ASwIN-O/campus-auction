-- Add the notification type for server-generated saved-search alerts.
ALTER TYPE public.notification_type
  ADD VALUE IF NOT EXISTS 'saved_search_match';
