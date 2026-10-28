import { useRef, useState } from "react";
import { supabase } from "./supabase.js";
import {
  isAuctionMatchForSavedSearch,
  parseAssistantSearch,
  validateAssistantCriteria,
} from "./assistantSearch.js";

function leadingBid(item) {
  return item.bids.length
    ? Math.max(...item.bids.map((bid) => bid.amount))
    : item.price;
}

export default function AuctionAssistant({
  categories,
  currentUserId,
  fetchListings,
  money,
  onOpenItem,
  renderAuctionCard,
  savedSearches,
  savedSearchesError,
  savedSearchesLoading,
  savedSearchesOwnerId,
  user,
}) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [notice, setNotice] = useState("");
  const [useHostedAi, setUseHostedAi] = useState(false);
  const requestId = useRef(0);

  async function searchAuctions(event) {
    event.preventDefault();
    const searchPrompt = prompt.trim();
    if (!searchPrompt || searchPrompt.length > 500) {
      setErrorMessage("Enter a request of up to 500 characters.");
      return;
    }

    if (useHostedAi && !user) {
      setErrorMessage(
        "Sign in to use the optional hosted AI interpreter. Built-in search works without signing in.",
      );
      return;
    }

    const currentRequestId = ++requestId.current;
    setBusy(true);
    setErrorMessage("");
    setNotice("");
    setResults(null);

    let criteria;
    let usedHostedAi = false;
    try {
      if (useHostedAi) {
        try {
          const { data, error } = await supabase.functions.invoke(
            "auction-assistant",
            { body: { prompt: searchPrompt } },
          );
          if (error) throw error;
          criteria = validateAssistantCriteria(data?.criteria, categories);
          usedHostedAi = true;
        } catch (error) {
          console.error("Hosted auction assistant is unavailable.", error);
          criteria = validateAssistantCriteria(
            parseAssistantSearch(searchPrompt),
            categories,
          );
          setNotice(
            "The hosted AI interpreter is unavailable or not configured. Used the built-in structured search instead.",
          );
        }
      } else {
        criteria = validateAssistantCriteria(
          parseAssistantSearch(searchPrompt),
          categories,
        );
        setNotice(
          "Using built-in structured search. Your prompt is not sent to an AI provider.",
        );
      }

      if (
        !criteria.keywords &&
        !criteria.category &&
        criteria.maxPrice === null &&
        !criteria.cheapest &&
        !criteria.matchSavedSearches
      ) {
        throw new Error(
          "Try a request with an item or category, such as “scientific calculator under ₹400”.",
        );
      }

      if (criteria.matchSavedSearches) {
        if (!user) {
          throw new Error("Sign in to search using your private saved searches.");
        }
        if (savedSearchesOwnerId !== currentUserId) {
          throw new Error(
            savedSearchesLoading
              ? "Your saved searches are still loading. Try again in a moment."
              : "Your saved searches could not be loaded. Open Saved searches and retry.",
          );
        }
        if (savedSearchesError) {
          throw new Error(savedSearchesError);
        }
      }

      const listings = await fetchListings();
      if (currentRequestId !== requestId.current) return;

      let matches = listings.filter((item) => {
        if (criteria.matchSavedSearches) {
          return savedSearches.some((savedSearch) =>
            isAuctionMatchForSavedSearch(item, savedSearch),
          );
        }

        const searchableText =
          `${item.title} ${item.description} ${item.category}`.toLowerCase();
        return (
          (!criteria.keywords ||
            searchableText.includes(criteria.keywords.toLowerCase())) &&
          (!criteria.category || item.category === criteria.category) &&
          (criteria.maxPrice === null || item.price <= criteria.maxPrice)
        );
      });

      if (criteria.cheapest) {
        matches = [...matches].sort((first, second) => {
          const priceDifference = leadingBid(first) - leadingBid(second);
          return priceDifference || first.endsAt - second.endsAt;
        });
      }

      setResults(matches);
      if (usedHostedAi) {
        setNotice(
          "Hosted AI interpreted your prompt; results come from current published auctions only.",
        );
      } else if (criteria.matchSavedSearches) {
        setNotice(
          "Compared your private saved-search criteria with current public auctions.",
        );
      }
    } catch (error) {
      console.error("Could not search auctions with the assistant.", error);
      if (currentRequestId === requestId.current) {
        setErrorMessage(
          typeof error?.message === "string" && error.message.trim()
            ? error.message
            : "Auction search could not be completed. Please try again.",
        );
      }
    } finally {
      if (currentRequestId === requestId.current) setBusy(false);
    }
  }

  const examples = [
    "Find me a cycle under ₹2,000",
    "Scientific calculator for less than ₹400",
    "Show me the cheapest available calculator",
    "Which published auctions match my saved searches?",
  ];

  return (
    <section className="page-section assistant-page">
      <div className="section-heading">
        <div>
          <span className="eyebrow">REAL AUCTIONS, NO GUESSES</span>
          <h1>Auction assistant</h1>
          <p className="subheading">
            Describe what you need and search published campus auctions.
          </p>
        </div>
      </div>

      <form className="assistant-search-form" onSubmit={searchAuctions}>
        <label htmlFor="assistant-prompt">
          What are you looking for?
          <textarea
            id="assistant-prompt"
            maxLength="500"
            rows="3"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="e.g. Find me a scientific calculator under ₹400"
            disabled={busy}
          />
        </label>
        <div className="assistant-search-footer">
          <span>{prompt.length}/500</span>
          <button
            className="primary-button"
            type="submit"
            disabled={busy || !prompt.trim()}
          >
            {busy ? "Searching auctions..." : "Find auctions"}
          </button>
        </div>
        <label className="assistant-ai-consent">
          <input
            type="checkbox"
            checked={useHostedAi}
            onChange={(event) => setUseHostedAi(event.target.checked)}
            disabled={busy}
          />
          If configured, allow this prompt to be sent to the hosted AI
          interpreter for search criteria only. No account data, bids,
          saved-search contents, or chat messages are sent.
        </label>
      </form>

      <div className="assistant-examples" aria-label="Example searches">
        <span>Try:</span>
        {examples.map((example) => (
          <button
            key={example}
            className="assistant-example"
            type="button"
            disabled={busy}
            onClick={() => {
              setPrompt(example);
              setErrorMessage("");
            }}
          >
            {example}
          </button>
        ))}
      </div>

      {notice && (
        <p className="assistant-notice" role="status">
          {notice}
        </p>
      )}
      {errorMessage && (
        <div className="empty-state" role="alert">
          <h3>Search could not be completed</h3>
          <p>{errorMessage}</p>
        </div>
      )}
      {results !== null && (
        <>
          <p className="results-count">
            {results.length} matching active auction
            {results.length === 1 ? "" : "s"}
          </p>
          {results.length === 0 ? (
            <div className="empty-state">
              <span>🔎</span>
              <h3>No matching active auctions</h3>
              <p>
                Try a broader item description, remove a price limit, or save a
                search to get alerts for new listings.
              </p>
            </div>
          ) : (
            <div className="product-grid assistant-result-grid">
              {results.map((item) => (
                <div className="assistant-result-card" key={item.id}>
                  {renderAuctionCard(item, () => onOpenItem(item))}
                  <p>
                    Starting price: {money(item.price)} · Current:{" "}
                    {money(leadingBid(item))}
                  </p>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
