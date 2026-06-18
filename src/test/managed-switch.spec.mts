/**
 * ManagedSwitch service tests (Pillar 3: declarative switch state enforcement).
 *
 * ManagedSwitch enforces a switch entity's on/off state by:
 *   1. Checking on a cron schedule (default: every minute).
 *   2. Checking whenever any `onUpdate` entity changes.
 *
 * Key behaviors under test:
 *   - When `shouldBeOn()` returns `true` and the current hass state is "off",
 *     `hass.call.switch.turn_on` is called.
 *   - When `shouldBeOn()` returns `false` and the current state is "on",
 *     `hass.call.switch.turn_off` is called.
 *   - When the switch is already in the correct state, no service call is made.
 *   - When `shouldBeOn()` returns `undefined`, no service call is made.
 *   - During teardown the cron tick is ignored (boot.phase check).
 */

import { CronExpression, MINUTE } from "@digital-alchemy/core";

// Register test entity IDs into HassEntitySetupMapping
import "./test-types.mts";

import { automationTestRunner } from "../mock/automation-test-runner.mts";

// ─── Named constants ──────────────────────────────────────────────────────────

/** Entity used in all tests — must be a switch domain entity_id */
const TEST_SWITCH = "switch.test_managed_switch" as const;
/** Cron that fires every minute — matches the test's `schedule` override */
const EVERY_MINUTE = CronExpression.EVERY_MINUTE;
/** Advance window to trigger one cron tick */
const ONE_MINUTE_MS = MINUTE;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function advanceOneTick(): Promise<void> {
  vi.advanceTimersByTime(ONE_MINUTE_MS);
  await Promise.resolve();
  await Promise.resolve();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ManagedSwitch — turn_on enforcement", () => {
  afterEach(async () => {
    await automationTestRunner.teardown();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("calls hass.call.switch.turn_on when shouldBeOn=true and entity state is off", async () => {
    vi.useFakeTimers();
    const turnOnSpy = vi.fn().mockResolvedValue(undefined);
    const turnOffSpy = vi.fn().mockResolvedValue(undefined);

    await automationTestRunner.run(async ({ automation, hass, mock_assistant, context }) => {
      // Seed the entity state as "off"
      mock_assistant.entity.register(TEST_SWITCH, { state: "off" });

      // Intercept service calls
      hass.call.switch.turn_on = turnOnSpy;
      hass.call.switch.turn_off = turnOffSpy;

      automation.managed_switch({
        context,
        entity_id: TEST_SWITCH,
        schedule: EVERY_MINUTE,
        shouldBeOn: () => true,
      });

      await advanceOneTick();
    });

    expect(turnOnSpy).toHaveBeenCalledWith({ entity_id: [TEST_SWITCH] });
    expect(turnOffSpy).not.toHaveBeenCalled();
  });

  it("calls hass.call.switch.turn_off when shouldBeOn=false and entity state is on", async () => {
    vi.useFakeTimers();
    const turnOnSpy = vi.fn().mockResolvedValue(undefined);
    const turnOffSpy = vi.fn().mockResolvedValue(undefined);

    await automationTestRunner.run(async ({ automation, hass, mock_assistant, context }) => {
      mock_assistant.entity.register(TEST_SWITCH, { state: "on" });

      hass.call.switch.turn_on = turnOnSpy;
      hass.call.switch.turn_off = turnOffSpy;

      automation.managed_switch({
        context,
        entity_id: TEST_SWITCH,
        schedule: EVERY_MINUTE,
        shouldBeOn: () => false,
      });

      await advanceOneTick();
    });

    expect(turnOffSpy).toHaveBeenCalledWith({ entity_id: [TEST_SWITCH] });
    expect(turnOnSpy).not.toHaveBeenCalled();
  });
});

describe("ManagedSwitch — no-op when already in correct state", () => {
  afterEach(async () => {
    await automationTestRunner.teardown();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("makes no service call when shouldBeOn=true and entity is already on", async () => {
    vi.useFakeTimers();
    const turnOnSpy = vi.fn().mockResolvedValue(undefined);

    await automationTestRunner.run(async ({ automation, hass, mock_assistant, context }) => {
      mock_assistant.entity.register(TEST_SWITCH, { state: "on" });
      hass.call.switch.turn_on = turnOnSpy;

      automation.managed_switch({
        context,
        entity_id: TEST_SWITCH,
        schedule: EVERY_MINUTE,
        shouldBeOn: () => true,
      });

      await advanceOneTick();
    });

    expect(turnOnSpy).not.toHaveBeenCalled();
  });

  it("makes no service call when shouldBeOn=false and entity is already off", async () => {
    vi.useFakeTimers();
    const turnOffSpy = vi.fn().mockResolvedValue(undefined);

    await automationTestRunner.run(async ({ automation, hass, mock_assistant, context }) => {
      mock_assistant.entity.register(TEST_SWITCH, { state: "off" });
      hass.call.switch.turn_off = turnOffSpy;

      automation.managed_switch({
        context,
        entity_id: TEST_SWITCH,
        schedule: EVERY_MINUTE,
        shouldBeOn: () => false,
      });

      await advanceOneTick();
    });

    expect(turnOffSpy).not.toHaveBeenCalled();
  });
});

describe("ManagedSwitch — shouldBeOn undefined", () => {
  afterEach(async () => {
    await automationTestRunner.teardown();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("makes no service call when shouldBeOn returns undefined", async () => {
    vi.useFakeTimers();
    const turnOnSpy = vi.fn().mockResolvedValue(undefined);
    const turnOffSpy = vi.fn().mockResolvedValue(undefined);

    await automationTestRunner.run(async ({ automation, hass, mock_assistant, context }) => {
      mock_assistant.entity.register(TEST_SWITCH, { state: "off" });
      hass.call.switch.turn_on = turnOnSpy;
      hass.call.switch.turn_off = turnOffSpy;

      automation.managed_switch({
        context,
        entity_id: TEST_SWITCH,
        schedule: EVERY_MINUTE,
        shouldBeOn: () => undefined,
      });

      await advanceOneTick();
    });

    expect(turnOnSpy).not.toHaveBeenCalled();
    expect(turnOffSpy).not.toHaveBeenCalled();
  });
});
