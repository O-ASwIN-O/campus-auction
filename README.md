# Campus Auction 🎓

Campus Auction is a college-focused marketplace where students can list items they no longer need and let other students bid through timed auctions. It aims to make buying and selling within a campus community more organized, transparent, and convenient.

## ✨ Current Features

- **Authentication:** Sign up and sign in with Supabase Auth.
- **Auction creation:** Sellers can list an item with details, photos, a seller-selected starting price, and a closing time.
- **Timed bidding:** Buyers can place bids while an auction is active. A new bid should exceed the current highest bid.
- **Bid history:** Auction bid history is available without exposing bidder identities in the public history view.
- **Photo uploads:** Listing photos use Supabase Storage.
- **Auction cancellation:** Sellers can cancel eligible published auctions through a backend operation.
- **Notifications:** An authenticated notification bell and panel is implemented in the frontend for bid, cancellation, result, and handover updates. Live end-to-end behavior still needs testing.
- **Seller result review:** The intended workflow lets sellers review auction results before a sale is confirmed.
- **Handover workflow:** Buyer and seller can confirm the handover through the application.
- **Security controls:** Supabase Row Level Security (RLS), database functions, and Storage policies are used to protect data and important operations.

> **Development status:** This project is under active development. Recent build, lint, and diff checks have passed for the notification UI changes, but the full application has not yet been validated end-to-end against the live Supabase project. Feature descriptions represent implemented UI and intended backend behavior where noted; they are not a claim of production readiness.

## 🧰 Tech Stack

- **Frontend:** React, JavaScript, Vite, CSS
- **Backend and database:** Supabase, PostgreSQL
- **Authentication:** Supabase Auth
- **Image storage:** Supabase Storage
- **Version control:** Git and GitHub

## 🚀 Getting Started

### Prerequisites

- Node.js and npm
- A Supabase project

### 1. Clone the repository

```bash
git clone https://github.com/O-ASwIN-O/campus-auction.git
cd campus-auction
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Create a `.env` file in the project root:

```env
VITE_SUPABASE_URL=your_supabase_project_url
VITE_SUPABASE_PUBLISHABLE_KEY=your_supabase_publishable_key
```

Get these values from your Supabase project settings. **Never put a Supabase service-role key or another secret in a `VITE_*` variable**; these variables are exposed to the browser.

### 4. Configure Supabase

Review the SQL migration files in the repository. Apply only migrations that have not already been applied to your Supabase project, in the correct order. Do not blindly rerun migrations. After setup, verify the tables, views, functions, Storage policies, and RLS policies in the Supabase dashboard.

For password reset, make sure your local reset URL is allowed in Supabase Auth URL Configuration.

### 5. Run the development server

```bash
npm run dev
```

Vite prints the local URL in the terminal, usually `http://localhost:5173`.

## 🧪 Useful Commands

```bash
npm run dev       # Start the development server
npm run build     # Build the app for production
npm run lint      # Run ESLint
npm run preview   # Preview a production build locally
```

## 🗃️ Data and Security Notes

- `bids` is the source table for accepted bid records.
- `public_bid_history` is defined in the checked-in migrations as a view over bid records, not a separate bid table. It omits bidder identity from the public history.
- Important rules—bid validity, auction status, closing time, seller restrictions, and concurrent bidding—must be enforced by the database, not only by frontend validation.
- Notification reads and updates should be restricted to the signed-in user by database policies as well as frontend queries.
- Buyer and seller email addresses must not be public; reveal them only through an appropriately protected flow after the result is approved.
- Auction expiry and automatic deletion of cancelled auctions require a verified server-side scheduled process. A browser countdown is not enough to perform reliable cleanup.

## ✅ Testing Checklist

The following flows should be tested against the live Supabase project before considering the app production-ready:

- [ ] Sign up, sign in, sign out, and password reset
- [ ] Create an auction with a seller-selected starting price and upload an image
- [ ] Accept valid bids and reject bids that do not exceed the current highest bid
- [ ] Test simultaneous bids and confirm database concurrency protection
- [ ] Reject bids after the database closing time
- [ ] Confirm the notification bell works for buyers and sellers, including unread counts and mark-as-read
- [ ] Confirm a cancelled auction disappears immediately and is deleted only after the configured retention period, once server-side scheduling is configured
- [ ] Test winner selection, seller approval/rejection, and handover notifications
- [ ] Verify RLS, Storage permissions, and post-approval email access using separate accounts
- [ ] Run build, lint, and functional tests after changes

## 🤝 Contributing

Before submitting changes, run:

```bash
npm run lint
npm run build
```

Keep secrets out of commits, use new SQL migrations for schema changes, and test important business rules at the database level.

## 📄 License

No license has been specified yet. Contact the repository owner before reusing or distributing this project.
