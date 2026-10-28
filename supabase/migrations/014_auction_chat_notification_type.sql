-- Add the notification type used for private auction chat messages.
-- Apply this migration separately before migration 015.
BEGIN;

ALTER TYPE public.notification_type
  ADD VALUE IF NOT EXISTS 'auction_chat_message';

COMMIT;
