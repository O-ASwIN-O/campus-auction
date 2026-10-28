# Campus Auction

A campus marketplace for creating short-lived item auctions, placing bids, and
coordinating a sale after the seller approves the result. The frontend is a
React single-page application built with Vite. Supabase provides authentication,
PostgreSQL, Row Level Security (RLS), and private photo storage.

## What the application supports

- Public browsing of active, published auctions.
- Email/password registration and sign-in, persistent Supabase sessions, and
  password reset.
- Seller listings with a chosen starting price, bid increment, closing
  duration, description, condition, category, and up to five photos.
- Search and marketplace filters, auction countdowns, current bid information,
  and public bid history.
- Private saved searches for keywords, category, and maximum starting price,
  with persistent in-app alerts for newly published matching auctions.
- Bids submitted through the `place_bid` PostgreSQL RPC. The database checks
  the bidder, seller ownership, auction status and deadline, bid amount, and
  concurrent bids.
- Seller cancellation, staged deletion of eligible listings, and cancellation
  retention/cleanup support.
- Per-user notifications for bids, auction results, cancellation, and handover.
- Seller approval or rejection of provisional results, with contact details
  retrieved through an authorization-checked RPC after approval.
- Database-side expiry processing and scheduled cleanup definitions in the
  later migrations. These require the applicable migrations and Supabase
  scheduler configuration to be installed and verified.

## Technology

- React 19 and JavaScript
- Vite
- Plain CSS
- `@supabase/supabase-js`
- Supabase Auth, PostgreSQL, RLS, Storage, and optional `pg_cron`/`pg_net`

## Requirements

- Node.js and npm
- A Supabase project
- Supabase SQL Editor access to apply and verify database migrations
- Supabase CLI only if deploying the cancelled-auction cleanup Edge Function

## Run locally

1. Install dependencies:

   ```sh
   npm install
   ```

2. Copy `.env.example` to `.env` and set your project URL and publishable key:

   ```dotenv
   VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
   VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_SUPABASE_PUBLISHABLE_KEY
   ```

   The frontend reads only these two Supabase variables in `src/supabase.js`.
   A publishable/anon key is intended for browser use with RLS enabled. Never
   put a service-role key, database password, or other secret in a `VITE_`
   variable or commit it to source control. `.env` is ignored by Git.

3. Start the development server:

   ```sh
   npm run dev
   ```

   Open the local URL printed by Vite.

## Supabase setup

### Database migrations

SQL files are in `supabase/migrations`. Review and apply them to the intended
Supabase project in the order below. Do not rerun migrations that have already
been applied; check the project's migration history first. The presence of a
SQL file in this repository does **not** prove it has been run on the live
database.

| Migration | Purpose | Important dependency or setup |
| --- | --- | --- |
| `001_initial_schema.sql` | Profiles, auctions, bids, notifications, statuses, RLS, core RPCs, and public bid history. | Base schema; apply first. |
| `002_listing_photo_storage.sql` | Private `listing-photos` bucket, object policies, and path validation. | Requires the base schema and Supabase Storage. |
| `003_secure_auction_deletion.sql` | Seller-authorized staged deletion for eligible listings. | Requires auctions, bids, and Storage schema. |
| `004_add_cancellation_notification.sql` | Adds the `auction_cancelled` notification enum value. | Apply as its own completed SQL step before migration 005 uses the value. |
| `005_cancel_auction_with_bids.sql` | Cancellation that retains bids and notifies bidders. | Requires migrations 001–004. |
| `006_require_bids_above_one.sql` | Bid validation update and a historical fixed-starting-price rule. | Requires migrations 001–005. It is superseded in part by migration 007. |
| `007_restore_seller_starting_price.sql` | Restores seller-selected starting prices and updates bid validation. | Requires migrations 001–006. Apply after 006; do not apply 006 again afterward. |
| `008_cancelled_auction_retention.sql` | Cancellation timestamps, cleanup queue, and cleanup scheduling function. | Requires migrations 001–007. The Edge Function, server secrets, and scheduled cleanup must also be configured. |
| `009_result_contact_sharing.sql` | Notifies both parties about pending/decided results and adds restricted Auth-email lookup. | Requires the schema and result functions from migrations 001–008. |
| `010_auction_ended_no_bids_notification_type.sql` | Adds a notification type for expired auctions with no bids. | Run and confirm separately before migration 011. |
| `011_automated_auction_result_processing.sql` | Adds database-side expiry processing, updates result notices, backfills eligible notices, and schedules a one-minute `pg_cron` job. | Requires migrations 001–010 in order and a Supabase database where `pg_cron` is available and permitted. |
| `012_auction_question_notification_types.sql` | Adds notification types for buyer questions and seller replies. | Run as a completed migration before migration 013. |
| `013_auction_questions_and_answers.sql` | Adds public-safe Q&A reads, RLS, idempotent question submission, and one-time seller replies. | Requires migrations 001–012. Does not alter existing auction or notification RPCs. |
| `014_auction_chat_notification_type.sql` | Adds the private chat-message notification type. | Run as a completed migration before migration 015. |
| `015_auction_chat_and_expiry_cleanup.sql` | Adds private per-buyer conversations, authorization-checked chat RPCs, and scheduled expired-chat cleanup. | Requires migrations 001–014 and the `pg_cron` extension available from the migration 011 scheduler setup. |
| `016_saved_search_notification_type.sql` | Adds the notification type for saved-search matches. | Run to completion before migration 017 uses the enum value. |
| `017_saved_searches_and_matching_alerts.sql` | Adds owner-private saved searches, RLS, duplicate prevention, and a database trigger that creates persistent alerts when an eligible auction is published. | Requires migrations 001–016 in order. Does not require a separate scheduler or browser polling. |
| `018_last_minute_auction_extensions.sql` | Extends an open auction to 60 seconds after an accepted bid in its final 30 seconds. | Requires the auction and bid schema from migrations 001–017. The bid insert and extension share a transaction. |
| `019_automatic_bidding.sql` | Adds private per-user maximums and secure RPCs that place proxy bids in the same transaction as bidding changes. | Requires migrations 001–018. Direct access to maximums is revoked; configure, read, and disable them through the provided RPCs. |

Migrations 010 and 011 are present in the repository, but their live Supabase
application status must be confirmed in the Supabase project. After applying
011, verify both the function and the cron job, and then verify successful job
runs. A scheduled job is not considered operational merely because its SQL
definition exists.

Migrations 016 and 017 are local feature files and have not necessarily been
applied to any Supabase project. Apply 016 first and confirm it completes before
applying 017. The trigger evaluates searches in the same transaction that
inserts or transitions an auction to `published`; notifications remain stored
even when the recipient is offline. It ignores expired auctions, skips the
seller, and creates one notification per matching saved search. Category is an
exact match, keywords are case-insensitive literal phrases over title,
description, and category, and maximum price is compared with `starting_price`.
Saved searches that match multiple criteria require every specified criterion
to match. Condition and closing-time browse filters are not part of saved-search
matching.

Migrations 018 and 019 are also local files until deliberately reviewed and
applied to the intended Supabase project. Migration 018 resets an auction's
deadline to 60 seconds after each accepted bid received within the final 30
seconds; the database deadline remains authoritative. Migration 019 extends
`place_bid` while preserving its existing validations, and adds
`configure_automatic_bid`, `get_my_automatic_bid`, and
`disable_automatic_bid`. Each user can privately configure a maximum per
auction. Proxy responses are serialized with the auction row, use the minimum
amount needed to beat the next competing maximum where possible, and never
exceed the configured maximum. The UI requires an explicit checkbox and a
confirmation step before enabling automatic bidding. The SQL has not been
executed by the application; review and test it in a non-production project
before applying it.

### Auction assistant

The Auction assistant tab can search currently published, unexpired auctions
using built-in structured parsing without login or sending the prompt to an AI
provider. It can filter by keywords, category, and maximum **starting** price,
sort cheapest results by current bid, and compare auctions with the signed-in
user's private saved searches. Search criteria matching and auction results
are processed in the browser using data the application already makes
available to that user; saved-search contents are not sent to the AI function.

Hosted AI interpretation is optional and off by default. A user must sign in
and check the consent box before the prompt is sent to the
`auction-assistant` Supabase Edge Function. Add `OPENAI_API_KEY` as an Edge
Function secret in the Supabase project settings (never as a `VITE_` variable),
then deploy from the repository with:

```sh
supabase functions deploy auction-assistant
```

`OPENAI_MODEL` is optional and defaults to `gpt-4o-mini`. The function
verifies the caller's Supabase session and requests search criteria only; it
does not place bids or receive account details, bid history, chat messages, or
saved-search contents. If the function is unavailable, the UI displays a
notice and falls back to built-in search. Prompts sent to hosted AI are
processed by the configured provider, so use that option only with
appropriate user consent and provider configuration.

For example, these read-only checks can be run in the Supabase SQL Editor after
the migrations:

```sql
SELECT to_regprocedure('public.process_expired_auctions()') AS processor;

SELECT jobid, jobname, schedule, command, active
FROM cron.job
WHERE jobname = 'campus-auction-expired-results';

SELECT jobid, runid, status, return_message, start_time, end_time
FROM cron.job_run_details
WHERE jobid IN (
  SELECT jobid
  FROM cron.job
  WHERE jobname = 'campus-auction-expired-results'
)
ORDER BY start_time DESC
LIMIT 20;
```

If `pg_cron` is unavailable or the migration cannot schedule the job, stop and
resolve the database extension/permissions issue rather than assuming auction
expiry is automatic. Until the processor and schedule are confirmed, the
frontend countdown is only a display; the seller can manually trigger the
`close_auction_for_review` action for an expired listing.

### Cancelled-auction cleanup

Migration 008 prepares a 24-hour cancelled-auction retention flow. It requires
the `cleanup-cancelled-auctions` Supabase Edge Function in
`supabase/functions/cleanup-cancelled-auctions/` and server-only configuration.
The function expects `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and
`CANCELLED_AUCTION_CLEANUP_TOKEN` as Edge Function secrets. Migration 008's
scheduled request also expects the project URL and matching cleanup token to be
stored in Supabase Vault under the names used in that migration. Never put
these secrets in the frontend or README. Deploy/configure this function and
verify its scheduled runs before relying on permanent cleanup.

The expiry-result job in migration 011 is separate from the cancelled-auction
cleanup job in migration 008.

### Auction chat and earlier Q&A migrations

The auction details modal now presents product information and a separate
private chat panel. Each buyer has a separate conversation with the seller, so
buyers cannot read one another's messages. Signed-in users other than the
seller may start a conversation while an auction is `published` and before its
database `closes_at` deadline. The seller can select among buyer conversations.
There is no read-only chat access after the auction deadline or for other
auction statuses.

Migration 015 enforces those rules in PostgreSQL RPCs; the browser countdown is
only a display. Direct table access is revoked and RLS is enabled. Message
notifications identify the auction but do not include message contents or
contact details. A separate `pg_cron` job, `campus-auction-chat-cleanup`, uses
the extension already used by migration 011. It deletes conversations only
when their auction's original `closes_at` has passed; messages cascade from
those conversations. Access is denied at the deadline even if the cleanup job
has not run yet. Physical deletion normally follows within about a minute,
but can be delayed if the scheduler is unavailable.

Migrations 012 and 013 remain in the migration history, but the current
frontend no longer displays or calls the Q&A feature. They are not edited or
removed because they may already be applied in a Supabase project. Apply and
confirm migrations 012 and 013 before 014 and 015; none is applied
automatically by the application. Before relying on chat, verify both the new
RPCs and the cleanup job in a test Supabase project.

Read-only scheduler checks after applying migration 015:

```sql
SELECT
  to_regprocedure('public.open_auction_chat(uuid)') AS open_chat,
  to_regprocedure('public.list_auction_chat_conversations(uuid)') AS list_chats,
  to_regprocedure('public.read_auction_chat(uuid)') AS read_chat,
  to_regprocedure('public.send_auction_chat_message(uuid,text,uuid)') AS send_chat,
  to_regprocedure('public.cleanup_expired_auction_chats()') AS cleanup;

SELECT jobid, jobname, schedule, command, active
FROM cron.job
WHERE jobname IN (
  'campus-auction-expired-results',
  'campus-auction-chat-cleanup'
);

SELECT jobid, runid, status, return_message, start_time, end_time
FROM cron.job_run_details
WHERE jobid IN (
  SELECT jobid
  FROM cron.job
  WHERE jobname = 'campus-auction-chat-cleanup'
)
ORDER BY start_time DESC
LIMIT 20;
```

Test in a non-production Supabase project with one seller, two buyers, and an
unrelated signed-in account. Have both buyers open conversations for a published
auction and confirm each buyer sees only their own thread while the seller can
select both. Verify an unrelated account cannot read or send to any thread, a
buyer cannot access another buyer's thread, and the seller cannot chat with
themself. Test empty and over-500-character messages through the RPC as well as
the UI. After setting a test auction's `closes_at` into the past, confirm reads
and sends fail immediately;
then verify the cleanup job deletes its conversations/messages while an active
auction's messages remain. Do not treat successful SQL installation alone as
proof that authorization or scheduled execution works.

### Supabase Auth

Configure email confirmation and the site's allowed redirect URLs in Supabase
Auth. Password reset redirects to `/reset-password` on the current site origin,
so that URL must be allowed in the Supabase Auth URL configuration. The app
does not store user passwords.

### Photo storage

Migration 002 defines the private `listing-photos` bucket and access policies.
The app validates JPG/JPEG, PNG, and WebP uploads (up to five photos and 5 MB
per image); the bucket policies and database path validation provide the
server-side enforcement. Confirm the bucket and policies are present in the
target project before testing listing photos.

## Auction result lifecycle

1. Buyers place bids through `place_bid`; the database uses `closes_at` as the
   deadline source of truth.
2. The browser countdown reaching zero does not itself select a winner.
3. With migration 011 applied and its cron job running, the database processes
   expired published auctions. It selects the highest bid using amount
   descending, then earlier bid timestamp, then bid ID as tie-breakers.
4. The seller and provisional winner receive persistent `result_pending`
   notifications. An auction with no bids transitions to `ended_no_bids` and
   notifies its seller.
5. The seller approves or rejects the result. Approval notifications include
   the counterpart's email only for the seller and winning bidder; the
   `get_auction_contact` RPC independently checks authorization and approved
   status.
6. Handover confirmations are recorded through the database workflow.

The notification bell fetches each authenticated user's own notifications,
refreshes when opened, and polls periodically. Notification rows are protected
by RLS. This describes the local implementation; delivery in a Supabase
environment still depends on the migrations and policies being installed.

## Project layout

```text
src/
  App.jsx                 Main UI and Supabase workflows
  App.css                 Application styles
  supabase.js             Supabase client and public environment configuration
  AuctionAssistant.jsx    Auction search assistant interface
  assistantSearch.js      Built-in search parsing and saved-search matching
supabase/
  migrations/             Ordered database schema and function changes
  functions/
    auction-assistant/    Optional authenticated AI search interpreter
    cleanup-cancelled-auctions/
                           Server-side cancelled-auction photo/record cleanup
public/                   Static assets
.env.example              Frontend environment-variable template
```

## Development checks

```sh
npm run lint
npm run build
```

`npm test` runs the focused Node.js tests for assistant prompt parsing,
criteria validation, and saved-search matching. Build and lint checks do not
test live Supabase Auth, Storage, RLS, RPCs, or scheduled jobs.

## Manual verification checklist

Use separate seller and buyer accounts, and optionally a third account for
unauthorized-access checks:

- Register, confirm email if enabled, sign in/out, and restore a session after
  refreshing.
- Request a password reset and complete it using the configured redirect URL.
- Publish an auction with selected starting price, duration, and optional
  photos. Confirm it appears in active browsing.
- Place bids from the buyer account. Test a valid bid, a bid at or below the
  current highest bid, a seller self-bid, and a bid after expiry.
- After applying 018 and 019 to a test project, configure automatic bidding
  for two buyers on the same auction. Test that responses respect each private
  maximum, concurrent bids are serialized, users can disable their own limit,
  and neither buyer can read the other's maximum. Place an accepted bid within
  the final 30 seconds and verify the deadline extends to 60 seconds after it.
- Open the Auction assistant while signed out and test keyword/category/price
  parsing, cheapest sorting, empty results, and opening a result in the
  existing auction modal. Sign in to test matching private saved searches.
  Deploy and configure the optional Edge Function to test hosted interpretation
  only after explicitly checking the consent box; verify missing configuration
  falls back to built-in search with a notice.
- Confirm public bid history omits private bidder email information.
- With 011 installed, wait for the cron job to process an expired auction.
  Check auction status and persistent notifications for the seller and
  provisional winner. Also test an expired auction with no bids.
- With 014 and 015 applied, use two signed-in buyer accounts and the seller to
  verify separate conversations, message notifications, and message
  authorization. Confirm the seller cannot chat with themself, an unrelated
  account cannot read or send messages, and empty or over-500-character
  messages are rejected by both UI and RPC.
- Verify chat reads and sends fail immediately at the original `closes_at`,
  including before the scheduled cleanup has run. After the cleanup job runs,
  confirm expired conversation/message rows are deleted and active-auction
  messages remain.
- After applying 016 and 017 in a test project, save searches under two buyer
  accounts and confirm each account can read and edit only its own searches.
  Try empty criteria, invalid prices, and equivalent duplicate searches.
- Publish auctions that match and do not match the saved criteria. Verify
  case-insensitive literal keywords, exact category, the starting-price
  boundary, seller exclusion, and no alerts for expired or cancelled listings.
  Confirm multiple matching searches create distinct alerts and repeated
  publication processing does not duplicate them.
- Confirm each saved-search notification appears for its recipient and opens
  the linked auction. Delete a saved search and verify existing notifications
  remain readable. Confirm logged-out users can still browse but cannot save
  or access private saved searches.
- Approve and reject results. Confirm contact email is unavailable before
  approval and only available to the seller and confirmed winning bidder after
  approval.
- Test cancellation, bidder notifications, 24-hour cleanup configuration, and
  preservation of unrelated auctions.
- Verify the cron job's run history and investigate failures before relying on
  automatic processing.

## Security notes

- Keep `.env` and all server credentials out of Git.
- Use only the Supabase publishable key in browser code; enforce data access
  with RLS and trusted database functions.
- Never expose the Supabase service-role key to the frontend.
- Treat live database migration state and scheduler health as deployment
  configuration that must be explicitly verified.
