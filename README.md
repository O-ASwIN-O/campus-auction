# Campus Auction 🎓

A campus-focused marketplace where students can list items they no longer need and let other students bid through timed auctions. The goal is to make buying and selling within a college community more organized and transparent.

## ✨ Features

- **Authentication:** Sign up and sign in using Supabase Auth.
- **Auction listings:** Sellers can publish item details, photos, a seller-selected starting price, and an auction closing time.
- **Timed bidding:** Buyers place bids while an auction is active. The intended rule is that a new bid must exceed the current highest bid.
- **Bid history:** Displays auction bid history without publicly exposing bidder identities.
- **Photo storage:** Listing images are uploaded to Supabase Storage.
- **Auction cancellation:** Sellers can cancel a published auction through a backend operation; existing bid history should be handled safely.
- **Notifications:** An authenticated notification bell and panel for bid, cancellation, result, and handover updates.
- **Seller result review:** Auction results are designed to be reviewed by the seller before the sale is confirmed.
- **Handover workflow:** Buyer and seller can confirm the item handover through the application.
- **Access controls:** Supabase Row Level Security (RLS) and database functions are used to protect user-specific data and important auction operations.

> **Project status:** This is an actively developed project. Build/lint checks have passed for recent changes, but live end-to-end tests with separate buyer and seller accounts, concurrent bids, scheduled auction closing, notification delivery, and email privacy still need to be verified. Feature descriptions above reflect the current intended implementation and should not be read as a claim that every flow has been production-validated.

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

Use the URL and publishable key from your Supabase project settings. **Never put a Supabase service-role key or other secret in a `VITE_*` variable**, because variables with that prefix are exposed to the browser.

### 4. Configure Supabase

Review the SQL migration files in the repository and apply only migrations that have not already been applied to your project, in the documented order. Do not blindly rerun migrations. Verify the resulting tables, views, functions, Storage policies, and RLS policies in the Supabase dashboard.

For password reset, ensure your local reset URL is permitted in Supabase Auth URL configuration.

### 5. Start the development server

```bash
npm run dev
```

Vite prints the local development URL in the terminal, usually `http://localhost:5173`.

## 🧪 Useful Commands

```bash
npm run dev       # Start the development server
npm run build     # Build the app for production
npm run lint      # Run ESLint
npm run preview   # Preview a production build locally
```

## 🗃️ Data and Security Notes

- `bids` is the source table for accepted bid records.
- `public_bid_history` is intended to be a view over bid records, not a second table that duplicates them. It excludes bidder identity from public history.
- Database validation—not frontend checks alone—must enforce bid amount, auction status, deadline, seller restrictions, and concurrent-bid behavior.
- Notification queries and updates should be limited to the signed-in user by database policies as well as application logic.
- Buyer and seller email addresses must not be exposed publicly; disclose them only through an appropriately protected flow after the result is approved.
- Automatic auction expiry and scheduled cleanup of cancelled auctions require a verified server-side scheduled process. A browser timer alone is not sufficient.

## 🛠️ Development Status / Next Verification

Before treating the project as production-ready, verify these flows against the live Supabase project:

- [ ] Sign up, sign in, sign out, and password reset
- [ ] Create an auction with a seller-selected starting price and upload a photo
- [ ] Place valid bids and reject bids that do not exceed the current highest bid
- [ ] Test simultaneous bids and ensure only valid bids are accepted
- [ ] Reject bids after the database closing time
- [ ] Confirm the notification bell works for buyer and seller accounts, including unread counts and mark-as-read
- [ ] Confirm cancellation hides the auction immediately and scheduled deletion occurs only after the configured retention period
- [ ] Confirm seller approval/rejection, winner selection, and handover notifications
- [ ] Verify RLS, Storage permissions, and post-approval email access with separate accounts
- [ ] Run build/lint checks and functional tests after changes

## 🤝 Contributing

This project is under active development. Before submitting changes, run:

```bash
npm run lint
npm run build
```

Keep secrets out of commits, use new SQL migrations for schema changes, and test important rules at the database level.

## 📄 License

No license has been specified yet. Contact the repository owner before reusing or distributing this project.
