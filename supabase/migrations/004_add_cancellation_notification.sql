-- Add the notification type in its own migration so PostgreSQL commits the
-- enum value before the cancellation function references it.
ALTER TYPE public.notification_type
  ADD VALUE IF NOT EXISTS 'auction_cancelled';
