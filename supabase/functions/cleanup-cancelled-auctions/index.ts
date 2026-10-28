import { createClient } from "npm:@supabase/supabase-js@2";

const bucket = "listing-photos";
const batchSize = 100;

function isOwnedPhotoPath(path: string, sellerId: string): boolean {
  const parts = path.split("/");
  return (
    parts.length === 3 &&
    parts[0] === sellerId &&
    parts[1].length > 0 &&
    parts[2].length > 0
  );
}

async function findExistingPhotoPaths(
  supabase: ReturnType<typeof createClient>,
  paths: string[],
): Promise<string[]> {
  const existingPaths: string[] = [];
  for (const path of paths) {
    const separator = path.lastIndexOf("/");
    const folder = path.slice(0, separator);
    const fileName = path.slice(separator + 1);
    const { data, error } = await supabase.storage
      .from(bucket)
      .list(folder, { limit: 100, search: fileName });

    if (error) throw error;
    if ((data || []).some((file) => file.name === fileName)) {
      existingPaths.push(path);
    }
  }
  return existingPaths;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed.", { status: 405 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const cleanupToken = Deno.env.get("CANCELLED_AUCTION_CLEANUP_TOKEN");
  if (!supabaseUrl || !serviceRoleKey || !cleanupToken) {
    console.error("Cancelled-auction cleanup is missing its server configuration.");
    return new Response("Cleanup service is not configured.", { status: 500 });
  }

  const expectedAuthorization = ["Bearer", cleanupToken].join(" ");
  if (request.headers.get("authorization") !== expectedAuthorization) {
    return new Response("Unauthorized.", { status: 401 });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: dueAuctions, error: queryError } = await supabase.rpc(
    "get_expired_cancelled_auctions",
  );

  if (queryError) {
    console.error("Could not load auctions eligible for retention cleanup.", queryError);
    return new Response("Could not load cleanup candidates.", { status: 500 });
  }

  let deletedCount = 0;
  let failedCount = 0;
  for (const auction of (dueAuctions || []).slice(0, batchSize)) {
    const { data: attemptStarted, error: attemptError } = await supabase.rpc(
      "mark_cancelled_auction_cleanup_attempt",
      { p_auction_id: auction.auction_id },
    );
    if (attemptError || attemptStarted !== true) {
      failedCount += 1;
      console.error(
        "Could not register a cancelled-auction cleanup attempt.",
        attemptError || "The auction is no longer eligible.",
      );
      continue;
    }

    const photoPaths = auction.photo_paths || [];
    if (
      photoPaths.some(
        (path: string) =>
          typeof path !== "string" ||
          !isOwnedPhotoPath(path, auction.seller_id),
      )
    ) {
      failedCount += 1;
      console.error("Skipped cleanup for an auction with an invalid photo path.");
      continue;
    }

    if (photoPaths.length) {
      let existingPhotoPaths: string[];
      try {
        existingPhotoPaths = await findExistingPhotoPaths(supabase, photoPaths);
      } catch (storageListError) {
        failedCount += 1;
        console.error("Could not check listing photos before cleanup.", storageListError);
        continue;
      }

      if (existingPhotoPaths.length === 0) {
        const { data: deleted, error: finalizeError } = await supabase.rpc(
          "finalize_cancelled_auction_cleanup",
          { p_auction_id: auction.auction_id },
        );
        if (finalizeError || deleted !== true) {
          failedCount += 1;
          console.error(
            "Could not finalize expired cancelled-auction cleanup.",
            finalizeError || "The database did not confirm deletion.",
          );
          continue;
        }
        deletedCount += 1;
        continue;
      }

      const { error: storageError } = await supabase.storage
        .from(bucket)
        .remove(existingPhotoPaths);
      if (storageError) {
        failedCount += 1;
        console.error("Could not remove photos for an expired cancelled auction.", storageError);
        continue;
      }
    }

    const { data: deleted, error: finalizeError } = await supabase.rpc(
      "finalize_cancelled_auction_cleanup",
      { p_auction_id: auction.auction_id },
    );
    if (finalizeError || deleted !== true) {
      failedCount += 1;
      console.error(
        "Could not finalize expired cancelled-auction cleanup.",
        finalizeError || "The database did not confirm deletion.",
      );
      continue;
    }

    deletedCount += 1;
  }

  return Response.json({ deleted: deletedCount, failed: failedCount });
});
