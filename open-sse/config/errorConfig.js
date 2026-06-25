// OpenAI-compatible error types mapping (client-facing)
export const ERROR_TYPES = {
  400: { type: "invalid_request_error", code: "bad_request" },
  401: { type: "authentication_error", code: "invalid_api_key" },
  402: { type: "billing_error", code: "payment_required" },
  403: { type: "permission_error", code: "insufficient_quota" },
  404: { type: "invalid_request_error", code: "model_not_found" },
  406: { type: "invalid_request_error", code: "model_not_supported" },
  429: { type: "rate_limit_error", code: "rate_limit_exceeded" },
  500: { type: "server_error", code: "internal_server_error" },
  502: { type: "server_error", code: "bad_gateway" },
  503: { type: "server_error", code: "service_unavailable" },
  504: { type: "server_error", code: "gateway_timeout" }
};

// Default error messages per status code (client-facing)
export const DEFAULT_ERROR_MESSAGES = {
  400: "Bad request",
  401: "Invalid API key provided",
  402: "Payment required",
  403: "You exceeded your current quota",
  404: "Model not found",
  406: "Model not supported",
  429: "Rate limit exceeded",
  500: "Internal server error",
  502: "Bad gateway - upstream provider error",
  503: "Service temporarily unavailable",
  504: "Gateway timeout"
};

// Exponential backoff config for rate limits
export const BACKOFF_CONFIG = {
  base: 2000,
  max: 5 * 60 * 1000,
  maxLevel: 15
};

// Default cooldown for transient/unknown errors
export const TRANSIENT_COOLDOWN_MS = 30 * 1000;
// Per-model consecutive-failure exponential backoff.
// When a model cannot be called it is blocked for MODEL_FAILURE_BACKOFF_BASE_MS.
// Each consecutive failure (no successful call in between) doubles the block
// window, capped at MODEL_FAILURE_BACKOFF_MAX_MS. A successful call to that model
// resets the counter so the next failure starts back at the base.
export const MODEL_FAILURE_BACKOFF_BASE_MS = 30 * 1000;
export const MODEL_FAILURE_BACKOFF_MAX_MS = 30 * 60 * 1000;
// Idle window after which the per-model failure counter resets to a fresh
// start. Must exceed MODEL_FAILURE_BACKOFF_MAX_MS so a capped block is never
// shorter than the reset window (otherwise chronic-dead models oscillate
// ramp -> reset -> ramp instead of staying capped). 60min = 2x the 30min cap.
export const MODEL_FAILURE_IDLE_RESET_MS = 60 * 60 * 1000;


// Short account/provider cooldown for busy or concurrency gates.
export const BUSY_CONNECTION_COOLDOWN_MS = 30 * 1000;

// Hard cap for provider-reported rate limit cooldown (e.g. codex resets_at can be 5-6h)
export const MAX_RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;

// Cooldown durations (ms)
const COOLDOWN = {
  long: 2 * 60 * 1000,
  short: 5 * 1000,
};

/**
 * Unified error classification rules.
 * Checked top-to-bottom: text rules first (by order), then status rules.
 * Each rule: { text?, status?, cooldownMs?, backoff? }
 *   - text: substring match (case-insensitive) on error message
 *   - status: HTTP status code match
 *   - cooldownMs: fixed cooldown duration
 *   - backoff: true = use exponential backoff (rate limit)
 */
export const ERROR_RULES = [
  // --- Transient stream errors: short cooldown, don't mark account dead long ---
  { text: "empty upstream stream",             cooldownMs: 5 * 1000 },
  { text: "upstream first productive timeout", cooldownMs: 5 * 1000 },
  { text: "upstream stalled",                  cooldownMs: 5 * 1000 },
  // --- Text-based rules (checked first, order = priority) ---
  { text: "no credentials",           cooldownMs: COOLDOWN.long },
  { text: "request not allowed",      cooldownMs: COOLDOWN.short },
  { text: "improperly formed request", cooldownMs: COOLDOWN.long },
  { text: "hệ thống đang bận",        cooldownMs: BUSY_CONNECTION_COOLDOWN_MS },
  { text: "system busy",              cooldownMs: BUSY_CONNECTION_COOLDOWN_MS },
  { text: "try again later",          cooldownMs: BUSY_CONNECTION_COOLDOWN_MS },
  { text: "please wait",              cooldownMs: BUSY_CONNECTION_COOLDOWN_MS },
  { text: "pool limit",               cooldownMs: BUSY_CONNECTION_COOLDOWN_MS },
  { text: "maximum concurrent requests", cooldownMs: BUSY_CONNECTION_COOLDOWN_MS },
  { text: "too many in-flight",       cooldownMs: BUSY_CONNECTION_COOLDOWN_MS },
  { text: "in-flight requests",       cooldownMs: BUSY_CONNECTION_COOLDOWN_MS },
  { text: "rate limit",               backoff: true },
  { text: "too many requests",        backoff: true },
  { text: "quota exceeded",           backoff: true },
  { text: "capacity",                 backoff: true },
  { text: "overloaded",               backoff: true },

  // --- Status-based rules (fallback when text doesn't match) ---
  { status: 401, cooldownMs: COOLDOWN.long },
  { status: 402, cooldownMs: COOLDOWN.long },
  { status: 403, cooldownMs: COOLDOWN.long },
  { status: 404, cooldownMs: COOLDOWN.long },
  { status: 429, backoff: true },
];

// Backward compat: COOLDOWN_MS object (used by index.js re-export)
export const COOLDOWN_MS = {
  unauthorized: COOLDOWN.long,
  paymentRequired: COOLDOWN.long,
  notFound: COOLDOWN.long,
  transient: TRANSIENT_COOLDOWN_MS,
  requestNotAllowed: COOLDOWN.short,
};
