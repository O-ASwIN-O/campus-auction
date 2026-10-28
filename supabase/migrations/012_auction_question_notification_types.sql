-- Add dedicated notification types for auction questions and seller replies.
-- Run this migration to completion before migration 013.
ALTER TYPE public.notification_type
  ADD VALUE IF NOT EXISTS 'auction_question';

ALTER TYPE public.notification_type
  ADD VALUE IF NOT EXISTS 'auction_question_reply';
