// Shared quota-fetch logic used by both /api/usage/[connectionId] and
// /api/usage/batch. Extracted so the batch endpoint can fan out to many
// connections server-side without duplicating the per-connection flow.

import "open-sse/index.js";

import { getProviderConnectionById, updateProviderConnection } from "@/lib/localDb";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { getExecutor } from "open-sse/executors/index.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { USAGE_APIKEY_PROVIDERS } from "@/shared/constants/providers";

const AUTH_EXPIRED_PATTERNS = ["expired", "authentication", "unauthorized", "401", "re-authorize"];
function isAuthExpiredMessage(usage) {
  if (!usage?.message) return false;
  const msg = usage.message.toLowerCase();
  return AUTH_EXPIRED_PATTERNS.some((p) => msg.includes(p));
}

export async function refreshAndUpdateCredentials(connection, force = false, proxyOptions = null) {
  const executor = getExecutor(connection.provider);

  const credentials = {
    accessToken: connection.accessToken,
    refreshToken: connection.refreshToken,
    idToken: connection.idToken,
    expiresAt: connection.expiresAt || connection.tokenExpiresAt,
    lastRefreshAt: connection.lastRefreshAt,
    connectionId: connection.id,
    providerSpecificData: connection.providerSpecificData,
    copilotToken: connection.providerSpecificData?.copilotToken,
    copilotTokenExpiresAt: connection.providerSpecificData?.copilotTokenExpiresAt,
  };

  const needsRefresh = force || executor.needsRefresh(credentials);

  if (!needsRefresh) {
    return { connection, refreshed: false };
  }

  const refreshResult = await executor.refreshCredentials(credentials, console, proxyOptions);

  if (!refreshResult) {
    if (connection.accessToken) {
      return { connection, refreshed: false };
    }
    throw new Error("Failed to refresh credentials. Please re-authorize the connection.");
  }

  const now = new Date().toISOString();
  const updateData = { updatedAt: now };

  if (refreshResult.accessToken) updateData.accessToken = refreshResult.accessToken;
  if (refreshResult.refreshToken) updateData.refreshToken = refreshResult.refreshToken;
  if (refreshResult.idToken) updateData.idToken = refreshResult.idToken;
  if (refreshResult.lastRefreshAt) updateData.lastRefreshAt = refreshResult.lastRefreshAt;

  if (refreshResult.expiresIn) {
    updateData.expiresAt = new Date(Date.now() + refreshResult.expiresIn * 1000).toISOString();
    updateData.expiresIn = refreshResult.expiresIn;
  } else if (refreshResult.expiresAt) {
    updateData.expiresAt = refreshResult.expiresAt;
  }

  const providerSpecificUpdates = {
    ...(refreshResult.providerSpecificData || {}),
    ...(refreshResult.copilotToken ? { copilotToken: refreshResult.copilotToken } : {}),
    ...(refreshResult.copilotTokenExpiresAt ? { copilotTokenExpiresAt: refreshResult.copilotTokenExpiresAt } : {}),
  };
  if (Object.keys(providerSpecificUpdates).length > 0) {
    updateData.providerSpecificData = {
      ...(connection.providerSpecificData || {}),
      ...providerSpecificUpdates,
    };
  }

  await updateProviderConnection(connection.id, updateData);

  const updatedConnection = {
    ...connection,
    ...updateData,
    providerSpecificData: updateData.providerSpecificData || connection.providerSpecificData,
  };

  return { connection: updatedConnection, refreshed: true };
}

/**
 * Core: fetch usage/quota for a single connection.
 * Returns { ok: true, data } on success or { ok: false, status, error } on failure.
 * Individual failures are isolated so a batch call never aborts on one bad connection.
 */
export async function fetchConnectionUsage(connectionId) {
  let connection;
  try {
    connection = await getProviderConnectionById(connectionId);
    if (!connection) {
      return { ok: false, status: 404, error: "Connection not found" };
    }

    const isOAuth = connection.authType === "oauth";
    const isApikeyAuth =
      connection.authType === "apikey" || connection.authType === "api_key";
    const isApikeyEligible =
      isApikeyAuth && USAGE_APIKEY_PROVIDERS.includes(connection.provider);

    if (!isOAuth && !isApikeyEligible) {
      // Not an error — provider simply has no usage API
      return { ok: true, data: { message: "Usage not available for this connection" } };
    }

    const proxyConfig = await resolveConnectionProxyConfig(connection.providerSpecificData);
    const proxyOptions = {
      connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
      connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
      connectionNoProxy: proxyConfig.connectionNoProxy || "",
      vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
      strictProxy: false,
    };

    if (isOAuth) {
      try {
        const result = await refreshAndUpdateCredentials(connection, false, proxyOptions);
        connection = result.connection;
      } catch (refreshError) {
        console.error("[Usage API] Credential refresh failed:", refreshError);
        return { ok: false, status: 401, error: `Credential refresh failed: ${refreshError.message}` };
      }
    }

    let usage = await getUsageForProvider(connection, proxyOptions);

    if (isOAuth && isAuthExpiredMessage(usage) && connection.refreshToken) {
      try {
        const retryResult = await refreshAndUpdateCredentials(connection, true, proxyOptions);
        connection = retryResult.connection;
        usage = await getUsageForProvider(connection, proxyOptions);
      } catch (retryError) {
        console.warn(`[Usage] ${connection.provider}: force refresh failed: ${retryError.message}`);
      }
    }

    return { ok: true, data: usage };
  } catch (error) {
    const provider = connection?.provider ?? "unknown";
    console.warn(`[Usage] ${provider}: ${error.message}`);
    return { ok: false, status: 500, error: error.message };
  }
}

// --- Server-side quota cache (stale-while-revalidate) ---
// In-memory cache shared across requests. Returns fresh results instantly,
// stale results instantly + triggers a background refresh, and caps each
// upstream fetch with a timeout so one slow provider can't block the batch.

const QUOTA_CACHE = new Map(); // connectionId -> { value, fetchedAt, pending }
const QUOTA_FRESH_TTL_MS = 30_000;
const QUOTA_STALE_TTL_MS = 300_000;
const QUOTA_FETCH_TIMEOUT_MS = 7_000;

function getEarliestQuotaResetMs(result) {
  const quotas = result?.data?.quotas;
  if (!quotas || typeof quotas !== "object") return null;

  const times = Object.values(quotas)
    .map((quota) => {
      const time = quota?.resetAt ? new Date(quota.resetAt).getTime() : NaN;
      return Number.isFinite(time) ? time : null;
    })
    .filter((time) => time && time > 0);

  return times.length > 0 ? Math.min(...times) : null;
}


/**
 * Read cached quota for a connection.
 * Returns { value, cacheStatus, cachedAt } or null if expired / no cache.
 *  - cacheStatus "fresh": within fresh TTL — no refetch needed
 *  - cacheStatus "stale": past fresh but within stale TTL — serve + revalidate
 */
export function readQuotaCache(connectionId) {
  const entry = QUOTA_CACHE.get(connectionId);
  if (!entry || !entry.value) return null;
  const now = Date.now();
  const resetMs = getEarliestQuotaResetMs(entry.value);
  if (resetMs && now >= resetMs) {
    QUOTA_CACHE.delete(connectionId);
    return null;
  }

  const age = now - entry.fetchedAt;
  if (age < QUOTA_FRESH_TTL_MS) {
    return { value: entry.value, cacheStatus: "fresh", cachedAt: entry.fetchedAt };
  }
  if (age < QUOTA_STALE_TTL_MS) {
    return { value: entry.value, cacheStatus: "stale", cachedAt: entry.fetchedAt };
  }
  QUOTA_CACHE.delete(connectionId);
  return null;
}

function writeQuotaCache(connectionId, value) {
  const existing = QUOTA_CACHE.get(connectionId);
  QUOTA_CACHE.set(connectionId, {
    value,
    fetchedAt: Date.now(),
    pending: existing?.pending || null,
  });
}

/**
 * Fetch usage with single-flight dedup + per-connection timeout.
 * If a fetch is already in-flight for this connectionId, reuses it.
 * Caches successful results. Returns { ok, data } | { ok:false, status, error }.
 */
export function fetchConnectionUsageCached(connectionId) {
  const entry = QUOTA_CACHE.get(connectionId);
  if (entry?.pending) return entry.pending;

  const promise = (async () => {
    const timeout = new Promise((resolve) =>
      setTimeout(
        () => resolve({ ok: false, status: 504, error: "Usage refresh timed out" }),
        QUOTA_FETCH_TIMEOUT_MS,
      ),
    );
    const result = await Promise.race([
      fetchConnectionUsage(connectionId),
      timeout,
    ]);
    if (result?.ok) {
      writeQuotaCache(connectionId, result);
    }
    const cur = QUOTA_CACHE.get(connectionId);
    if (cur) cur.pending = null;
    return result;
  })();

  if (entry) {
    entry.pending = promise;
  } else {
    QUOTA_CACHE.set(connectionId, { value: null, fetchedAt: 0, pending: promise });
  }
  return promise;
}
