
import { useEffect, useMemo, useRef, useState } from "react";
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
const maxAuctionDurationMinutes = 30 * 24 * 60;
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

function getSavedSearchLabel(savedSearch) {
  const criteria = [
    savedSearch.keywords,
    savedSearch.category,
    savedSearch.max_price == null
      ? null
      : `up to ${money(savedSearch.max_price)} starting price`,
  ].filter(Boolean);

  return criteria.join(" · ");
}

function normalizeSavedSearchDraft(draft) {
  const keywords = String(draft.keywords || "").trim();
  const category =
    draft.category && draft.category !== "All" ? draft.category : null;
  const maxPriceInput = String(draft.maxPrice || "").trim();

  if (keywords.length > 200) {
    return { error: "Keywords must be 200 characters or fewer." };
  }
  if (category && !categories.includes(category)) {
    return { error: "Choose a valid category." };
  }

  let maxPrice = null;
  if (maxPriceInput) {
    if (!/^\d+(?:\.\d{1,2})?$/.test(maxPriceInput)) {
      return { error: "Enter a valid maximum starting price." };
    }

    maxPrice = Number(maxPriceInput);
    if (
      !Number.isFinite(maxPrice) ||
      maxPrice <= 0 ||
      maxPrice > 9999999999.99
    ) {
      return { error: "Maximum starting price must be greater than zero." };
    }
  }

  if (!keywords && !category && maxPrice === null) {
    return {
      error: "Add keywords, choose a category, or enter a maximum price.",
    };
  }

  return {
    values: {
      keywords: keywords || null,
      category,
      max_price: maxPrice,
    },
  };
}

function leadingBid(item) {
  return item.bids.length
    ? Math.max(...item.bids.map((bid) => bid.amount))
    : item.price;
}

function minimumNextBid(item) {
  return item.bids.length
    ? leadingBid(item) + item.increment
    : Math.max(2, item.price + 0.01);
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

async function fetchListings({ mode = "active", sellerId } = {}) {
  let auctionQuery = supabase
    .from("auctions")
    .select(
      "id, seller_id, title, description, category, item_condition, starting_price, min_increment, closes_at, photo_paths, status",
    );

  if (mode === "active") {
    auctionQuery = auctionQuery
      .eq("status", "published")
      .gt("closes_at", new Date().toISOString());
  } else if (mode === "seller") {
    if (!sellerId) throw new Error("Sign in to load your listings.");
    auctionQuery = auctionQuery
      .eq("seller_id", sellerId)
      .neq("status", "cancelled");
  } else {
    throw new Error("Unsupported auction listing query.");
  }

  const { data: auctionRows, error: auctionsError } =
    await auctionQuery.order("closes_at", { ascending: true });

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

async function fetchListingById(auctionId) {
  const { data: auction, error: auctionError } = await supabase
    .from("auctions")
    .select(
      "id, seller_id, title, description, category, item_condition, starting_price, min_increment, closes_at, photo_paths, status",
    )
    .eq("id", auctionId)
    .maybeSingle();

  if (auctionError) throw auctionError;
  if (!auction) return null;

  const [bidsResult, profileResult, photoUrlsByPath] = await Promise.all([
    supabase
      .from("public_bid_history")
      .select("bid_id, auction_id, amount, created_at, auction_status")
      .eq("auction_id", auctionId)
      .order("created_at", { ascending: false }),
    supabase
      .from("profiles")
      .select("display_name")
      .eq("id", auction.seller_id)
      .maybeSingle(),
    createPhotoUrlMap(auction.photo_paths || []),
  ]);

  if (bidsResult.error) throw bidsResult.error;
  if (profileResult.error) throw profileResult.error;

  return mapAuction(
    { ...auction, seller_name: profileResult.data?.display_name },
    (bidsResult.data || []).map(mapBid),
    photoUrlsByPath,
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
  const listingRequestId = useRef(0);
  const contactRequestId = useRef(0);
  const notificationControlRef = useRef(null);
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
  const [auctionContact, setAuctionContact] = useState(null);
  const [auctionContactLoading, setAuctionContactLoading] = useState(false);
  const [auctionContactError, setAuctionContactError] = useState("");
  const [resultActionBusy, setResultActionBusy] = useState(false);
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
  const [notifications, setNotifications] = useState([]);
  const [notificationsOwnerId, setNotificationsOwnerId] = useState(null);
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const [notificationsError, setNotificationsError] = useState("");
  const [notificationsErrorOwnerId, setNotificationsErrorOwnerId] = useState(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notificationActionBusy, setNotificationActionBusy] = useState(false);
  const [notificationRefresh, setNotificationRefresh] = useState(0);
  const [savedSearches, setSavedSearches] = useState([]);
  const [savedSearchesOwnerId, setSavedSearchesOwnerId] = useState(null);
  const [savedSearchesLoading, setSavedSearchesLoading] = useState(false);
  const [savedSearchesError, setSavedSearchesError] = useState("");
  const [savedSearchesErrorOwnerId, setSavedSearchesErrorOwnerId] =
    useState(null);
  const [savedSearchRefresh, setSavedSearchRefresh] = useState(0);
  const [savedSearchBusyId, setSavedSearchBusyId] = useState(null);
  const [savedSearchEditor, setSavedSearchEditor] = useState(null);
  const [chatConversations, setChatConversations] = useState([]);
  const [chatConversationsLoading, setChatConversationsLoading] = useState(false);
  const [chatConversationId, setChatConversationId] = useState(null);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatMessagesLoading, setChatMessagesLoading] = useState(false);
  const [chatError, setChatError] = useState("");
  const [chatDraft, setChatDraft] = useState("");
  const [chatRequestKey, setChatRequestKey] = useState(null);
  const [chatSending, setChatSending] = useState(false);
  const [chatFeedback, setChatFeedback] = useState(null);
  const [chatRefresh, setChatRefresh] = useState(0);
  const [automaticBidConfig, setAutomaticBidConfig] = useState(null);
  const [automaticBidConfigAuctionId, setAutomaticBidConfigAuctionId] =
    useState(null);
  const [automaticBidLoading, setAutomaticBidLoading] = useState(false);
  const [automaticBidBusy, setAutomaticBidBusy] = useState(false);
  const [automaticBidDraft, setAutomaticBidDraft] = useState("");
  const [automaticBidConsent, setAutomaticBidConsent] = useState(false);
  const [automaticBidError, setAutomaticBidError] = useState("");
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
    startingPrice: "",
    increment: "50",
    durationMinutes: "1440",
    customDurationMinutes: "",
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
      if (!session?.user) {
        setNotifications([]);
        setNotificationsOwnerId(null);
        setNotificationsLoading(false);
        setNotificationsError("");
        setNotificationsErrorOwnerId(null);
        setNotificationsOpen(false);
      }
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
      const requestId = listingRequestId.current;
      setItemsLoading(true);
      setItemsError("");
      try {
        const listings = await fetchListings();
        if (active && requestId === listingRequestId.current) {
          setItems(listings);
        }
      } catch (error) {
        console.error("Could not load Supabase auctions.", error);
        if (active && requestId === listingRequestId.current) {
          setItemsError("Auctions could not be loaded. Please try again.");
        }
      } finally {
        if (active && requestId === listingRequestId.current) {
          setItemsLoading(false);
        }
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
    if (!items.length) return undefined;
    let active = true;
    const auctionIds = items.map((item) => item.id);

    const interval = setInterval(async () => {
      let currentAuctionsQuery = supabase
        .from("auctions")
        .select("id, closes_at")
        .in("id", auctionIds);

      if (page === "my-listings" && currentUserId) {
        currentAuctionsQuery = currentAuctionsQuery
          .eq("seller_id", currentUserId)
          .neq("status", "cancelled");
      } else {
        currentAuctionsQuery = currentAuctionsQuery
          .eq("status", "published")
          .gt("closes_at", new Date().toISOString());
      }

      const { data, error } = await currentAuctionsQuery;

      if (!active) return;
      if (error) {
        console.error("Could not reconcile cached auction listings.", error);
        return;
      }

      const existingIds = new Set((data || []).map((auction) => auction.id));
      const deletedIds = new Set(
        auctionIds.filter((auctionId) => !existingIds.has(auctionId)),
      );
      const currentEndsAt = new Map(
        (data || []).map((auction) => [
          auction.id,
          new Date(auction.closes_at).getTime(),
        ]),
      );

      setItems((previous) => {
        let changed = false;
        const next = previous
          .filter((item) => !deletedIds.has(item.id))
          .map((item) => {
            const endsAt = currentEndsAt.get(item.id);
            if (endsAt === undefined || endsAt === item.endsAt) return item;
            changed = true;
            return { ...item, endsAt };
          });
        if (next.length !== previous.length) changed = true;
        return changed ? next : previous;
      });
      setSelectedItem((current) =>
        current
          ? deletedIds.has(current.id)
            ? null
            : currentEndsAt.has(current.id) &&
                currentEndsAt.get(current.id) !== current.endsAt
              ? { ...current, endsAt: currentEndsAt.get(current.id) }
              : current
          : null,
      );
    }, 5000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [currentUserId, items, page]);

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

    if (!currentUserId) return undefined;

    async function loadNotifications() {
      setNotificationsLoading(true);
      const { data, error } = await supabase
        .from("notifications")
        .select("id, notification_type, message, is_read, created_at, auction_id")
        .eq("user_id", currentUserId)
        .order("created_at", { ascending: false })
        .limit(50);

      if (!active) return;
      if (error) {
        console.error("Could not load notifications.", error);
        setNotificationsError("Notifications could not be loaded. Please try again.");
        setNotificationsErrorOwnerId(currentUserId);
      } else {
        setNotifications(data || []);
        setNotificationsOwnerId(currentUserId);
        setNotificationsError("");
        setNotificationsErrorOwnerId(null);
      }
      setNotificationsLoading(false);
    }

    void loadNotifications();
    const interval = setInterval(() => {
      void loadNotifications();
    }, 30000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [currentUserId, notificationRefresh]);

  useEffect(() => {
    let active = true;

    if (!currentUserId) return undefined;

    async function loadSavedSearches() {
      setSavedSearchesLoading(true);
      setSavedSearchesError("");
      setSavedSearchesErrorOwnerId(null);

      try {
        const { data, error } = await supabase
          .from("saved_searches")
          .select("id, keywords, category, max_price, created_at")
          .eq("user_id", currentUserId)
          .order("created_at", { ascending: false });

        if (error) throw error;
        if (!active) return;

        setSavedSearches(data || []);
        setSavedSearchesOwnerId(currentUserId);
      } catch (error) {
        if (!active) return;
        console.error("Could not load saved searches.", error);
        setSavedSearchesError(
          "Saved searches could not be loaded. Please try again.",
        );
        setSavedSearchesErrorOwnerId(currentUserId);
      } finally {
        if (active) setSavedSearchesLoading(false);
      }
    }

    void loadSavedSearches();
    return () => {
      active = false;
    };
  }, [currentUserId, savedSearchRefresh]);

  useEffect(() => {
    let active = true;
    const auctionId = selectedItem?.id;

    if (
      !auctionId ||
      !currentUserId ||
      selectedItem?.sellerId === currentUserId ||
      selectedItem?.status !== "PUBLISHED" ||
      Date.now() >= selectedItem?.endsAt
    ) {
      return undefined;
    }

    async function loadAutomaticBidConfig() {
      setAutomaticBidLoading(true);
      setAutomaticBidError("");
      try {
        const { data, error } = await supabase.rpc(
          "get_my_automatic_bid",
          { p_auction_id: auctionId },
        );
        if (error) throw error;
        if (!active) return;

        const config = data?.[0] || null;
        setAutomaticBidConfig(config);
        setAutomaticBidConfigAuctionId(auctionId);
        setAutomaticBidDraft(
          config?.max_amount == null ? "" : String(config.max_amount),
        );
        setAutomaticBidConsent(false);
      } catch (error) {
        if (!active) return;
        console.error("Could not load automatic-bid settings.", error);
        setAutomaticBidConfig(null);
        setAutomaticBidConfigAuctionId(auctionId);
        setAutomaticBidDraft("");
        setAutomaticBidError(
          "Automatic-bid settings could not be loaded. Check that migration 019 is installed and try again.",
        );
      } finally {
        if (active) setAutomaticBidLoading(false);
      }
    }

    void loadAutomaticBidConfig();
    return () => {
      active = false;
    };
  }, [
    currentUserId,
    selectedItem?.id,
    selectedItem?.sellerId,
    selectedItem?.status,
    selectedItem?.endsAt,
  ]);

  useEffect(() => {
    let active = true;
    const auctionId = selectedItem?.id;
    const auctionSellerId = selectedItem?.sellerId;
    const auctionStatus = selectedItem?.status;
    const auctionEndsAt = selectedItem?.endsAt;

    if (!auctionId || !currentUserId) return undefined;

    if (
      auctionStatus !== "PUBLISHED" ||
      Date.now() >= auctionEndsAt
    ) {
      return undefined;
    }

    async function loadSellerConversations() {
      setChatConversationsLoading(true);
      try {
        const { data, error } = await supabase.rpc(
          "list_auction_chat_conversations",
          { p_auction_id: auctionId },
        );
        if (error) throw error;
        if (!active) return;

        const conversations = data || [];
        setChatConversations(conversations);
        setChatConversationId((current) =>
          conversations.some((entry) => entry.conversation_id === current)
            ? current
            : conversations[0]?.conversation_id || null,
        );
        setChatError("");
      } catch (error) {
        if (!active) return;
        console.error("Could not load auction chat conversations.", error);
        setChatError(
          typeof error?.message === "string" && error.message.trim()
            ? error.message
            : "Conversations could not be loaded. Please try again.",
        );
      } finally {
        if (active) setChatConversationsLoading(false);
      }
    }

    async function openBuyerConversation() {
      setChatConversationsLoading(true);
      try {
        const { data, error } = await supabase.rpc("open_auction_chat", {
          p_auction_id: auctionId,
        });
        if (error) throw error;
        if (!active) return;

        const conversationId = data?.[0]?.conversation_id;
        if (!conversationId) {
          throw new Error("The conversation could not be opened.");
        }
        setChatConversationId(conversationId);
        setChatError("");
      } catch (error) {
        if (!active) return;
        console.error("Could not open the auction chat.", error);
        setChatError(
          typeof error?.message === "string" && error.message.trim()
            ? error.message
            : "Chat could not be opened. Please try again.",
        );
      } finally {
        if (active) setChatConversationsLoading(false);
      }
    }

    const loadConversation = auctionSellerId === currentUserId
      ? loadSellerConversations
      : openBuyerConversation;

    void loadConversation();
    const interval = setInterval(() => {
      if (Date.now() >= auctionEndsAt) {
        clearInterval(interval);
        return;
      }
      void loadConversation();
    }, 20000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [
    selectedItem?.id,
    selectedItem?.sellerId,
    selectedItem?.status,
    selectedItem?.endsAt,
    currentUserId,
  ]);

  useEffect(() => {
    let active = true;
    let firstLoad = true;
    const auctionId = selectedItem?.id;
    const auctionEndsAt = selectedItem?.endsAt;
    const conversationId = chatConversationId;

    if (!auctionId || !conversationId || !currentUserId) return undefined;

    async function loadMessages() {
      try {
        if (firstLoad) setChatMessagesLoading(true);
        const { data, error } = await supabase.rpc("read_auction_chat", {
          p_conversation_id: conversationId,
        });
        if (error) throw error;
        if (active) {
          setChatMessages(data || []);
          setChatError("");
        }
      } catch (error) {
        if (!active) return;
        console.error("Could not load auction chat messages.", error);
        setChatError(
          typeof error?.message === "string" && error.message.trim()
            ? error.message
            : "Messages could not be loaded. Please try again.",
        );
      } finally {
        firstLoad = false;
        if (active) setChatMessagesLoading(false);
      }
    }

    void loadMessages();
    const interval = setInterval(() => {
      if (Date.now() >= auctionEndsAt) {
        clearInterval(interval);
        return;
      }
      void loadMessages();
    }, 12000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [
    selectedItem?.id,
    selectedItem?.endsAt,
    chatConversationId,
    currentUserId,
    chatRefresh,
  ]);

  useEffect(() => {
    function handleNotificationDismiss(event) {
      if (!notificationControlRef.current?.contains(event.target)) {
        setNotificationsOpen(false);
      }
    }

    function handleNotificationEscape(event) {
      if (event.key === "Escape") setNotificationsOpen(false);
    }

    document.addEventListener("pointerdown", handleNotificationDismiss);
    document.addEventListener("keydown", handleNotificationEscape);
    return () => {
      document.removeEventListener("pointerdown", handleNotificationDismiss);
      document.removeEventListener("keydown", handleNotificationEscape);
    };
  }, []);

  function flash(message) {
    setNotice(message);
    setTimeout(() => setNotice(""), 3500);
  }

  async function markNotificationRead(notificationId) {
    if (!currentUserId) return;

    setNotificationActionBusy(true);
    try {
      const { error } = await supabase
        .from("notifications")
        .update({ is_read: true })
        .eq("id", notificationId)
        .eq("user_id", currentUserId)
        .eq("is_read", false);

      if (error) throw error;
      setNotifications((previous) =>
        previous.map((entry) =>
          entry.id === notificationId ? { ...entry, is_read: true } : entry,
        ),
      );
    } catch (error) {
      console.error("Could not mark notification as read.", error);
      flash("This notification could not be marked as read.");
    } finally {
      setNotificationActionBusy(false);
    }
  }

  async function markAllNotificationsRead() {
    if (!currentUserId) return;

    setNotificationActionBusy(true);
    try {
      const { error } = await supabase
        .from("notifications")
        .update({ is_read: true })
        .eq("user_id", currentUserId)
        .eq("is_read", false);

      if (error) throw error;
      setNotifications((previous) =>
        previous.map((entry) => ({ ...entry, is_read: true })),
      );
    } catch (error) {
      console.error("Could not mark all notifications as read.", error);
      flash("Notifications could not be marked as read.");
    } finally {
      setNotificationActionBusy(false);
    }
  }

  async function sendAuctionChatMessage(event) {
    event.preventDefault();
    if (chatSending || !chatConversationId || !selectedItem) return;

    const message = chatDraft.trim();
    if (!message || message.length > 500) {
      setChatFeedback({
        kind: "error",
        message: "Enter a message using 1 to 500 characters.",
      });
      return;
    }

    if (!user) {
      setChatFeedback({
        kind: "error",
        message: "Sign in before sending a message.",
      });
      return;
    }

    const requestKey = chatRequestKey || crypto.randomUUID();
    setChatRequestKey(requestKey);
    setChatSending(true);
    setChatFeedback(null);
    try {
      const { error } = await supabase.rpc("send_auction_chat_message", {
        p_conversation_id: chatConversationId,
        p_message: message,
        p_idempotency_key: requestKey,
      });
      if (error) throw error;

      setChatDraft("");
      setChatRequestKey(null);
      setChatFeedback({ kind: "success", message: "Message sent." });
      setChatRefresh((count) => count + 1);
      setNotificationRefresh((count) => count + 1);
    } catch (error) {
      console.error("Could not send an auction chat message.", error);
      setChatFeedback({
        kind: "error",
        message:
          typeof error?.message === "string" && error.message.trim()
            ? error.message
            : "Your message could not be sent. Please try again.",
      });
    } finally {
      setChatSending(false);
    }
  }

  async function refreshListings(mode = "active") {
    const requestId = ++listingRequestId.current;
    setItemsLoading(true);
    setItemsError("");
    try {
      const listings = await fetchListings({
        mode,
        sellerId: mode === "seller" ? user?.id : undefined,
      });
      if (requestId !== listingRequestId.current) return;
      setItems(listings);
      setSelectedItem((current) =>
        current && !listings.some((item) => item.id === current.id)
          ? null
          : current,
      );
    } catch (error) {
      if (requestId !== listingRequestId.current) return;
      console.error("Could not refresh Supabase auctions.", error);
      setItemsError("Auctions could not be refreshed. Please try again.");
    } finally {
      if (requestId === listingRequestId.current) setItemsLoading(false);
    }
  }

  function go(nextPage) {
    setSelectedItem(null);
    setPage(nextPage);
    setNotice("");
    const listingMode =
      nextPage === "my-listings"
        ? "seller"
        : ["home", "browse"].includes(nextPage)
          ? "active"
          : null;
    if (listingMode) {
      void refreshListings(listingMode);
    } else {
      listingRequestId.current += 1;
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function requestLogin(intent) {
    setAuthIntent(intent);
    setAuthMode("signin");
    setPage("login");
  }

  async function saveCurrentSearch() {
    if (!user) {
      requestLogin("buy");
      return;
    }

    const normalized = normalizeSavedSearchDraft({
      keywords: search,
      category,
      maxPrice,
    });
    if (normalized.error) {
      flash(normalized.error);
      return;
    }

    setSavedSearchBusyId("create");
    try {
      const { data, error } = await supabase
        .from("saved_searches")
        .insert(normalized.values)
        .select("id, keywords, category, max_price, created_at")
        .single();

      if (error) {
        if (error.code === "23505") {
          throw new Error("You already have an equivalent saved search.");
        }
        throw error;
      }

      setSavedSearches((previous) => [data, ...previous]);
      setSavedSearchesOwnerId(user.id);
      flash("Search saved. Matching new auctions will appear in notifications.");
    } catch (error) {
      console.error("Could not save search.", error);
      flash(
        typeof error?.message === "string"
          ? error.message
          : "This search could not be saved. Please try again.",
      );
    } finally {
      setSavedSearchBusyId(null);
    }
  }

  function editSavedSearch(savedSearch) {
    setSavedSearchesError("");
    setSavedSearchEditor({
      id: savedSearch.id,
      keywords: savedSearch.keywords || "",
      category: savedSearch.category || "All",
      maxPrice:
        savedSearch.max_price == null ? "" : String(savedSearch.max_price),
    });
  }

  async function updateSavedSearch(event) {
    event.preventDefault();
    if (!user || !savedSearchEditor) return;

    const normalized = normalizeSavedSearchDraft(savedSearchEditor);
    if (normalized.error) {
      flash(normalized.error);
      return;
    }

    const savedSearchId = savedSearchEditor.id;
    setSavedSearchBusyId(savedSearchId);
    try {
      const { data, error } = await supabase
        .from("saved_searches")
        .update(normalized.values)
        .eq("id", savedSearchId)
        .eq("user_id", user.id)
        .select("id, keywords, category, max_price, created_at")
        .single();

      if (error) {
        if (error.code === "23505") {
          throw new Error("You already have an equivalent saved search.");
        }
        throw error;
      }

      setSavedSearches((previous) =>
        previous.map((entry) => (entry.id === data.id ? data : entry)),
      );
      setSavedSearchEditor(null);
      flash("Saved search updated.");
    } catch (error) {
      console.error("Could not update saved search.", error);
      flash(
        typeof error?.message === "string"
          ? error.message
          : "This search could not be updated. Please try again.",
      );
    } finally {
      setSavedSearchBusyId(null);
    }
  }

  async function deleteSavedSearch(savedSearch) {
    if (!user || savedSearchBusyId) return;
    if (
      !window.confirm(
        `Delete the saved search "${getSavedSearchLabel(savedSearch)}"?`,
      )
    ) {
      return;
    }

    setSavedSearchBusyId(savedSearch.id);
    try {
      const { data, error } = await supabase
        .from("saved_searches")
        .delete()
        .eq("id", savedSearch.id)
        .eq("user_id", user.id)
        .select("id")
        .maybeSingle();

      if (error) throw error;
      if (!data) throw new Error("This saved search could not be found.");

      setSavedSearches((previous) =>
        previous.filter((entry) => entry.id !== savedSearch.id),
      );
      if (savedSearchEditor?.id === savedSearch.id) {
        setSavedSearchEditor(null);
      }
      flash("Saved search deleted.");
    } catch (error) {
      console.error("Could not delete saved search.", error);
      flash(
        typeof error?.message === "string"
          ? error.message
          : "This search could not be deleted. Please try again.",
      );
    } finally {
      setSavedSearchBusyId(null);
    }
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

  async function openItem(item, { allowClosed = false } = {}) {
    const contactRequest = ++contactRequestId.current;
    setSelectedItem(null);
    setChatConversations([]);
    setChatConversationId(null);
    setChatMessages([]);
    setChatConversationsLoading(false);
    setChatMessagesLoading(false);
    setChatError("");
    setChatDraft("");
    setChatRequestKey(null);
    setChatFeedback(null);
    setAutomaticBidConfig(null);
    setAutomaticBidConfigAuctionId(null);
    setAutomaticBidLoading(false);
    setAutomaticBidDraft("");
    setAutomaticBidConsent(false);
    setAutomaticBidError("");
    setAuctionContact(null);
    setAuctionContactError("");
    setAuctionContactLoading(false);
    setDetailLoading(true);
    try {
      const latestItem = await fetchListingById(item.id);
      if (!latestItem) {
        setItems((previous) =>
          previous.filter((entry) => entry.id !== item.id),
        );
        setSelectedItem((current) =>
          current?.id === item.id ? null : current,
        );
        flash("This auction is no longer available.");
        return;
      }

      const onBuyerScreen = ["home", "browse"].includes(page);
      if (
        onBuyerScreen &&
        !allowClosed &&
        (latestItem.status !== "PUBLISHED" || latestItem.endsAt <= Date.now())
      ) {
        setItems((previous) =>
          previous.filter((entry) => entry.id !== item.id),
        );
        flash("This auction is no longer open for bidding.");
        return;
      }

      setItems((previous) =>
        previous.map((entry) => (entry.id === item.id ? latestItem : entry)),
      );
      setSelectedItem(latestItem);
      setBidAmount(String(minimumNextBid(latestItem)));

      if (
        user &&
        ["APPROVED", "COMPLETED"].includes(latestItem.status)
      ) {
        setAuctionContactLoading(true);
        try {
          const { data, error } = await supabase.rpc("get_auction_contact", {
            p_auction_id: item.id,
          });
          if (contactRequest !== contactRequestId.current) return;
          if (error) throw error;

          const contact = data?.[0];
          setAuctionContact(
            contact
              ? {
                  auctionId: item.id,
                  email: contact.contact_email,
                  displayName: contact.contact_display_name,
                  role: contact.contact_role,
                }
              : null,
          );
          if (!contact) {
            setAuctionContactError(
              "Contact details are available only to the seller and approved winning bidder.",
            );
          }
        } catch (error) {
          if (contactRequest !== contactRequestId.current) return;
          console.error("Could not retrieve approved auction contact details.", error);
          setAuctionContactError("Contact details could not be loaded. Please try again.");
        } finally {
          if (contactRequest === contactRequestId.current) {
            setAuctionContactLoading(false);
          }
        }
      }
    } catch (error) {
      console.error("Could not load the latest auction details.", error);
      flash("Auction details could not be verified. Please try again.");
    } finally {
      if (contactRequest === contactRequestId.current) {
        setDetailLoading(false);
      }
    }
  }

  async function openNotificationAuction(notification) {
    if (!notification.auction_id) {
      flash("This auction is no longer available.");
      return;
    }

    await markNotificationRead(notification.id);
    setNotificationsOpen(false);
    await openItem(
      { id: notification.auction_id },
      { allowClosed: true },
    );
  }

  async function closeAuctionForReview(item) {
    if (resultActionBusy) return;

    setResultActionBusy(true);
    try {
      const { error } = await supabase.rpc("close_auction_for_review", {
        p_auction_id: item.id,
      });
      if (error) throw error;

      setNotificationRefresh((count) => count + 1);
      await openItem({ id: item.id }, { allowClosed: true });
      flash("Auction result is ready for your review.");
    } catch (error) {
      console.error("Could not close auction for result review.", error);
      flash(
        typeof error?.message === "string"
          ? error.message
          : "Auction result could not be opened for review.",
      );
    } finally {
      setResultActionBusy(false);
    }
  }

  async function decideAuctionResult(item, approve) {
    if (resultActionBusy) return;

    setResultActionBusy(true);
    try {
      const { error } = await supabase.rpc("decide_auction_result", {
        p_auction_id: item.id,
        p_approve: approve,
      });
      if (error) throw error;

      setNotificationRefresh((count) => count + 1);
      await openItem({ id: item.id }, { allowClosed: true });
      flash(
        approve
          ? "Result approved. Both parties can now view each other's contact email."
          : "Result rejected. Contact details remain private.",
      );
    } catch (error) {
      console.error("Could not save the auction result decision.", error);
      flash(
        typeof error?.message === "string"
          ? error.message
          : "Your result decision could not be saved.",
      );
    } finally {
      setResultActionBusy(false);
    }
  }

  async function saveAutomaticBid() {
    if (!user || !selectedItem || automaticBidBusy) return;

    if (!automaticBidConsent) {
      setAutomaticBidError(
        "Confirm that you authorize automatic bids up to the amount shown.",
      );
      return;
    }

    const rawMaximum = automaticBidDraft.trim();
    const maximum = Number(rawMaximum);
    if (
      !/^\d+(?:\.\d{1,2})?$/.test(rawMaximum) ||
      !Number.isFinite(maximum) ||
      maximum <= 0 ||
      maximum > 9999999999.99
    ) {
      setAutomaticBidError(
        "Enter a positive maximum amount with at most two decimal places.",
      );
      return;
    }

    const approved = window.confirm(
      `Enable automatic bidding for "${selectedItem.title}" with a maximum of ${money(maximum)}?\n\nCampus Auction may place bids automatically while this auction is eligible, and will never bid above this amount. You can disable automatic bidding from this auction's details at any time.`,
    );
    if (!approved) return;

    setAutomaticBidBusy(true);
    setAutomaticBidError("");
    try {
      const { data, error } = await supabase.rpc(
        "configure_automatic_bid",
        {
          p_auction_id: selectedItem.id,
          p_max_amount: rawMaximum,
        },
      );
      if (error) throw error;

      const config = data?.[0];
      if (!config) {
        throw new Error("The automatic-bid configuration was not returned.");
      }

      setAutomaticBidConfig(config);
      setAutomaticBidConfigAuctionId(selectedItem.id);
      setAutomaticBidDraft(String(config.max_amount));
      setAutomaticBidConsent(false);
      setNotificationRefresh((refresh) => refresh + 1);
      flash("Automatic bidding is configured for this auction.");
    } catch (error) {
      console.error("Could not configure automatic bidding.", error);
      setAutomaticBidError(
        typeof error?.message === "string" && error.message.trim()
          ? error.message
          : "Automatic bidding could not be configured. Please try again.",
      );
    } finally {
      setAutomaticBidBusy(false);
    }
  }

  async function disableAutomaticBid() {
    if (!user || !selectedItem || automaticBidBusy) return;

    if (
      !window.confirm(
        `Disable automatic bidding for "${selectedItem.title}"? No further automatic bids will be placed.`,
      )
    ) {
      return;
    }

    setAutomaticBidBusy(true);
    setAutomaticBidError("");
    try {
      const { data, error } = await supabase.rpc(
        "disable_automatic_bid",
        { p_auction_id: selectedItem.id },
      );
      if (error) throw error;
      if (!data) {
        throw new Error("Automatic bidding was not active for this auction.");
      }

      setAutomaticBidConfig((previous) =>
        previous ? { ...previous, is_active: false } : previous,
      );
      setAutomaticBidConsent(false);
      flash("Automatic bidding is disabled.");
    } catch (error) {
      console.error("Could not disable automatic bidding.", error);
      setAutomaticBidError(
        typeof error?.message === "string" && error.message.trim()
          ? error.message
          : "Automatic bidding could not be disabled. Please try again.",
      );
    } finally {
      setAutomaticBidBusy(false);
    }
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

    const minimum = minimumNextBid(item);

    if (
      !Number.isFinite(amount) ||
      amount <= 1 ||
      amount <= leadingBid(item) ||
      amount < minimum ||
      !/^\d+(?:\.\d{1,2})?$/.test(bidAmount.trim())
    ) {
      flash(`Your minimum valid bid is ${money(minimum)}.`);
      return;
    }

    setBidBusy(true);
    let error;
    try {
      ({ error } = await supabase.rpc("place_bid", {
        p_auction_id: item.id,
        p_amount: bidAmount.trim(),
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
      const [historyResult, auctionResult] = await Promise.all([
        supabase
          .from("public_bid_history")
          .select("bid_id, auction_id, amount, created_at, auction_status")
          .eq("auction_id", item.id)
          .order("created_at", { ascending: false }),
        supabase
          .from("auctions")
          .select("closes_at")
          .eq("id", item.id)
          .single(),
      ]);
      const { data, error: historyError } = historyResult;
      const { data: auctionData, error: auctionError } = auctionResult;
      if (historyError) throw historyError;
      if (auctionError) throw auctionError;

      const bids = (data || []).map(mapBid);
      const updatedItem = {
        ...item,
        bids,
        endsAt: new Date(auctionData.closes_at).getTime(),
      };
      setItems((previous) =>
        previous.map((entry) => (entry.id === item.id ? updatedItem : entry)),
      );
      setSelectedItem(updatedItem);
      setBidAmount(String(minimumNextBid(updatedItem)));
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

    const price = Number(form.startingPrice);
    const increment = Number(form.increment);
    const durationMinutes =
      form.durationMinutes === "custom"
        ? Number(form.customDurationMinutes)
        : Number(form.durationMinutes);

    if (
      !form.title.trim() ||
      !form.description.trim() ||
      !Number.isFinite(price) ||
      price <= 0 ||
      price > 9999999999.99 ||
      !/^\d+(?:\.\d{1,2})?$/.test(form.startingPrice) ||
      !Number.isFinite(increment) ||
      increment <= 0 ||
      !Number.isInteger(durationMinutes) ||
      durationMinutes < 1 ||
      durationMinutes > maxAuctionDurationMinutes ||
      photoFiles.length > 5
    ) {
      flash("Enter a starting price and valid item details, increment, and duration.");
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

      const closesAt = new Date(
        Date.now() + durationMinutes * 60 * 1000,
      ).toISOString();
      const listingData = {
        title: form.title.trim(),
        description: form.description.trim(),
        category: form.category,
        item_condition: form.condition,
        starting_price: form.startingPrice,
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
        startingPrice: "",
        increment: "50",
        durationMinutes: "1440",
        customDurationMinutes: "",
      });
      go("browse");
      flash(
        photosAvailable
          ? "Your auction has been published."
          : "Auction published. Photos could not be loaded; refresh and try again.",
      );

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
        `Cancel "${item.title}"?\n\nThis immediately ends the auction and invalidates its result. Bidders will be notified, and bid/notification records are retained for 24 hours. The cancelled auction and its bids will then be permanently deleted. This cannot be undone.`,
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

    setItems((previous) => previous.filter((entry) => entry.id !== itemId));
    setSelectedItem((previous) =>
      previous?.id === itemId ? null : previous,
    );
    flash(
      item.bids.length
        ? "Auction cancelled. Bidders were notified; the auction and bids will be permanently removed after 24 hours."
        : "Auction cancelled. It will be permanently removed after 24 hours.",
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
      setItems((previous) => previous.filter((entry) => entry.id !== item.id));
      setSelectedItem((previous) =>
        previous?.id === item.id ? { ...previous, status: "CANCELLED" } : previous,
      );

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
        await refreshListings(page === "my-listings" ? "seller" : "active");
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
    if (
      itemsLoading ||
      itemsError ||
      item.status !== "PUBLISHED" ||
      now >= item.endsAt
    ) {
      return false;
    }

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
  const sellerItems =
    itemsLoading || itemsError
      ? []
      : items.filter(
          (item) =>
            item.sellerId === user?.id && item.status !== "CANCELLED",
        );

  const isSelectedAuctionOwner = Boolean(
    user &&
      selectedItem &&
      String(user.id).toLowerCase() ===
        String(selectedItem.sellerId).toLowerCase(),
  );
  const isSelectedChatAvailable = Boolean(
    selectedItem &&
      selectedItem.status === "PUBLISHED" &&
      now < selectedItem.endsAt,
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
  const userNotifications =
    notificationsOwnerId === currentUserId ? notifications : [];
  const userNotificationsError =
    notificationsErrorOwnerId === currentUserId ? notificationsError : "";
  const userSavedSearches =
    savedSearchesOwnerId === currentUserId ? savedSearches : [];
  const userSavedSearchesError =
    savedSearchesErrorOwnerId === currentUserId ? savedSearchesError : "";
  const unreadNotificationCount = userNotifications.filter(
    (notification) => !notification.is_read,
  ).length;

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
              <div className="notification-control" ref={notificationControlRef}>
                <button
                  className="notification-toggle"
                  type="button"
                  aria-label={
                    unreadNotificationCount > 0
                      ? `Notifications, ${unreadNotificationCount} unread`
                      : "Notifications"
                  }
                  aria-expanded={notificationsOpen}
                  aria-haspopup="dialog"
                  onClick={() => {
                    if (!notificationsOpen) {
                      setNotificationRefresh((count) => count + 1);
                    }
                    setNotificationsOpen((open) => !open);
                  }}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
                    <path d="M10 21h4" />
                  </svg>
                  {unreadNotificationCount > 0 && (
                    <span className="notification-badge">
                      {unreadNotificationCount > 99 ? "99+" : unreadNotificationCount}
                    </span>
                  )}
                </button>
                {notificationsOpen && (
                  <section
                    className="notification-panel"
                    aria-label="Your notifications"
                    role="dialog"
                  >
                    <div className="notification-panel-header">
                      <strong>Notifications</strong>
                      {unreadNotificationCount > 0 && (
                        <button
                          type="button"
                          className="notification-mark-all"
                          disabled={notificationActionBusy}
                          onClick={markAllNotificationsRead}
                        >
                          Mark all read
                        </button>
                      )}
                    </div>
                    {userNotificationsError ? (
                      <div className="notification-empty">
                        <p>{userNotificationsError}</p>
                        <button
                          type="button"
                          className="notification-mark-all"
                          onClick={() =>
                            setNotificationRefresh((count) => count + 1)
                          }
                        >
                          Try again
                        </button>
                      </div>
                    ) : notificationsLoading && userNotifications.length === 0 ? (
                      <p className="notification-empty">Loading notifications...</p>
                    ) : userNotifications.length === 0 ? (
                      <p className="notification-empty">You have no notifications.</p>
                    ) : (
                      <div className="notification-list">
                        {userNotifications.map((notification) => (
                          <article
                            className={`notification-item${notification.is_read ? "" : " is-unread"}`}
                            key={notification.id}
                          >
                            <p>{notification.message}</p>
                            <time dateTime={notification.created_at}>
                              {new Date(notification.created_at).toLocaleString()}
                            </time>
                            {notification.auction_id && (
                              <button
                                type="button"
                                className="notification-mark-all"
                                onClick={() =>
                                  openNotificationAuction(notification)
                                }
                              >
                                {notification.notification_type === "result_pending"
                                  ? "View provisional result"
                                  : notification.notification_type === "result_approved"
                                    ? "View result and contacts"
                                    : notification.notification_type === "auction_chat_message"
                                      ? "Open chat"
                                      : notification.notification_type === "saved_search_match"
                                        ? "View matching auction"
                                      : "View auction"}
                              </button>
                            )}
                            {!notification.is_read && (
                              <button
                                type="button"
                                className="notification-mark-all"
                                disabled={notificationActionBusy}
                                onClick={() =>
                                  markNotificationRead(notification.id)
                                }
                              >
                                Mark as read
                              </button>
                            )}
                          </article>
                        ))}
                      </div>
                    )}
                  </section>
                )}
              </div>
              <NavButton onClick={() => go("my-listings")}>My listings</NavButton>
              <NavButton onClick={() => go("saved-searches")}>
                Saved searches
              </NavButton>
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
                aria-label="Maximum current bid"
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

            <div className="save-search-row">
              <p>
                Alerts use keywords, category, and maximum starting price.
                Condition and closing-time filters are not included.
              </p>
              <button
                className="secondary-button save-search-button"
                type="button"
                disabled={Boolean(savedSearchBusyId)}
                onClick={saveCurrentSearch}
              >
                {savedSearchBusyId === "create"
                  ? "Saving search..."
                  : "Save this search"}
              </button>
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
                <p>Try changing your search or filters.</p>
              </div>
            )}
          </section>
        )}

        {page === "saved-searches" && (
          <section className="page-section saved-searches-page">
            <div className="section-heading">
              <div>
                <span className="eyebrow">PERSONALIZED AUCTION ALERTS</span>
                <h1>Saved searches</h1>
                <p className="subheading">
                  Get a notification when a newly published auction matches.
                </p>
              </div>
              <button
                className="primary-button"
                type="button"
                onClick={() => go("browse")}
              >
                Browse auctions
              </button>
            </div>

            {!user ? (
              <div className="empty-state">
                <h3>Sign in to view saved searches</h3>
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => requestLogin("buy")}
                >
                  Sign in →
                </button>
              </div>
            ) : savedSearchesLoading && userSavedSearches.length === 0 ? (
              <p className="saved-search-status" role="status">
                Loading saved searches...
              </p>
            ) : userSavedSearchesError ? (
              <div className="empty-state" role="alert">
                <h3>Saved searches are unavailable</h3>
                <p>{userSavedSearchesError}</p>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() =>
                    setSavedSearchRefresh((refresh) => refresh + 1)
                  }
                >
                  Try again
                </button>
              </div>
            ) : userSavedSearches.length === 0 ? (
              <div className="empty-state">
                <span>🔔</span>
                <h3>You have no saved searches yet</h3>
                <p>
                  Search the marketplace, choose keywords or filters, then save
                  them to get alerts for matching new auctions.
                </p>
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => go("browse")}
                >
                  Find an item →
                </button>
              </div>
            ) : (
              <div className="saved-search-list">
                {userSavedSearches.map((savedSearch) => (
                  <article className="saved-search-card" key={savedSearch.id}>
                    {savedSearchEditor?.id === savedSearch.id ? (
                      <form
                        className="listing-form saved-search-editor"
                        onSubmit={updateSavedSearch}
                      >
                        <label>
                          Keywords
                          <input
                            type="search"
                            maxLength="200"
                            value={savedSearchEditor.keywords}
                            onChange={(event) =>
                              setSavedSearchEditor((previous) => ({
                                ...previous,
                                keywords: event.target.value,
                              }))
                            }
                            placeholder="e.g. scientific calculator"
                          />
                        </label>
                        <div className="form-row">
                          <label>
                            Category
                            <select
                              value={savedSearchEditor.category}
                              onChange={(event) =>
                                setSavedSearchEditor((previous) => ({
                                  ...previous,
                                  category: event.target.value,
                                }))
                              }
                            >
                              {categories.map((name) => (
                                <option key={name} value={name}>
                                  {name === "All" ? "Any category" : name}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            Maximum starting price (₹)
                            <input
                              type="number"
                              min="0.01"
                              max="9999999999.99"
                              step="0.01"
                              value={savedSearchEditor.maxPrice}
                              onChange={(event) =>
                                setSavedSearchEditor((previous) => ({
                                  ...previous,
                                  maxPrice: event.target.value,
                                }))
                              }
                              placeholder="No limit"
                            />
                          </label>
                        </div>
                        <div className="saved-search-actions">
                          <button
                            className="primary-button"
                            type="submit"
                            disabled={Boolean(savedSearchBusyId)}
                          >
                            {savedSearchBusyId === savedSearch.id
                              ? "Saving..."
                              : "Save changes"}
                          </button>
                          <button
                            className="secondary-button"
                            type="button"
                            disabled={Boolean(savedSearchBusyId)}
                            onClick={() => setSavedSearchEditor(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    ) : (
                      <>
                        <div className="saved-search-details">
                          <span className="eyebrow">SEARCH ALERT</span>
                          <h2>{getSavedSearchLabel(savedSearch)}</h2>
                          <p>
                            Matching checks use auction title, description,
                            category, and starting price.
                          </p>
                        </div>
                        <div className="saved-search-actions">
                          <button
                            className="secondary-button"
                            type="button"
                            disabled={Boolean(savedSearchBusyId)}
                            onClick={() => editSavedSearch(savedSearch)}
                          >
                            Edit
                          </button>
                          <button
                            className="cancel-listing-button"
                            type="button"
                            disabled={Boolean(savedSearchBusyId)}
                            onClick={() => deleteSavedSearch(savedSearch)}
                          >
                            {savedSearchBusyId === savedSearch.id
                              ? "Deleting..."
                              : "Delete"}
                          </button>
                        </div>
                      </>
                    )}
                  </article>
                ))}
              </div>
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
                    <input
                      required
                      type="number"
                      min="0.01"
                      max="9999999999.99"
                      step="0.01"
                      value={form.startingPrice}
                      onChange={(event) =>
                        setForm({ ...form, startingPrice: event.target.value })
                      }
                      placeholder="e.g. 500"
                    />
                  </label>
                  <label>
                    Minimum bid increment (₹)
                    <input required type="number" min="0.01" step="0.01" value={form.increment} onChange={(event) => setForm({ ...form, increment: event.target.value })} />
                  </label>
                </div>
                <p className="form-notice">
                  The first bid must be greater than your starting price. Later
                  bids must meet the current highest bid plus the minimum increment.
                </p>
                <label>
                  Auction duration
                  <select
                    value={form.durationMinutes}
                    onChange={(event) =>
                      setForm({ ...form, durationMinutes: event.target.value })
                    }
                  >
                    <option value="1">1 minute</option>
                    <option value="5">5 minutes</option>
                    <option value="10">10 minutes</option>
                    <option value="30">30 minutes</option>
                    <option value="60">1 hour</option>
                    <option value="360">6 hours</option>
                    <option value="720">12 hours</option>
                    <option value="1440">24 hours</option>
                    <option value="2880">2 days</option>
                    <option value="4320">3 days</option>
                    <option value="custom">Custom duration</option>
                  </select>
                </label>
                {form.durationMinutes === "custom" && (
                  <label>
                    Custom duration (minutes)
                    <input
                      required
                      type="number"
                      min="1"
                      max={maxAuctionDurationMinutes}
                      step="1"
                      value={form.customDurationMinutes}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          customDurationMinutes: event.target.value,
                        })
                      }
                      placeholder={`1-${maxAuctionDurationMinutes}`}
                    />
                    <span className="field-hint">
                      Enter a whole number from 1 to 43,200 minutes (30 days).
                    </span>
                  </label>
                )}
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
                  The closing time is saved when you publish and is checked by the database when bids are placed. Photos are visible to everyone.
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
              {sellerItems.map((item) => (
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
            {!itemsLoading && !itemsError && sellerItems.length === 0 && (
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
            <div className="detail-product">
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
                <span>
                  {selectedItem.bids.length
                    ? "Current highest bid"
                    : "Starting bid"}
                </span>
                <strong>{money(leadingBid(selectedItem))}</strong>
              </div>
              <div className="detail-meta">
                <span>Minimum increment: {money(selectedItem.increment)}</span>
                <span>
                  Closes in: {selectedItem.status === "CANCELLED"
                    ? "Cancelled"
                    : selectedItem.status !== "PUBLISHED" || now >= selectedItem.endsAt
                      ? "Ended"
                      : countdown(selectedItem.endsAt)}
                </span>
                {selectedItem.status === "PUBLISHED" && now < selectedItem.endsAt && (
                  <span>
                    Minimum next valid bid: {money(minimumNextBid(selectedItem))}
                  </span>
                )}
              </div>
              {selectedItem.status === "CANCELLED" && (
                <p className="form-notice cancellation-notice" role="status">
                  This auction was cancelled by the seller. It is no longer
                  accepting bids; all recorded bids remain in the public history.
                </p>
              )}
              {selectedItem.status === "AWAITING_SELLER_DECISION" && (
                <p className="form-notice" role="status">
                  Provisional highest bid: {money(leadingBid(selectedItem))}.
                  Seller approval is pending. Contact details remain private
                  until the result is approved.
                </p>
              )}
              {selectedItem.status === "ENDED_NO_BIDS" && (
                <p className="form-notice" role="status">
                  This auction ended without bids. No winner was selected.
                </p>
              )}
              {["APPROVED", "COMPLETED"].includes(selectedItem.status) && user && (
                <section className="auction-contact">
                  <h3>Handover contact</h3>
                  {auctionContactLoading ? (
                    <p className="muted">Checking approved contact access...</p>
                  ) : auctionContact?.auctionId === selectedItem.id ? (
                    <>
                      <p>
                        {auctionContact.displayName} ({auctionContact.role})
                        <br />
                        {auctionContact.email}
                      </p>
                      <a
                        className="primary-button contact-email-button"
                        href={`mailto:${auctionContact.email}?subject=${encodeURIComponent(`Campus Auction: ${selectedItem.title}`)}`}
                      >
                        Contact {auctionContact.role === "seller" ? "Seller" : "Buyer"} →
                      </a>
                    </>
                  ) : (
                    <p className={auctionContactError ? "form-notice" : "muted"}>
                      {auctionContactError ||
                        "Contact details are available to the seller and approved winning bidder."}
                    </p>
                  )}
                </section>
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
                  <input
                    id="bid-amount"
                    type="number"
                    min={minimumNextBid(selectedItem)}
                    step="0.01"
                    required
                    value={bidAmount}
                    onChange={(event) => setBidAmount(event.target.value)}
                    disabled={bidBusy}
                  />
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
              {selectedItem.status === "PUBLISHED" &&
                now < selectedItem.endsAt &&
                !isSelectedAuctionOwner && (
                  <section className="automatic-bid-panel">
                    <h3>Automatic bidding</h3>
                    {automaticBidError && (
                      <p className="automatic-bid-error" role="alert">
                        {automaticBidError}
                      </p>
                    )}
                    {!user ? (
                      <>
                        <p>
                          Sign in to authorize automatic bids with a private
                          maximum limit.
                        </p>
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={() => requestLogin("buy")}
                        >
                          Sign in to set a maximum
                        </button>
                      </>
                    ) : automaticBidConfigAuctionId !== selectedItem.id &&
                      automaticBidLoading ? (
                      <p role="status">Loading your private settings...</p>
                    ) : (
                      <>
                        {automaticBidConfigAuctionId === selectedItem.id &&
                          automaticBidConfig && (
                            <p className="automatic-bid-status">
                              Your maximum:{" "}
                              <strong>
                                {money(automaticBidConfig.max_amount)}
                              </strong>
                              {" · "}
                              {automaticBidConfig.is_active
                                ? automaticBidConfig.reached_limit
                                  ? "Active; next valid bid exceeds your limit."
                                  : "Active"
                                : "Not active"}
                            </p>
                          )}
                        <label htmlFor="automatic-bid-maximum">
                          {automaticBidConfigAuctionId === selectedItem.id &&
                          automaticBidConfig
                            ? "Maximum authorized amount (₹)"
                            : "Set maximum authorized amount (₹)"}
                          <input
                            id="automatic-bid-maximum"
                            type="number"
                            min="0.01"
                            max="9999999999.99"
                            step="0.01"
                            value={automaticBidDraft}
                            onChange={(event) => {
                              setAutomaticBidDraft(event.target.value);
                              setAutomaticBidConsent(false);
                              setAutomaticBidError("");
                            }}
                            disabled={automaticBidBusy || automaticBidLoading}
                          />
                        </label>
                        <label className="automatic-bid-consent">
                          <input
                            type="checkbox"
                            checked={automaticBidConsent}
                            onChange={(event) => {
                              setAutomaticBidConsent(event.target.checked);
                              setAutomaticBidError("");
                            }}
                            disabled={automaticBidBusy}
                          />
                          I authorize bids up to{" "}
                          {Number(automaticBidDraft) > 0
                            ? money(Number(automaticBidDraft))
                            : "the amount entered"}. The limit will not be
                          exceeded, and I can disable this at any time.
                        </label>
                        <button
                          className="primary-button full-button"
                          type="button"
                          disabled={
                            automaticBidBusy ||
                            automaticBidLoading ||
                            !automaticBidConsent
                          }
                          onClick={saveAutomaticBid}
                        >
                          {automaticBidBusy
                            ? "Saving authorization..."
                            : automaticBidConfigAuctionId === selectedItem.id &&
                                automaticBidConfig
                              ? "Confirm and update maximum"
                              : "Confirm and enable automatic bidding"}
                        </button>
                        {automaticBidConfigAuctionId === selectedItem.id &&
                          automaticBidConfig?.is_active && (
                          <button
                            className="cancel-listing-button"
                            type="button"
                            disabled={automaticBidBusy}
                            onClick={disableAutomaticBid}
                          >
                            Disable automatic bidding
                          </button>
                        )}
                      </>
                    )}
                  </section>
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
                      {now >= selectedItem.endsAt && (
                        <button
                          className="primary-button full-button"
                          type="button"
                          disabled={resultActionBusy || detailLoading}
                          onClick={() => closeAuctionForReview(selectedItem)}
                        >
                          {resultActionBusy
                            ? "Reviewing auction result..."
                            : "Close auction and review result"}
                        </button>
                      )}
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
                  ) : selectedItem.status === "AWAITING_SELLER_DECISION" ? (
                    <>
                      <p className="form-notice">
                        Review the provisional result. Approving confirms the
                        outcome and shares contact emails with the winning buyer.
                      </p>
                      <button
                        className="primary-button full-button"
                        type="button"
                        disabled={resultActionBusy}
                        onClick={() =>
                          decideAuctionResult(selectedItem, true)
                        }
                      >
                        {resultActionBusy ? "Saving decision..." : "Approve result"}
                      </button>
                      <button
                        className="cancel-listing-button"
                        type="button"
                        disabled={resultActionBusy}
                        onClick={() =>
                          decideAuctionResult(selectedItem, false)
                        }
                      >
                        {resultActionBusy ? "Saving decision..." : "Reject result"}
                      </button>
                    </>
                  ) : selectedItem.status === "ENDED_NO_BIDS" ? (
                    <p className="form-notice">
                      This auction ended without bids. No winner was selected.
                    </p>
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
            </div>
            <aside className="auction-chat" aria-labelledby="auction-chat-heading">
              <header className="auction-chat-header">
                <span className="eyebrow">Private auction chat</span>
                <h3 id="auction-chat-heading">{selectedItem.title}</h3>
                <p>
                  Only you and the listing seller can read this conversation.
                  Chat closes when the auction ends.
                </p>
              </header>

              {isSelectedChatAvailable ? (
                <>
                  {!user ? (
                    <div className="auction-chat-empty">
                      <p>Sign in to message the seller about this item.</p>
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => {
                          setSelectedItem(null);
                          requestLogin("buy");
                        }}
                      >
                        Sign in
                      </button>
                    </div>
                  ) : isSelectedAuctionOwner ? (
                    chatConversationsLoading && !chatConversations.length ? (
                      <p className="muted" role="status">Loading conversations...</p>
                    ) : chatConversations.length ? (
                      <label className="auction-chat-conversation-picker">
                        Buyer conversation
                        <select
                          value={chatConversationId || ""}
                          onChange={(event) => {
                            setChatConversationId(event.target.value || null);
                            setChatMessages([]);
                            setChatDraft("");
                            setChatRequestKey(null);
                            setChatFeedback(null);
                            setChatError("");
                          }}
                        >
                          {chatConversations.map((conversation) => (
                            <option
                              key={conversation.conversation_id}
                              value={conversation.conversation_id}
                            >
                              {conversation.buyer_display_name}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : (
                      <p className="auction-chat-empty">
                        {chatError || "No conversations yet. Buyers can message while this auction is open."}
                      </p>
                    )
                  ) : chatConversationsLoading ? (
                    <p className="muted" role="status">Opening your conversation...</p>
                  ) : chatError ? (
                    <p className="form-notice" role="alert">{chatError}</p>
                  ) : null}

                  {user && chatConversationId && (
                    <>
                      {chatError && (
                        <p className="form-notice" role="alert">{chatError}</p>
                      )}
                      <div className="auction-chat-history" role="log" aria-live="polite">
                        {chatMessagesLoading ? (
                          <p className="muted" role="status">Loading messages...</p>
                        ) : chatMessages.length === 0 ? (
                          <p className="auction-chat-empty">
                            No messages yet. Start the conversation about this item.
                          </p>
                        ) : (
                          chatMessages.map((message) => (
                            <article
                              className={`auction-chat-message${message.is_mine ? " is-mine" : ""}`}
                              key={message.message_id}
                            >
                              <span>
                                {message.is_mine
                                  ? "You"
                                  : isSelectedAuctionOwner
                                    ? chatConversations.find(
                                        (entry) =>
                                          entry.conversation_id === chatConversationId,
                                      )?.buyer_display_name || "Buyer"
                                    : "Seller"}
                              </span>
                              <p>{message.message_text}</p>
                              <time dateTime={message.created_at}>
                                {new Date(message.created_at).toLocaleString()}
                              </time>
                            </article>
                          ))
                        )}
                      </div>

                      {chatFeedback && (
                        <p
                          className={
                            chatFeedback.kind === "error"
                              ? "form-notice"
                              : "auction-chat-success"
                          }
                          role={chatFeedback.kind === "error" ? "alert" : "status"}
                        >
                          {chatFeedback.message}
                        </p>
                      )}

                      <form
                        className="auction-chat-form"
                        onSubmit={sendAuctionChatMessage}
                      >
                        <label htmlFor="auction-chat-input">Message</label>
                        <textarea
                          id="auction-chat-input"
                          maxLength={500}
                          rows={3}
                          required
                          value={chatDraft}
                          onChange={(event) => {
                            setChatDraft(event.target.value);
                            setChatRequestKey(null);
                          }}
                          disabled={chatSending}
                          placeholder="Write a message (up to 500 characters)"
                        />
                        <div className="auction-chat-form-footer">
                          <span>{chatDraft.length}/500</span>
                          <button
                            className="primary-button"
                            type="submit"
                            disabled={
                              chatSending ||
                              !chatConversationId ||
                              !chatDraft.trim()
                            }
                          >
                            {chatSending ? "Sending..." : "Send"}
                          </button>
                        </div>
                      </form>
                    </>
                  )}
                </>
              ) : (
                <p className="auction-chat-empty" role="status">
                  Chat is unavailable because this auction is no longer open.
                </p>
              )}
            </aside>
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
            <span className="muted-label">
              {item.bids.length ? "Highest bid" : "Starting bid"}
            </span>
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
