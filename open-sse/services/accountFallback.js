import { ERROR_RULES, BACKOFF_CONFIG, TRANSIENT_COOLDOWN_MS, BUSY_CONNECTION_COOLDOWN_MS, MODEL_FAILURE_BACKOFF_BASE_MS, MODEL_FAILURE_BACKOFF_MAX_MS, MODEL_FAILURE_IDLE_RESET_MS } from "../config/errorConfig.js";

const BUSY_CONCURRENCY_TEXT = [
  "hệ thống đang bận",
  "system busy",
  "try again later",
  "please wait",
  "pool limit",
  "maximum concurrent requests",
  "too many in-flight",
  "in-flight requests",
];

const PREFLIGHT_TIMEOUT_TEXT = [
  "upstream first byte timeout",
  "upstream first productive timeout",
  "upstream headers timeout",
];

const CLIENT_PAYLOAD_ERROR_RULES = [
  (text) => text.includes("image_url") && text.includes("expected a valid url"),
];

function normalizeErrorText(errorText) {
  if (!errorText) return "";
  return (typeof errorText === "string" ? errorText : JSON.stringify(errorText)).toLowerCase();
}

export function isClientPayloadError(status, errorText) {
  if (Number(status) !== 400) return false;
  const lowerError = normalizeErrorText(errorText);
  return !!lowerError && CLIENT_PAYLOAD_ERROR_RULES.some(rule => rule(lowerError));
}

/**
 * Calculate exponential backoff cooldown for rate limits (429)
 * Level 1: 1s, Level 2: 2s, Level 3: 4s... → max 4 min
 * @param {number} backoffLevel - Current backoff level
 * @returns {number} Cooldown in milliseconds
 */
export function getQuotaCooldown(backoffLevel = 0) {
  const level = Math.max(0, backoffLevel - 1);
  const cooldown = BACKOFF_CONFIG.base * Math.pow(2, level);
  return Math.min(cooldown, BACKOFF_CONFIG.max);
}

/**
 * Check if error should trigger account fallback (switch to next account)
 * Config-driven: matches ERROR_RULES top-to-bottom (text rules first, then status)
 * @param {number} status - HTTP status code
 * @param {string} errorText - Error message text
 * @param {number} backoffLevel - Current backoff level for exponential backoff
 * @returns {{ shouldFallback: boolean, cooldownMs: number, newBackoffLevel?: number, selfHeal?: boolean }}
 */
export function checkFallbackError(status, errorText, backoffLevel = 0) {
  const lowerError = normalizeErrorText(errorText);

  if (isClientPayloadError(status, lowerError)) {
    return { shouldFallback: false, cooldownMs: 0, clientError: true };
  }

  for (const rule of ERROR_RULES) {
    // Text-based rule: match substring in error message
    if (rule.text && lowerError && lowerError.includes(rule.text)) {
      if (rule.backoff) {
        const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
        return { shouldFallback: true, cooldownMs: getQuotaCooldown(newLevel), newBackoffLevel: newLevel };
      }
      return { shouldFallback: true, cooldownMs: rule.cooldownMs, selfHeal: rule.selfHeal === true };
    }

    // Status-based rule: match HTTP status code
    if (rule.status && rule.status === status) {
      if (rule.backoff) {
        const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
        return { shouldFallback: true, cooldownMs: getQuotaCooldown(newLevel), newBackoffLevel: newLevel };
      }
      return { shouldFallback: true, cooldownMs: rule.cooldownMs, selfHeal: rule.selfHeal === true };
    }
  }

  // Default: transient cooldown for any unmatched error
  return { shouldFallback: true, cooldownMs: TRANSIENT_COOLDOWN_MS };
}

/** True for the rate-limit error class: HTTP 429 or a rate-limit text rule
 *  (the `backoff: true` entries in ERROR_RULES). These get a fixed base cooldown
 *  and are neutral to the per-model failure counter (no bump, no reset). */
export function isProviderSelfHealError(status, errorText) {
  const lowerError = normalizeErrorText(errorText);
  for (const rule of ERROR_RULES) {
    if (!rule.selfHeal) continue;
    if (rule.text && lowerError && lowerError.includes(rule.text)) return true;
    if (rule.status && rule.status === status) return true;
  }
  return false;
}

export function isRateLimitError(status, errorText) {
  const lowerError = normalizeErrorText(errorText);
  for (const rule of ERROR_RULES) {
    if (!rule.backoff) continue;
    if (rule.text && lowerError && lowerError.includes(rule.text)) return true;
    if (rule.status && rule.status === status) return true;
  }
  return false;
}

export function shouldDisableConnectionForError(status, errorText) {
  if (Number(status) === 402) return true;
  if (Number(status) !== 403) return false;

  const lowerError = normalizeErrorText(errorText);
  if (!lowerError) return false;
  return (
    lowerError.includes("hết credit") ||
    lowerError.includes("het credit") ||
    (lowerError.includes("credit") && lowerError.includes("pay-as-you")) ||
    (lowerError.includes("insufficient") && lowerError.includes("credit"))
  );
}

export function isBusyConcurrencyError(errorText) {
  const lowerError = normalizeErrorText(errorText);
  return !!lowerError && BUSY_CONCURRENCY_TEXT.some(text => lowerError.includes(text));
}

export function isPreflightTimeoutError(status, errorText) {
  const lowerError = normalizeErrorText(errorText);
  return Number(status) === 502 && PREFLIGHT_TIMEOUT_TEXT.some(text => lowerError.includes(text));
}

export function shouldLockConnectionForError({ status, errorText, recentFailureCount = 0 } = {}) {
  if (isBusyConcurrencyError(errorText)) return true;
  if (isPreflightTimeoutError(status, errorText) && recentFailureCount >= 2) return true;
  return false;
}

export function resolveConnectionCooldownMs({ status, errorText, cooldownMs = 0, recentFailureCount = 0 } = {}) {
  if (isBusyConcurrencyError(errorText)) return BUSY_CONNECTION_COOLDOWN_MS;
  if (isPreflightTimeoutError(status, errorText) && recentFailureCount >= 2) return Math.max(cooldownMs || 0, BUSY_CONNECTION_COOLDOWN_MS);
  return cooldownMs || 0;
}

/**
 * Check if account is currently unavailable (cooldown not expired)
 */
export function isAccountUnavailable(unavailableUntil) {
  if (!unavailableUntil) return false;
  return new Date(unavailableUntil).getTime() > Date.now();
}

/**
 * Calculate unavailable until timestamp
 */
export function getUnavailableUntil(cooldownMs) {
  return new Date(Date.now() + cooldownMs).toISOString();
}

/**
 * Get the earliest rateLimitedUntil from a list of accounts
 * @param {Array} accounts - Array of account objects with rateLimitedUntil
 * @returns {string|null} Earliest rateLimitedUntil ISO string, or null
 */
export function getEarliestRateLimitedUntil(accounts) {
  let earliest = null;
  const now = Date.now();
  for (const acc of accounts) {
    if (!acc.rateLimitedUntil) continue;
    const until = new Date(acc.rateLimitedUntil).getTime();
    if (until <= now) continue;
    if (!earliest || until < earliest) earliest = until;
  }
  if (!earliest) return null;
  return new Date(earliest).toISOString();
}

/**
 * Format rateLimitedUntil to human-readable "reset after Xm Ys"
 * @param {string} rateLimitedUntil - ISO timestamp
 * @returns {string} e.g. "reset after 2m 30s"
 */
export function formatRetryAfter(rateLimitedUntil) {
  if (!rateLimitedUntil) return "";
  const diffMs = new Date(rateLimitedUntil).getTime() - Date.now();
  if (diffMs <= 0) return "reset after 0s";
  const totalSec = Math.ceil(diffMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return `reset after ${parts.join(" ")}`;
}

/** Prefix for model lock flat fields on connection record */
export const MODEL_LOCK_PREFIX = "modelLock_";

/** Special key used when no model is known (account-level lock) */
export const MODEL_LOCK_ALL = `${MODEL_LOCK_PREFIX}__all`;

/** Build the flat field key for a model lock */
export function getModelLockKey(model) {
  return model ? `${MODEL_LOCK_PREFIX}${model}` : MODEL_LOCK_ALL;
}

/**
 * Check if a model lock on a connection is still active.
 * Reads flat field `modelLock_${model}` (or `modelLock___all` when model=null).
 */
export function isModelLockActive(connection, model) {
  const key = getModelLockKey(model);
  const expiry = connection[key] || connection[MODEL_LOCK_ALL];
  if (!expiry) return false;
  return new Date(expiry).getTime() > Date.now();
}

/**
 * Get earliest active model lock expiry across all modelLock_* fields.
 * Used for UI cooldown display.
 */
export function getEarliestModelLockUntil(connection) {
  if (!connection) return null;
  let earliest = null;
  const now = Date.now();
  for (const [key, val] of Object.entries(connection)) {
    if (!key.startsWith(MODEL_LOCK_PREFIX) || !val) continue;
    const t = new Date(val).getTime();
    if (t <= now) continue;
    if (!earliest || t < earliest) earliest = t;
  }
  return earliest ? new Date(earliest).toISOString() : null;
}

/**
 * Build update object to set a model lock on a connection.
 */
export function buildModelLockUpdate(model, cooldownMs) {
  const key = getModelLockKey(model);
  return { [key]: new Date(Date.now() + cooldownMs).toISOString() };
}

/**
 * Build update object to clear all model locks on a connection.
 */
export function buildClearModelLocksUpdate(connection) {
  const cleared = {};
  for (const key of Object.keys(connection)) {
    if (key.startsWith(MODEL_LOCK_PREFIX)) cleared[key] = null;
  }
  return cleared;
}

/** Prefix for per-model consecutive-failure counters on a connection record.
 *  Distinct from MODEL_LOCK_PREFIX so counters survive lock expiry and are
 *  only cleared on a successful call to that model (not on auto-heal). */
export const MODEL_FAILURE_PREFIX = "modelFailure_";
export const MODEL_FAILURE_ALL = `${MODEL_FAILURE_PREFIX}__all`;

/** Build the flat field key for a per-model failure counter. */
export function getModelFailureKey(model) {
  return model ? `${MODEL_FAILURE_PREFIX}${model}` : MODEL_FAILURE_ALL;
}

/** Prefix for per-model last-failure timestamps (non-rate-limit failures only).
 *  Drives time-based counter decay: after MODEL_FAILURE_IDLE_RESET_MS with no
 *  new non-rate-limit failure, the counter resets to a fresh start. */
export const MODEL_FAILURE_AT_PREFIX = "modelFailureAt_";
export const MODEL_FAILURE_AT_ALL = `${MODEL_FAILURE_AT_PREFIX}__all`;

/** Build the flat field key for a per-model last-failure timestamp. */
export function getModelFailureAtKey(model) {
  return model ? `${MODEL_FAILURE_AT_PREFIX}${model}` : MODEL_FAILURE_AT_ALL;
}

/** Read the stored consecutive-failure count for a model (or connection-level __all). */
export function getModelFailureCount(connection, model) {
  if (!connection) return 0;
  const count = Number(connection[getModelFailureKey(model)]);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

/** Cooldown for the Nth consecutive failure: base * 2^(n-1), capped at max. */
export function getModelBackoffCooldownMs(failureCount) {
  const n = Math.max(1, failureCount);
  const cooldown = MODEL_FAILURE_BACKOFF_BASE_MS * Math.pow(2, n - 1);
  return Math.min(cooldown, MODEL_FAILURE_BACKOFF_MAX_MS);
}

/** Bump the per-model consecutive-failure counter and return the resulting
 *  cooldown to apply as a model lock. Counters persist across lock expiry so
 *  that repeated failures keep escalating until a successful call resets them.
 *
 *  Rate-limit class errors (429 + rate-limit text rules) are neutral to the
 *  counter: they block for a fixed MODEL_FAILURE_BACKOFF_BASE_MS without
 *  bumping or resetting the counter, so consecutive 429s never double.
 *  Non-rate-limit failures escalate (base * 2^(n-1)) and, after
 *  MODEL_FAILURE_IDLE_RESET_MS with no new non-rate-limit failure, the counter
 *  resets to a fresh start. */
export function buildModelFailureBackoffUpdate(connection, model, { isRateLimit = false, selfHeal = false } = {}) {
  const prevCount = getModelFailureCount(connection, model);
  const atKey = getModelFailureAtKey(model);
  const now = Date.now();
  if (isRateLimit || selfHeal) {
    return { count: prevCount, cooldownMs: selfHeal ? 0 : MODEL_FAILURE_BACKOFF_BASE_MS, update: {} };
  }
  const lastAt = Number(connection?.[atKey]) || 0;
  const idleLongEnough = lastAt > 0 && (now - lastAt) > MODEL_FAILURE_IDLE_RESET_MS;
  const count = idleLongEnough ? 1 : prevCount + 1;
  const cooldownMs = getModelBackoffCooldownMs(count);
  return { count, cooldownMs, update: { [getModelFailureKey(model)]: count, [atKey]: now } };
}

/** Build update object that clears the per-model failure counter on success.
 *  A specific model success clears only that model's counter; a model-less
 *  success (fetch/search) clears the connection-level __all counter only. */
export function buildClearModelFailureUpdate(connection, model) {
  if (!connection) return {};
  const update = {};
  if (model) {
    const key = getModelFailureKey(model);
    if (connection[key] != null) update[key] = 0;
  } else if (connection[MODEL_FAILURE_ALL] != null) {
    update[MODEL_FAILURE_ALL] = 0;
  }
  return update;
}

/**
 * Filter available accounts (not in cooldown)
 */
export function filterAvailableAccounts(accounts, excludeId = null) {
  const now = Date.now();
  return accounts.filter(acc => {
    if (excludeId && acc.id === excludeId) return false;
    if (acc.rateLimitedUntil) {
      const until = new Date(acc.rateLimitedUntil).getTime();
      if (until > now) return false;
    }
    return true;
  });
}

/**
 * Reset account state when request succeeds
 * Clears cooldown and resets backoff level to 0
 * @param {object} account - Account object
 * @returns {object} Updated account with reset state
 */
export function resetAccountState(account) {
  if (!account) return account;
  return {
    ...account,
    rateLimitedUntil: null,
    backoffLevel: 0,
    lastError: null,
    status: "active"
  };
}

/**
 * Apply error state to account
 * @param {object} account - Account object
 * @param {number} status - HTTP status code
 * @param {string} errorText - Error message
 * @returns {object} Updated account with error state
 */
export function applyErrorState(account, status, errorText) {
  if (!account) return account;

  const backoffLevel = account.backoffLevel || 0;
  const { cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel);

  return {
    ...account,
    rateLimitedUntil: cooldownMs > 0 ? getUnavailableUntil(cooldownMs) : null,
    backoffLevel: newBackoffLevel ?? backoffLevel,
    lastError: { status, message: errorText, timestamp: new Date().toISOString() },
    status: "error"
  };
}

/**
 * Detect and build a cleanup update for a connection whose error state is stale:
 * testStatus is "unavailable"/"error" (or lastError set) but all modelLock_* keys
 * have expired. Returns { needsUpdate, update } where update is the DB patch.
 * Does NOT persist; caller decides whether to write. When some locks are still
 * active, only expired lock keys are cleaned (partial=true) without resetting
 * error display state.
 */
export function normalizeStaleConnectionState(connection) {
  if (!connection) return { needsUpdate: false, update: {} };
  const hasErrorState =
    connection.testStatus === "unavailable" ||
    connection.testStatus === "error" ||
    !!connection.lastError;
  if (!hasErrorState) return { needsUpdate: false, update: {} };

  const now = Date.now();
  const lockEntries = Object.entries(connection).filter(
    ([k]) => k.startsWith(MODEL_LOCK_PREFIX) || k === MODEL_LOCK_ALL,
  );
  const expiredLockKeys = [];
  let hasActiveLock = false;

  for (const [key, val] of lockEntries) {
    if (!val) continue;
    if (new Date(val).getTime() > now) {
      hasActiveLock = true;
    } else {
      expiredLockKeys.push(key);
    }
  }

  // Clean expired lock keys even while other locks are still active,
  // but do not reset testStatus/lastError until no active locks remain.
  if (hasActiveLock) {
    if (expiredLockKeys.length === 0) return { needsUpdate: false, update: {} };
    const update = {};
    for (const k of expiredLockKeys) update[k] = null;
    return { needsUpdate: true, update, partial: true };
  }

  // No active locks: full auto-heal
  const update = {};
  for (const k of expiredLockKeys) update[k] = null;
  if (connection.testStatus === "unavailable" || connection.testStatus === "error") {
    update.testStatus = "active";
  }
  if (connection.lastError) update.lastError = null;
  if (connection.lastErrorAt) update.lastErrorAt = null;
  if (connection.errorCode) update.errorCode = null;
  if (connection.backoffLevel) update.backoffLevel = 0;
  return { needsUpdate: Object.keys(update).length > 0, update };
}
