import { fetchConnectionUsageCached, readQuotaCache } from "../_shared";

const MAX_BATCH_SIZE = 100;

function normalizeConnectionIds(rawIds) {
  if (!Array.isArray(rawIds)) return [];
  return [...new Set(rawIds.map((id) => String(id || "").trim()).filter(Boolean))]
    .slice(0, MAX_BATCH_SIZE);
}

/**
 * POST /api/usage/batch
 * Body: { connectionIds: string[] }
 *
 * Server-side stale-while-revalidate: returns cached quota instantly for
 * warm entries, fetches only cache misses, and triggers background refresh
 * for stale entries so the next request is fast. A per-connection timeout
 * prevents one slow upstream from blocking the entire batch.
 */
export async function POST(request) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const connectionIds = normalizeConnectionIds(body.connectionIds);
  if (connectionIds.length === 0) {
    return Response.json({ results: {}, requested: 0 });
  }

  const results = {};
  const toFetch = [];

  for (const id of connectionIds) {
    const cached = readQuotaCache(id);
    if (cached) {
      results[id] = {
        ...cached.value,
        cacheStatus: cached.cacheStatus,
        cachedAt: cached.cachedAt,
      };
      if (cached.cacheStatus === "stale") {
        // Background refresh - do not block the response
        fetchConnectionUsageCached(id).catch(() => {});
      }
    } else {
      toFetch.push(id);
    }
  }

  if (toFetch.length > 0) {
    const fetched = await Promise.all(
      toFetch.map(async (id) => [id, await fetchConnectionUsageCached(id)]),
    );
    for (const [id, result] of fetched) {
      results[id] = {
        ...result,
        cacheStatus: result?.ok ? "fresh" : "miss",
      };
    }
  }

  return Response.json({
    results,
    requested: connectionIds.length,
  });
}
