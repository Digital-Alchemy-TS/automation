/**
 * CircadianLighting service tests (Pillar 4: color temperature progression).
 *
 * CircadianLighting:
 *   - Is disabled by default (CIRCADIAN_ENABLED=false); `circadianEntity` stays undefined.
 *   - When enabled, creates a `synapse.sensor` entity on `onPostConfig`.
 *   - Updates sensor state every 30 seconds via cron.
 *   - Computes Kelvin as a linear interpolation between CIRCADIAN_MIN_TEMP and
 *     CIRCADIAN_MAX_TEMP based on solar position (offset 0 at night, 1 at solar noon).
 *
 * Boot-ordering: `vi.useFakeTimers()` + `vi.setSystemTime()` BEFORE `run()`.
 * All HH:mm times are UTC; anchor to UTC midnight.
 *
 * Assertion-timing: solar reference times (`solarNoon`, `dawn`, `dusk`) are populated
 * in `SolarCalculator.onBootstrap` which runs in parallel with the test callback's
 * `onBootstrap`. All assertions that access solar properties MUST be deferred via
 * `lifecycle.onReady`, which fires after ALL `onBootstrap` handlers complete.
 */

import dayjs from "dayjs";

import {
  automationCircadianRunner,
  automationTestRunner,
  CIRCADIAN_TEST_MAX_TEMP,
  CIRCADIAN_TEST_MIN_TEMP,
} from "../mock/automation-test-runner.mts";

// ─── Named constants ──────────────────────────────────────────────────────────

/**
 * Anchor date: 10:00 UTC = 03:00 PDT on June 15.
 * At this point SF is before sunrise (~12:47 UTC / 05:47 PDT),
 * which means the solar algorithm computes June 15 events (not the previous day's).
 * Using UTC midnight causes solar noon to fall before the anchor (yesterday's noon),
 * producing negative tick values.
 */
const ANCHOR_DATE = "2024-06-15T10:00:00.000Z";
/** San Francisco lat/long */
const TEST_LATITUDE = 37.7749;
const TEST_LONGITUDE = -122.4194;
/** Cron advance to guarantee at least one 30-second tick (use 31 seconds) */
const THIRTY_ONE_SECONDS_MS = 31 * 1000;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("CircadianLighting — disabled by default", () => {
  afterEach(async () => {
    await automationTestRunner.teardown();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("circadianEntity is undefined when CIRCADIAN_ENABLED=false", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(ANCHOR_DATE));

    await automationTestRunner.run(({ automation, mock_assistant, lifecycle }) => {
      mock_assistant.config.merge({ latitude: TEST_LATITUDE, longitude: TEST_LONGITUDE });
      // circadianEntity is only populated in onPostConfig when CIRCADIAN_ENABLED=true
      lifecycle.onReady(() => {
        expect(automation.circadian.circadianEntity).toBeUndefined();
      });
    });
  });
});

describe("CircadianLighting — Kelvin at night (before dawn)", () => {
  afterEach(async () => {
    await automationCircadianRunner.teardown();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("getKelvin returns MIN_TEMP before dawn (clock at UTC midnight)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(ANCHOR_DATE));

    await automationCircadianRunner.run(({ automation, mock_assistant, lifecycle }) => {
      mock_assistant.config.merge({ latitude: TEST_LATITUDE, longitude: TEST_LONGITUDE });
      // UTC midnight is before SF dawn — offset = 0 → MIN_TEMP
      lifecycle.onReady(() => {
        expect(automation.circadian.getKelvin()).toBe(CIRCADIAN_TEST_MIN_TEMP);
      });
    });
  });
});

describe("CircadianLighting — Kelvin at solar noon", () => {
  afterEach(async () => {
    await automationCircadianRunner.teardown();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("getKelvin returns MAX_TEMP when clock is at solar noon", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(ANCHOR_DATE));

    await automationCircadianRunner.run(async ({ automation, mock_assistant, lifecycle }) => {
      mock_assistant.config.merge({ latitude: TEST_LATITUDE, longitude: TEST_LONGITUDE });

      lifecycle.onReady(async () => {
        // Advance to solar noon so offset is 1.0 → MAX_TEMP
        const solarNoonMs = automation.solar.solarNoon.diff(dayjs(new Date(ANCHOR_DATE)), "ms");
        vi.advanceTimersByTime(solarNoonMs);
        await Promise.resolve();

        expect(automation.circadian.getKelvin()).toBe(CIRCADIAN_TEST_MAX_TEMP);
      });
    });
  }, 10_000);
});

describe("CircadianLighting — Kelvin during morning", () => {
  afterEach(async () => {
    await automationCircadianRunner.teardown();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("getKelvin is between MIN and MAX at the midpoint between dawn and solar noon", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(ANCHOR_DATE));

    await automationCircadianRunner.run(async ({ automation, mock_assistant, lifecycle }) => {
      mock_assistant.config.merge({ latitude: TEST_LATITUDE, longitude: TEST_LONGITUDE });

      lifecycle.onReady(async () => {
        const { dawn, solarNoon } = automation.solar;
        const dawnMs = dawn.diff(dayjs(new Date(ANCHOR_DATE)), "ms");
        const midMorningMs = dawnMs + Math.floor(solarNoon.diff(dawn, "ms") / 2);

        vi.advanceTimersByTime(midMorningMs);
        await Promise.resolve();

        const kelvin = automation.circadian.getKelvin();
        expect(kelvin).toBeGreaterThan(CIRCADIAN_TEST_MIN_TEMP);
        expect(kelvin).toBeLessThan(CIRCADIAN_TEST_MAX_TEMP);
      });
    });
  }, 10_000);
});

describe("CircadianLighting — updateKelvin writes to sensor storage", () => {
  afterEach(async () => {
    await automationCircadianRunner.teardown();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("updateKelvin sets sensor state to the computed Kelvin value", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(ANCHOR_DATE));

    await automationCircadianRunner.run(async ({ automation, mock_assistant, lifecycle }) => {
      mock_assistant.config.merge({ latitude: TEST_LATITUDE, longitude: TEST_LONGITUDE });

      lifecycle.onReady(async () => {
        // Advance to solar noon so offset is 1.0 → MAX_TEMP
        const solarNoonMs = automation.solar.solarNoon.diff(dayjs(new Date(ANCHOR_DATE)), "ms");
        vi.advanceTimersByTime(solarNoonMs);
        await Promise.resolve();

        automation.circadian.updateKelvin();

        expect(automation.circadian.circadianEntity?.storage.get("state")).toBe(
          CIRCADIAN_TEST_MAX_TEMP,
        );
      });
    });
  }, 10_000);

  it("cron tick writes a value to sensor state after 30 seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(ANCHOR_DATE));

    await automationCircadianRunner.run(async ({ automation, mock_assistant, lifecycle }) => {
      mock_assistant.config.merge({ latitude: TEST_LATITUDE, longitude: TEST_LONGITUDE });

      lifecycle.onReady(async () => {
        // Sensor storage should be undefined before the first cron tick
        const before = automation.circadian.circadianEntity?.storage.get("state");
        expect(before).toBeUndefined();

        // Advance past the 30-second cron boundary — triggers one updateKelvin() call.
        // Use advanceTimersByTimeAsync to allow the async safeExec chain to settle.
        await vi.advanceTimersByTimeAsync(THIRTY_ONE_SECONDS_MS);

        // After the cron tick the sensor state must be set to a valid Kelvin value
        const after = automation.circadian.circadianEntity?.storage.get("state") as number;
        expect(after).toBeGreaterThanOrEqual(CIRCADIAN_TEST_MIN_TEMP);
        expect(after).toBeLessThanOrEqual(CIRCADIAN_TEST_MAX_TEMP);
      });
    });
  }, 10_000);
});
