import { describe, it, expect, beforeEach } from "vitest";

import { handleComboChat, getRotatedModels, resetComboRotation, resetComboCooldowns } from "../../open-sse/services/combo.js";
import { parseResetAfterText, parseRetryAfterHeader } from "../../open-sse/utils/error.js";
import { guardInitialStream, isProductiveStreamChunk } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { resolveRoutePolicy } from "../../open-sse/services/routePolicy.js";
import { isBusyConcurrencyError, shouldLockConnectionForError, resolveConnectionCooldownMs } from "../../open-sse/services/accountFallback.js";

describe("adaptive combo fallback", () => {
  beforeEach(() => { resetComboRotation(); resetComboCooldowns(); });

  const log = { info: () => {}, warn: () => {}, debug: () => {} };

  it("falls back immediately on combo 429 without retrying the same model", async () => {
    const tried = [];
    const res = await handleComboChat({
      body: { model: "combo", messages: [] },
      models: ["p/a", "p/b"],
      comboName: "combo",
      comboRetryAttempts: 3,
      comboRetryDelayMs: 0,
      log,
      handleSingleModel: async (_body, model) => {
        tried.push(model);
        if (model === "p/a") return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    expect(res.ok).toBe(true);
    expect(tried).toEqual(["p/a", "p/b"]);
  });

  it("retries transient 503 according to config, then falls back", async () => {
    const tried = [];
    const res = await handleComboChat({
      body: { model: "combo", messages: [] },
      models: ["p/a", "p/b"],
      comboName: "combo",
      comboRetryAttempts: 1,
      comboRetryDelayMs: 0,
      log,
      handleSingleModel: async (_body, model) => {
        tried.push(model);
        if (model === "p/a") return new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    expect(res.ok).toBe(true);
    expect(tried).toEqual(["p/a", "p/a", "p/b"]);
  });

  it("round-robin only chooses start; failed starter still falls through remaining models", async () => {
    expect(getRotatedModels(["p/a", "p/b", "p/c"], "rr", "round-robin")[0]).toBe("p/a");
    const tried = [];
    const res = await handleComboChat({
      body: { model: "rr", messages: [] },
      models: ["p/a", "p/b", "p/c"],
      comboName: "rr",
      comboStrategy: "round-robin",
      comboRetryAttempts: 0,
      log,
      handleSingleModel: async (_body, model) => {
        tried.push(model);
        if (model !== "p/c") return new Response(JSON.stringify({ error: { message: "bad gateway" } }), { status: 502 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    expect(res.ok).toBe(true);
    expect(tried).toEqual(["p/b", "p/c"]);
  });

  it("still attempts a cooling model instead of hard-skipping it (live model always reachable)", async () => {
    // 1st request: model trips a preflight-timeout, which arms its in-memory
    // combo cooldown window.
    let phase = "warm";
    const run = () => handleComboChat({
      body: { model: "combo", messages: [] },
      models: ["p/only"],
      comboName: "combo",
      comboRetryAttempts: 0,
      comboRetryDelayMs: 0,
      log,
      handleSingleModel: async () => {
        if (phase === "warm") {
          return new Response(
            JSON.stringify({ error: { message: "Upstream first productive timeout (9s)" } }),
            { status: 502 },
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    const first = await run();
    expect(first.ok).toBe(false);

    // 2nd request: the same model is now in cooldown but is alive again. It must
    // still be tried (soft de-prioritization), not skipped into an all-failed 503.
    phase = "live";
    const tried = [];
    const second = await handleComboChat({
      body: { model: "combo", messages: [] },
      models: ["p/only"],
      comboName: "combo",
      comboRetryAttempts: 0,
      comboRetryDelayMs: 0,
      log,
      handleSingleModel: async (_body, model) => {
        tried.push(model);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    expect(tried).toEqual(["p/only"]);
    expect(second.ok).toBe(true);
  });

  it("sinks a cooling model to the end but still reaches it when others fail", async () => {
    // Arm cooldown on p/a via a preflight timeout.
    await handleComboChat({
      body: { model: "combo", messages: [] },
      models: ["p/a"],
      comboName: "combo",
      comboRetryAttempts: 0,
      comboRetryDelayMs: 0,
      log,
      handleSingleModel: async () => new Response(
        JSON.stringify({ error: { message: "upstream first productive timeout" } }),
        { status: 502 },
      ),
    });

    // p/a is cooling and p/b fails: p/a must be moved last but STILL tried, and
    // since it is alive again the combo succeeds.
    const tried = [];
    const res = await handleComboChat({
      body: { model: "combo", messages: [] },
      models: ["p/a", "p/b"],
      comboName: "combo",
      comboRetryAttempts: 0,
      comboRetryDelayMs: 0,
      log,
      handleSingleModel: async (_body, model) => {
        tried.push(model);
        if (model === "p/b") return new Response(JSON.stringify({ error: { message: "bad gateway" } }), { status: 502 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    expect(tried).toEqual(["p/b", "p/a"]);
    expect(res.ok).toBe(true);
  });

  it("emits combo summary counters", async () => {
    const infos = [];
    const summaryLog = { info: (_tag, msg) => infos.push(msg), warn: () => {}, debug: () => {} };
    const res = await handleComboChat({
      body: { model: "combo", messages: [] },
      models: ["p/a", "p/b"],
      comboName: "combo",
      comboRetryAttempts: 0,
      log: summaryLog,
      handleSingleModel: async (_body, model) => {
        if (model === "p/a") return new Response(JSON.stringify({ error: { message: "bad gateway" } }), { status: 502 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    expect(res.ok).toBe(true);
    expect(infos.some(msg => msg.includes("summary | combo=combo | success=p/b | tried=2") && msg.includes("failed=1"))).toBe(true);
  });
});

describe("productive stream watchdog", () => {
  const log = { warn: () => {} };

  function sseResponse(lines, keepOpen = false) {
    return new Response(new ReadableStream({
      start(controller) {
        for (const line of lines) controller.enqueue(new TextEncoder().encode(line));
        if (!keepOpen) controller.close();
      }
    }), { headers: { "Content-Type": "text/event-stream" } });
  }

  it("rejects DONE without content before client response starts", async () => {
    const res = await guardInitialStream(sseResponse(["data: [DONE]\n\n"]), {
      targetFormat: null, log, provider: "p", model: "m",
      policy: { firstByteTimeoutMs: 5, firstProductiveTimeoutMs: 20, totalBudgetMs: 50 },
    });
    expect(res.error).toMatch(/Empty upstream stream/);
  });

  it("does not treat metadata-only chunks as productive", async () => {
    const res = await guardInitialStream(sseResponse(["data: {\"id\":\"x\",\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n"], true), {
      targetFormat: null, log, provider: "p", model: "m",
      policy: { firstByteTimeoutMs: 5, firstProductiveTimeoutMs: 20, totalBudgetMs: 60 },
    });
    expect(res.error).toMatch(/productive timeout/);
  });

  it("counts content, thinking, and tool calls as productive", () => {
    expect(isProductiveStreamChunk({ choices: [{ delta: { content: "hi" } }] })).toBe(true);
    expect(isProductiveStreamChunk({ choices: [{ delta: { reasoning_content: "thinking" } }] })).toBe(true);
    expect(isProductiveStreamChunk({ choices: [{ delta: { tool_calls: [{ index: 0 }] } }] })).toBe(true);
    expect(isProductiveStreamChunk({ choices: [{ delta: { role: "assistant" } }] })).toBe(false);
    expect(isProductiveStreamChunk({ usage: { prompt_tokens: 1, completion_tokens: 0 } })).toBe(false);
  });

  it("direct default timeout is longer than combo default timeout", () => {
    expect(resolveRoutePolicy("direct").stream.firstProductiveTimeoutMs).toBeGreaterThan(resolveRoutePolicy("combo").stream.firstProductiveTimeoutMs);
  });
});

describe("retry-after parsing", () => {
  it("parses Retry-After header and reset-after text", () => {
    const h = new Headers({ "Retry-After": "7" });
    expect(parseRetryAfterHeader(h)).toBeGreaterThan(Date.now() + 6000);
    const reset = parseResetAfterText("quota exceeded, reset after 2m 7s");
    expect(reset).toBeGreaterThan(Date.now() + 120000);
    expect(reset).toBeLessThan(Date.now() + 130000);
  });
});

describe("busy and connection cooldown classification", () => {
  it("classifies provider busy/concurrency text for short account cooldown", () => {
    for (const msg of [
      "Hệ thống đang bận, vui lòng thử lại",
      "system busy",
      "try again later",
      "please wait",
      "POOL LIMIT",
      "maximum concurrent requests",
      "too many in-flight requests",
    ]) {
      expect(isBusyConcurrencyError(msg)).toBe(true);
      expect(shouldLockConnectionForError({ status: 429, errorText: msg, recentFailureCount: 1 })).toBe(true);
      expect(resolveConnectionCooldownMs({ status: 429, errorText: msg, cooldownMs: 1000 })).toBeGreaterThanOrEqual(5000);
    }
  });

  it("locks a connection after two recent preflight timeouts", () => {
    const msg = "Upstream first productive timeout";
    expect(shouldLockConnectionForError({ status: 502, errorText: msg, recentFailureCount: 1 })).toBe(false);
    expect(shouldLockConnectionForError({ status: 502, errorText: msg, recentFailureCount: 2 })).toBe(true);
    expect(resolveConnectionCooldownMs({ status: 502, errorText: msg, cooldownMs: 1000, recentFailureCount: 2 })).toBeGreaterThan(1000);
  });
});
