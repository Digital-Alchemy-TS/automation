import {
  CronExpression,
  is,
  NONE,
  TBlackHole,
  TServiceParams,
} from "@digital-alchemy/core";
import { HassConfig } from "@digital-alchemy/hass";
import dayjs, { Dayjs } from "dayjs";
import {
  Duration,
  DurationUnitsObjectType,
  DurationUnitType,
} from "dayjs/plugin/duration";
import EventEmitter from "events";

import { calcSolNoon, calcSunriseSet } from "..";

export type SolarEvents =
  | "dawn"
  | "dusk"
  | "solarNoon"
  | "sunrise"
  | "nightStart"
  | "nightEnd"
  | "sunset"
  | "sunriseEnd"
  | "sunsetStart";

const solarEvents = [
  "dawn",
  "sunriseEnd",
  "sunsetStart",
  "dusk",
  "nightStart",
  "nightEnd",
  "sunrise",
  "sunset",
  "solarNoon",
] as SolarEvents[];

const CACHE_KEY = "SOLAR_CALC_CONFIG_CACHE";

const degreesBelowHorizon = {
  goldenHour: -6,
  nauticalTwilight: 12,
  night: 18,
  sunrise: 0.833,
  sunriseEnd: 0.3,
  twilight: 6,
};
const UNLIMITED = 0;
type Part<CHAR extends string> = `${number}${CHAR}` | "";
type Time = `T${Part<"H">}${Part<"M">}${Part<"S">}` | "";
type ISO_8601 = `P${Part<"Y">}${Part<"M">}${Part<"W">}${Part<"D">}${Time}`;

type OffsetTypes =
  | Duration
  | number
  | DurationUnitsObjectType
  | ISO_8601
  | [quantity: number, unit: DurationUnitType];

type OnSolarEvent = {
  label?: string;
  offset?: OffsetTypes | (() => OffsetTypes);
  eventName: SolarEvents;
  exec: () => TBlackHole;
};

type SolarReference = Record<SolarEvents, Dayjs> & {
  isBetween: (a: SolarEvents, b: SolarEvents) => boolean;
  loaded: boolean;
  onEvent: (options: OnSolarEvent) => TBlackHole;
};

/**
 * Benefits from a persistent cache, like Redis
 */
export function SolarCalculator({
  logger,
  cache,
  scheduler,
  hass,
  lifecycle,
}: TServiceParams) {
  let config: HassConfig;
  const event = new EventEmitter();
  event.setMaxListeners(UNLIMITED);
  let lastEventAttachment: string;

  lifecycle.onBootstrap(async () => {
    config = await cache.get(CACHE_KEY);
    if (!config) {
      // Hold up bootstrapping for it
      logger.info(
        { name: "onBootstrap" },
        `no lat/long on hand, fetching from Home Assistant`,
      );
      await updateLocation();
      return;
    }
    // Background update, just in case
    // Not expecting it to change, so it can be done in
    setImmediate(async () => await updateLocation());
  });

  // Rebuild references hourly
  //
  scheduler.cron({
    exec: () => PopulateReferences(),
    schedule: CronExpression.EVERY_HOUR,
  });

  async function updateLocation() {
    config = await hass.fetch.getConfig();
    await cache.set(CACHE_KEY, config);
    PopulateReferences();
  }

  const solarReference: Partial<SolarReference> = {};

  async function PopulateReferences() {
    solarReference.dawn = dayjs(
      calcSunriseSet(
        true,
        degreesBelowHorizon.twilight,
        config.latitude,
        config.longitude,
      ),
    );

    solarReference.sunriseEnd = dayjs(
      calcSunriseSet(
        true,
        degreesBelowHorizon.sunriseEnd,
        config.latitude,
        config.longitude,
      ),
    );

    solarReference.sunsetStart = dayjs(
      calcSunriseSet(
        false,
        degreesBelowHorizon.sunriseEnd,
        config.latitude,
        config.longitude,
      ),
    );

    solarReference.dusk = dayjs(
      calcSunriseSet(
        false,
        degreesBelowHorizon.twilight,
        config.latitude,
        config.longitude,
      ),
    );

    solarReference.nightStart = dayjs(
      calcSunriseSet(
        false,
        degreesBelowHorizon.night,
        config.latitude,
        config.longitude,
      ),
    );

    solarReference.nightEnd = dayjs(
      calcSunriseSet(
        true,
        degreesBelowHorizon.night,
        config.latitude,
        config.longitude,
      ),
    );

    solarReference.sunrise = dayjs(
      calcSunriseSet(
        true,
        degreesBelowHorizon.sunrise,
        config.latitude,
        config.longitude,
      ),
    );

    solarReference.sunset = dayjs(
      calcSunriseSet(
        false,
        degreesBelowHorizon.sunrise,
        config.latitude,
        config.longitude,
      ),
    );

    solarReference.solarNoon = dayjs(calcSolNoon(config.longitude));
    solarReference.loaded = true;

    const now = dayjs();
    const today = now.format("YYYY-MM-DD");
    if (lastEventAttachment !== today) {
      lastEventAttachment = today;
      solarEvents.forEach((i: SolarEvents) => {
        if (solarReference[i].isBefore(now)) {
          return;
        }
        setTimeout(
          () => event.emit(i),
          Math.abs(now.diff(solarReference[i], "ms")),
        );
      });
    }
  }
  solarReference.loaded = false;

  solarReference.isBetween = (a: SolarEvents, b: SolarEvents) => {
    const now = dayjs();
    return now.isBetween(solarReference[a], solarReference[b]);
  };

  solarReference.onEvent = ({
    eventName,
    label,
    exec,
    offset,
  }: OnSolarEvent) => {
    let duration: Duration;
    if (is.function(offset)) {
      offset = offset();
    }
    if (is.array(offset)) {
      const [amount, unit] = offset;
      duration = dayjs.duration(amount, unit);
    } else if (is.object(offset)) {
      duration = isDuration(offset)
        ? (offset as Duration)
        : dayjs.duration(offset as DurationUnitsObjectType);
    }
    if (is.string(offset)) {
      duration = dayjs.duration(offset);
    }
    if (is.number(offset)) {
      duration = dayjs.duration(offset, "ms");
    }
    scheduler.sliding({
      exec: async () => await exec(),
      label,
      next: () =>
        duration
          ? solarReference[eventName].add(duration)
          : solarReference[eventName],
      reset: CronExpression.EVERY_DAY_AT_MIDNIGHT,
    });
  };

  return solarReference as SolarReference;
}

function isDuration(
  item: Duration | DurationUnitsObjectType,
): item is Duration {
  return typeof item.days === "function";
}
