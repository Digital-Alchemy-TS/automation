/**
 * SolarCalculator service tests (Pillar 1: real behavior against mock_assistant).
 *
 * ## Boot-ordering contract
 * `vi.useFakeTimers()` + `vi.setSystemTime()` MUST be called BEFORE `run()`.
 * SolarCalculator reads `new Date()` during `onBootstrap` → `populateReferences()`.
 * Any clock anchoring after boot will NOT retroactively fix the solar reference times.
 *
 * ## Assertion-timing contract
 * `solar.loaded` and the solar reference times (`sunrise`, `sunset`, etc.) are populated
 * inside `SolarCalculator.onBootstrap` which runs as an unprioritized (parallel)
 * lifecycle callback. The `run()` callback's `lifecycle.onBootstrap` also runs in
 * parallel — there is no ordering guarantee between them. Assertions about post-bootstrap
 * state MUST be deferred via `lifecycle.onReady`, which fires after ALL onBootstrap
 * handlers complete.
 *
 * ## Timezone contract
 * All HH:mm literals in `mock_assistant.time.*` are UTC.
 * Seed the clock to UTC midnight so solar-offset arithmetic stays unambiguous.
 */

import { MINUTE } from "@digital-alchemy/core";
import dayjs from "dayjs";

import { automationTestRunner } from "../mock/automation-test-runner.mts";

// ─── Named constants ──────────────────────────────────────────────────────────

/**
 * Anchor date: 10:00 UTC = 03:00 PDT on June 15.
 * At this point SF is before sunrise (~12:47 UTC / 05:47 PDT),
 * which means isBefore("sunrise") is true and the solar algorithm
 * computes June 15 events (not the previous day's).
 */
const ANCHOR_DATE = "2024-06-15T10:00:00.000Z";
/** San Francisco lat/long (clear summer sunrise/sunset on anchor date) */
const TEST_LATITUDE = 37.7749;
const TEST_LONGITUDE = -122.4194;
/** Offset applied to test that onEvent respects offsets */
const OFFSET_MINUTES = 15;
/** Tolerance in minutes for solar time comparisons (algorithm + TZ drift) */
const SOLAR_TOLERANCE_MINUTES = 90;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function advanceByTicks(totalMs: number): Promise<void> {
  let remaining = totalMs;
  while (remaining > 0) {
    const step = Math.min(MINUTE, remaining);
    vi.advanceTimersByTime(step);
    await Promise.resolve();
    await Promise.resolve();
    remaining -= step;
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SolarCalculator — solar reference times populated on bootstrap", () => {
  afterEach(async () => {
    await automationTestRunner.teardown();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reports loaded=true after bootstrap when hass config provides lat/long", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(ANCHOR_DATE));

    await automationTestRunner.run(({ automation, mock_assistant, lifecycle }) => {
      mock_assistant.config.merge({ latitude: TEST_LATITUDE, longitude: TEST_LONGITUDE });
      // onReady fires after ALL onBootstrap handlers (including SolarCalculator's) complete
      lifecycle.onReady(() => {
        expect(automation.solar.loaded).toBe(true);
      });
    });
  });

  it("sunset is after sunrise on a normal summer day (SF lat/long)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(ANCHOR_DATE));

    await automationTestRunner.run(({ automation, mock_assistant, lifecycle }) => {
      mock_assistant.config.merge({ latitude: TEST_LATITUDE, longitude: TEST_LONGITUDE });
      lifecycle.onReady(() => {
        const { sunrise, sunset } = automation.solar;
        expect(sunset.isAfter(sunrise)).toBe(true);
      });
    });
  });

  it("solarNoon falls between sunrise and sunset", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(ANCHOR_DATE));

    await automationTestRunner.run(({ automation, mock_assistant, lifecycle }) => {
      mock_assistant.config.merge({ latitude: TEST_LATITUDE, longitude: TEST_LONGITUDE });
      lifecycle.onReady(() => {
        const { sunrise, sunset, solarNoon } = automation.solar;
        expect(solarNoon.isAfter(sunrise)).toBe(true);
        expect(solarNoon.isBefore(sunset)).toBe(true);
      });
    });
  });

  it("isBetween(dawn, dusk) returns true when the clock is at solarNoon", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(ANCHOR_DATE));

    await automationTestRunner.run(async ({ automation, mock_assistant, lifecycle }) => {
      mock_assistant.config.merge({ latitude: TEST_LATITUDE, longitude: TEST_LONGITUDE });
      lifecycle.onReady(async () => {
        // Advance clock to solar noon
        const solarNoonMs = automation.solar.solarNoon.diff(dayjs(new Date(ANCHOR_DATE)), "ms");
        await advanceByTicks(solarNoonMs);
        expect(automation.solar.isBetween("dawn", "dusk")).toBe(true);
      });
    });
  });

  it("isBefore(sunrise) returns true when the clock is before sunrise", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(ANCHOR_DATE));

    await automationTestRunner.run(({ automation, mock_assistant, lifecycle }) => {
      mock_assistant.config.merge({ latitude: TEST_LATITUDE, longitude: TEST_LONGITUDE });
      lifecycle.onReady(() => {
        // Clock is at midnight UTC, which is before SF sunrise
        expect(automation.solar.isBefore("sunrise")).toBe(true);
      });
    });
  });

  it("isAfter(dawn) returns true when the clock is past solar noon", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(ANCHOR_DATE));

    await automationTestRunner.run(async ({ automation, mock_assistant, lifecycle }) => {
      mock_assistant.config.merge({ latitude: TEST_LATITUDE, longitude: TEST_LONGITUDE });
      lifecycle.onReady(async () => {
        // Advance to well after solar noon (18:00 UTC = 11:00 PDT)
        const eighteenHoursMs = 18 * 60 * MINUTE;
        await advanceByTicks(eighteenHoursMs);
        expect(automation.solar.isAfter("dawn")).toBe(true);
      });
    });
  });

  it("onEvent fires exec callback at the scheduled solar event time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(ANCHOR_DATE));
    const spy = vi.fn();

    await automationTestRunner.run(async ({ automation, mock_assistant, lifecycle }) => {
      mock_assistant.config.merge({ latitude: TEST_LATITUDE, longitude: TEST_LONGITUDE });

      lifecycle.onReady(async () => {
        const sunriseMs = automation.solar.sunrise.diff(dayjs(new Date(ANCHOR_DATE)), "ms");

        // Register onEvent — it schedules a setTimeout at the event time
        automation.solar.onEvent({
          eventName: "sunrise",
          exec: spy,
        });

        // Advance to just before sunrise — spy must NOT fire
        await advanceByTicks(sunriseMs - MINUTE);
        expect(spy).not.toHaveBeenCalled();

        // Advance past sunrise — spy must fire
        await advanceByTicks(2 * MINUTE);
        expect(spy).toHaveBeenCalledTimes(1);
      });
    });
  });

  it("onEvent with offsetMinutes fires after the base event time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(ANCHOR_DATE));
    const spy = vi.fn();

    await automationTestRunner.run(async ({ automation, mock_assistant, lifecycle }) => {
      mock_assistant.config.merge({ latitude: TEST_LATITUDE, longitude: TEST_LONGITUDE });

      lifecycle.onReady(async () => {
        const sunriseMs = automation.solar.sunrise.diff(dayjs(new Date(ANCHOR_DATE)), "ms");
        const offsetMs = OFFSET_MINUTES * MINUTE;

        automation.solar.onEvent({
          eventName: "sunrise",
          exec: spy,
          offset: OFFSET_MINUTES,
        });

        // At base sunrise — spy must NOT have fired yet (offset not reached)
        await advanceByTicks(sunriseMs);
        expect(spy).not.toHaveBeenCalled();

        // Advance through offset window — spy fires
        await advanceByTicks(offsetMs + MINUTE);
        expect(spy).toHaveBeenCalledTimes(1);
      });
    });
  });

  it("dawn and dusk are within 12 hours of solarNoon (SF, summer)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(ANCHOR_DATE));

    await automationTestRunner.run(({ automation, mock_assistant, lifecycle }) => {
      mock_assistant.config.merge({ latitude: TEST_LATITUDE, longitude: TEST_LONGITUDE });
      lifecycle.onReady(() => {
        const { dawn, dusk, solarNoon } = automation.solar;
        const dawnDiff = Math.abs(solarNoon.diff(dawn, "minute"));
        const duskDiff = Math.abs(solarNoon.diff(dusk, "minute"));
        expect(dawnDiff).toBeLessThan(SOLAR_TOLERANCE_MINUTES * 8);
        expect(duskDiff).toBeLessThan(SOLAR_TOLERANCE_MINUTES * 8);
      });
    });
  });
});
