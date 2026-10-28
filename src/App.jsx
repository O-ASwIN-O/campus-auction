
import { useEffect, useState } from "react";
import "./App.css";

const initialItems = [
  {
    id: "1",
    title: "Mountain Bicycle",
    category: "Cycle",
    condition: "Good",
    description: "A reliable bicycle for daily campus travel.",
    price: 2500,
    increment: 100,
    endsAt: Date.now() + 5 * 60 * 60 * 1000,
    emoji: "🚲",
    color: "#e2f3e6",
    seller: "Campus Seller",
    bids: [],
    status: "ACTIVE",
  },
  {
    id: "2",
    title: "Casio Scientific Calculator",
    category: "Calculator",
    condition: "Like New",
    description: "Scientific calculator in excellent working condition.",
    price: 650,
    increment: 50,
    endsAt: Date.now() + 3 * 60 * 60 * 1000,
    emoji: "🧮",
    color: "#e8ebff",
    seller: "Campus Seller",
    bids: [],
    status: "ACTIVE",
  },
  {
    id: "3",
    title: "Engineering Mathematics Books",
    category: "Books",
    condition: "Good",
    description: "Useful reference books for engineering students.",
    price: 300,
    increment: 25,
    endsAt: Date.now() + 90 * 60 * 1000,
    emoji: "📚",
    color: "#fff0d9",
    seller: "Campus Seller",
    bids: [],
    status: "ACTIVE",
  },
  {
    id: "4",
    title: "Wireless Headphones",
    category: "Electronics",
    condition: "Good",
    description: "Wireless headphones, ready for a new owner.",
    price: 900,
    increment: 50,
    endsAt: Date.now() + 7 * 60 * 60 * 1000,
    emoji: "🎧",
    color: "#f4e6f5",
    seller: "Campus Seller",
    bids: [],
    status: "ACTIVE",
  },
];

const categories = ["All", "Cycle", "Calculator", "Books", "Electronics"];

function money(amount) {
  return `₹${Number(amount).toLocaleString("en-IN")}`;
}

function leadingBid(item) {
  return item.bids.length
    ? Math.max(...item.bids.map((bid) => bid.amount))
    : item.price;
}

function App() {
  const [page, setPage] = useState("home");
  const [items, setItems] = useState(initialItems);
  const [user, setUser] = useState(null);
  const [authIntent, setAuthIntent] = useState("buy");
  const [selectedItem, setSelectedItem] = useState(null);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  const [condition, setCondition] = useState("All");
  const [maxPrice, setMaxPrice] = useState("");
  const [closingSoon, setClosingSoon] = useState(false);
  const [bidAmount, setBidAmount] = useState("");
  const [notice, setNotice] = useState("");

  const [loginName, setLoginName] = useState("");
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");

  const [form, setForm] = useState({
    title: "",
    category: "Books",
    condition: "Good",
    description: "",
    price: "",
    increment: "50",
    hours: "24",
  });

  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  function flash(message) {
    setNotice(message);
    setTimeout(() => setNotice(""), 3500);
  }

  function go(nextPage) {
    setSelectedItem(null);
    setPage(nextPage);
    setNotice("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function requestLogin(intent) {
    setAuthIntent(intent);
    setPage("login");
  }

  // Temporary frontend-only sign-in for interface testing.
  // Replace this with real backend authentication before deployment.
  function handleDemoLogin(event) {
    event.preventDefault();

    if (!loginEmail.trim() || !loginPassword.trim()) {
      flash("Enter your email and password.");
      return;
    }

    setUser({
      id: loginEmail.trim().toLowerCase(),
      name: loginName.trim() || loginEmail.split("@")[0],
      email: loginEmail.trim(),
    });

    if (authIntent === "sell") {
      go("sell");
    } else {
      go("browse");
    }

    flash("Demo sign-in successful. Connect real authentication before launch.");
  }

  function handleLogout() {
    setUser(null);
    go("home");
    flash("You have signed out of the demo.");
  }

  function openItem(item) {
    setSelectedItem(item);
    setBidAmount(String(leadingBid(item) + item.increment));
  }

  function placeBid(event) {
    event.preventDefault();

    if (!user) {
      setSelectedItem(null);
      requestLogin("buy");
      flash("Sign in before placing a bid.");
      return;
    }

    const item = items.find((entry) => entry.id === selectedItem?.id);
    const amount = Number(bidAmount);

    if (!item || item.status !== "ACTIVE" || now >= item.endsAt) {
      flash("This auction has closed.");
      setSelectedItem(null);
      return;
    }

    if (item.sellerId === user.id) {
      flash("You cannot bid on your own listing.");
      return;
    }

    const minimum = item.bids.length
      ? leadingBid(item) + item.increment
      : item.price;

    if (!Number.isFinite(amount) || amount < minimum) {
      flash(`Your minimum valid bid is ${money(minimum)}.`);
      return;
    }

    setItems((previous) =>
      previous.map((entry) =>
        entry.id === item.id
          ? {
              ...entry,
              bids: [
                ...entry.bids,
                {
                  id: crypto.randomUUID(),
                  bidderId: user.id,
                  bidderName: user.name,
                  amount,
                  createdAt: Date.now(),
                },
              ],
            }
          : entry
      )
    );

    setSelectedItem(null);
    flash("Demo bid recorded in this browser only.");
  }

  function createListing(event) {
    event.preventDefault();

    if (!user) {
      requestLogin("sell");
      return;
    }

    const price = Number(form.price);
    const increment = Number(form.increment);
    const hours = Number(form.hours);

    if (
      !form.title.trim() ||
      !form.description.trim() ||
      !Number.isFinite(price) ||
      price <= 0 ||
      !Number.isFinite(increment) ||
      increment <= 0 ||
      !Number.isFinite(hours) ||
      hours <= 0
    ) {
      flash("Enter valid item details, price and closing time.");
      return;
    }

    const emojiByCategory = {
      Cycle: "🚲",
      Calculator: "🧮",
      Books: "📚",
      Electronics: "🎧",
    };

    const newItem = {
      id: crypto.randomUUID(),
      title: form.title.trim(),
      category: form.category,
      condition: form.condition,
      description: form.description.trim(),
      price,
      increment,
      endsAt: Date.now() + hours * 60 * 60 * 1000,
      emoji: emojiByCategory[form.category] || "📦",
      color: "#e2f3e6",
      seller: user.name,
      sellerId: user.id,
      bids: [],
      status: "ACTIVE",
    };

    setItems((previous) => [newItem, ...previous]);
    setForm({
      title: "",
      category: "Books",
      condition: "Good",
      description: "",
      price: "",
      increment: "50",
      hours: "24",
    });

    go("browse");
    flash("Demo listing created in this browser only.");
  }

  function cancelListing(itemId) {
    const item = items.find((entry) => entry.id === itemId);
    if (!item || item.bids.length > 0) {
      flash("For this demo, only listings with no bids can be cancelled.");
      return;
    }

    setItems((previous) =>
      previous.map((entry) =>
        entry.id === itemId
          ? { ...entry, status: "CANCELLED" }
          : entry
      )
    );
    flash("Demo listing cancelled.");
  }

  const visibleItems = items.filter((item) => {
    if (item.status !== "ACTIVE" || now >= item.endsAt) return false;

    const matchesSearch =
      `${item.title} ${item.description} ${item.category}`
        .toLowerCase()
        .includes(search.toLowerCase());

    const matchesCategory =
      category === "All" || item.category === category;

    const matchesCondition =
      condition === "All" || item.condition === condition;

    const matchesPrice =
      maxPrice === "" || leadingBid(item) <= Number(maxPrice);

    const matchesClosing =
      !closingSoon || item.endsAt - now <= 60 * 60 * 1000;

    return (
      matchesSearch &&
      matchesCategory &&
      matchesCondition &&
      matchesPrice &&
      matchesClosing
    );
  });

  function countdown(endTime) {
    const remaining = Math.max(0, endTime - now);
    const hours = Math.floor(remaining / 3600000);
    const minutes = Math.floor((remaining % 3600000) / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  function NavButton({ children, onClick, className = "" }) {
    return (
      <button className={className} onClick={onClick}>
        {children}
      </button>
    );
  }

  return (
    <div className="app">
      <header className="navbar">
        <button className="brand" onClick={() => go("home")}>
          <span className="brand-mark">C</span>
          Campus<span className="brand-accent">Auction</span>
        </button>

        <nav className="nav-links">
          <NavButton onClick={() => go("browse")}>Buy items</NavButton>
          <NavButton onClick={() => user ? go("sell") : requestLogin("sell")}>
            Sell items
          </NavButton>
          {user ? (
            <>
              <NavButton onClick={() => go("my-listings")}>My listings</NavButton>
              <NavButton className="nav-login" onClick={handleLogout}>
                Sign out
              </NavButton>
            </>
          ) : (
            <NavButton className="nav-login" onClick={() => requestLogin("buy")}>
              Sign in
            </NavButton>
          )}
        </nav>
      </header>

      {notice && <div className="toast" role="status">{notice}</div>}

      <main>
        {page === "home" && (
          <>
            <section className="hero">
              <div className="hero-copy">
                <span className="eyebrow">THE CAMPUS EXCHANGE</span>
                <h1>Good things deserve <span>a second life.</span></h1>
                <p>
                  Seniors are moving out. Find your next campus essential
                  through transparent student auctions.
                </p>
                <button className="primary-button" onClick={() => go("browse")}>
                  Explore auctions <span>→</span>
                </button>
                <div className="trust-note">♻️ Reuse more. Spend smarter.</div>
              </div>
              <div className="hero-visual">
                <div className="hero-orbit orbit-one" />
                <div className="hero-orbit orbit-two" />
                <span className="hero-bike">🚲</span>
                <span className="floating-item floating-book">📚</span>
                <span className="floating-item floating-calc">🧮</span>
                <div className="floating-card">
                  <span>Campus finds</span>
                  <strong>One bid away.</strong>
                </div>
              </div>
            </section>

            <section className="choice-section">
              <div className="section-intro">
                <span className="eyebrow">YOUR CAMPUS. YOUR MARKETPLACE.</span>
                <h2>What would you like to do?</h2>
                <p>Start browsing, or give your items a second life.</p>
              </div>

              <div className="choice-grid">
                <button className="choice-card buyer-card" onClick={() => go("browse")}>
                  <span className="choice-icon">🛍️</span>
                  <span className="choice-title">Buy items</span>
                  <span className="choice-description">
                    Browse cycles, books, calculators and more. No login needed to explore.
                  </span>
                  <span className="choice-action">Explore marketplace →</span>
                </button>

                <button
                  className="choice-card seller-card"
                  onClick={() => user ? go("sell") : requestLogin("sell")}
                >
                  <span className="choice-icon">📦</span>
                  <span className="choice-title">Sell items</span>
                  <span className="choice-description">
                    Sign in to list your items, manage bids and coordinate handover.
                  </span>
                  <span className="choice-action">
                    {user ? "Create a listing →" : "Sign in to start selling →"}
                  </span>
                </button>
              </div>
            </section>

            <section className="home-preview">
              <div className="section-heading">
                <div>
                  <span className="eyebrow">DON'T MISS OUT</span>
                  <h2>Auctions to explore</h2>
                </div>
                <button className="text-button" onClick={() => go("browse")}>
                  View all →
                </button>
              </div>
              <div className="product-grid">
                {visibleItems.slice(0, 3).map((item) => (
                  <ProductCard
                    key={item.id}
                    item={item}
                    now={now}
                    countdown={countdown}
                    onOpen={() => openItem(item)}
                  />
                ))}
              </div>
            </section>
          </>
        )}

        {page === "browse" && (
          <section className="marketplace page-section">
            <div className="section-heading">
              <div>
                <span className="eyebrow">FIND YOUR NEXT ESSENTIAL</span>
                <h1>Campus marketplace</h1>
                <p className="subheading">Explore auctions from your campus community.</p>
              </div>
              <button className="primary-button" onClick={() => user ? go("sell") : requestLogin("sell")}>
                + Sell an item
              </button>
            </div>

            <div className="filters">
              <input
                className="search-input"
                placeholder="Search items..."
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <select value={category} onChange={(event) => setCategory(event.target.value)}>
                {categories.map((name) => (
                  <option key={name} value={name}>
                    {name === "All" ? "All categories" : name}
                  </option>
                ))}
              </select>
              <select value={condition} onChange={(event) => setCondition(event.target.value)}>
                {["All", "New", "Like New", "Good", "Fair"].map((name) => (
                  <option key={name} value={name}>
                    {name === "All" ? "All conditions" : name}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min="0"
                className="price-filter"
                placeholder="Max ₹"
                value={maxPrice}
                onChange={(event) => setMaxPrice(event.target.value)}
              />
              <label className="closing-filter">
                <input
                  type="checkbox"
                  checked={closingSoon}
                  onChange={(event) => setClosingSoon(event.target.checked)}
                />
                Closing in 1 hour
              </label>
            </div>

            <p className="results-count">{visibleItems.length} active auctions</p>
            <div className="product-grid">
              {visibleItems.map((item) => (
                <ProductCard
                  key={item.id}
                  item={item}
                  now={now}
                  countdown={countdown}
                  onOpen={() => openItem(item)}
                />
              ))}
            </div>
            {visibleItems.length === 0 && (
              <div className="empty-state">
                <span>🔎</span>
                <h3>No matching auctions</h3>
                <p>Try changing your search or filters.</p>
              </div>
            )}
          </section>
        )}

        {page === "login" && (
          <section className="auth-page">
            <form className="auth-card" onSubmit={handleDemoLogin}>
              <span className="auth-icon">{authIntent === "sell" ? "📦" : "👋"}</span>
              <span className="eyebrow">WELCOME TO CAMPUS AUCTION</span>
              <h1>{authIntent === "sell" ? "Start selling" : "Sign in to continue"}</h1>
              <p>
                {authIntent === "sell"
                  ? "Sign in to create listings and manage your auctions."
                  : "You can browse without an account. Sign in when you're ready to bid."}
              </p>
              <label>
                Display name (optional)
                <input value={loginName} onChange={(event) => setLoginName(event.target.value)} placeholder="Your name" />
              </label>
              <label>
                Email
                <input type="email" required value={loginEmail} onChange={(event) => setLoginEmail(event.target.value)} placeholder="you@college.edu" />
              </label>
              <label>
                Password
                <input type="password" required value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} placeholder="Enter password" />
              </label>
              <button className="primary-button full-button" type="submit">
                Continue →
              </button>
              <p className="demo-disclaimer">
                Frontend preview only. This form does not verify your identity or save credentials.
              </p>
              <button className="text-button back-button" type="button" onClick={() => go("home")}>
                ← Back to home
              </button>
            </form>
          </section>
        )}

        {page === "sell" && (
          <section className="page-section form-page">
            <div className="section-heading">
              <div>
                <span className="eyebrow">GIVE YOUR ITEM A SECOND LIFE</span>
                <h1>Create an auction</h1>
                <p className="subheading">Add clear details so students know what they're bidding on.</p>
              </div>
            </div>

            {!user ? (
              <div className="empty-state">
                <h3>Sign in to sell</h3>
                <button className="primary-button" onClick={() => requestLogin("sell")}>Sign in →</button>
              </div>
            ) : (
              <form className="listing-form" onSubmit={createListing}>
                <label>
                  Item title
                  <input required maxLength="100" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="e.g. Mountain bicycle" />
                </label>
                <div className="form-row">
                  <label>
                    Category
                    <select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}>
                      {categories.filter((name) => name !== "All").map((name) => (
                        <option key={name}>{name}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Condition
                    <select value={form.condition} onChange={(event) => setForm({ ...form, condition: event.target.value })}>
                      {["New", "Like New", "Good", "Fair"].map((name) => (
                        <option key={name}>{name}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <label>
                  Description
                  <textarea required maxLength="1000" rows="4" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="Describe condition, age, included accessories and any defects." />
                </label>
                <div className="form-row">
                  <label>
                    Starting price (₹)
                    <input required type="number" min="1" value={form.price} onChange={(event) => setForm({ ...form, price: event.target.value })} placeholder="500" />
                  </label>
                  <label>
                    Minimum bid increment (₹)
                    <input required type="number" min="1" value={form.increment} onChange={(event) => setForm({ ...form, increment: event.target.value })} />
                  </label>
                </div>
                <label>
                  Auction duration
                  <select value={form.hours} onChange={(event) => setForm({ ...form, hours: event.target.value })}>
                    <option value="1">1 hour</option>
                    <option value="6">6 hours</option>
                    <option value="12">12 hours</option>
                    <option value="24">24 hours</option>
                    <option value="48">48 hours</option>
                    <option value="72">3 days</option>
                  </select>
                </label>
                <div className="form-notice">
                  Photo uploads and exact closing date/time will be connected to the backend in the next step.
                </div>
                <button className="primary-button full-button" type="submit">Create demo listing →</button>
              </form>
            )}
          </section>
        )}

        {page === "my-listings" && (
          <section className="page-section">
            <div className="section-heading">
              <div>
                <span className="eyebrow">YOUR SELLER SPACE</span>
                <h1>My listings</h1>
              </div>
              <button className="primary-button" onClick={() => go("sell")}>+ New listing</button>
            </div>
            <div className="product-grid">
              {items.filter((item) => item.sellerId === user?.id).map((item) => (
                <div className="seller-listing" key={item.id}>
                  <ProductCard
                    item={item}
                    now={now}
                    countdown={countdown}
                    onOpen={() => openItem(item)}
                  />
                  <div className="seller-listing-actions">
                    <span className="status-pill">{item.status}</span>
                    <button className="text-button" onClick={() => cancelListing(item.id)}>Cancel listing</button>
                  </div>
                </div>
              ))}
            </div>
            {items.filter((item) => item.sellerId === user?.id).length === 0 && (
              <div className="empty-state">
                <span>📦</span>
                <h3>No listings yet</h3>
                <p>Create your first auction to get started.</p>
                <button className="primary-button" onClick={() => go("sell")}>Create listing</button>
              </div>
            )}
          </section>
        )}
      </main>

      <footer className="footer">
        <button className="brand footer-brand" onClick={() => go("home")}>Campus<span className="brand-accent">Auction</span></button>
        <p>Built for campus life. Reuse more. Spend smarter.</p>
        <span>Student marketplace · Demo frontend</span>
      </footer>

      {selectedItem && (
        <div className="modal-backdrop" onClick={() => setSelectedItem(null)}>
          <section className="detail-modal" onClick={(event) => event.stopPropagation()}>
            <button className="modal-close" aria-label="Close" onClick={() => setSelectedItem(null)}>×</button>
            <div className="detail-art" style={{ backgroundColor: selectedItem.color }}>
              <span>{selectedItem.emoji}</span>
            </div>
            <div className="detail-content">
              <span className="eyebrow">{selectedItem.category} · {selectedItem.condition}</span>
              <h2>{selectedItem.title}</h2>
              <p>{selectedItem.description}</p>
              <div className="detail-price">
                <span>Current leading bid</span>
                <strong>{money(leadingBid(selectedItem))}</strong>
              </div>
              <div className="detail-meta">
                <span>Minimum increment: {money(selectedItem.increment)}</span>
                <span>Closes in: {countdown(selectedItem.endsAt)}</span>
              </div>

              <h3>Public bid history</h3>
              {selectedItem.bids.length === 0 ? (
                <p className="muted">No bids yet. Be the first to bid!</p>
              ) : (
                <div className="bid-history">
                  {[...selectedItem.bids].sort((a, b) => b.amount - a.amount).map((bid) => (
                    <div className="bid-history-row" key={bid.id}>
                      <span>{bid.bidderName}</span>
                      <strong>{money(bid.amount)}</strong>
                      <time>{new Date(bid.createdAt).toLocaleTimeString()}</time>
                    </div>
                  ))}
                </div>
              )}

              {selectedItem.status === "ACTIVE" && now < selectedItem.endsAt ? (
                <form className="bid-form" onSubmit={placeBid}>
                  <label htmlFor="bid-amount">Your bid (₹)</label>
                  <input id="bid-amount" type="number" min={selectedItem.bids.length ? leadingBid(selectedItem) + selectedItem.increment : selectedItem.price} step={selectedItem.increment} required value={bidAmount} onChange={(event) => setBidAmount(event.target.value)} />
                  <button className="primary-button full-button" type="submit">
                    {user ? "Place demo bid →" : "Sign in to place a bid →"}
                  </button>
                </form>
              ) : (
                <p className="form-notice">This auction is closed in the demo.</p>
              )}
              <p className="demo-disclaimer">Demo only: bids are stored in this browser's memory. They are not shared or secure until the backend is connected.</p>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function ProductCard({ item, now, countdown, onOpen }) {
  const price = leadingBid(item);
  const closed = now >= item.endsAt;

  return (
    <article className="product-card">
      <button className="product-image" style={{ backgroundColor: item.color }} onClick={onOpen} aria-label={`View ${item.title}`}>
        <span className="condition-pill">{item.condition}</span>
        <span className="product-emoji">{item.emoji}</span>
      </button>
      <div className="product-info">
        <span className="product-category">{item.category}</span>
        <h3>{item.title}</h3>
        <div className="product-price-row">
          <div>
            <span className="muted-label">Leading bid</span>
            <strong>{money(price)}</strong>
          </div>
          <div className="product-timer">
            <span className="muted-label">Closes in</span>
            <strong className={closed ? "closed-time" : ""}>
              {closed ? "Closed" : countdown(item.endsAt)}
            </strong>
          </div>
        </div>
        <button className="secondary-button" onClick={onOpen}>View auction →</button>
      </div>
    </article>
  );
}

export default App;
