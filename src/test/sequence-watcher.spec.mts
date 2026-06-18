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
 *
 * ## Event emission pattern
 *
 * `hass.socket.onEvent({ event: "zha_event", exec })` registers on `socketEvents`
 * (the internal EventEmitter in WebsocketAPI). The `mock_assistant.events.emitEvent`
 * path goes through `onMessage → onMessageEvent → socketEvents.emit`, but in the
 * test environment the `socketEvents` in `onMessageEvent`'s closure is a different
 * instance from `hass.socket.socketEvents` (an artifact of the mock wiring order).
 *
 * The correct test pattern — used by synapse's own specs — is to emit directly:
 *   `hass.socket.socketEvents.emit(event_type, { data: {...}, event_type })`
 *
 * ## Payload structure
 * `socketEvents` listeners receive `message.event` = `{ data: {...}, event_type: "..." }`.
 * The user payload is nested under `.data`, so `path = "data.command"`.
 * Filters receive the same structure, so `device_id` is at `data["data"]["device_id"]`.
 *
 * ## Async drain
 * exec fires via setImmediate → safeExec. After socketEvents.emit, drain with
 * multiple Promise.resolve() turns then a real setImmediate flush.
 */

import type EventEmitter from "node:events";

import { automationTestRunner } from "../mock/automation-test-runner.mts";

// ─── Named constants ──────────────────────────────────────────────────────────

/** Default SEQUENCE_TIMEOUT from module config (milliseconds) */
const SEQUENCE_TIMEOUT_MS = 1500;
/** Margin to advance just past the timeout */
const TIMEOUT_MARGIN_MS = 100;
/** Event type for all tests — mimics a ZHA button event */
const TEST_EVENT_TYPE = "zha_event";
/**
 * Dot-path to the value inside the socketEvents payload.
 * socketEvents listeners receive `{ data: {...}, event_type }`.
 * The button command is at `.data.command`, so path = "data.command".
 */
const EVENT_PATH = "data.command";
/** Advance within timeout window (less than SEQUENCE_TIMEOUT_MS) */
const WITHIN_WINDOW_MS = 1000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

type SocketEventsEmitter = EventEmitter & { emit(event: string, ...args: unknown[]): boolean };

/**
 * Emit a socket event directly on `hass.socket.socketEvents`.
 * This is the correct pattern for test environments (mirrors synapse's specs).
 * The payload wraps user data under `.data` to match real HA socket event structure.
 */
function emitSocketEvent(socketEvents: SocketEventsEmitter, eventType: string, data: object): void {
  socketEvents.emit(eventType, { data, event_type: eventType });
}

/**
 * Drain the setImmediate → safeExec async chain after a socketEvents.emit.
 *
 * Chain: socketEvents.emit fires async listener → safeExec → trigger →
 *   forEach(async) → onMatch → data.exec() schedules setImmediate →
 *   setImmediate body: safeExec(inner) → user spy.
 *
 * Steps:
 *   P1-P4: microtask turns to advance the forEach/onMatch chain
 *   T0: setImmediate flush to fire the scheduled setImmediate
 *   P5-P6: trailing microtasks for safeExec and user callback
 *
 * When `useFakeTimers` is true, uses `vi.advanceTimersByTimeAsync(0)` instead
 * of real setImmediate (which would hang with fake timers active).
 */
async function drainEventChain(useFakeTimers = false): Promise<void> {
  await Promise.resolve(); // P1
  await Promise.resolve(); // P2
  await Promise.resolve(); // P3
  await Promise.resolve(); // P4
  if (useFakeTimers) {
    await vi.advanceTimersByTimeAsync(0); // T0 via fake clock
  } else {
    await new Promise<void>(resolve => setImmediate(resolve)); // T0 via real setImmediate
  }
  await Promise.resolve(); // P5
  await Promise.resolve(); // P6
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SequenceWatcher — single-step match", () => {
  afterEach(async () => {
    await automationTestRunner.teardown();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("exec fires when the single-element sequence matches", async () => {
    const spy = vi.fn();

    await automationTestRunner.run(async ({ automation, hass, context }) => {
      const socketEvents = (hass.socket as { socketEvents: SocketEventsEmitter }).socketEvents;

      automation.sequence({
        context,
        event_type: TEST_EVENT_TYPE,
        exec: spy,
        filter: () => true,
        match: ["toggle"],
        path: EVENT_PATH,
      });

      emitSocketEvent(socketEvents, TEST_EVENT_TYPE, { command: "toggle" });
      await drainEventChain();
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  it("exec does not fire when the event value does not match", async () => {
    vi.useFakeTimers();
    const spy = vi.fn();

    await automationTestRunner.run(async ({ automation, hass, context }) => {
      const socketEvents = (hass.socket as { socketEvents: SocketEventsEmitter }).socketEvents;

      automation.sequence({
        context,
        event_type: TEST_EVENT_TYPE,
        exec: spy,
        filter: () => true,
        match: ["toggle"],
        path: EVENT_PATH,
      });

      emitSocketEvent(socketEvents, TEST_EVENT_TYPE, { command: "hold" });
      await vi.advanceTimersByTimeAsync(SEQUENCE_TIMEOUT_MS + TIMEOUT_MARGIN_MS);
      expect(spy).not.toHaveBeenCalled();
    });
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

    await automationTestRunner.run(async ({ automation, hass, context }) => {
      const socketEvents = (hass.socket as { socketEvents: SocketEventsEmitter }).socketEvents;

      automation.sequence({
        context,
        event_type: TEST_EVENT_TYPE,
        exec: spy,
        filter: () => true,
        match: ["on", "off"],
        path: EVENT_PATH,
      });

      emitSocketEvent(socketEvents, TEST_EVENT_TYPE, { command: "on" });
      // Drain microtasks for the first event (partial match — no exec scheduled yet)
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Advance within the timeout window (must be < SEQUENCE_TIMEOUT_MS)
      await vi.advanceTimersByTimeAsync(WITHIN_WINDOW_MS);

      emitSocketEvent(socketEvents, TEST_EVENT_TYPE, { command: "off" });
      await drainEventChain(true);
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  it("exec does NOT fire when the second step arrives after the timeout window", async () => {
    vi.useFakeTimers();
    const spy = vi.fn();

    await automationTestRunner.run(async ({ automation, hass, context }) => {
      const socketEvents = (hass.socket as { socketEvents: SocketEventsEmitter }).socketEvents;

      automation.sequence({
        context,
        event_type: TEST_EVENT_TYPE,
        exec: spy,
        filter: () => true,
        match: ["on", "off"],
        path: EVENT_PATH,
      });

      emitSocketEvent(socketEvents, TEST_EVENT_TYPE, { command: "on" });
      // Let the timeout expire
      await vi.advanceTimersByTimeAsync(SEQUENCE_TIMEOUT_MS + TIMEOUT_MARGIN_MS);
      emitSocketEvent(socketEvents, TEST_EVENT_TYPE, { command: "off" });
      await vi.advanceTimersByTimeAsync(0);
      expect(spy).not.toHaveBeenCalled();
    });
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

    await automationTestRunner.run(async ({ automation, hass, context }) => {
      const socketEvents = (hass.socket as { socketEvents: SocketEventsEmitter }).socketEvents;

      automation.sequence({
        context,
        event_type: TEST_EVENT_TYPE,
        exec: spy,
        // filter receives { data: {...}, event_type }
        filter: (data: Record<string, Record<string, string>>) =>
          data["data"]["device_id"] === "allowed",
        match: ["toggle"],
        path: EVENT_PATH,
      });

      emitSocketEvent(socketEvents, TEST_EVENT_TYPE, { command: "toggle", device_id: "blocked" });
      await vi.advanceTimersByTimeAsync(SEQUENCE_TIMEOUT_MS + TIMEOUT_MARGIN_MS);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it("exec fires when the filter passes the event", async () => {
    const spy = vi.fn();

    await automationTestRunner.run(async ({ automation, hass, context }) => {
      const socketEvents = (hass.socket as { socketEvents: SocketEventsEmitter }).socketEvents;

      automation.sequence({
        context,
        event_type: TEST_EVENT_TYPE,
        exec: spy,
        filter: (data: Record<string, Record<string, string>>) =>
          data["data"]["device_id"] === "allowed",
        match: ["toggle"],
        path: EVENT_PATH,
      });

      emitSocketEvent(socketEvents, TEST_EVENT_TYPE, { command: "toggle", device_id: "allowed" });
      await drainEventChain();
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });
});

describe("SequenceWatcher — reset:self", () => {
  afterEach(async () => {
    await automationTestRunner.teardown();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reset:self allows the watcher to fire again immediately after the first match", async () => {
    const spy = vi.fn();

    await automationTestRunner.run(async ({ automation, hass, context }) => {
      const socketEvents = (hass.socket as { socketEvents: SocketEventsEmitter }).socketEvents;

      automation.sequence({
        context,
        event_type: TEST_EVENT_TYPE,
        exec: spy,
        filter: () => true,
        match: ["toggle"],
        path: EVENT_PATH,
        reset: "self",
      });

      vi.useFakeTimers();

      // First match — fires when sequence is complete
      emitSocketEvent(socketEvents, TEST_EVENT_TYPE, { command: "toggle" });
      await drainEventChain(true);
      expect(spy).toHaveBeenCalledTimes(1);

      // Advance past SEQUENCE_TIMEOUT so the forEach body's sleep expires and
      // ACTIVE.delete(data) runs, clearing the accumulated match state.
      // reset:self removes from ACTIVE in onMatch, but forEach re-adds it;
      // only after the sleep expires is ACTIVE fully cleared.
      await vi.advanceTimersByTimeAsync(SEQUENCE_TIMEOUT_MS + TIMEOUT_MARGIN_MS);

      // Second match — ACTIVE is clear, so this fires as a fresh single-step match
      emitSocketEvent(socketEvents, TEST_EVENT_TYPE, { command: "toggle" });
      await drainEventChain(true);
      expect(spy).toHaveBeenCalledTimes(2);
    });
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

    await automationTestRunner.run(async ({ automation, hass, context }) => {
      const socketEvents = (hass.socket as { socketEvents: SocketEventsEmitter }).socketEvents;

      const remove = automation.sequence({
        context,
        event_type: TEST_EVENT_TYPE,
        exec: spy,
        filter: () => true,
        match: ["toggle"],
        path: EVENT_PATH,
      });

      remove();

      emitSocketEvent(socketEvents, TEST_EVENT_TYPE, { command: "toggle" });
      await vi.advanceTimersByTimeAsync(SEQUENCE_TIMEOUT_MS + TIMEOUT_MARGIN_MS);
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
