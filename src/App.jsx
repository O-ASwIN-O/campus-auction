
import { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabase.js";
import "./App.css";

const categories = ["All", "Cycle", "Calculator", "Books", "Electronics"];
const photoBucket = "listing-photos";
const allowedPhotoTypes = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);
const maxPhotoSize = 5 * 1024 * 1024;
const categoryColors = {
  Cycle: "#e2f3e6",
  Calculator: "#e8ebff",
  Books: "#fff0d9",
  Electronics: "#f4e6f5",
};
const categoryEmoji = {
  Cycle: "🚲",
  Calculator: "🧮",
  Books: "📚",
  Electronics: "🎧",
};

function EyeIcon({ visible }) {
  return visible ? (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8" />
      <path d="M9.9 5.2A10.8 10.8 0 0 1 12 5c5.5 0 9 7 9 7a15.7 15.7 0 0 1-3.1 3.8M6.2 6.2C3.9 7.7 3 12 3 12s3.5 7 9 7a10.5 10.5 0 0 0 3-.4" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 12s3.5-7 9-7 9 7 9 7-3.5 7-9 7-9-7-9-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function money(amount) {
  return `₹${Number(amount).toLocaleString("en-IN")}`;
}

function leadingBid(item) {
  return item.bids.length
    ? Math.max(...item.bids.map((bid) => bid.amount))
    : item.price;
}

function mapBid(row) {
  return {
    id: row.bid_id,
    amount: Number(row.amount),
    createdAt: row.created_at,
    bidderName: "Campus bidder",
    auctionStatus: row.auction_status,
  };
}

function getPasswordResetError(error, isUpdatingPassword = false) {
  const code = String(error?.code || "").toLowerCase();
  const message = String(error?.message || "").toLowerCase();
  const status = Number(error?.status);
  const invalidResetLink =
    code.includes("expired") ||
    code.includes("token") ||
    code.includes("otp") ||
    message.includes("expired") ||
    message.includes("token") ||
    message.includes("reset link is invalid");

  if (
    status === 429 ||
    code.includes("rate") ||
    message.includes("rate limit") ||
    message.includes("too many requests")
  ) {
    return "Too many password reset requests. Please wait a while before trying again.";
  }

  if (
    isUpdatingPassword &&
    (code.includes("weak_password") ||
      message.includes("password") ||
      message.includes("at least")) &&
    !invalidResetLink
  ) {
    return "The new password does not meet the password requirements. Choose a stronger password and try again.";
  }

  if (invalidResetLink) {
    return "This password reset link is invalid or has expired. Request a new one.";
  }

  if (code.includes("redirect") || message.includes("redirect")) {
    return "The reset link could not be sent because its redirect URL is not allowed. Check the Supabase Auth URL configuration.";
  }

  return isUpdatingPassword
    ? "The password could not be updated. The reset link may have expired; request a new one if needed."
    : "The reset email could not be sent. Please check the address and try again later.";
}

async function createPhotoUrlMap(paths) {
  const uniquePaths = [...new Set(paths)];
  if (!uniquePaths.length) return new Map();

  const { data, error } = await supabase.storage
    .from(photoBucket)
    .createSignedUrls(uniquePaths, 60 * 60 * 24 * 7);
  if (error) throw error;

  const failedPath = data.find((photo) => photo.error || !photo.signedUrl);
  if (failedPath) {
    throw new Error(failedPath.error || "Could not create a photo link.");
  }

  return new Map(data.map((photo) => [photo.path, photo.signedUrl]));
}

function mapAuction(row, bids, photoUrlsByPath) {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    condition: row.item_condition,
    description: row.description,
    price: Number(row.starting_price),
    increment: Number(row.min_increment),
    endsAt: new Date(row.closes_at).getTime(),
    emoji: categoryEmoji[row.category] || "📦",
    color: categoryColors[row.category] || "#e2f3e6",
    seller: row.seller_name || "Campus seller",
    sellerId: row.seller_id,
    photoPaths: row.photo_paths || [],
    photoUrls: (row.photo_paths || [])
      .map((path) => photoUrlsByPath.get(path))
      .filter(Boolean),
    bids,
    status: row.status.toUpperCase(),
  };
}

async function fetchListings() {
  const { data: auctionRows, error: auctionsError } = await supabase
    .from("auctions")
    .select(
      "id, seller_id, title, description, category, item_condition, starting_price, min_increment, closes_at, photo_paths, status",
    )
    .order("closes_at", { ascending: true });

  if (auctionsError) throw auctionsError;
  if (!auctionRows?.length) return [];

  const auctionIds = auctionRows.map((auction) => auction.id);
  const sellerIds = [...new Set(auctionRows.map((auction) => auction.seller_id))];
  const photoPaths = auctionRows.flatMap((auction) => auction.photo_paths || []);
  const [bidsResult, profilesResult, photoUrlsByPath] = await Promise.all([
    supabase
      .from("public_bid_history")
      .select("bid_id, auction_id, amount, created_at, auction_status")
      .in("auction_id", auctionIds)
      .order("created_at", { ascending: false }),
    supabase
      .from("profiles")
      .select("id, display_name")
      .in("id", sellerIds),
    createPhotoUrlMap(photoPaths),
  ]);

  if (bidsResult.error) throw bidsResult.error;
  if (profilesResult.error) throw profilesResult.error;

  const bidsByAuction = new Map();
  for (const row of bidsResult.data || []) {
    const auctionBids = bidsByAuction.get(row.auction_id) || [];
    auctionBids.push(mapBid(row));
    bidsByAuction.set(row.auction_id, auctionBids);
  }

  const sellerNames = new Map(
    (profilesResult.data || []).map((profile) => [
      profile.id,
      profile.display_name,
    ]),
  );

  return auctionRows.map((row) =>
    mapAuction(
      { ...row, seller_name: sellerNames.get(row.seller_id) },
      bidsByAuction.get(row.id) || [],
      photoUrlsByPath,
    ),
  );
}

function NavButton({ children, onClick, className = "", disabled = false }) {
  return (
    <button className={className} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

function App() {
  const [page, setPage] = useState(() =>
    window.location.pathname.replace(/\/+$/, "") === "/reset-password"
      ? "reset-password"
      : "home",
  );
  const [items, setItems] = useState([]);
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authBusy, setAuthBusy] = useState(false);
  const [authMode, setAuthMode] = useState("signin");
  const [authError, setAuthError] = useState("");
  const [passwordResetEmail, setPasswordResetEmail] = useState("");
  const [passwordResetError, setPasswordResetError] = useState(() => {
    const resetRoute =
      window.location.pathname.replace(/\/+$/, "") === "/reset-password";
    const hasResetUrlError = ["error", "error_code", "error_description"].some(
      (key) =>
        new URLSearchParams(window.location.search).has(key) ||
        new URLSearchParams(window.location.hash.slice(1)).has(key),
    );
    return resetRoute && hasResetUrlError
      ? "This password reset link is invalid or has expired. Request a new one."
      : "";
  });
  const [passwordResetMessage, setPasswordResetMessage] = useState("");
  const [passwordResetBusy, setPasswordResetBusy] = useState(false);
  const [passwordResetSessionReady, setPasswordResetSessionReady] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [resetPasswordVisible, setResetPasswordVisible] = useState(false);
  const [confirmResetPasswordVisible, setConfirmResetPasswordVisible] = useState(false);
  const [itemsLoading, setItemsLoading] = useState(true);
  const [itemsError, setItemsError] = useState("");
  const [authIntent, setAuthIntent] = useState("buy");
  const [selectedItem, setSelectedItem] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [bidBusy, setBidBusy] = useState(false);
  const [listingBusy, setListingBusy] = useState(false);
  const [photoFiles, setPhotoFiles] = useState([]);
  const [replacementPhotoFiles, setReplacementPhotoFiles] = useState([]);
  const [replacementPhotosBusy, setReplacementPhotosBusy] = useState(false);
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
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [deletingAuctionId, setDeletingAuctionId] = useState(null);
  const [cancellingAuctionId, setCancellingAuctionId] = useState(null);
  const [deletionPendingIds, setDeletionPendingIds] = useState(() => new Set());
  const currentUserId = user?.id;
  const photoPreviews = useMemo(
    () => photoFiles.map((file) => URL.createObjectURL(file)),
    [photoFiles],
  );

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

  useEffect(() => {
    let active = true;
    const resetRoute =
      window.location.pathname.replace(/\/+$/, "") === "/reset-password";
    const hasResetUrlError = ["error", "error_code", "error_description"].some(
      (key) =>
        new URLSearchParams(window.location.search).has(key) ||
        new URLSearchParams(window.location.hash.slice(1)).has(key),
    );

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      setUser(session?.user || null);
      if (event === "PASSWORD_RECOVERY" && session) {
        setPage("reset-password");
        setPasswordResetSessionReady(true);
        setPasswordResetError("");
      }
    });

    supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (!active) return;
        if (error) {
          console.error("Could not restore the Supabase session.");
          flash("Could not restore your sign-in. Please sign in again.");
        }
        setUser(data.session?.user || null);
        if (resetRoute && !hasResetUrlError && data.session) {
          setPasswordResetSessionReady(true);
          setPasswordResetError("");
        } else if (resetRoute && !hasResetUrlError) {
          setPasswordResetSessionReady(false);
          setPasswordResetError(
            "This password reset link is invalid or has expired. Request a new one.",
          );
        }
        setAuthLoading(false);
      })
      .catch(() => {
        if (!active) return;
        console.error("Could not restore the Supabase session.");
        setAuthLoading(false);
        flash("Could not restore your sign-in. Please sign in again.");
      });

    async function loadAuctions() {
      setItemsLoading(true);
      setItemsError("");
      try {
        const listings = await fetchListings();
        if (active) setItems(listings);
      } catch (error) {
        console.error("Could not load Supabase auctions.", error);
        if (active) setItemsError("Auctions could not be loaded. Please try again.");
      } finally {
        if (active) setItemsLoading(false);
      }
    }

    void loadAuctions();
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(
    () => () => photoPreviews.forEach((url) => URL.revokeObjectURL(url)),
    [photoPreviews],
  );

  useEffect(() => {
    let active = true;

    if (!currentUserId) return undefined;

    supabase
      .from("auction_deletion_requests")
      .select("auction_id")
      .then(({ data, error }) => {
        if (!active) return;
        if (error) {
          console.error("Could not load pending listing deletions.", error);
          flash("Pending listing deletions could not be loaded.");
          return;
        }

        setDeletionPendingIds(
          new Set((data || []).map((row) => row.auction_id)),
        );
      })
      .catch((error) => {
        if (!active) return;
        console.error("Could not request pending listing deletions.", error);
        flash("Pending listing deletions could not be loaded.");
      });

    return () => {
      active = false;
    };
  }, [currentUserId]);

  useEffect(() => {
    let active = true;
    let noticeTimeout;

    if (!currentUserId) return undefined;

    async function loadCancellationNotices() {
      const { data, error } = await supabase
        .from("notifications")
        .select("id, message")
        .eq("notification_type", "auction_cancelled")
        .eq("is_read", false)
        .order("created_at", { ascending: false })
        .limit(25);

      if (!active) return;
      if (error) {
        console.error("Could not load auction cancellation notifications.", error);
        return;
      }
      if (!data?.length) return;

      setNotice(
        data.length === 1
          ? data[0].message
          : `${data.length} auctions you bid on were cancelled. Your bid history is preserved.`,
      );
      clearTimeout(noticeTimeout);
      noticeTimeout = setTimeout(() => {
        if (active) setNotice("");
      }, 5000);

      const { error: updateError } = await supabase
        .from("notifications")
        .update({ is_read: true })
        .in("id", data.map((notification) => notification.id));
      if (updateError) {
        console.error("Could not mark cancellation notifications as read.", updateError);
      }
    }

    void loadCancellationNotices();
    const interval = setInterval(() => {
      void loadCancellationNotices();
    }, 30000);

    return () => {
      active = false;
      clearInterval(interval);
      clearTimeout(noticeTimeout);
    };
  }, [currentUserId]);

  useEffect(() => {
    const auctionId = selectedItem?.id;
    if (!auctionId) return undefined;
    let active = true;

    supabase
      .from("public_bid_history")
      .select("bid_id, auction_id, amount, created_at, auction_status")
      .eq("auction_id", auctionId)
      .order("created_at", { ascending: false })
      .then(({ data, error }) => {
        if (!active) return;
        if (error) {
          console.error("Could not load public bid history.", error);
          flash("Bid history could not be loaded.");
          return;
        }
        const bids = (data || []).map(mapBid);
        setItems((previous) =>
          previous.map((item) =>
            item.id === auctionId ? { ...item, bids } : item,
          ),
        );
        setSelectedItem((current) =>
          current?.id === auctionId ? { ...current, bids } : current,
        );
      })
      .catch((error) => {
        if (!active) return;
        console.error("Could not request public bid history.", error);
        flash("Bid history could not be loaded.");
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });

    return () => {
      active = false;
    };
  }, [selectedItem?.id]);

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
    setAuthMode("signin");
    setPage("login");
  }

  async function handleAuth(event) {
    event.preventDefault();
    setAuthError("");

    const email = loginEmail.trim();
    if (!email || !loginPassword) {
      setAuthError("Enter your email and password.");
      return;
    }

    setAuthBusy(true);
    try {
      if (authMode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email,
          password: loginPassword,
          options: {
            data: { display_name: loginName.trim() || email.split("@")[0] },
          },
        });
        if (error) throw error;

        if (!data.session) {
          setLoginPassword("");
          flash("Check your email to confirm your account, then sign in.");
          setAuthMode("signin");
          return;
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password: loginPassword,
        });
        if (error) throw error;
      }

      setLoginPassword("");
      setAuthError("");
      go(authIntent === "sell" ? "sell" : "browse");
      flash(authMode === "signup" ? "Your account is ready." : "You are signed in.");
    } catch (error) {
      const message =
        typeof error?.message === "string" && error.message.trim()
          ? error.message
          : "Supabase returned an authentication error without a message.";
      const code = typeof error?.code === "string" ? ` (${error.code})` : "";
      setAuthError(`${message}${code}`);
    } finally {
      setAuthBusy(false);
    }
  }

  async function sendPasswordReset(event) {
    event.preventDefault();
    setPasswordResetError("");
    setPasswordResetMessage("");

    const email = passwordResetEmail.trim();
    if (!email) {
      setPasswordResetError("Enter the email address for your account.");
      return;
    }

    setPasswordResetBusy(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (error) {
        setPasswordResetError(getPasswordResetError(error));
        return;
      }

      setPasswordResetMessage(
        "If an account exists for that email, a reset link has been sent. Check your inbox and spam folder.",
      );
    } catch (error) {
      setPasswordResetError(getPasswordResetError(error));
    } finally {
      setPasswordResetBusy(false);
    }
  }

  async function updatePassword(event) {
    event.preventDefault();
    setPasswordResetError("");
    setPasswordResetMessage("");

    if (!passwordResetSessionReady) {
      setPasswordResetError(
        "This password reset link is invalid or has expired. Request a new one.",
      );
      return;
    }
    if (newPassword.length < 6) {
      setPasswordResetError("Your password must be at least 6 characters long.");
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setPasswordResetError("The password entries do not match.");
      return;
    }

    setPasswordResetBusy(true);
    try {
      const { data, error: sessionError } = await supabase.auth.getSession();
      if (sessionError) throw sessionError;
      if (!data.session) {
        setPasswordResetSessionReady(false);
        setPasswordResetError(
          "This password reset link is invalid or has expired. Request a new one.",
        );
        return;
      }

      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) {
        setPasswordResetError(getPasswordResetError(error, true));
        return;
      }

      setNewPassword("");
      setConfirmNewPassword("");
      setPasswordResetSessionReady(false);
      window.history.replaceState({}, "", "/");
      go("browse");
      flash("Your password has been updated successfully.");
    } catch (error) {
      setPasswordResetError(getPasswordResetError(error, true));
    } finally {
      setPasswordResetBusy(false);
    }
  }

  async function handleLogout() {
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      go("home");
      flash("You have signed out.");
    } catch (error) {
      console.error("Supabase sign-out failed.", error);
      flash("Sign-out failed. Please try again.");
    }
  }

  async function openItem(item) {
    setDetailLoading(true);
    setSelectedItem(item);
    setBidAmount(String(leadingBid(item) + item.increment));
  }

  async function placeBid(event) {
    event.preventDefault();

    if (!user) {
      setSelectedItem(null);
      requestLogin("buy");
      flash("Sign in before placing a bid.");
      return;
    }

    const item = items.find((entry) => entry.id === selectedItem?.id);
    const amount = Number(bidAmount);

    if (!item || item.status !== "PUBLISHED" || now >= item.endsAt) {
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

    setBidBusy(true);
    let error;
    try {
      ({ error } = await supabase.rpc("place_bid", {
        p_auction_id: item.id,
        p_amount: amount,
      }));
    } catch (requestError) {
      console.error("Could not send the bid request.", requestError);
      flash("The bid could not be sent. Check your connection and try again.");
      setBidBusy(false);
      return;
    }
    setBidBusy(false);
    if (error) {
      console.error("Supabase rejected the bid.", error);
      flash("Your bid was rejected. Check the current minimum and auction deadline.");
      return;
    }

    try {
      const { data, error: historyError } = await supabase
        .from("public_bid_history")
        .select("bid_id, auction_id, amount, created_at, auction_status")
        .eq("auction_id", item.id)
        .order("created_at", { ascending: false });
      if (historyError) throw historyError;

      const bids = (data || []).map(mapBid);
      const updatedItem = { ...item, bids };
      setItems((previous) =>
        previous.map((entry) => (entry.id === item.id ? updatedItem : entry)),
      );
      setSelectedItem(updatedItem);
      setBidAmount(String(leadingBid(updatedItem) + updatedItem.increment));
      flash("Your bid was placed.");
    } catch (error) {
      console.error("Bid succeeded, but refreshing bid history failed.", error);
      flash("Your bid was placed, but the latest bid history could not be loaded.");
    }
  }

  function handlePhotoSelection(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";

    if (files.length > 5) {
      flash("Choose no more than five photos.");
      return;
    }

    const invalidFile = files.find(
      (file) =>
        !allowedPhotoTypes.has(file.type) ||
        file.size > maxPhotoSize ||
        file.size === 0,
    );
    if (invalidFile) {
      flash("Use JPG, PNG or WebP photos no larger than 5 MB each.");
      return;
    }

    setPhotoFiles(files);
  }

  function handleReplacementPhotoSelection(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";

    if (files.length > 5) {
      flash("Choose no more than five replacement photos.");
      return;
    }

    const invalidFile = files.find(
      (file) =>
        !allowedPhotoTypes.has(file.type) ||
        file.size > maxPhotoSize ||
        file.size === 0,
    );
    if (invalidFile) {
      flash("Use JPG, PNG or WebP photos no larger than 5 MB each.");
      return;
    }

    setReplacementPhotoFiles(files);
  }

  async function replaceListingPhotos(item) {
    if (replacementPhotosBusy) return;
    if (!user || item.sellerId !== user.id) {
      flash("Only the listing owner can replace its photos.");
      return;
    }
    if (
      item.status !== "PUBLISHED" ||
      item.bids.length > 0 ||
      now >= item.endsAt
    ) {
      flash("Photos can only be replaced before bidding starts.");
      return;
    }
    if (!replacementPhotoFiles.length) {
      flash("Choose at least one replacement photo.");
      return;
    }
    if (
      !window.confirm(
        `Replace all photos for "${item.title}"? This is available only before any bids are placed.`,
      )
    ) {
      return;
    }

    setReplacementPhotosBusy(true);
    const batchId = crypto.randomUUID();
    const uploadedPaths = [];
    let listingUpdated = false;
    try {
      for (const file of replacementPhotoFiles) {
        const extension = allowedPhotoTypes.get(file.type);
        const path = `${user.id}/${batchId}/${crypto.randomUUID()}.${extension}`;
        const { error } = await supabase.storage
          .from(photoBucket)
          .upload(path, file, {
            cacheControl: "3600",
            contentType: file.type,
            upsert: false,
          });
        if (error) throw error;
        uploadedPaths.push(path);
      }

      const photoUrlsByPath = await createPhotoUrlMap(uploadedPaths);
      const { error } = await supabase.rpc("update_auction_listing", {
        p_auction_id: item.id,
        p_title: item.title,
        p_description: item.description,
        p_category: item.category,
        p_item_condition: item.condition,
        p_starting_price: item.price,
        p_min_increment: item.increment,
        p_closes_at: new Date(item.endsAt).toISOString(),
        p_photo_paths: uploadedPaths,
      });
      if (error) throw error;
      listingUpdated = true;

      const updatedItem = {
        ...item,
        photoPaths: uploadedPaths,
        photoUrls: uploadedPaths.map((path) => photoUrlsByPath.get(path)),
      };
      setItems((previous) =>
        previous.map((entry) => (entry.id === item.id ? updatedItem : entry)),
      );
      setSelectedItem((previous) =>
        previous?.id === item.id ? updatedItem : previous,
      );
      setReplacementPhotoFiles([]);

      if (item.photoPaths.length) {
        const { error: cleanupError } = await supabase.storage
          .from(photoBucket)
          .remove(item.photoPaths);
        if (cleanupError) {
          console.error("New photos are saved, but old listing photos could not be removed.", cleanupError);
          flash("Photos replaced, but old photo files could not be cleaned up. Contact support.");
          return;
        }
      }

      flash("Listing photos replaced.");
    } catch (error) {
      console.error("Could not replace listing photos.", error);
      if (!listingUpdated && uploadedPaths.length) {
        try {
          const { error: cleanupError } = await supabase.storage
            .from(photoBucket)
            .remove(uploadedPaths);
          if (cleanupError) {
            console.error("Could not clean up new photos after the failed replacement.", cleanupError);
          }
        } catch (cleanupError) {
          console.error("Could not request cleanup of the replacement photos.", cleanupError);
        }
      }
      flash(
        listingUpdated
          ? "Photos were updated, but old photo cleanup did not finish."
          : "Photos could not be replaced. The listing was not changed.",
      );
    } finally {
      setReplacementPhotosBusy(false);
    }
  }

  async function createListing(event) {
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
      hours <= 0 ||
      photoFiles.length > 5
    ) {
      flash("Enter valid item details, price and closing time.");
      return;
    }

    const validPhotos = photoFiles.every(
      (file) =>
        allowedPhotoTypes.has(file.type) &&
        file.size > 0 &&
        file.size <= maxPhotoSize,
    );
    if (!validPhotos) {
      flash("Remove invalid photos before publishing.");
      return;
    }

    setListingBusy(true);
    const photoBatchId = crypto.randomUUID();
    const uploadedPaths = [];
    let listingCreated = false;
    try {
      for (const file of photoFiles) {
        const extension = allowedPhotoTypes.get(file.type);
        const path = `${user.id}/${photoBatchId}/${crypto.randomUUID()}.${extension}`;
        const { error } = await supabase.storage
          .from(photoBucket)
          .upload(path, file, {
            cacheControl: "3600",
            contentType: file.type,
            upsert: false,
          });
        if (error) throw error;
        uploadedPaths.push(path);
      }

      const closesAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
      const listingData = {
        title: form.title.trim(),
        description: form.description.trim(),
        category: form.category,
        item_condition: form.condition,
        starting_price: price,
        min_increment: increment,
        closes_at: closesAt,
        photo_paths: uploadedPaths,
      };
      const { data: insertedAuction, error: insertError } = await supabase
        .from("auctions")
        .insert(listingData)
        .select("id")
        .single();
      if (insertError) throw insertError;
      listingCreated = true;
      let photoUrlsByPath = new Map();
      let photosAvailable = true;
      try {
        photoUrlsByPath = await createPhotoUrlMap(uploadedPaths);
      } catch (photoError) {
        photosAvailable = false;
        console.error("Auction published, but photo links could not be created.", photoError);
      }

      const createdListing = mapAuction(
        {
          ...listingData,
          id: insertedAuction.id,
          seller_id: user.id,
          status: "published",
          seller_name:
            user.user_metadata?.display_name || user.email?.split("@")[0],
        },
        [],
        photoUrlsByPath,
      );
      setItems((previous) => [createdListing, ...previous]);
      setPhotoFiles([]);
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
      flash(
        photosAvailable
          ? "Your auction has been published."
          : "Auction published. Photos could not be loaded; refresh and try again.",
      );

      try {
        setItems(await fetchListings());
      } catch (refreshError) {
        console.error("Could not refresh listings after publishing.", refreshError);
        flash("Auction published, but the latest listings could not be refreshed.");
      }
    } catch (error) {
      console.error("Could not publish Supabase auction.", error);
      if (!listingCreated && uploadedPaths.length) {
        try {
          const { error: cleanupError } = await supabase.storage
            .from(photoBucket)
            .remove(uploadedPaths);
          if (cleanupError) {
            console.error("Could not remove photos for the failed listing.", cleanupError);
          }
        } catch (cleanupError) {
          console.error("Could not request photo cleanup.", cleanupError);
        }
      }
      if (listingCreated) {
        flash("Auction published, but the latest listings could not be refreshed.");
      } else {
        flash("The listing could not be published. Check the details and try again.");
      }
    } finally {
      setListingBusy(false);
    }
  }

  async function cancelListing(itemId) {
    if (cancellingAuctionId) return;
    const item = items.find((entry) => entry.id === itemId);
    if (!item) {
      flash("This listing could not be found.");
      return;
    }

    if (
      !window.confirm(
        `Cancel "${item.title}"?\n\nThis immediately ends the auction and invalidates its result. Existing bids will remain in the public history, and all bidders will be notified. This cannot be undone.`,
      )
    ) {
      return;
    }

    setCancellingAuctionId(itemId);
    try {
      const { error } = await supabase.rpc("cancel_auction", {
        p_auction_id: itemId,
      });
      if (error) throw error;
    } catch (error) {
      console.error("Could not cancel Supabase auction.", error);
      flash(
        typeof error?.message === "string"
          ? `This listing could not be cancelled. ${error.message}`
          : "This listing could not be cancelled. Only its owner can cancel a published auction.",
      );
      return;
    } finally {
      setCancellingAuctionId(null);
    }

    setItems((previous) =>
      previous.map((entry) =>
        entry.id === itemId ? { ...entry, status: "CANCELLED" } : entry,
      ),
    );
    setSelectedItem((previous) =>
      previous?.id === itemId ? { ...previous, status: "CANCELLED" } : previous,
    );
    flash(
      item.bids.length
        ? "Auction cancelled. Bid history is preserved and bidders have been notified."
        : "Your auction has been cancelled.",
    );
  }

  async function deleteListing(item) {
    if (deletingAuctionId) return;

    const confirmed = window.confirm(
      `Delete "${item.title}"? This permanently removes the listing and its photos.`,
    );
    if (!confirmed) return;

    setDeletingAuctionId(item.id);
    let deletionStarted = false;
    try {
      const { data: photoPaths, error: beginError } = await supabase.rpc(
        "begin_auction_deletion",
        { p_auction_id: item.id },
      );
      if (beginError) throw beginError;
      deletionStarted = true;

      const paths = photoPaths || [];
      const filesByFolder = new Map();
      for (const path of paths) {
        const separator = path.lastIndexOf("/");
        if (separator <= 0 || separator === path.length - 1) {
          throw new Error("A listing photo path is invalid.");
        }
        const folder = path.slice(0, separator);
        const fileName = path.slice(separator + 1);
        const names = filesByFolder.get(folder) || [];
        names.push({ path, fileName });
        filesByFolder.set(folder, names);
      }

      const existingPaths = [];
      for (const [folder, files] of filesByFolder) {
        const { data, error } = await supabase.storage
          .from(photoBucket)
          .list(folder);
        if (error) throw error;

        const existingNames = new Set((data || []).map((file) => file.name));
        existingPaths.push(
          ...files
            .filter((file) => existingNames.has(file.fileName))
            .map((file) => file.path),
        );
      }

      if (existingPaths.length) {
        const { error } = await supabase.storage
          .from(photoBucket)
          .remove(existingPaths);
        if (error) throw error;
      }

      const { error: finalizeError } = await supabase.rpc(
        "finalize_auction_deletion",
        { p_auction_id: item.id },
      );
      if (finalizeError) throw finalizeError;

      setItems((previous) => previous.filter((entry) => entry.id !== item.id));
      setDeletionPendingIds((previous) => {
        const next = new Set(previous);
        next.delete(item.id);
        return next;
      });
      setSelectedItem(null);
      flash("Listing and its photos were deleted.");

      try {
        setItems(await fetchListings());
      } catch (refreshError) {
        console.error("Listing deleted, but refreshing auctions failed.", refreshError);
        flash("Listing deleted, but the latest auctions could not be refreshed.");
      }
    } catch (error) {
      console.error("Could not delete Supabase auction.", error);
      const errorMessage =
        typeof error?.message === "string" ? ` ${error.message}` : "";
      if (deletionStarted) {
        setDeletionPendingIds((previous) => new Set(previous).add(item.id));
        setSelectedItem((previous) =>
          previous?.id === item.id
            ? { ...previous, status: "CANCELLED" }
            : previous,
        );
        flash(
          `The listing is hidden from bidding, but photo cleanup did not finish. Retry deletion from its details.${errorMessage}`,
        );
      } else {
        flash(
          `The secure deletion request was rejected.${errorMessage || " Check that migration 003 is applied and that the listing is still eligible."}`,
        );
      }
    } finally {
      setDeletingAuctionId(null);
    }
  }

  const visibleItems = items.filter((item) => {
    if (item.status !== "PUBLISHED" || now >= item.endsAt) return false;

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
  const cancelledItems = items.filter((item) => item.status === "CANCELLED");

  const isSelectedAuctionOwner = Boolean(
    user &&
      selectedItem &&
      String(user.id).toLowerCase() ===
        String(selectedItem.sellerId).toLowerCase(),
  );
  const selectedDeletionPending = selectedItem
    ? deletionPendingIds.has(selectedItem.id)
    : false;
  const selectedAuctionEligibleForDeletion = Boolean(
    selectedItem &&
      selectedItem.status === "PUBLISHED" &&
      now < selectedItem.endsAt &&
      selectedItem.bids.length === 0,
  );

  function countdown(endTime) {
    const remaining = Math.max(0, endTime - now);
    const hours = Math.floor(remaining / 3600000);
    const minutes = Math.floor((remaining % 3600000) / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    return `${hours}h ${minutes}m ${seconds}s`;
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
            <NavButton
          className="nav-login"
          onClick={() => requestLogin("buy")}
          disabled={authLoading}
            >
          {authLoading ? "Loading..." : "Sign in"}
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
              {!itemsLoading && !itemsError && visibleItems.length === 0 && (
                <p className="empty-state">No published auctions yet.</p>
              )}
              {itemsError && <p className="form-notice">{itemsError}</p>}
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

            <p className="results-count">
              {itemsLoading ? "Loading auctions..." : `${visibleItems.length} active auctions`}
            </p>
            {itemsError && (
              <div className="empty-state" role="alert">
                <h3>Auctions are unavailable</h3>
                <p>{itemsError}</p>
              </div>
            )}
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
            {!itemsLoading && !itemsError && visibleItems.length === 0 && (
              <div className="empty-state">
                <span>🔎</span>
                <h3>No active auctions match</h3>
                <p>Try changing your search or filters. Cancelled auction history is shown below.</p>
              </div>
            )}
            {cancelledItems.length > 0 && (
              <section className="cancelled-auction-history">
                <div className="section-heading">
                  <div>
                    <span className="eyebrow">PUBLIC RECORD</span>
                    <h2>Cancelled auction history</h2>
                    <p className="subheading">
                      Cancelled auctions no longer accept bids. Existing bids remain visible.
                    </p>
                  </div>
                </div>
                <div className="product-grid">
                  {cancelledItems.map((item) => (
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
            )}
          </section>
        )}

        {page === "login" && (
          <section className="auth-page">
            <form className="auth-card" onSubmit={handleAuth}>
              <span className="auth-icon">{authIntent === "sell" ? "📦" : "👋"}</span>
              <span className="eyebrow">WELCOME TO CAMPUS AUCTION</span>
              <h1>
                {authMode === "signup"
                  ? "Create your account"
                  : authIntent === "sell"
                    ? "Start selling"
                    : "Sign in to continue"}
              </h1>
              <p>
                {authMode === "signup"
                  ? "Create an account with your email and password to start bidding and selling."
                  : authIntent === "sell"
                  ? "Sign in to create listings and manage your auctions."
                  : "You can browse without an account. Sign in when you're ready to bid."}
              </p>
              {authMode === "signup" && (
                <label>
                  Display name (optional)
                  <input
                    maxLength="80"
                    value={loginName}
                      onChange={(event) => {
                        setLoginName(event.target.value);
                        setAuthError("");
                      }}
                    placeholder="Your name"
                  />
                </label>
              )}
              <label>
                Email
                <input
                  type="email"
                  autoComplete="email"
                  required
                  value={loginEmail}
                  onChange={(event) => {
                    setLoginEmail(event.target.value);
                    setAuthError("");
                  }}
                  placeholder="you@college.edu"
                />
              </label>
              <label>
                Password
                <span className="password-input-wrap">
                  <input
                    type={passwordVisible ? "text" : "password"}
                    autoComplete={authMode === "signup" ? "new-password" : "current-password"}
                    required
                    minLength="6"
                    value={loginPassword}
                    onChange={(event) => {
                      setLoginPassword(event.target.value);
                      setAuthError("");
                    }}
                    placeholder="Enter password"
                  />
                  <button
                    className="password-visibility-toggle"
                    type="button"
                    aria-label={passwordVisible ? "Hide password" : "Show password"}
                    aria-pressed={passwordVisible}
                    onClick={() => setPasswordVisible((visible) => !visible)}
                  >
                    <EyeIcon visible={passwordVisible} />
                  </button>
                </span>
              </label>
              {authMode === "signin" && (
                <button
                  className="text-button password-reset-link"
                  type="button"
                  onClick={() => {
                    setPasswordResetEmail(loginEmail);
                    setPasswordResetError("");
                    setPasswordResetMessage("");
                    setPage("forgot-password");
                  }}
                >
                  Forgot password?
                </button>
              )}
              {authError && (
                <p className="auth-error" role="alert">
                  Supabase authentication error: {authError}
                </p>
              )}
              <button className="primary-button full-button" type="submit" disabled={authBusy}>
                {authBusy
                  ? "Please wait..."
                  : authMode === "signup"
                    ? "Create account →"
                    : "Sign in →"}
              </button>
              <p className="demo-disclaimer auth-switch">
                {authMode === "signup" ? "Already registered?" : "New to Campus Auction?"}
                <button
                  className="text-button"
                  type="button"
                  onClick={() => {
                    setAuthMode(authMode === "signup" ? "signin" : "signup");
                    setAuthError("");
                  }}
                >
                  {authMode === "signup" ? "Sign in" : "Create an account"}
                </button>
              </p>
              <button className="text-button back-button" type="button" onClick={() => go("home")}>
                ← Back to home
              </button>
            </form>
          </section>
        )}

        {page === "forgot-password" && (
          <section className="auth-page">
            <form className="auth-card" onSubmit={sendPasswordReset}>
              <span className="auth-icon">🔐</span>
              <span className="eyebrow">ACCOUNT RECOVERY</span>
              <h1>Reset your password</h1>
              <p>
                Enter the email address for your account. If it is registered,
                Supabase will email you a secure password reset link.
              </p>
              <label>
                Email
                <input
                  type="email"
                  autoComplete="email"
                  required
                  value={passwordResetEmail}
                  onChange={(event) => {
                    setPasswordResetEmail(event.target.value);
                    setPasswordResetError("");
                    setPasswordResetMessage("");
                  }}
                  placeholder="you@college.edu"
                />
              </label>
              {passwordResetError && (
                <p className="auth-error" role="alert">{passwordResetError}</p>
              )}
              {passwordResetMessage && (
                <p className="auth-success" role="status">{passwordResetMessage}</p>
              )}
              <button
                className="primary-button full-button"
                type="submit"
                disabled={passwordResetBusy}
              >
                {passwordResetBusy ? "Sending..." : "Send reset link →"}
              </button>
              <button
                className="text-button back-button"
                type="button"
                onClick={() => {
                  setAuthMode("signin");
                  setAuthError("");
                  window.history.replaceState({}, "", "/");
                  setPage("login");
                }}
              >
                ← Back to sign in
              </button>
            </form>
          </section>
        )}

        {page === "reset-password" && (
          <section className="auth-page">
            <form className="auth-card" onSubmit={updatePassword}>
              <span className="auth-icon">🔐</span>
              <span className="eyebrow">ACCOUNT RECOVERY</span>
              <h1>Choose a new password</h1>
              <p>Use a password you have not used for this account before.</p>
              {passwordResetError && (
                <p className="auth-error" role="alert">{passwordResetError}</p>
              )}
              {passwordResetSessionReady ? (
                <>
                  <label>
                    New password
                    <span className="password-input-wrap">
                      <input
                        type={resetPasswordVisible ? "text" : "password"}
                        autoComplete="new-password"
                        minLength="6"
                        required
                        value={newPassword}
                        onChange={(event) => {
                          setNewPassword(event.target.value);
                          setPasswordResetError("");
                        }}
                        placeholder="At least 6 characters"
                      />
                      <button
                        className="password-visibility-toggle"
                        type="button"
                        aria-label={resetPasswordVisible ? "Hide new password" : "Show new password"}
                        aria-pressed={resetPasswordVisible}
                        onClick={() => setResetPasswordVisible((visible) => !visible)}
                      >
                        <EyeIcon visible={resetPasswordVisible} />
                      </button>
                    </span>
                  </label>
                  <label>
                    Confirm new password
                    <span className="password-input-wrap">
                      <input
                        type={confirmResetPasswordVisible ? "text" : "password"}
                        autoComplete="new-password"
                        minLength="6"
                        required
                        value={confirmNewPassword}
                        onChange={(event) => {
                          setConfirmNewPassword(event.target.value);
                          setPasswordResetError("");
                        }}
                        placeholder="Re-enter new password"
                      />
                      <button
                        className="password-visibility-toggle"
                        type="button"
                        aria-label={confirmResetPasswordVisible ? "Hide confirmation password" : "Show confirmation password"}
                        aria-pressed={confirmResetPasswordVisible}
                        onClick={() =>
                          setConfirmResetPasswordVisible((visible) => !visible)
                        }
                      >
                        <EyeIcon visible={confirmResetPasswordVisible} />
                      </button>
                    </span>
                  </label>
                  <button
                    className="primary-button full-button"
                    type="submit"
                    disabled={passwordResetBusy}
                  >
                    {passwordResetBusy ? "Updating..." : "Update password →"}
                  </button>
                </>
              ) : (
                <button
                  className="primary-button full-button"
                  type="button"
                  onClick={() => {
                    setPasswordResetEmail(loginEmail);
                    setPasswordResetError("");
                    setPasswordResetMessage("");
                    window.history.replaceState({}, "", "/");
                    setPage("forgot-password");
                  }}
                >
                  Request a new reset link
                </button>
              )}
              <button
                className="text-button back-button"
                type="button"
                onClick={() => {
                  setAuthMode("signin");
                  window.history.replaceState({}, "", "/");
                  setPage("login");
                }}
              >
                ← Back to sign in
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
                    <input required type="number" min="0.01" step="0.01" value={form.price} onChange={(event) => setForm({ ...form, price: event.target.value })} placeholder="500" />
                  </label>
                  <label>
                    Minimum bid increment (₹)
                    <input required type="number" min="0.01" step="0.01" value={form.increment} onChange={(event) => setForm({ ...form, increment: event.target.value })} />
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
                <label>
                  Item photos (up to 5; JPG, PNG or WebP, max 5 MB each)
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    multiple
                    onChange={handlePhotoSelection}
                  />
                </label>
                {photoPreviews.length > 0 && (
                  <div className="photo-preview-grid">
                    {photoPreviews.map((url, index) => (
                      <div className="photo-preview" key={url}>
                        <img src={url} alt={`Selected item photo ${index + 1}`} />
                        <button
                          type="button"
                          aria-label={`Remove photo ${index + 1}`}
                          onClick={() =>
                            setPhotoFiles((previous) =>
                              previous.filter((_, photoIndex) => photoIndex !== index),
                            )
                          }
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="form-notice">
                  Your auction closes after the selected duration. Photos are visible to everyone.
                </div>
                <button
                  className="primary-button full-button"
                  type="submit"
                  disabled={listingBusy}
                >
                  {listingBusy ? "Publishing..." : "Publish auction →"}
                </button>
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
              {itemsLoading && <p className="results-count">Loading your listings...</p>}
              {items.filter((item) => item.sellerId === user?.id).map((item) => (
                <div className="seller-listing" key={item.id}>
                  <ProductCard
                    item={item}
                    now={now}
                    countdown={countdown}
                    onOpen={() => openItem(item)}
                  />
                  <div className="seller-listing-actions">
                    <span className="status-pill">{item.status.replaceAll("_", " ")}</span>
                    {item.status === "PUBLISHED" && (
                      <button
                        className="text-button"
                        disabled={cancellingAuctionId === item.id}
                        onClick={() => cancelListing(item.id)}
                      >
                        {cancellingAuctionId === item.id
                          ? "Cancelling..."
                          : "Cancel auction"}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {!itemsLoading && !itemsError && items.filter((item) => item.sellerId === user?.id).length === 0 && (
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
        <span>Student marketplace · Supabase</span>
      </footer>

      {selectedItem && (
        <div className="modal-backdrop" onClick={() => setSelectedItem(null)}>
          <section className="detail-modal" onClick={(event) => event.stopPropagation()}>
            <button className="modal-close" aria-label="Close" onClick={() => setSelectedItem(null)}>×</button>
            <div className="detail-art" style={{ backgroundColor: selectedItem.color }}>
              {selectedItem.photoUrls.length ? (
                <img src={selectedItem.photoUrls[0]} alt={selectedItem.title} />
              ) : (
                <span>{selectedItem.emoji}</span>
              )}
            </div>
            <div className="detail-content">
              <span className="eyebrow">{selectedItem.category} · {selectedItem.condition}</span>
              <h2>{selectedItem.title}</h2>
              <p>{selectedItem.description}</p>
              <p className="muted">Seller: {selectedItem.seller}</p>
              {selectedItem.photoUrls.length > 1 && (
                <div className="detail-photo-grid">
                  {selectedItem.photoUrls.map((url, index) => (
                    <img key={url} src={url} alt={`${selectedItem.title} photo ${index + 1}`} />
                  ))}
                </div>
              )}
              <div className="detail-price">
                <span>Current leading bid</span>
                <strong>{money(leadingBid(selectedItem))}</strong>
              </div>
              <div className="detail-meta">
                <span>Minimum increment: {money(selectedItem.increment)}</span>
                <span>
                  Closes in: {selectedItem.status === "CANCELLED"
                    ? "Cancelled"
                    : countdown(selectedItem.endsAt)}
                </span>
              </div>
              {selectedItem.status === "CANCELLED" && (
                <p className="form-notice cancellation-notice" role="status">
                  This auction was cancelled by the seller. It is no longer
                  accepting bids; all recorded bids remain in the public history.
                </p>
              )}

              <h3>Public bid history</h3>
              {detailLoading ? (
                <p className="muted">Loading bid history...</p>
              ) : selectedItem.bids.length === 0 ? (
                <p className="muted">No bids yet. Be the first to bid!</p>
              ) : (
                <div className="bid-history">
                  {[...selectedItem.bids].sort((a, b) => b.amount - a.amount).map((bid) => (
                    <div className="bid-history-row" key={bid.id}>
                      <span>{bid.bidderName}</span>
                      <strong>{money(bid.amount)}</strong>
                      <time>{new Date(bid.createdAt).toLocaleString()}</time>
                    </div>
                  ))}
                </div>
              )}

              {selectedItem.status === "PUBLISHED" && now < selectedItem.endsAt ? (
                <form className="bid-form" onSubmit={placeBid}>
                  <label htmlFor="bid-amount">Your bid (₹)</label>
                  <input id="bid-amount" type="number" min={selectedItem.bids.length ? leadingBid(selectedItem) + selectedItem.increment : selectedItem.price} step="0.01" required value={bidAmount} onChange={(event) => setBidAmount(event.target.value)} disabled={bidBusy} />
                  <button className="primary-button full-button" type="submit" disabled={bidBusy}>
                    {bidBusy
                      ? "Placing bid..."
                      : user
                        ? "Place bid →"
                        : "Sign in to place a bid →"}
                  </button>
                </form>
              ) : (
                <p className="form-notice">This auction is no longer accepting bids.</p>
              )}
              {isSelectedAuctionOwner && (
                <div className="seller-delete-section">
                  {selectedDeletionPending ? (
                    <>
                      <p className="form-notice">
                        Photo cleanup is pending. You can retry deleting this listing.
                      </p>
                      <button
                        className="delete-listing-button"
                        type="button"
                        disabled={deletingAuctionId === selectedItem.id}
                        onClick={() => deleteListing(selectedItem)}
                      >
                        {deletingAuctionId === selectedItem.id
                          ? "Finishing deletion..."
                          : "Retry delete listing"}
                      </button>
                    </>
                  ) : selectedItem.status === "PUBLISHED" ? (
                    <>
                      {selectedItem.bids.length > 0 && (
                        <p className="form-notice">
                          This auction has bids. Details and photos cannot be
                          changed after bidding starts. If the item identity or
                          essential information is wrong, cancel this auction
                          and publish a corrected listing. Existing bids will
                          remain in history and bidders will be notified.
                        </p>
                      )}
                      {selectedItem.bids.length === 0 &&
                        now < selectedItem.endsAt &&
                        !detailLoading && (
                          <div className="photo-replacement">
                            <label>
                              Correct listing photos (before the first bid)
                              <input
                                type="file"
                                accept="image/jpeg,image/png,image/webp"
                                multiple
                                onChange={handleReplacementPhotoSelection}
                              />
                            </label>
                            {replacementPhotoFiles.length > 0 && (
                              <>
                                <p className="muted">
                                  The following will replace all current photos:
                                </p>
                                <ul>
                                  {replacementPhotoFiles.map((file) => (
                                    <li key={`${file.name}-${file.lastModified}`}>
                                      {file.name}
                                    </li>
                                  ))}
                                </ul>
                                <button
                                  className="secondary-button"
                                  type="button"
                                  disabled={replacementPhotosBusy}
                                  onClick={() => replaceListingPhotos(selectedItem)}
                                >
                                  {replacementPhotosBusy
                                    ? "Replacing photos..."
                                    : "Replace listing photos"}
                                </button>
                                <button
                                  className="text-button"
                                  type="button"
                                  disabled={replacementPhotosBusy}
                                  onClick={() => setReplacementPhotoFiles([])}
                                >
                                  Clear selection
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      <button
                        className="cancel-listing-button"
                        type="button"
                        disabled={cancellingAuctionId === selectedItem.id}
                        onClick={() => cancelListing(selectedItem.id)}
                      >
                        {cancellingAuctionId === selectedItem.id
                          ? "Cancelling auction..."
                          : "Cancel auction"}
                      </button>
                      {detailLoading ? (
                        <button className="delete-listing-button" type="button" disabled>
                          Checking whether this listing can be deleted...
                        </button>
                      ) : selectedAuctionEligibleForDeletion ? (
                        <button
                          className="delete-listing-button"
                          type="button"
                          disabled={deletingAuctionId === selectedItem.id}
                          onClick={() => deleteListing(selectedItem)}
                        >
                          {deletingAuctionId === selectedItem.id
                            ? "Deleting listing..."
                            : "Delete listing"}
                        </button>
                      ) : selectedItem.bids.length === 0 && now < selectedItem.endsAt ? null : (
                        <p className="form-notice">
                          Physical deletion is available only for unexpired
                          listings with no bids. Use cancellation to preserve
                          this auction's history.
                        </p>
                      )}
                    </>
                  ) : selectedItem.status !== "CANCELLED" ? (
                    <p className="form-notice">
                      This auction is {selectedItem.status.toLowerCase()} and
                      cannot be cancelled through the ordinary seller action.
                      Approved results and handovers need a separate resolution
                      workflow.
                    </p>
                  ) : detailLoading ? (
                    <button className="delete-listing-button" type="button" disabled>
                      Checking deletion status...
                    </button>
                  ) : (
                    <p className="form-notice">This listing is already cancelled.</p>
                  )}
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function ProductCard({ item, now, countdown, onOpen }) {
  const price = leadingBid(item);
  const cancelled = item.status === "CANCELLED";
  const closed = cancelled || now >= item.endsAt;

  return (
    <article className="product-card">
      <button className="product-image" style={{ backgroundColor: item.color }} onClick={onOpen} aria-label={`View ${item.title}`}>
        <span className="condition-pill">{item.condition}</span>
        {cancelled && <span className="cancelled-pill">Cancelled</span>}
        {item.photoUrls[0] ? (
          <img className="product-photo" src={item.photoUrls[0]} alt="" />
        ) : (
          <span className="product-emoji">{item.emoji}</span>
        )}
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
              {cancelled ? "Cancelled" : closed ? "Closed" : countdown(item.endsAt)}
            </strong>
          </div>
        </div>
        <button className="secondary-button" onClick={onOpen}>View auction →</button>
      </div>
    </article>
  );
}

export default App;
