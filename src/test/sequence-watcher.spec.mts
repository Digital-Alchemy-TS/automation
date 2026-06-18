/**
 * SequenceWatcher service tests (Pillar 2: event-driven sequence matching).
 *
 * SequenceWatcher listens to hass socket events and accumulates state values
 * at a given path. When the accumulated list matches the configured sequence,
 * `exec` is called.
 *
 * Key timing behavior:
 *   - The 1500 ms SEQUENCE_TIMEOUT window is the "cooling off" period.
 *     A new event resets the window; if no new event arrives within the window
 *     the partial match is GC'd.
 *   - `reset: "self"` clears only this watcher's progress after a match so it
 *     can match again immediately.
 *   - `reset: { label }` clears all watchers with that label after a match.
 *
 * Event emission: `mock_assistant.events.emitEvent(event_type, data)` routes
 * through `hass.socket.onMessage` — the same path real events take.
 */

import { automationTestRunner } from "../mock/automation-test-runner.mts";

// ─── Named constants ──────────────────────────────────────────────────────────

/** Default SEQUENCE_TIMEOUT from module config */
const SEQUENCE_TIMEOUT_MS = 1500;
/** Margin to advance just past the timeout */
const TIMEOUT_MARGIN_MS = 100;
/** Event type for all tests — mimics a ZHA button event */
const TEST_EVENT_TYPE = "zha_event";
/** Path inside the event payload that holds the state value to match */
const EVENT_PATH = "command";
/** Advance budget after an event emission so setImmediate callbacks drain */
const SETTLE_MS = 50;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SequenceWatcher — single-step match", () => {
  afterEach(async () => {
    await automationTestRunner.teardown();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("exec fires when the single-element sequence matches", async () => {
    vi.useFakeTimers();
    const spy = vi.fn();

    await automationTestRunner.run(async ({ automation, mock_assistant, context }) => {
      automation.sequence({
        context,
        event_type: TEST_EVENT_TYPE,
        exec: spy,
        filter: () => true,
        match: ["toggle"],
        path: EVENT_PATH,
      });

      await mock_assistant.events.emitEvent(TEST_EVENT_TYPE, { command: "toggle" });
      vi.advanceTimersByTime(SETTLE_MS);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("exec does not fire when the event value does not match", async () => {
    vi.useFakeTimers();
    const spy = vi.fn();

    await automationTestRunner.run(async ({ automation, mock_assistant, context }) => {
      automation.sequence({
        context,
        event_type: TEST_EVENT_TYPE,
        exec: spy,
        filter: () => true,
        match: ["toggle"],
        path: EVENT_PATH,
      });

      await mock_assistant.events.emitEvent(TEST_EVENT_TYPE, { command: "hold" });
      vi.advanceTimersByTime(SEQUENCE_TIMEOUT_MS + TIMEOUT_MARGIN_MS);
      await Promise.resolve();
    });

    expect(spy).not.toHaveBeenCalled();
  });
});

describe("SequenceWatcher — two-step sequence", () => {
  afterEach(async () => {
    await automationTestRunner.teardown();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("exec fires when both steps arrive within the timeout window", async () => {
    vi.useFakeTimers();
    const spy = vi.fn();

    await automationTestRunner.run(async ({ automation, mock_assistant, context }) => {
      automation.sequence({
        context,
        event_type: TEST_EVENT_TYPE,
        exec: spy,
        filter: () => true,
        match: ["on", "off"],
        path: EVENT_PATH,
      });

      await mock_assistant.events.emitEvent(TEST_EVENT_TYPE, { command: "on" });
      // Advance within the window (1000 ms < 1500 ms)
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
      await mock_assistant.events.emitEvent(TEST_EVENT_TYPE, { command: "off" });
      vi.advanceTimersByTime(SETTLE_MS);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("exec does NOT fire when the second step arrives after the timeout window", async () => {
    vi.useFakeTimers();
    const spy = vi.fn();

    await automationTestRunner.run(async ({ automation, mock_assistant, context }) => {
      automation.sequence({
        context,
        event_type: TEST_EVENT_TYPE,
        exec: spy,
        filter: () => true,
        match: ["on", "off"],
        path: EVENT_PATH,
      });

      await mock_assistant.events.emitEvent(TEST_EVENT_TYPE, { command: "on" });
      // Let the timeout expire before the second event arrives
      vi.advanceTimersByTime(SEQUENCE_TIMEOUT_MS + TIMEOUT_MARGIN_MS);
      await Promise.resolve();
      await mock_assistant.events.emitEvent(TEST_EVENT_TYPE, { command: "off" });
      vi.advanceTimersByTime(SETTLE_MS);
      await Promise.resolve();
    });

    expect(spy).not.toHaveBeenCalled();
  });
});

describe("SequenceWatcher — filter gate", () => {
  afterEach(async () => {
    await automationTestRunner.teardown();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("exec does not fire when the filter rejects the event", async () => {
    vi.useFakeTimers();
    const spy = vi.fn();

    await automationTestRunner.run(async ({ automation, mock_assistant, context }) => {
      automation.sequence({
        context,
        event_type: TEST_EVENT_TYPE,
        exec: spy,
        filter: (data: Record<string, string>) => data["device_id"] === "allowed",
        match: ["toggle"],
        path: EVENT_PATH,
      });

      await mock_assistant.events.emitEvent(TEST_EVENT_TYPE, {
        command: "toggle",
        device_id: "blocked",
      });
      vi.advanceTimersByTime(SEQUENCE_TIMEOUT_MS + TIMEOUT_MARGIN_MS);
      await Promise.resolve();
    });

    expect(spy).not.toHaveBeenCalled();
  });

  it("exec fires when the filter passes the event", async () => {
    vi.useFakeTimers();
    const spy = vi.fn();

    await automationTestRunner.run(async ({ automation, mock_assistant, context }) => {
      automation.sequence({
        context,
        event_type: TEST_EVENT_TYPE,
        exec: spy,
        filter: (data: Record<string, string>) => data["device_id"] === "allowed",
        match: ["toggle"],
        path: EVENT_PATH,
      });

      await mock_assistant.events.emitEvent(TEST_EVENT_TYPE, {
        command: "toggle",
        device_id: "allowed",
      });
      vi.advanceTimersByTime(SETTLE_MS);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("SequenceWatcher — reset:self", () => {
  afterEach(async () => {
    await automationTestRunner.teardown();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reset:self allows the watcher to fire again immediately after the first match", async () => {
    vi.useFakeTimers();
    const spy = vi.fn();

    await automationTestRunner.run(async ({ automation, mock_assistant, context }) => {
      automation.sequence({
        context,
        event_type: TEST_EVENT_TYPE,
        exec: spy,
        filter: () => true,
        match: ["toggle"],
        path: EVENT_PATH,
        reset: "self",
      });

      // First match
      await mock_assistant.events.emitEvent(TEST_EVENT_TYPE, { command: "toggle" });
      vi.advanceTimersByTime(SETTLE_MS);
      await Promise.resolve();
      await Promise.resolve();

      // Second match — reset:self means progress was cleared, so this fires too
      await mock_assistant.events.emitEvent(TEST_EVENT_TYPE, { command: "toggle" });
      vi.advanceTimersByTime(SETTLE_MS);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("SequenceWatcher — removal", () => {
  afterEach(async () => {
    await automationTestRunner.teardown();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("calling the returned removal function prevents exec from firing", async () => {
    vi.useFakeTimers();
    const spy = vi.fn();

    await automationTestRunner.run(async ({ automation, mock_assistant, context }) => {
      const remove = automation.sequence({
        context,
        event_type: TEST_EVENT_TYPE,
        exec: spy,
        filter: () => true,
        match: ["toggle"],
        path: EVENT_PATH,
      });

      remove();

      await mock_assistant.events.emitEvent(TEST_EVENT_TYPE, { command: "toggle" });
      vi.advanceTimersByTime(SEQUENCE_TIMEOUT_MS + TIMEOUT_MARGIN_MS);
      await Promise.resolve();
    });

    expect(spy).not.toHaveBeenCalled();
  });
});
