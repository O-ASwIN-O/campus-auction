-- Add a distinct notification type for expired auctions with no bids.
-- Apply this migration before 011_automated_auction_result_processing.sql.
ALTER TYPE public.notification_type
  ADD VALUE IF NOT EXISTS 'auction_ended_no_bids';
