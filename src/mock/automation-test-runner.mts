/**
 * Test runners for @digital-alchemy/automation specs.
 *
 * Architecture: extends the hass `createTestRunner()` factory (which provides
 * LIB_HASS + LIB_MOCK_ASSISTANT in the correct wiring order), then appends
 * LIB_SYNAPSE, LIB_MOCK_SYNAPSE, and finally LIB_AUTOMATION.
 *
 * This mirrors the pattern from synapse's `synapseTestRunner` which extends
 * `fromLibrary(LIB_SYNAPSE)` and appends mock libraries.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CreateLibrary, createModule, TServiceParams } from "@digital-alchemy/core";
import { LIB_HASS } from "@digital-alchemy/hass";
import { LIB_MOCK_ASSISTANT } from "@digital-alchemy/hass/mock-assistant";
import { LIB_SYNAPSE } from "@digital-alchemy/synapse";
import { LIB_MOCK_SYNAPSE } from "@digital-alchemy/synapse/mock";

import { LIB_AUTOMATION } from "../automation.module.mts";

/**
 * Resolve the fixtures file from the hass portal checkout.
 */
function resolveFixturesFile(): string {
  const thisDir = fileURLToPath(new URL(".", import.meta.url));
  const pkgRoot = resolve(thisDir, "..", "..");
  const candidate = join(pkgRoot, "node_modules", "@digital-alchemy", "hass", "fixtures.json");
  if (existsSync(candidate)) {
    return candidate;
  }
  const synapseCandidate = join(
    pkgRoot,
    "node_modules",
    "@digital-alchemy",
    "synapse",
    "fixtures.json",
  );
  if (existsSync(synapseCandidate)) {
    return synapseCandidate;
  }
  throw new Error(`Could not locate fixtures.json. Tried:\n  ${candidate}\n  ${synapseCandidate}`);
}

const FIXTURES_FILE = resolveFixturesFile();

/** Minimum Kelvin used in circadian tests — named so test assertions can reference the same value */
export const CIRCADIAN_TEST_MIN_TEMP = 2000;
/** Maximum Kelvin used in circadian tests */
export const CIRCADIAN_TEST_MAX_TEMP = 5500;

/**
 * Default lat/long injected at setup time so SolarCalculator.onBootstrap never
 * receives undefined coordinates (which causes calcSunriseSet to enter an
 * infinite loop in calcJDofNextPreviousRiseSet).
 *
 * Using San Francisco as a representative mid-latitude location.
 */
const DEFAULT_LATITUDE = 37.7749;
const DEFAULT_LONGITUDE = -122.4194;

const SHARED_OPTIONS = {
  configSources: { argv: false, env: false, file: false } as const,
};

const SHARED_CONFIG = {
  boilerplate: { IS_TEST: true },
  mock_assistant: { FIXTURES_FILE },
  synapse: {
    DATABASE_TYPE: "sqlite" as const,
    DATABASE_URL: ":memory:",
    EMIT_HEARTBEAT: false,
  },
};

/**
 * Library that seeds lat/long into the mock hass config BEFORE
 * SolarCalculator.onBootstrap fires.
 *
 * Must depend on LIB_MOCK_ASSISTANT so mock_assistant.config is available
 * when SeedLocation's constructor runs.
 */
const LIB_SOLAR_SEED = CreateLibrary({
  depends: [LIB_MOCK_ASSISTANT],
  name: "solar_seed",
  services: {
    location: ({ mock_assistant }: TServiceParams) => {
      mock_assistant.config.merge({
        latitude: DEFAULT_LATITUDE,
        longitude: DEFAULT_LONGITUDE,
      });
    },
  },
});

declare module "@digital-alchemy/core" {
  export interface LoadedModules {
    solar_seed: typeof LIB_SOLAR_SEED;
  }
}

function buildRunner(automationConfig: Record<string, unknown> = {}) {
  return createModule
    .fromLibrary(LIB_HASS)
    .extend()
    .toTest()
    .setOptions(SHARED_OPTIONS)
    .configure({
      ...SHARED_CONFIG,
      automation: automationConfig,
    })
    .appendLibrary(LIB_SYNAPSE)
    .appendLibrary(LIB_AUTOMATION)
    .appendLibrary(LIB_MOCK_SYNAPSE)
    .appendLibrary(LIB_MOCK_ASSISTANT)
    .appendLibrary(LIB_SOLAR_SEED);
}

/** Default runner: CIRCADIAN_ENABLED=false (module default) */
export const automationTestRunner = buildRunner();

/**
 * Circadian runner: CIRCADIAN_ENABLED=true with controlled temperature range.
 * Use for specs that test getKelvin / updateKelvin / sensor state behavior.
 */
export const automationCircadianRunner = buildRunner({
  CIRCADIAN_ENABLED: true,
  CIRCADIAN_MAX_TEMP: CIRCADIAN_TEST_MAX_TEMP,
  CIRCADIAN_MIN_TEMP: CIRCADIAN_TEST_MIN_TEMP,
});
