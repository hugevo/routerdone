import { describe, it, expect } from "vitest";
import { guardContext, formatContextGuardLog, estimateInputTokens } from "../../open-sse/rtk/contextGuard.js";

// Build a reasoning item with a sized encrypted_content blob.
function reasoningItem(id, encLen) {
  return {
    type: "reasoning",
    id: `rs_${id}`,
    encrypted_content: "x".repeat(encLen),
    summary: [{ type: "summary_text", text: `reasoning ${id}` }],
  };
}

// Build a body in OpenAI Responses `input` format with N reasoning items.
function makeBody(n, encLen = 200_000) {
  const input = [];
  input.push({ type: "message", role: "user", content: "hello" });
  for (let i = 0; i < n; i++) input.push(reasoningItem(i, encLen));
  input.push({ type: "message", role: "user", content: "next" });
  return { input };
}

describe("guardContext - no-op cases", () => {
  it("returns null when disabled", () => {
    const body = makeBody(10);
    expect(guardContext(body, { enabled: false })).toBeNull();
  });

  // Compact/handoff requests must bypass the guard so the upstream /compact
  // endpoint receives the full reasoning blobs to summarize. chatCore encodes
  // this as `enabled: contextGuardEnabled !== false && !body._compact`.
  it("is skipped for compact/handoff requests (caller disables via !body._compact)", () => {
    const body = makeBody(10); // over default threshold
    body._compact = true;
    // Mirror the exact enabled expression used in chatCore.js
    const enabled = true !== false && !body._compact;
    const stats = guardContext(body, { enabled, maxBytes: 1, keepRecent: 3 });
    expect(stats).toBeNull();
    // All reasoning blobs preserved for upstream compaction
    for (let i = 1; i <= 10; i++) {
      expect(body.input[i].encrypted_content).toBeDefined();
    }
  });
  it("returns null when no items", () => {
    expect(guardContext({ input: [] })).toBeNull();
    expect(guardContext({})).toBeNull();
    expect(guardContext(null)).toBeNull();
  });

  it("returns null when no reasoning items", () => {
    const body = { input: [{ type: "message", role: "user", content: "hi" }] };
    expect(guardContext(body, { maxBytes: 1 })).toBeNull();
  });

  it("returns null when below threshold", () => {
    const body = makeBody(3, 100);
    const stats = guardContext(body, { maxBytes: 3_500_000, keepRecent: 8 });
    expect(stats).toBeNull();
    // nothing mutated
    expect(body.input[1].encrypted_content).toBeDefined();
  });

  it("returns null when keepRecent >= reasoning count (nothing to evict)", () => {
    const body = makeBody(5, 200_000); // 5 reasoning blobs -> over threshold
    const stats = guardContext(body, { maxBytes: 1, keepRecent: 5 });
    expect(stats).toBeNull();
    expect(body.input[1].encrypted_content).toBeDefined();
  });
});

describe("guardContext - eviction", () => {
  it("evicts old reasoning blobs keeping the most recent N", () => {
    const body = makeBody(10, 200_000); // 10 blobs x 200KB = ~2M chars -> over 3.5M? no
    // Use smaller threshold to force eviction with 10 blobs
    const stats = guardContext(body, { maxBytes: 1, keepRecent: 3 });
    expect(stats).not.toBeNull();
    expect(stats.evictedItems).toBe(7); // 10 - 3
    expect(stats.totalReasoningItems).toBe(10);
    expect(stats.keptRecent).toBe(3);
    // oldest 7 evicted (indices 1..7 in input), recent 3 kept (indices 8..10)
    for (let i = 1; i <= 7; i++) {
      expect(body.input[i].encrypted_content).toBeUndefined();
      expect(body.input[i].type).toBe("reasoning"); // structure preserved
      expect(body.input[i].summary).toBeDefined();
    }
    for (let i = 8; i <= 10; i++) {
      expect(body.input[i].encrypted_content).toBeDefined();
    }
  });

  it("replaces empty summary with trim notice on evicted items", () => {
    const body = { input: [] };
    body.input.push({ type: "message", role: "user", content: "hi" });
    // reasoning item without a summary array
    body.input.push({ type: "reasoning", id: "r0", encrypted_content: "x".repeat(200_000) });
    body.input.push({ type: "reasoning", id: "r1", encrypted_content: "x".repeat(200_000) });
    const stats = guardContext(body, { maxBytes: 1, keepRecent: 1 });
    expect(stats.evictedItems).toBe(1);
    expect(body.input[1].encrypted_content).toBeUndefined();
    expect(Array.isArray(body.input[1].summary)).toBe(true);
    expect(body.input[1].summary[0].text).toContain("trimmed");
  });

  it("preserves existing summary on evicted items", () => {
    const body = { input: [] };
    body.input.push({ type: "message", role: "user", content: "hi" });
    body.input.push({
      type: "reasoning",
      id: "r0",
      encrypted_content: "x".repeat(200_000),
      summary: [{ type: "summary_text", text: "custom summary" }],
    });
    body.input.push({ type: "reasoning", id: "r1", encrypted_content: "x".repeat(200_000) });
    const stats = guardContext(body, { maxBytes: 1, keepRecent: 1 });
    expect(stats.evictedItems).toBe(1);
    expect(body.input[1].summary[0].text).toBe("custom summary");
  });

  it("reports estimated token before/after", () => {
    const body = makeBody(10, 200_000);
    const stats = guardContext(body, { maxBytes: 1, keepRecent: 3 });
    expect(stats.estTokensBefore).toBeGreaterThan(0);
    expect(stats.estTokensAfter).toBeGreaterThan(0);
    expect(stats.estTokensBefore).toBeGreaterThan(stats.estTokensAfter);
    expect(stats.evictedBytes).toBeGreaterThan(0);
  });

  it("works with messages-format body", () => {
    const body = {
      messages: [
        { role: "user", content: "hi" },
        reasoningItem(0, 200_000),
        reasoningItem(1, 200_000),
        reasoningItem(2, 200_000),
      ],
    };
    const stats = guardContext(body, { maxBytes: 1, keepRecent: 1 });
    expect(stats.evictedItems).toBe(2);
    expect(body.messages[1].encrypted_content).toBeUndefined();
    expect(body.messages[3].encrypted_content).toBeDefined();
  });

  it("respects custom maxBytes threshold", () => {
    // 3 blobs x 100KB = 300KB; threshold 250KB -> evict 1 (keep recent 2)
    const body = makeBody(3, 100_000);
    const stats = guardContext(body, { maxBytes: 250_000, keepRecent: 2 });
    expect(stats).not.toBeNull();
    expect(stats.evictedItems).toBe(1);
    expect(body.input[1].encrypted_content).toBeUndefined();
    expect(body.input[2].encrypted_content).toBeDefined();
    expect(body.input[3].encrypted_content).toBeDefined();
  });
});

describe("formatContextGuardLog", () => {
  it("returns null when no stats", () => {
    expect(formatContextGuardLog(null)).toBeNull();
    expect(formatContextGuardLog({ evictedItems: 0 })).toBeNull();
  });

  it("formats a log line with counts and token estimate", () => {
    const stats = {
      evictedItems: 7,
      totalReasoningItems: 10,
      keptRecent: 3,
      evictedBytes: 1_400_000,
      estBytesBefore: 2_000_000,
      estTokensBefore: 500_000,
      estTokensAfter: 150_000,
      threshold: 1,
    };
    const line = formatContextGuardLog(stats);
    expect(line).toContain("[CTX-GUARD]");
    expect(line).toContain("trimmed 7/10");
    expect(line).toContain("500000 -> 150000 tokens");
    expect(line).toContain("kept recent 3");
  });

  it("includes KB savings from evicted bytes", () => {
    const line = formatContextGuardLog({
      evictedItems: 5,
      totalReasoningItems: 8,
      keptRecent: 3,
      evictedBytes: 2048,
      estBytesBefore: 4096,
      estTokensBefore: 1024,
      estTokensAfter: 512,
    });
    expect(line).toContain("2KB"); // 2048/1024 = 2
  });
});
describe("guardContext - isCompact direct bypass", () => {
  // Covers the internal isCompact option branch directly, distinct from the
  // caller disabling via enabled: ... && !body._compact. chatCore passes
  // isCompact alongside enabled, so both paths must skip eviction.
  it("isCompact: true skips eviction and preserves all encrypted_content", () => {
    const body = makeBody(10, 200_000);
    const stats = guardContext(body, { enabled: true, maxBytes: 1, keepRecent: 3, isCompact: true });
    expect(stats).toBeNull();
    for (let i = 1; i <= 10; i++) {
      expect(body.input[i].encrypted_content).toBeDefined();
    }
  });

  it("isCompact: false with enabled true still evicts (sanity)", () => {
    const body = makeBody(10, 200_000);
    const stats = guardContext(body, { enabled: true, maxBytes: 1, keepRecent: 3, isCompact: false });
    expect(stats).not.toBeNull();
    expect(stats.evictedItems).toBe(7);
  });
});

describe("estimateInputTokens", () => {
  it("returns 0 for null/empty/missing bodies", () => {
    expect(estimateInputTokens(null)).toBe(0);
    expect(estimateInputTokens({})).toBe(0);
    expect(estimateInputTokens({ input: [] })).toBe(0);
    expect(estimateInputTokens({ messages: [] })).toBe(0);
    expect(estimateInputTokens(undefined)).toBe(0);
  });

  it("counts content and encrypted_content", () => {
    const body = makeBody(2, 200_000);
    const tokens = estimateInputTokens(body);
    expect(tokens).toBeGreaterThan(0);
    // 400_000 bytes / 4 = ~100_000 tokens
    expect(tokens).toBeGreaterThanOrEqual(90_000);
    expect(tokens).toBeLessThanOrEqual(110_000);
  });

  it("counts array content text parts", () => {
    const body = {
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "x".repeat(4000) }] },
      ],
    };
    const tokens = estimateInputTokens(body);
    expect(tokens).toBe(1000);
  });

  it("counts messages-format body", () => {
    const body = {
      messages: [
        { role: "user", content: "hello world" },
        reasoningItem(0, 800),
      ],
    };
    const tokens = estimateInputTokens(body);
    expect(tokens).toBeGreaterThan(0);
  });
});