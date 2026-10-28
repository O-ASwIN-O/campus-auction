import assert from "node:assert/strict";
import test from "node:test";
import {
  isAuctionMatchForSavedSearch,
  parseAssistantSearch,
  validateAssistantCriteria,
} from "./assistantSearch.js";

const categories = ["All", "Cycle", "Calculator", "Books", "Electronics"];

test("parses keyword, category, and maximum price", () => {
  const parsed = parseAssistantSearch(
    "Find me a scientific calculator under ₹400",
  );

  assert.deepEqual(parsed, {
    keywords: "scientific",
    category: "Calculator",
    maxPrice: 400,
    cheapest: false,
    matchSavedSearches: false,
  });
});

test("parses rupee prices with thousands separators", () => {
  assert.equal(parseAssistantSearch("Find a cycle under ₹2,000").maxPrice, 2000);
});

test("recognizes cheapest and saved-search requests", () => {
  const cheapest = parseAssistantSearch("Show me the cheapest calculator");
  assert.equal(cheapest.category, "Calculator");
  assert.equal(cheapest.cheapest, true);

  const savedSearch = parseAssistantSearch(
    "Which published auctions match my saved searches?",
  );
  assert.equal(savedSearch.matchSavedSearches, true);
  assert.equal(savedSearch.keywords, null);
});

test("rejects malformed, unsupported, or invalid criteria", () => {
  assert.throws(
    () => validateAssistantCriteria(null, categories),
    /invalid search criteria/i,
  );
  assert.throws(
    () =>
      validateAssistantCriteria(
        {
          keywords: "",
          category: "All",
          max_price: null,
          cheapest: false,
          match_saved_searches: false,
        },
        categories,
      ),
    /unsupported category/i,
  );
  assert.throws(
    () =>
      validateAssistantCriteria(
        {
          keywords: "",
          category: null,
          max_price: 0,
          cheapest: false,
          match_saved_searches: false,
        },
        categories,
      ),
    /invalid price/i,
  );
});

test("matches saved-search keywords, category, and inclusive price limit", () => {
  const auction = {
    title: "Scientific calculator",
    description: "A barely used calculator for college courses.",
    category: "Calculator",
    price: 400,
  };
  const savedSearch = {
    keywords: "scientific calculator",
    category: "Calculator",
    max_price: 400,
  };

  assert.equal(isAuctionMatchForSavedSearch(auction, savedSearch), true);
  assert.equal(
    isAuctionMatchForSavedSearch(
      { ...auction, price: 400.01 },
      savedSearch,
    ),
    false,
  );
  assert.equal(
    isAuctionMatchForSavedSearch(
      { ...auction, category: "Electronics" },
      savedSearch,
    ),
    false,
  );
});
