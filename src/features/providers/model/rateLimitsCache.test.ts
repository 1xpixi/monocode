// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderRateLimits } from "./rateLimits";

const fetches = vi.hoisted(() => ({
  claude: vi.fn<(accountId: string) => Promise<ProviderRateLimits>>(),
  codex: vi.fn<(accountId: string) => Promise<ProviderRateLimits>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./rateLimitsFetch", () => ({
  fetchClaudeRateLimits: fetches.claude,
  fetchCodexRateLimits: fetches.codex,
  fetchDevinRateLimits: vi.fn(),
  fetchOpencodeGoRateLimits: vi.fn(),
}));

import {
  clearCachedRateLimits,
  getCachedRateLimits,
  loadRateLimits,
  scheduleRateLimitsAutoRefresh,
  cancelRateLimitsAutoRefresh,
  AUTO_REFRESH_DEBOUNCE_MS,
} from "./rateLimitsCache";

function sampleLimits(
  usedPercent: number,
  updatedAt = Date.now(),
): ProviderRateLimits {
  return {
    provider: "claude",
    session: { usedPercent, windowMinutes: 300, resetsAt: Date.now() + 3600000 },
    weekly: null,
    monthly: null,
    resetCredits: null,
    updatedAt,
    error: null,
    status: "ok",
  };
}

describe("rateLimitsCache auto-refresh debouncing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearCachedRateLimits();
    fetches.claude.mockReset();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    clearCachedRateLimits();
  });

  it("debounces rapid triggers and combines clustered completions into a single refresh", async () => {
    fetches.claude.mockResolvedValue(sampleLimits(42));

    // Multiple rapid turn completions within the debounce window
    scheduleRateLimitsAutoRefresh("claude", "default", 500);
    vi.advanceTimersByTime(200);
    scheduleRateLimitsAutoRefresh("claude", "default", 500);
    vi.advanceTimersByTime(200);
    scheduleRateLimitsAutoRefresh("claude", "default", 500);

    expect(fetches.claude).not.toHaveBeenCalled();

    // Advance past the final debounce timeout
    await vi.advanceTimersByTimeAsync(500);

    expect(fetches.claude).toHaveBeenCalledTimes(1);
    expect(fetches.claude).toHaveBeenCalledWith("default");
    expect(getCachedRateLimits("claude", "default").session?.usedPercent).toBe(42);
  });

  it("handles distinct accounts with their own debounce timers", async () => {
    fetches.claude.mockResolvedValue(sampleLimits(10));

    scheduleRateLimitsAutoRefresh("claude", "account-1", 500);
    scheduleRateLimitsAutoRefresh("claude", "account-2", 500);

    await vi.advanceTimersByTimeAsync(500);

    expect(fetches.claude).toHaveBeenCalledTimes(2);
    expect(fetches.claude).toHaveBeenCalledWith("account-1");
    expect(fetches.claude).toHaveBeenCalledWith("account-2");
  });

  it("can cancel pending auto-refresh timers", async () => {
    fetches.claude.mockResolvedValue(sampleLimits(10));

    const cancel = scheduleRateLimitsAutoRefresh("claude", "default", 500);
    cancel();

    await vi.advanceTimersByTimeAsync(1000);

    expect(fetches.claude).not.toHaveBeenCalled();
  });

  it("cancels a scheduled auto-refresh when an intervening forced load starts", async () => {
    fetches.claude.mockResolvedValue(sampleLimits(15));

    // Schedule auto-refresh (e.g. from turn completion)
    scheduleRateLimitsAutoRefresh("claude", "default", 1000);

    // User or focus triggers a forced load before debounce timeout fires
    await vi.advanceTimersByTimeAsync(300);
    await loadRateLimits("claude", "default", true);

    expect(fetches.claude).toHaveBeenCalledTimes(1);

    // Debounce window completes - timer should have been canceled, so no second load
    await vi.advanceTimersByTimeAsync(1500);

    expect(fetches.claude).toHaveBeenCalledTimes(1);
  });

  it("refreshes after a pre-turn request resolves during the completion debounce", async () => {
    let resolvePreTurn!: (limits: ProviderRateLimits) => void;
    fetches.claude
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePreTurn = resolve;
          }),
      )
      .mockResolvedValue(sampleLimits(75));

    // This request started before the turn completed, so its result may be outdated.
    const preTurn = loadRateLimits("claude", "default", true);
    scheduleRateLimitsAutoRefresh("claude", "default", 1000);

    vi.setSystemTime(Date.now() + 200);
    resolvePreTurn(sampleLimits(50));
    await preTurn;
    expect(getCachedRateLimits("claude", "default").session?.usedPercent).toBe(
      50,
    );

    // A later updatedAt does not prove this snapshot includes the completed turn.
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetches.claude).toHaveBeenCalledTimes(2);
    expect(getCachedRateLimits("claude", "default").session?.usedPercent).toBe(
      75,
    );
  });

  it("retries after a pre-turn request fails during the completion debounce", async () => {
    let rejectPreTurn!: (reason: Error) => void;
    fetches.claude
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectPreTurn = reject;
          }),
      )
      .mockResolvedValue(sampleLimits(65));

    const preTurn = loadRateLimits("claude", "default", true);
    scheduleRateLimitsAutoRefresh("claude", "default", 1000);

    vi.setSystemTime(Date.now() + 200);
    rejectPreTurn(new Error("Temporary network failure"));
    await preTurn;
    expect(getCachedRateLimits("claude", "default").status).toBe("error");

    // The error has a newer timestamp, but the post-turn refresh is still needed.
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetches.claude).toHaveBeenCalledTimes(2);
    expect(getCachedRateLimits("claude", "default").session?.usedPercent).toBe(
      65,
    );
  });
});
