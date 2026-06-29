"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import ProviderIcon from "@/shared/components/ProviderIcon";
import QuotaTable from "./QuotaTable";
import Toggle from "@/shared/components/Toggle";
import Tooltip from "@/shared/components/Tooltip";
import {
  parseQuotaData,
  calculatePercentage,
  getConnectionLabel,
  getConnectionQuotaRemaining,
  sortVisibleConnections,
  filterQuotaStateByConnections,
  getConnectionsEmptyMessage,
  getPageSizeLabel,
  getConnectionsPaginationSummary,
  getSafePagination,
  getSafeTotals,
  shouldResetPage,
  getPaginationPageValue,
  getProviderOptions,
  reconcileConnectionsPage,
  getQuotaCache,
  setQuotaCache,
  setQuotaCacheBatch,
  getConnectionsCache,
  setConnectionsCache,
  QUOTA_CACHE_KEY,
  REFRESH_INTERVAL_MS,
  CLAUDE_REFRESH_INTERVAL_MS,
  DEPLETED_QUOTA_THRESHOLD,
  AUTO_REFRESH_STORAGE_KEY,
  CONNECTIONS_PAGE_SIZE,
  ACCOUNT_PAGE_SIZE_OPTIONS,
  ACCOUNT_PAGE_SIZE_MAX,
  ACCOUNT_FILTER_OPTIONS,
  QUOTA_SORT_OPTIONS,
} from "./utils";
import Card from "@/shared/components/Card";
import { ConfirmModal, EditConnectionModal } from "@/shared/components";
import { USAGE_SUPPORTED_PROVIDERS, USAGE_APIKEY_PROVIDERS } from "@/shared/constants/providers";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

// Maps the stored providerSpecificData.authMethod to a human label for Kiro.
// Values come from the Kiro connect flows: builder-id/idc (device code),
// google/github (social), imported (refresh-token paste), api_key (headless).
const KIRO_METHOD_LABELS = {
  "builder-id": "AWS Builder ID",
  idc: "IAM Identity Center",
  google: "Google",
  github: "GitHub",
  imported: "Imported Token",
  api_key: "API Key",
};

function kiroMethodLabel(conn) {
  const m = conn.providerSpecificData?.authMethod;
  if (m && KIRO_METHOD_LABELS[m]) return KIRO_METHOD_LABELS[m];
  return conn.authType === "api_key" ? "API Key" : "OAuth";
}

function getConnectionSecondaryLabel(connection) {
  if (connection.name?.trim() && connection.email?.trim() && connection.name.trim() !== connection.email.trim()) {
    return connection.email.trim();
  }

  if (connection.name?.trim() && connection.displayName?.trim() && connection.name.trim() !== connection.displayName.trim()) {
    return connection.displayName.trim();
  }

  return null;
}

// Region is stored for builder-id/idc/api_key flows; social and imported flows
// omit it, so fall back to the region segment of the profileArn
// (arn:aws:codewhisperer:<region>:...).
function kiroRegion(conn) {
  const r = conn.providerSpecificData?.region;
  if (r) return r;
  const arn = conn.providerSpecificData?.profileArn;
  const seg = typeof arn === "string" ? arn.split(":")[3] : "";
  return seg || "";
}

function getCodexResetCreditCount(quota) {
  const value = quota?.raw?.resetCredits?.availableCount;
  const count = typeof value === "number" ? value : Number(value);
  return Number.isFinite(count) ? Math.max(0, count) : 0;
}


// Connection is eligible for the quota page when it uses OAuth or is an apikey provider whitelisted for quota
const isUsageEligible = (conn) =>
  USAGE_SUPPORTED_PROVIDERS.includes(conn.provider) &&
  (conn.authType === "oauth" || USAGE_APIKEY_PROVIDERS.includes(conn.provider));

const AUTO_MANAGE_STORAGE_KEY = "quotaAutoManage";
const DEFAULT_PROVIDER_FILTER_KEY = "quotaDefaultProviderFilter";
export default function ProviderLimits() {
  const { copied, copy } = useCopyToClipboard();
  const [connections, setConnections] = useState([]);
  const [quotaData, setQuotaData] = useState({});
  const [loading, setLoading] = useState({});
  const [errors, setErrors] = useState({});
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [autoManage, setAutoManage] = useState(() => {
    if (typeof window === "undefined") return true;
    const stored = window.localStorage.getItem(AUTO_MANAGE_STORAGE_KEY);
    return stored === null ? true : stored === "true";
  });
  const [autoManageNotice, setAutoManageNotice] = useState(null);
  const [autoPingMap, setAutoPingMap] = useState({});
  const [lastUpdated, setLastUpdated] = useState(null);
  const [hasHydratedAutoRefresh, setHasHydratedAutoRefresh] = useState(false);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [countdown, setCountdown] = useState(60);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const [deletingId, setDeletingId] = useState(null);
  const [togglingId, setTogglingId] = useState(null);
  const [resettingLimitId, setResettingLimitId] = useState(null);
  const [resetConfirmState, setResetConfirmState] = useState(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedConnection, setSelectedConnection] = useState(null);
  const [proxyPools, setProxyPools] = useState([]);
  const [providerFilter, setProviderFilter] = useState(() => {
    if (typeof window === "undefined") return "all";
    return window.localStorage.getItem(DEFAULT_PROVIDER_FILTER_KEY) || "all";
  });
  const [defaultProviderFilter, setDefaultProviderFilter] = useState(() => {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(DEFAULT_PROVIDER_FILTER_KEY);
  });
  const [providerOptions, setProviderOptions] = useState([]);
  const [accountFilter, setAccountFilter] = useState("all");
  const [quotaSortMode, setQuotaSortMode] = useState("default");
  const [expiringFirst, setExpiringFirst] = useState(false);
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const [bulkToggling, setBulkToggling] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(CONNECTIONS_PAGE_SIZE);
  const [customPageSizeInput, setCustomPageSizeInput] = useState(
    String(CONNECTIONS_PAGE_SIZE),
  );
  const [pagination, setPagination] = useState({
    page: 1,
    pageSize: CONNECTIONS_PAGE_SIZE,
    total: 0,
    totalPages: 1,
  });
  const [totals, setTotals] = useState({
    eligibleConnections: 0,
    providerFilteredConnections: 0,
  });

  const intervalRef = useRef(null);
  const connectionsRef = useRef(connections);
  const hydratedRef = useRef(false);
  const countdownRef = useRef(null);
  const tickCountRef = useRef(0);
  const resetRefreshTimerRef = useRef(null);

  const fetchConnections = useCallback(
    async (targetPage = page) => {
      try {
        const params = new URLSearchParams({
          page: String(targetPage),
          pageSize: String(pageSize),
          accountStatus: accountFilter,
          sort: "priority",
        });

        if (providerFilter !== "all") {
          params.set("provider", providerFilter);
        }

        const response = await fetch(
          `/api/providers/client?${params.toString()}`,
        );
        if (!response.ok) throw new Error("Failed to fetch connections");

        const data = await response.json();
        const connectionList = data.connections || [];
        const nextPagination = getSafePagination(data.pagination, pageSize);
        const nextTotals = getSafeTotals(data.totals, connectionList.length);
        const providerOpts = getProviderOptions(data.providerOptions);

        setConnections(connectionList);
        setProviderOptions(providerOpts);
        setPagination(nextPagination);
        setTotals(nextTotals);
        setPage(getPaginationPageValue(data.pagination, targetPage));
        setConnectionsCache({
          connections: connectionList,
          pagination: nextPagination,
          totals: nextTotals,
          providerOptions: providerOpts,
        });
        return connectionList;
      } catch (error) {
        console.error("Error fetching connections:", error);
        return connectionsRef.current;
      }
    },
    [accountFilter, expiringFirst, page, pageSize, providerFilter],
  );

  // Fetch quota for a specific connection
  const fetchQuota = useCallback(async (connectionId, provider) => {
    setLoading((prev) => ({ ...prev, [connectionId]: true }));
    setErrors((prev) => ({ ...prev, [connectionId]: null }));

    try {
      const response = await fetch(`/api/usage/${connectionId}`);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMsg = errorData.error || response.statusText;

        // Handle different error types gracefully
        if (response.status === 404) {
          return;
        }

        if (response.status === 401) {
          const quotaEntry = {
            quotas: [],
            message: errorMsg,
          };
          setQuotaData((prev) => ({
            ...prev,
            [connectionId]: quotaEntry,
          }));
          setQuotaCache(connectionId, quotaEntry);
          return;
        }

        throw new Error(`HTTP ${response.status}: ${errorMsg}`);
      }

      const data = await response.json();

      // Parse quota data using provider-specific parser
      const parsedQuotas = parseQuotaData(provider, data);

      const quotaEntry = {
        quotas: parsedQuotas,
        plan: data.plan || null,
        message: data.message || null,
        raw: data,
      };

      setQuotaData((prev) => ({
        ...prev,
        [connectionId]: quotaEntry,
      }));
      setQuotaCache(connectionId, quotaEntry);
    } catch (error) {
      console.error(
        `[ProviderLimits] Error fetching quota for ${provider} (${connectionId}):`,
        error,
      );
      setErrors((prev) => ({
        ...prev,
        [connectionId]: error.message || "Failed to fetch quota",
      }));
    } finally {
      setLoading((prev) => ({ ...prev, [connectionId]: false }));
    }
  }, []);

  // Batch-fetch quotas for many connections in a single request.
  // Replaces the N+1 per-connection fetches that bottlenecked the quota page.
  const fetchQuotaBatch = useCallback(async (conns, { showLoading = true } = {}) => {
    if (!conns || conns.length === 0) return;
    const ids = conns.map((c) => c.id);
    const providerById = new Map(conns.map((c) => [c.id, c.provider]));

    if (showLoading) {
      setLoading((prev) => {
        const next = { ...prev };
        for (const id of ids) next[id] = true;
        return next;
      });
    }
    setErrors((prev) => {
      const next = { ...prev };
      for (const id of ids) next[id] = null;
      return next;
    });

    try {
      const response = await fetch("/api/usage/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionIds: ids }),
      });

      if (!response.ok) {
        // Batch endpoint unavailable - fall back to per-connection fetch
        await Promise.all(conns.map((c) => fetchQuota(c.id, c.provider)));
        return;
      }

      const payload = await response.json();
      const results = payload?.results || {};

      const newQuotaData = {};
      const newErrors = {};

      for (const id of ids) {
        const provider = providerById.get(id);
        const result = results[id];

        if (!result) {
          newErrors[id] = "No quota response";
          continue;
        }

        if (result.ok) {
          const data = result.data;
          const parsedQuotas = parseQuotaData(provider, data);
          newQuotaData[id] = {
            quotas: parsedQuotas,
            plan: data?.plan || null,
            message: data?.message || null,
            raw: data,
          };
        } else if (result.status === 404) {
          // Connection not found - skip silently
        } else if (result.status === 401) {
          newQuotaData[id] = { quotas: [], message: result.error };
        } else {
          newErrors[id] = result.error || "Failed to fetch quota";
        }
      }

      if (Object.keys(newQuotaData).length > 0) {
        setQuotaData((prev) => ({ ...prev, ...newQuotaData }));
        setQuotaCacheBatch(newQuotaData);
      }
      if (Object.keys(newErrors).length > 0) {
        setErrors((prev) => ({ ...prev, ...newErrors }));
      }
    } catch (error) {
      console.error("[ProviderLimits] Batch quota fetch failed:", error);
      setErrors((prev) => {
        const next = { ...prev };
        for (const id of ids) {
          if (!next[id]) next[id] = error.message || "Failed to fetch quota";
        }
        return next;
      });
    } finally {
      setLoading((prev) => {
        const next = { ...prev };
        for (const id of ids) next[id] = false;
        return next;
      });
    }
  }, [fetchQuota]);

  // Refresh quota for a specific provider
  const refreshProvider = useCallback(
    async (connectionId, provider) => {
      await fetchQuota(connectionId, provider);
      setLastUpdated(new Date());
    },
    [fetchQuota],
  );

  const handleResetCodexLimit = useCallback(
    async (connectionId, provider) => {
      if (provider !== "codex" || resettingLimitId) return;

      setResettingLimitId(connectionId);
      setErrors((prev) => ({ ...prev, [connectionId]: null }));

      try {
        const response = await fetch(`/api/usage/${connectionId}/codex-reset-credits`, { method: "POST" });
        const result = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(result.message || result.error || result.code || "Failed to reset Codex limit");
        }

        await fetchQuota(connectionId, provider);
        setLastUpdated(new Date());
      } catch (error) {
        setErrors((prev) => ({ ...prev, [connectionId]: error.message || "Failed to reset Codex limit" }));
      } finally {
        setResettingLimitId(null);
      }
    },
    [fetchQuota, resettingLimitId],
  );

  const handleDeleteConnection = useCallback(
    async (id) => {
      if (!confirm("Delete this connection?")) return;
      setDeletingId(id);
      try {
        const res = await fetch(`/api/providers/${id}`, { method: "DELETE" });
        if (res.ok) {
          setQuotaData((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
          setLoading((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
          setErrors((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });

          if (typeof window !== "undefined") {
            try {
              const cache = getQuotaCache();
              if (cache[id]) {
                delete cache[id];
                window.localStorage.setItem(
                  QUOTA_CACHE_KEY,
                  JSON.stringify(cache),
                );
              }
            } catch (e) {
              console.error("Error deleting cache entry:", e);
            }
          }

          await reconcileConnectionsPage(fetchConnections, page);
        }
      } catch (error) {
        console.error("Error deleting connection:", error);
      } finally {
        setDeletingId(null);
      }
    },
    [fetchConnections, page],
  );

  const handleToggleConnectionActive = useCallback(
    async (id, isActive) => {
      setTogglingId(id);
      try {
        const res = await fetch(`/api/providers/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isActive }),
        });
        if (res.ok) {
          setQuotaData((prev) => {
            const next = { ...prev };
            return next;
          });
          await reconcileConnectionsPage(fetchConnections, page);
        }
      } catch (error) {
        console.error("Error updating connection status:", error);
      } finally {
        setTogglingId(null);
      }
    },
    [fetchConnections, page],
  );

  const handleUpdateConnection = useCallback(
    async (formData) => {
      if (!selectedConnection?.id) return;
      const connectionId = selectedConnection.id;
      const provider = selectedConnection.provider;
      try {
        const res = await fetch(`/api/providers/${connectionId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(formData),
        });
        if (res.ok) {
          await fetchConnections();
          setShowEditModal(false);
          setSelectedConnection(null);
          if (USAGE_SUPPORTED_PROVIDERS.includes(provider)) {
            await fetchQuota(connectionId, provider);
          }
        }
      } catch (error) {
        console.error("Error saving connection:", error);
      }
    },
    [selectedConnection, fetchConnections, fetchQuota],
  );

  useEffect(() => {
    let cancelled = false;
    fetch("/api/proxy-pools?isActive=true", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && data?.proxyPools) {
          setProxyPools(data.proxyPools);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshAll = useCallback(async (force = false) => {
    if (refreshingAll) return;

    setRefreshingAll(true);
    setCountdown(60);

    // Throttle Claude: poll its quota every Nth auto-tick (manual force bypasses)
    const tick = (tickCountRef.current += 1);
    const claudeEvery = Math.round(CLAUDE_REFRESH_INTERVAL_MS / REFRESH_INTERVAL_MS);
    const shouldFetch = (conn) =>
      force || conn.provider !== "claude" || tick % claudeEvery === 0;

    try {
      const visibleConnections = await fetchConnections(page);
      const toFetch = visibleConnections.filter(shouldFetch);

      setLoading((prev) => {
        const next = { ...prev };
        for (const conn of toFetch) {
          next[conn.id] = !quotaData[conn.id];
        }
        return next;
      });
      setErrors((prev) =>
        filterQuotaStateByConnections(prev, visibleConnections),
      );
      setQuotaData((prev) =>
        filterQuotaStateByConnections(prev, visibleConnections),
      );

      await fetchQuotaBatch(toFetch);

      setLastUpdated(new Date());
    } catch (error) {
      console.error("Error refreshing all providers:", error);
    } finally {
      setRefreshingAll(false);
    }
  }, [refreshingAll, fetchConnections, fetchQuotaBatch, page, quotaData]);

  useEffect(() => {
    const initializeData = async () => {
      const isFirstHydration = !hydratedRef.current;
      if (isFirstHydration) {
        hydratedRef.current = true;
        const snapshot = getConnectionsCache();
        if (snapshot?.connections?.length) {
          setConnections(snapshot.connections);
          setProviderOptions(snapshot.providerOptions || []);
          setPagination(
            snapshot.pagination || {
              page: 1,
              pageSize,
              total: snapshot.connections.length,
              totalPages: 1,
            },
          );
          setTotals(
            snapshot.totals || {
              eligibleConnections: 0,
              providerFilteredConnections: 0,
            },
          );
          setConnectionsLoading(false);

          const quotaCache = getQuotaCache();
          const cachedQuota = {};
          for (const conn of snapshot.connections) {
            if (quotaCache[conn.id]) cachedQuota[conn.id] = quotaCache[conn.id];
          }
          if (Object.keys(cachedQuota).length > 0) {
            setQuotaData(cachedQuota);
          }
        } else {
          setConnectionsLoading(true);
        }
      }

      const visibleConnections = await fetchConnections(page);
      setConnectionsLoading(false);

      // Stale-while-revalidate: show cached quota immediately, only show
      // loading skeletons for connections without cached data.
      const cache = getQuotaCache();
      const cachedVisible = {};
      const loadingState = {};
      for (const conn of visibleConnections) {
        if (cache[conn.id]) {
          cachedVisible[conn.id] = cache[conn.id];
        } else {
          loadingState[conn.id] = true;
        }
      }
      setQuotaData((prev) => ({
        ...filterQuotaStateByConnections(prev, visibleConnections),
        ...cachedVisible,
      }));
      setLoading(loadingState);
      setErrors((prev) =>
        filterQuotaStateByConnections(prev, visibleConnections),
      );

      // Fetch fresh quota in background via a single batch request
      await fetchQuotaBatch(visibleConnections, { showLoading: false });
      setLastUpdated(new Date());
    };

    initializeData();
  }, [fetchConnections, fetchQuotaBatch, page]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(AUTO_REFRESH_STORAGE_KEY);
    setAutoRefresh(stored === null ? true : stored === "true");
    setHasHydratedAutoRefresh(true);
  }, []);

  // Persist auto-refresh preference
  useEffect(() => {
    if (typeof window === "undefined" || !hasHydratedAutoRefresh) return;
    window.localStorage.setItem(AUTO_REFRESH_STORAGE_KEY, String(autoRefresh));
  }, [autoRefresh, hasHydratedAutoRefresh]);

  // Load Claude auto-ping per-connection map
  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : {}))
      .then((s) => setAutoPingMap(s?.claudeAutoPing?.connections || {}))
      .catch(() => {});
  }, []);

  const toggleAutoPing = useCallback(async (connectionId, on) => {
    const next = { ...autoPingMap, [connectionId]: on };
    setAutoPingMap(next);
    try {
      const r = await fetch("/api/settings", { cache: "no-store" });
      const s = r.ok ? await r.json() : {};
      const cfg = { ...(s.claudeAutoPing || {}), connections: next };
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claudeAutoPing: cfg }),
      });
    } catch {
      setAutoPingMap(autoPingMap);
    }
  }, [autoPingMap]);

  // Auto-refresh interval
  useEffect(() => {
    if (!hasHydratedAutoRefresh || !autoRefresh) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (countdownRef.current) {
        clearInterval(countdownRef.current);
        countdownRef.current = null;
      }
      return;
    }

    // Main refresh interval
    intervalRef.current = setInterval(() => {
      refreshAll();
    }, REFRESH_INTERVAL_MS);

    // Countdown interval
    countdownRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) return 60;
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [autoRefresh, refreshAll, hasHydratedAutoRefresh]);

  // Pause auto-refresh when tab is hidden (Page Visibility API)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
        if (countdownRef.current) {
          clearInterval(countdownRef.current);
          countdownRef.current = null;
        }
      } else if (autoRefresh && hasHydratedAutoRefresh) {
        // Resume auto-refresh when tab becomes visible
        intervalRef.current = setInterval(() => refreshAll(), REFRESH_INTERVAL_MS);
        countdownRef.current = setInterval(() => {
          setCountdown((prev) => (prev <= 1 ? 60 : prev - 1));
        }, 1000);
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [autoRefresh, refreshAll, hasHydratedAutoRefresh]);

  const sortedConnections = useMemo(
    () =>
      sortVisibleConnections(
        connections,
        quotaData,
        expiringFirst,
        providerFilter,
        quotaSortMode,
      ),
    [connections, quotaData, expiringFirst, providerFilter, quotaSortMode],
  );

  // Connection is depleted when any quota entry hit the threshold
  const isConnectionDepleted = (conn) => {
    const quotas = quotaData[conn.id]?.quotas;
    if (!quotas?.length) return false;
    return quotas.some((q) => {
      if (!q.total || q.total <= 0) return false;
      return calculatePercentage(q.used, q.total) <= DEPLETED_QUOTA_THRESHOLD;
    });
  };

  // A connection is payment-blocked when it currently has an active 402
  // (Payment Required / billing) error. Such connections must stay disabled
  // even when quota numbers look positive, because the upstream account has a
  // billing problem that quota data does not reflect.
  const isConnectionPaymentBlocked = (conn) => {
    if (conn?.errorCode === 402 && conn?.testStatus === "unavailable") return true;
    const err = String(conn?.lastError || "").toLowerCase();
    return err.includes("payment required") || err.includes("billing_error");
  };

  // A connection is quota-API blocked when the upstream quota API returned an
  // auth/forbidden state (e.g. Antigravity "quota API authentication expired",
  // "quota API access forbidden", or Codex usage API 401). The chat path may still work, but we
  // cannot trust quota numbers, so auto-manage must keep it disabled instead of
  // re-enabling it on stale/positive-looking data.
  const isConnectionQuotaBlocked = (conn) => {
    const msg = String(quotaData[conn.id]?.message || "").toLowerCase();
    if (!msg) return false;
    return (
      msg.includes("quota api authentication expired") ||
      msg.includes("quota api access forbidden") ||
      msg.includes("usage api temporarily unavailable (401)") ||
      msg.includes("authentication expired") ||
      msg.includes("access forbidden")
    );
  };

  // Connection is fully available only when ALL quota types are above threshold.
  // AND condition: session AND weekly must both be positive; one depleted -> stays disabled.
  // A 402 payment-blocked connection is never "fully available" regardless of quota.
  const isConnectionFullyAvailable = (conn) => {
    if (isConnectionPaymentBlocked(conn)) return false;
    if (isConnectionQuotaBlocked(conn)) return false;
    const quotas = quotaData[conn.id]?.quotas;
    if (!quotas?.length) return false;
    return quotas.every((q) => {
      if (!q.total || q.total <= 0) return false;
      return calculatePercentage(q.used, q.total) > DEPLETED_QUOTA_THRESHOLD;
    });
  };

  const bulkSetActive = useCallback(
    async (targetIds, isActive) => {
      if (!targetIds.length || bulkToggling) return;
      setBulkToggling(true);
      try {
        await Promise.all(
          targetIds.map((id) =>
            fetch(`/api/providers/${id}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ isActive }),
            }),
          ),
        );
        await reconcileConnectionsPage(fetchConnections, page);
      } catch (error) {
        console.error("Error bulk toggling connections:", error);
      } finally {
        setBulkToggling(false);
      }
    },
    [bulkToggling, fetchConnections, page],
  );

  const bulkToggleMixed = useCallback(
    async (toggles) => {
      if (!toggles.length || bulkToggling) return;
      setBulkToggling(true);
      try {
        await Promise.all(
          toggles.map(({ id, isActive }) =>
            fetch(`/api/providers/${id}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ isActive }),
            }),
          ),
        );
        setConnections((prev) =>
          prev.map((c) => {
            const toggle = toggles.find((t) => t.id === c.id);
            return toggle ? { ...c, isActive: toggle.isActive } : c;
          }),
        );
      } catch (error) {
        console.error("Error bulk toggling connections:", error);
      } finally {
        setBulkToggling(false);
      }
    },
    [bulkToggling],
  );

  const handleSetDefaultProvider = useCallback(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(DEFAULT_PROVIDER_FILTER_KEY, providerFilter);
    setDefaultProviderFilter(providerFilter);
    setProviderMenuOpen(false);
  }, [providerFilter]);

  const handleDisableDepleted = () => {
    const ids = sortedConnections
      .filter((c) => (c.isActive ?? true) && isConnectionDepleted(c))
      .map((c) => c.id);
    bulkSetActive(ids, false);
  };

  const handleEnableAvailable = () => {
    const ids = sortedConnections
      .filter((c) => !(c.isActive ?? true) && isConnectionFullyAvailable(c))
      .map((c) => c.id);
    bulkSetActive(ids, true);
  };
  // Keep connectionsRef synced so auto-manage reads current isActive without
  // re-running every time our own toggle updates the connections array.
  useEffect(() => {
    connectionsRef.current = connections;
  }, [connections]);

  useEffect(() => {
    if (!autoManage) return;
    if (resetRefreshTimerRef.current) {
      clearTimeout(resetRefreshTimerRef.current);
      resetRefreshTimerRef.current = null;
    }

    const now = Date.now();
    const nextReset = Object.values(quotaData)
      .flatMap((entry) => entry?.quotas || [])
      .map((quota) => quota?.resetAt ? new Date(quota.resetAt).getTime() : NaN)
      .filter((time) => Number.isFinite(time) && time > now)
      .sort((a, b) => a - b)[0];

    if (!nextReset) return;

    const delay = Math.min(Math.max(nextReset - now + 2000, 1000), 2_147_483_647);
    resetRefreshTimerRef.current = setTimeout(() => {
      const conns = connectionsRef.current.filter((conn) =>
        conn.authType === "oauth" && isUsageEligible(conn) && !(conn.isActive ?? true)
      );
      if (conns.length > 0) {
        fetchQuotaBatch(conns, { showLoading: false });
      } else {
        refreshAll(true);
      }
    }, delay);

    return () => {
      if (resetRefreshTimerRef.current) {
        clearTimeout(resetRefreshTimerRef.current);
        resetRefreshTimerRef.current = null;
      }
    };
  }, [autoManage, quotaData, fetchQuotaBatch, refreshAll]);

  // Auto-manage: disable depleted connections, re-enable fully available ones.
  // AND condition: a connection is re-enabled only when ALL quota types
  // (session AND weekly) are positive; one depleted -> stays disabled.
  // Depends on quotaData (trigger) + autoManage + bulkToggling only, not on
  // sortedConnections, to avoid re-running after our own active-state toggles.
  useEffect(() => {
    if (!autoManage || bulkToggling) return;

    const conns = connectionsRef.current.filter(
      (conn) => conn.authType === "oauth" && isUsageEligible(conn),
    );

    const toggles = [
      ...conns
        .filter((c) => (c.isActive ?? true) && (isConnectionDepleted(c) || isConnectionPaymentBlocked(c) || isConnectionQuotaBlocked(c)))
        .map((c) => ({ id: c.id, isActive: false })),
      ...conns
        .filter((c) => !(c.isActive ?? true) && isConnectionFullyAvailable(c))
        .map((c) => ({ id: c.id, isActive: true })),
    ];

    if (toggles.length > 0) {
      const disabled = toggles.filter((t) => !t.isActive).length;
      const enabled = toggles.filter((t) => t.isActive).length;
      const notices = [];
      if (disabled > 0) notices.push(`Auto-disabled ${disabled} account(s) (depleted, payment, or quota API error)`);
      if (enabled > 0) notices.push(`Auto-enabled ${enabled} account(s) with available quota`);
      setAutoManageNotice(notices.join(" - "));
      bulkToggleMixed(toggles);
    }
  }, [autoManage, quotaData, bulkToggling]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear auto-manage notice after 5 seconds
  useEffect(() => {
    if (!autoManageNotice) return;
    const t = setTimeout(() => setAutoManageNotice(null), 5000);
    return () => clearTimeout(t);
  }, [autoManageNotice]);

  // Auto-retry failed quota fetches for self-healing (10s delay).
  // When a quota fetch fails, automatically retry after 10s without
  // manual refresh. Clears timers for connections that recovered.
  const retryTimersRef = useRef({});

  useEffect(() => {
    const errorIds = new Set(
      Object.entries(errors)
        .filter(([, err]) => err)
        .map(([id]) => id),
    );

    // Clear timers for connections that no longer have errors
    Object.keys(retryTimersRef.current).forEach((id) => {
      if (!errorIds.has(id)) {
        clearTimeout(retryTimersRef.current[id]);
        delete retryTimersRef.current[id];
      }
    });

    // Schedule retries for connections with errors
    errorIds.forEach((id) => {
      if (retryTimersRef.current[id]) return;

      const conn = connectionsRef.current.find((c) => c.id === id);
      if (!conn || !isUsageEligible(conn)) return;

      retryTimersRef.current[id] = setTimeout(() => {
        delete retryTimersRef.current[id];
        fetchQuota(id, conn.provider);
      }, 10_000);
    });
  }, [errors, fetchQuota]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup all retry timers on unmount
  useEffect(() => {
    const timers = retryTimersRef.current;
    return () => {
      Object.values(timers).forEach(clearTimeout);
    };
  }, []);

  // Validate saved default provider filter still has eligible connections;
  // reset to "all" if the pinned provider disappeared (e.g. disconnected).
  useEffect(() => {
    if (connectionsLoading || providerFilter === "all") return;
    const hasProvider = connections.some(
      (c) => isUsageEligible(c) && c.provider === providerFilter,
    );
    if (!hasProvider && connections.some(isUsageEligible)) {
      setProviderFilter("all");
    }
  }, [connectionsLoading, providerFilter, connections]);

  const selectedProviderLabel =
    providerFilter === "all" ? "All providers" : providerFilter;
  const hasEligibleConnections = totals.eligibleConnections > 0;
  const hasVisibleConnections = sortedConnections.length > 0;
  const emptyState = getConnectionsEmptyMessage(
    totals,
    providerFilter,
    accountFilter,
  );
  const connectionsPageSummary = getConnectionsPaginationSummary(pagination);
  const isCustomPageSize = !ACCOUNT_PAGE_SIZE_OPTIONS.includes(pageSize);
  const pageSizeLabel = getPageSizeLabel(pageSize, isCustomPageSize);

  if (!connectionsLoading && !hasEligibleConnections) {
    return (
      <Card padding="lg">
        <div className="text-center py-12">
          <span className="material-symbols-outlined text-[64px] text-text-muted opacity-20">
            cloud_off
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">
            No Providers Connected
          </h3>
          <p className="mt-2 text-sm text-text-muted max-w-md mx-auto">
            Connect to providers with OAuth to track your API quota limits and
            usage.
          </p>
        </div>
      </Card>
    );
  }

  if (!connectionsLoading && !hasVisibleConnections) {
    return (
      <Card padding="lg">
        <div className="text-center py-12">
          <span className="material-symbols-outlined text-[64px] text-text-muted opacity-20">
            {emptyState.icon}
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">
            {emptyState.title}
          </h3>
          <p className="mt-2 text-sm text-text-muted max-w-md mx-auto">
            {emptyState.description}
          </p>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header Controls */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-end">
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="relative">
            <button
              type="button"
              onClick={() => setProviderMenuOpen((prev) => !prev)}
              className="flex h-8 items-center justify-between gap-1 rounded-lg border border-black/10 bg-black/[0.02] px-2 text-xs text-text-primary transition-colors hover:bg-black/5 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/10"
              aria-haspopup="menu"
              aria-expanded={providerMenuOpen}
              title="Filter quota providers"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {providerFilter === "all" ? (
                  <span className="material-symbols-outlined text-[14px] text-text-muted">
                    apps
                  </span>
                ) : (
                  <ProviderIcon
                    src={`/providers/${providerFilter}.png`}
                    alt={providerFilter}
                    size={18}
                    className="size-[18px] rounded object-contain"
                    fallbackText={providerFilter.slice(0, 2).toUpperCase()}
                  />
                )}
                <span className="truncate capitalize hidden lg:inline">
                  {selectedProviderLabel}
                </span>
              </span>
              <span className="material-symbols-outlined text-[14px] text-text-muted">
                expand_more
              </span>
            </button>

            {providerMenuOpen && (
              <>
                <button
                  type="button"
                  className="fixed inset-0 z-30 bg-transparent"
                  aria-label="Close provider filter"
                  onClick={() => setProviderMenuOpen(false)}
                />
                <div className="absolute left-0 z-40 mt-2 w-64 overflow-hidden rounded-2xl border border-black/10 bg-surface/95 p-1.5 shadow-xl shadow-black/10 backdrop-blur dark:border-white/10 dark:bg-surface/95 sm:w-72">
                  <button
                    type="button"
                    onClick={() => {
                      if (shouldResetPage(providerFilter, "all")) {
                        setPage(1);
                      }
                      setProviderFilter("all");
                      setProviderMenuOpen(false);
                    }}
                    className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors ${providerFilter === "all" ? "bg-primary/10 text-primary" : "text-text-primary hover:bg-black/5 dark:hover:bg-white/10"}`}
                  >
                    <span className="material-symbols-outlined text-[22px]">
                      apps
                    </span>
                    <span className="font-medium">All providers</span>
                    {providerFilter === "all" && (
                      <span className="material-symbols-outlined ml-auto text-[20px]">
                        check
                      </span>
                    )}
                  </button>
                  <div className="my-1 h-px bg-black/10 dark:bg-white/10" />
                  <div className="max-h-72 overflow-y-auto pr-1">
                    {providerOptions.map((provider) => (
                      <button
                        key={provider}
                        type="button"
                        onClick={() => {
                          if (shouldResetPage(providerFilter, provider)) {
                            setPage(1);
                          }
                          setProviderFilter(provider);
                          setProviderMenuOpen(false);
                        }}
                        className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors ${providerFilter === provider ? "bg-primary/10 text-primary" : "text-text-primary hover:bg-black/5 dark:hover:bg-white/10"}`}
                      >
                        <ProviderIcon
                          src={`/providers/${provider}.png`}
                          alt={provider}
                          size={24}
                          className="size-6 rounded-md object-contain"
                          fallbackText={provider.slice(0, 2).toUpperCase()}
                        />
                        <span className="font-medium capitalize">
                          {provider}
                        </span>
                        {providerFilter === provider && (
                          <span className="material-symbols-outlined ml-auto text-[20px]">
                            check
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                  {/* Set as default provider view */}
                  <div className="my-1 h-px bg-black/10 dark:bg-white/10" />
                  <button
                    type="button"
                    onClick={handleSetDefaultProvider}
                    className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-xs transition-colors ${
                      defaultProviderFilter === providerFilter
                        ? "text-primary"
                        : "text-text-muted hover:bg-black/5 dark:hover:bg-white/10"
                    }`}
                    title="Remember current provider view for next visits"
                  >
                    <span className="material-symbols-outlined text-[16px]">
                      {defaultProviderFilter === providerFilter ? "check_circle" : "push_pin"}
                    </span>
                    <span>
                      {defaultProviderFilter === providerFilter
                        ? "Default view"
                        : "Set as default view"}
                    </span>
                  </button>
                </div>
              </>
            )}
          </div>
          <select
            value={accountFilter}
            onChange={(event) => {
              const nextValue = event.target.value;
              if (shouldResetPage(accountFilter, nextValue)) {
                setPage(1);
              }
              setAccountFilter(nextValue);
            }}
            className="h-8 rounded-lg border border-black/10 bg-black/[0.02] px-2 text-xs text-text-primary outline-none transition-colors hover:bg-black/5 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/10"
            aria-label="Filter accounts by status"
          >
            {ACCOUNT_FILTER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          {providerFilter === "codex" && (
            <select
              value={quotaSortMode}
              onChange={(event) => setQuotaSortMode(event.target.value)}
              className="h-8 rounded-lg border border-black/10 bg-black/[0.02] px-2 text-xs text-text-primary outline-none transition-colors hover:bg-black/5 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/10"
              aria-label="Sort Codex quotas by remaining"
            >
              {QUOTA_SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          )}

          <button
            type="button"
            onClick={() => setExpiringFirst((prev) => !prev)}
            aria-pressed={expiringFirst}
            className={`flex h-8 shrink-0 items-center gap-1 rounded-lg border px-2 text-xs transition-colors ${expiringFirst ? "border-amber-500/40 bg-amber-500/10 text-amber-500" : "border-black/10 text-text-primary hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"}`}
            title="Sort accounts by earliest quota reset time"
          >
            <span className="material-symbols-outlined text-[14px]">
              hourglass_top
            </span>
            <span className="hidden sm:inline">Expiring first</span>
          </button>

          {/* Bulk: disable depleted */}
          <button
            type="button"
            onClick={handleDisableDepleted}
            disabled={bulkToggling}
            className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-red-500/30 px-2 text-xs text-red-500 transition-colors hover:bg-red-500/10 disabled:opacity-50"
            title="Disable connections with depleted quota on the current page"
          >
            <span className="material-symbols-outlined text-[14px]">block</span>
            <span className="hidden sm:inline">Turn off Empty</span>
          </button>

          {/* Bulk: enable available */}
          <button
            type="button"
            onClick={handleEnableAvailable}
            disabled={bulkToggling}
            className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-emerald-500/30 px-2 text-xs text-emerald-500 transition-colors hover:bg-emerald-500/10 disabled:opacity-50"
            title="Enable connections that still have quota on the current page"
          >
            <span className="material-symbols-outlined text-[14px]">
              check_circle
            </span>
            <span className="hidden sm:inline">Turn on Available</span>
          </button>

          {/* Auto-manage toggle */}
          <button
            onClick={() => setAutoManage((prev) => !prev)}
            className={`flex h-8 shrink-0 items-center gap-1 rounded-lg border px-2 text-xs transition-colors ${autoManage ? "border-primary/30 bg-primary/5 text-primary" : "border-black/10 text-text-primary hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"}`}
            title={autoManage ? "Auto quota management is ON — depleted accounts auto-disabled, available accounts auto-enabled" : "Enable auto quota management"}
          >
            <span className="material-symbols-outlined text-[14px]">bolt</span>
            <span className="hidden sm:inline">Auto-manage</span>
          </button>

          {/* Auto-refresh toggle */}
          <button
            onClick={() => setAutoRefresh((prev) => !prev)}
            className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-black/10 px-2 text-xs transition-colors hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"
            title={autoRefresh ? "Disable auto-refresh" : "Enable auto-refresh"}
          >
            <span
              className={`material-symbols-outlined text-[14px] ${
                autoRefresh ? "text-primary" : "text-text-muted"
              }`}
            >
              {autoRefresh ? "toggle_on" : "toggle_off"}
            </span>
            <span className="hidden text-text-primary sm:inline">
              Auto-refresh
            </span>
            {autoRefresh && (
              <span className="text-[10px] text-text-muted tabular-nums">
                ({countdown}s)
              </span>
            )}
          </button>


          {/* Refresh all button */}
          <button
            type="button"
            onClick={() => refreshAll(true)}
            disabled={refreshingAll}
            className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-black/10 px-2 text-xs text-text-primary transition-colors hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5 disabled:opacity-50"
            title="Refresh all"
          >
            <span
              className={`material-symbols-outlined text-[14px] ${refreshingAll ? "animate-spin" : ""}`}
            >
              refresh
            </span>
          </button>
        </div>
      </div>

      {/* Auto-manage notice */}
      {autoManageNotice && autoManage && (
        <div className="flex items-center gap-2 rounded-lg bg-primary/10 px-3 py-1.5 text-xs text-primary">
          <span className="material-symbols-outlined text-[14px]">bolt</span>
          {autoManageNotice}
        </div>
      )}

      {/* Provider cards: 2 columns, compact */}
      {expiringFirst && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          Expiring-first currently reorders accounts inside the current page.
          Cross-page ordering still follows backend pagination.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {sortedConnections.map((conn) => {
          const quota = quotaData[conn.id];
          const isLoading = Boolean(loading[conn.id]);
          const error = errors[conn.id];
          const hasQuotaSnapshot = Boolean(quota);

          // Use table layout for all providers
          const isInactive = conn.isActive === false;
          const isCodex = conn.provider === "codex";
          const resetCreditCount = getCodexResetCreditCount(quota);
          const isResettingLimit = resettingLimitId === conn.id;
          const rowBusy = deletingId === conn.id || togglingId === conn.id || isResettingLimit;

          return (
            <Card
              key={conn.id}
              padding="none"
              className={`min-w-0 ${isInactive ? "opacity-60" : ""}`}
            >
              <div className="px-3 py-2 border-b border-black/10 dark:border-white/10">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-8 h-8 shrink-0 rounded-md flex items-center justify-center overflow-hidden">
                      <ProviderIcon
                        src={`/providers/${conn.provider}.png`}
                        alt={conn.provider}
                        size={32}
                        className="object-contain"
                        fallbackText={
                          conn.provider?.slice(0, 2).toUpperCase() || "PR"
                        }
                      />
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-text-primary capitalize truncate">
                        {conn.provider}
                      </h3>
                      {getConnectionLabel(conn) ? (
                        <p className="text-xs text-text-muted truncate">
                          {getConnectionLabel(conn)}
                        </p>
                      ) : null}
                      {getConnectionSecondaryLabel(conn) ? (
                        <p className="text-[11px] text-text-muted/80 truncate">
                          {getConnectionSecondaryLabel(conn)}
                        </p>
                      ) : null}
                      {isCodex && (
                        <p className="text-[11px] text-text-muted truncate">
                          Reset eligible: {resetCreditCount}
                        </p>
                      )}
                      {conn.provider === "kiro" && (
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          <span className="rounded-full bg-brand-500/10 px-2 py-0.5 text-[10px] font-semibold text-brand-600 dark:text-brand-300">
                            {kiroMethodLabel(conn)}
                          </span>
                          {kiroRegion(conn) && (
                            <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] font-semibold text-blue-600 dark:text-blue-400">
                              {kiroRegion(conn)}
                            </span>
                          )}
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                              isInactive
                                ? "bg-surface-2 text-text-muted"
                                : conn.testStatus === "active" || conn.testStatus === "success"
                                  ? "bg-green-500/10 text-green-600 dark:text-green-400"
                                  : conn.testStatus === "error" || conn.testStatus === "expired" || conn.testStatus === "unavailable"
                                    ? "bg-red-500/10 text-red-600 dark:text-red-400"
                                    : "bg-surface-2 text-text-muted"
                            }`}
                          >
                            {isInactive ? "disabled" : conn.testStatus || "unknown"}
                          </span>
                          {conn.providerSpecificData?.profileArn && (
                            <button
                              type="button"
                              onClick={() => copy(conn.providerSpecificData.profileArn, conn.id)}
                              title={conn.providerSpecificData.profileArn}
                              className="inline-flex max-w-full items-center gap-1 rounded-full border border-border-subtle px-2 py-0.5 text-[10px] text-text-muted transition-colors hover:text-primary"
                            >
                              <span className="material-symbols-outlined text-[12px]">
                                {copied === conn.id ? "check" : "content_copy"}
                              </span>
                              <code className="truncate font-mono">
                                {conn.providerSpecificData.profileArn}
                              </code>
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    {isCodex && (
                      <Tooltip text={`Codex reset credits remaining: ${resetCreditCount}`}>
                        <div
                          className={`hidden h-8 items-center gap-1 rounded-lg border px-2 text-[11px] sm:flex ${
                            resetCreditCount > 0
                              ? "border-primary/30 bg-primary/5 text-primary"
                              : "border-black/10 bg-black/[0.02] text-text-muted dark:border-white/10 dark:bg-white/[0.03]"
                          }`}
                        >
                          <span className="material-symbols-outlined text-[14px]">restart_alt</span>
                          <span className="tabular-nums">{resetCreditCount}</span>
                        </div>
                      </Tooltip>
                    )}
                    {isCodex && resetCreditCount > 0 && (
                      <Tooltip text={`Use one Codex reset credit. Available: ${resetCreditCount}`}>
                        <button
                          type="button"
                          onClick={() => setResetConfirmState({ connection: conn, resetCreditCount })}
                          disabled={isLoading || rowBusy}
                          className="flex h-8 items-center gap-1 rounded-lg border border-primary/30 px-2 text-[11px] text-primary transition-colors hover:bg-primary/10 disabled:opacity-50"
                        >
                          <span className={`material-symbols-outlined text-[15px] ${isResettingLimit ? "animate-spin" : ""}`}>
                            {isResettingLimit ? "progress_activity" : "bolt"}
                          </span>
                          <span className="hidden lg:inline">Reset limit</span>
                        </button>
                      </Tooltip>
                    )}
                    {conn.provider === "claude" && conn.authType === "oauth" && (
                      <Tooltip text="When your 5h quota runs out, auto-sends a request the moment it resets so a new window starts right away.">
                        <button
                          type="button"
                          onClick={() => toggleAutoPing(conn.id, !(autoPingMap[conn.id] === true))}
                          aria-label="Toggle auto-ping"
                          className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-black/5 dark:hover:bg-white/5 ${autoPingMap[conn.id] === true ? "text-primary" : "text-text-muted"}`}
                        >
                          <span className="material-symbols-outlined text-[18px]">bolt</span>
                        </button>
                      </Tooltip>
                    )}
                    <Tooltip text="Refresh quota">
                      <button
                        type="button"
                        onClick={() => refreshProvider(conn.id, conn.provider)}
                        disabled={isLoading || rowBusy}
                        aria-label="Refresh quota"
                        className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                      >
                        <span
                          className={`material-symbols-outlined text-[18px] text-text-muted ${isLoading ? "animate-spin" : ""}`}
                        >
                          refresh
                        </span>
                      </button>
                    </Tooltip>
                    <Tooltip text="Edit connection">
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedConnection(conn);
                          setShowEditModal(true);
                        }}
                        disabled={rowBusy}
                        aria-label="Edit connection"
                        className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-text-muted hover:text-primary transition-colors disabled:opacity-50"
                      >
                        <span className="material-symbols-outlined text-[18px]">
                          edit
                        </span>
                      </button>
                    </Tooltip>
                    <Tooltip text="Delete connection">
                      <button
                        type="button"
                        onClick={() => handleDeleteConnection(conn.id)}
                        disabled={rowBusy}
                        aria-label="Delete connection"
                        className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-red-500/10 text-red-500 transition-colors disabled:opacity-50"
                      >
                        <span
                          className={`material-symbols-outlined text-[18px] ${deletingId === conn.id ? "animate-pulse" : ""}`}
                        >
                          delete
                        </span>
                      </button>
                    </Tooltip>
                    <div
                      className="inline-flex items-center pl-0.5"
                      title={
                        (conn.isActive ?? true)
                          ? "Disable connection"
                          : "Enable connection"
                      }
                    >
                      <Toggle
                        size="sm"
                        checked={conn.isActive ?? true}
                        disabled={rowBusy}
                        onChange={(nextActive) =>
                          handleToggleConnectionActive(conn.id, nextActive)
                        }
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div className="px-2 py-1.5">
                {isLoading && !hasQuotaSnapshot ? (
                  <div className="text-center py-5 text-text-muted">
                    <span className="material-symbols-outlined text-[28px] animate-spin">
                      progress_activity
                    </span>
                  </div>
                ) : error && !hasQuotaSnapshot ? (
                  <div className="text-center py-5">
                    <span className="material-symbols-outlined text-[28px] text-red-500">
                      error
                    </span>
                    <p className="mt-1.5 text-xs text-text-muted">{error}</p>
                  </div>
                ) : quota?.message ? (
                  <div className="text-center py-5">
                    <p className="text-xs text-text-muted">{quota.message}</p>
                  </div>
                ) : (
                  <QuotaTable
                    quotas={quota?.quotas}
                    compact
                    sortMode="default"
                    showSortLabel={
                      conn.provider === "codex" && quotaSortMode !== "default"
                    }
                  />
                )}
              </div>
            </Card>
          );
        })}
      </div>

      <div className="rounded-xl border border-black/10 bg-black/[0.02] px-3 py-2 dark:border-white/10 dark:bg-white/[0.03]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-text-muted">{connectionsPageSummary}</span>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={isCustomPageSize ? "custom" : String(pageSize)}
                onChange={(event) => {
                  const nextValue = event.target.value;
                  if (nextValue === "custom") return;
                  const nextPageSize = Number.parseInt(nextValue, 10);
                  if (Number.isFinite(nextPageSize)) {
                    setPage(1);
                    setPageSize(nextPageSize);
                    setCustomPageSizeInput(String(nextPageSize));
                  }
                }}
                className="h-8 rounded-lg border border-black/10 bg-black/[0.02] px-2 text-xs text-text-primary outline-none transition-colors hover:bg-black/5 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/10"
                aria-label="Accounts per page"
              >
                {ACCOUNT_PAGE_SIZE_OPTIONS.map((option) => (
                  <option key={option} value={String(option)}>
                    {option} / page
                  </option>
                ))}
                <option value="custom">Custom</option>
              </select>
              <input
                type="number"
                min="1"
                max={String(ACCOUNT_PAGE_SIZE_MAX)}
                inputMode="numeric"
                value={customPageSizeInput}
                onChange={(event) => setCustomPageSizeInput(event.target.value)}
                onBlur={() => {
                  const parsedValue = Number.parseInt(customPageSizeInput, 10);
                  if (!Number.isFinite(parsedValue)) {
                    setCustomPageSizeInput(String(pageSize));
                    return;
                  }
                  const nextPageSize = Math.min(ACCOUNT_PAGE_SIZE_MAX, Math.max(1, parsedValue));
                  setPage(1);
                  setPageSize(nextPageSize);
                  setCustomPageSizeInput(String(nextPageSize));
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  const parsedValue = Number.parseInt(customPageSizeInput, 10);
                  if (!Number.isFinite(parsedValue)) {
                    setCustomPageSizeInput(String(pageSize));
                    return;
                  }
                  const nextPageSize = Math.min(ACCOUNT_PAGE_SIZE_MAX, Math.max(1, parsedValue));
                  setPage(1);
                  setPageSize(nextPageSize);
                  setCustomPageSizeInput(String(nextPageSize));
                }}
                className="h-8 w-20 rounded-lg border border-black/10 bg-black/[0.02] px-2 text-xs text-text-primary outline-none transition-colors hover:bg-black/5 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/10"
                aria-label="Custom accounts per page"
                placeholder="Custom"
              />
              <span className="text-xs text-text-muted">Page {pagination.page} / {pagination.totalPages}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setPage(1)}
                disabled={
                  pagination.page <= 1 || connectionsLoading || refreshingAll
                }
                className="flex h-8 items-center rounded-lg border border-black/10 px-3 text-xs text-text-primary transition-colors hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/5"
              >
                First Page
              </button>
              <button
                type="button"
                onClick={() =>
                  setPage((currentPage) => Math.max(1, currentPage - 1))
                }
                disabled={
                  pagination.page <= 1 || connectionsLoading || refreshingAll
                }
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-black/10 text-text-primary transition-colors hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/5"
                aria-label="Previous accounts page"
              >
                <span className="material-symbols-outlined text-[16px]">
                  chevron_left
                </span>
              </button>
              <button
                type="button"
                onClick={() =>
                  setPage((currentPage) =>
                    Math.min(pagination.totalPages, currentPage + 1),
                  )
                }
                disabled={
                  pagination.page >= pagination.totalPages ||
                  connectionsLoading ||
                  refreshingAll
                }
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-black/10 text-text-primary transition-colors hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/5"
                aria-label="Next accounts page"
              >
                <span className="material-symbols-outlined text-[16px]">
                  chevron_right
                </span>
              </button>
              <button
                type="button"
                onClick={() => setPage(pagination.totalPages)}
                disabled={
                  pagination.page >= pagination.totalPages ||
                  connectionsLoading ||
                  refreshingAll
                }
                className="flex h-8 items-center rounded-lg border border-black/10 px-3 text-xs text-text-primary transition-colors hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/5"
              >
                Last Page
              </button>
            </div>
          </div>
        </div>

      <ConfirmModal
        isOpen={Boolean(resetConfirmState)}
        onClose={() => {
          if (!resettingLimitId) setResetConfirmState(null);
        }}
        onConfirm={async () => {
          const connection = resetConfirmState?.connection;
          if (!connection) return;
          await handleResetCodexLimit(connection.id, connection.provider);
          setResetConfirmState(null);
        }}
        title="Reset Codex limit?"
        message={`Use 1 Codex reset credit for ${getConnectionLabel(resetConfirmState?.connection || {}) || "this account"}. This cannot be undone. Remaining credits: ${resetConfirmState?.resetCreditCount ?? 0}.`}
        confirmText="Reset limit"
        cancelText="Cancel"
        variant="danger"
        loading={Boolean(resettingLimitId)}
      />

      <EditConnectionModal
        isOpen={showEditModal}
        connection={selectedConnection}
        proxyPools={proxyPools}
        onSave={handleUpdateConnection}
        onClose={() => {
          setShowEditModal(false);
          setSelectedConnection(null);
        }}
      />
    </div>
  );
}
