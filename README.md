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

Migrations 010 and 011 are present in the repository, but their live Supabase
application status must be confirmed in the Supabase project. After applying
011, verify both the function and the cron job, and then verify successful job
runs. A scheduled job is not considered operational merely because its SQL
definition exists.

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
supabase/
  migrations/             Ordered database schema and function changes
  functions/
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

There is currently no automated functional-test script in `package.json`.
Build and lint checks do not test live Supabase Auth, Storage, RLS, RPCs, or
scheduled jobs.

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
- Confirm public bid history omits private bidder email information.
- With 011 installed, wait for the cron job to process an expired auction.
  Check auction status and persistent notifications for the seller and
  provisional winner. Also test an expired auction with no bids.
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
