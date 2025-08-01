import { CronExpression, SINGLE, sleep, TBlackHole, TServiceParams } from "@digital-alchemy/core";
import { HassConfig } from "@digital-alchemy/hass";
import dayjs, { Dayjs } from "dayjs";
import { Duration, DurationUnitsObjectType, DurationUnitType } from "dayjs/plugin/duration";
import EventEmitter from "events";

import { calcSolNoon, calcSunriseSet } from "../index.mts";

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
type ISO_8601_PARTIAL = `${Part<"H" | "h">}${Part<"M" | "m">}${Part<"S" | "s">}` | "";

export type OffsetTypes =
  | Duration
  | number
  | DurationUnitsObjectType
  | ISO_8601_PARTIAL
  | [quantity: number, unit: DurationUnitType];

type TOffset = OffsetTypes | (() => OffsetTypes);

type OnSolarEvent = {
  label?: string;
  /**
   * **Any quantity may be negative**
   *
   * Value must be:
   * - (`number`) `ms`
   * - (`tuple`) [`quantity`, `unit`]
   * - (`string`) `ISO 8601` duration string: `P(#Y)(#M)(#D)(T(#H)(#M)(#S))`
   * - (`object`) mapping of units to quantities
   * - (`Duration`) `dayjs.duration` object
   * - (`function`) a function that returns any of the above
   * ---
   * Offset calculated at midnight & init
   */
  offset?: TOffset;
  eventName: SolarEvents;
  exec: () => TBlackHole;
};

type SolarReference = Record<SolarEvents, Dayjs> & {
  isBetween: (a: SolarEvents, b: SolarEvents) => boolean;
  isBefore: (event: SolarEvents) => boolean;
  isAfter: (event: SolarEvents) => boolean;
  loaded: boolean;
  onEvent: (options: OnSolarEvent) => { remove: () => TBlackHole };
};

/**
 * Benefits from a persistent cache, like Redis
 */
export function SolarCalculator({
  logger,
  scheduler,
  hass,
  lifecycle,
  internal: {
    utils: { is },
  },
}: TServiceParams) {
  let config: HassConfig;
  const event = new EventEmitter();
  event.setMaxListeners(UNLIMITED);
  let lastEventAttachment: string;

  lifecycle.onBootstrap(async () => {
    if (!config) {
      // Hold up bootstrapping for it
      logger.info({ name: "onBootstrap" }, `no lat/long on hand, fetching from Home Assistant`);
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
    exec: () => populateReferences(),
    schedule: CronExpression.EVERY_HOUR,
  });

  async function updateLocation() {
    config = await hass.fetch.getConfig();
    populateReferences();
  }

  const solarReference: Partial<SolarReference> = {};

  async function populateReferences() {
    solarReference.dawn = dayjs(
      calcSunriseSet(true, degreesBelowHorizon.twilight, config.latitude, config.longitude),
    );

    solarReference.sunriseEnd = dayjs(
      calcSunriseSet(true, degreesBelowHorizon.sunriseEnd, config.latitude, config.longitude),
    );

    solarReference.sunsetStart = dayjs(
      calcSunriseSet(false, degreesBelowHorizon.sunriseEnd, config.latitude, config.longitude),
    );

    solarReference.dusk = dayjs(
      calcSunriseSet(false, degreesBelowHorizon.twilight, config.latitude, config.longitude),
    );

    solarReference.nightStart = dayjs(
      calcSunriseSet(false, degreesBelowHorizon.night, config.latitude, config.longitude),
    );

    solarReference.nightEnd = dayjs(
      calcSunriseSet(true, degreesBelowHorizon.night, config.latitude, config.longitude),
    );

    solarReference.sunrise = dayjs(
      calcSunriseSet(true, degreesBelowHorizon.sunrise, config.latitude, config.longitude),
    );

    solarReference.sunset = dayjs(
      calcSunriseSet(false, degreesBelowHorizon.sunrise, config.latitude, config.longitude),
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
        setTimeout(() => event.emit(i), Math.abs(now.diff(solarReference[i], "ms")));
      });
    }
  }
  solarReference.loaded = false;

  solarReference.isBetween = (a: SolarEvents, b: SolarEvents) => {
    const now = dayjs();
    return now.isBetween(solarReference[a], solarReference[b]);
  };

  solarReference.isBefore = (event: SolarEvents) => {
    const now = dayjs();
    return now.isBefore(solarReference[event]);
  };

  solarReference.isAfter = (event: SolarEvents) => {
    const now = dayjs();
    return now.isAfter(solarReference[event]);
  };

  function getNextTime(eventName: SolarEvents, offset: TOffset, label: string) {
    let duration: Duration;
    // * if function, unwrap
    if (is.function(offset)) {
      offset = offset();
      logger.trace({ eventName, label, offset }, `resolved offset`);
    }
    // * if tuple, resolve
    if (is.array(offset)) {
      const [amount, unit] = offset;
      duration = dayjs.duration(amount, unit);
      // * resolve objects, or capture Duration
    } else if (is.object(offset)) {
      duration = isDuration(offset)
        ? (offset as Duration)
        : dayjs.duration(offset as DurationUnitsObjectType);
    }
    // * resolve from partial ISO 8601
    if (is.string(offset)) {
      duration = dayjs.duration(`PT${offset.toUpperCase()}`);
    }
    // * ms
    if (is.number(offset)) {
      duration = dayjs.duration(offset, "ms");
    }
    return duration ? solarReference[eventName].add(duration) : solarReference[eventName];
  }

  solarReference.onEvent = ({ eventName, label, exec, offset }: OnSolarEvent) => {
    async function run() {
      const nextTrigger = getNextTime(eventName, offset, label);
      const logData = {
        eventName,
        label,
        nextTime: nextTrigger.toDate().toLocaleString(),
        offset,
      };
      if (nextTrigger.isAfter(dayjs().startOf("hour").add(SINGLE, "hour"))) {
        logger.trace(logData, "solar trigger not soon");
        return;
      }
      logger.trace(logData, "scheduling solar trigger soon");
      await sleep(nextTrigger.toDate());
      logger.debug(logData, "triggering event");
      await exec();
    }
    // check at boot
    lifecycle.onReady(async () => await run());

    // recheck every hour
    const remove = scheduler.cron({
      exec: async () => await run(),
      schedule: CronExpression.EVERY_HOUR,
    });
    return { remove };
  };

  return solarReference as SolarReference;
}

function isDuration(item: Duration | DurationUnitsObjectType): item is Duration {
  return typeof item.days === "function";
}
