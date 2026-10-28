export function parseAssistantSearch(prompt) {
  const normalizedPrompt = String(prompt || "").trim();
  const matchSavedSearches =
    /\bmy saved searches?\b|\bsaved search matches\b/i.test(normalizedPrompt);
  const cheapest = /\bcheapest|lowest price|lowest-priced\b/i.test(
    normalizedPrompt,
  );
  const priceMatch = normalizedPrompt.match(
    /\b(?:under|below|less than|up to|at most|within|cheaper than)\s*(?:₹|rs\.?\s*)?([\d,]+(?:\.\d{1,2})?)/i,
  );
  const maxPrice = priceMatch
    ? Number(priceMatch[1].replaceAll(",", ""))
    : null;
  let category = null;
  let keywords = normalizedPrompt.toLowerCase();

  const categoryPatterns = [
    { value: "Cycle", pattern: /\b(?:cycles?|bicycles?|bikes?)\b/i },
    { value: "Calculator", pattern: /\bcalculators?\b/i },
    { value: "Books", pattern: /\bbooks?\b/i },
    {
      value: "Electronics",
      pattern: /\b(?:electronics?|headphones?|earbuds?|gadgets?)\b/i,
    },
  ];
  for (const entry of categoryPatterns) {
    if (entry.pattern.test(normalizedPrompt)) {
      category = entry.value;
      keywords = keywords.replace(entry.pattern, " ");
      break;
    }
  }

  if (priceMatch) {
    keywords = keywords.replace(priceMatch[0].toLowerCase(), " ");
  }
  keywords = keywords
    .replace(
      /\b(?:find|show|search|searches|look|looking|for|me|i|need|want|a|an|the|please|can|you|which|cheapest|lowest|price|priced|available|published|auction|auctions|item|items|under|below|less|than|up|to|at|most|within|cheaper|my|saved|matches|match)\b/gi,
      " ",
    )
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    keywords: keywords || null,
    category,
    maxPrice,
    cheapest,
    matchSavedSearches,
  };
}

export function validateAssistantCriteria(criteria, categories) {
  if (!criteria || typeof criteria !== "object" || Array.isArray(criteria)) {
    throw new Error("The assistant returned invalid search criteria.");
  }

  const rawKeywords = criteria.keywords ?? "";
  if (typeof rawKeywords !== "string") {
    throw new Error("The assistant returned invalid search keywords.");
  }
  const keywords = rawKeywords.trim();

  let category = null;
  if (criteria.category !== null && criteria.category !== undefined) {
    if (
      typeof criteria.category !== "string" ||
      criteria.category === "All" ||
      !categories.includes(criteria.category)
    ) {
      throw new Error("The assistant returned an unsupported category.");
    }
    category = criteria.category;
  }

  const rawMaxPrice = criteria?.max_price ?? criteria?.maxPrice;
  if (rawMaxPrice != null && typeof rawMaxPrice !== "number") {
    throw new Error("The assistant returned an invalid price limit.");
  }
  const maxPrice = rawMaxPrice ?? null;

  if (keywords.length > 200) {
    throw new Error("The assistant returned keywords that were too long.");
  }
  if (
    maxPrice !== null &&
    (!Number.isFinite(maxPrice) ||
      maxPrice <= 0 ||
    maxPrice > 9999999999.99 ||
    !Number.isInteger(maxPrice * 100))
  ) {
    throw new Error("The assistant returned an invalid price limit.");
  }

  const cheapest = criteria.cheapest;
  const matchSavedSearches =
    criteria.match_saved_searches ?? criteria.matchSavedSearches;
  if (
    typeof cheapest !== "boolean" ||
    typeof matchSavedSearches !== "boolean"
  ) {
    throw new Error("The assistant returned incomplete search criteria.");
  }

  return {
    keywords: keywords || null,
    category,
    maxPrice,
    cheapest,
    matchSavedSearches,
  };
}

export function isAuctionMatchForSavedSearch(item, savedSearch) {
  const searchableText =
    `${item.title} ${item.description} ${item.category}`.toLowerCase();
  return (
    (!savedSearch.keywords ||
      searchableText.includes(savedSearch.keywords.toLowerCase())) &&
    (!savedSearch.category || item.category === savedSearch.category) &&
    (savedSearch.max_price == null ||
      item.price <= Number(savedSearch.max_price))
  );
}
