import { CronExpression, TServiceParams } from "@digital-alchemy/core";
import dayjs from "dayjs";

import { LOCATION_UPDATED } from "../helpers/index.mts";

const MIN = 0;
const MAX = 1;

export function CircadianLighting({
  logger,
  lifecycle,
  scheduler,
  synapse,
  automation,
  config,
  context,
  event,
}: TServiceParams) {
  let circadianEntity: ReturnType<typeof synapse.sensor>;

  lifecycle.onPostConfig(() => {
    if (!config.automation.CIRCADIAN_ENABLED) {
      logger.info({ name: "onPostConfig" }, `circadian disabled`);
      return;
    }
    circadianEntity = synapse.sensor({
      context,
      // @ts-expect-error issue in synapse
      device_class: "temperature",
      icon: "mdi:sun-thermometer",
      name: config.automation.CIRCADIAN_SENSOR_NAME,
      unit_of_measurement: "K",
    });
    out.circadianEntity = circadianEntity;

    scheduler.cron({
      exec: () => updateKelvin(),
      schedule: CronExpression.EVERY_30_SECONDS,
    });
  });

  event.on(LOCATION_UPDATED, () => updateKelvin());

  function getKelvin() {
    const offset = getColorOffset();
    return Math.floor(
      (config.automation.CIRCADIAN_MAX_TEMP - config.automation.CIRCADIAN_MIN_TEMP) * offset +
        config.automation.CIRCADIAN_MIN_TEMP,
    );
  }

  function updateKelvin() {
    if (!circadianEntity) {
      return;
    }
    if (!automation.solar.loaded) {
      logger.debug({ name: updateKelvin }, `lat/long not loaded yet`);
      return;
    }
    circadianEntity.storage.set("state", getKelvin());
  }

  /**
   * Returns 0 when it's dark out, increasing to 1 at solar noon
   */
  function getColorOffset(): number {
    if (!circadianEntity) {
      return MIN;
    }
    if (!automation.solar.loaded) {
      logger.debug({ name: getColorOffset }, `lat/long not loaded yet`);
      return MIN;
    }
    const now = dayjs();
    const { solarNoon, dawn, dusk } = automation.solar;

    if (now.isBefore(dawn)) {
      // After midnight, but before dawn
      return MIN;
    }
    if (now.isBefore(solarNoon)) {
      // After dawn, but before solar noon
      return Math.abs(solarNoon.diff(now, "s") / solarNoon.diff(dawn, "s") - MAX);
    }
    if (now.isBefore(dusk)) {
      // Afternoon, but before dusk
      return Math.abs(solarNoon.diff(now, "s") / solarNoon.diff(dusk, "s") - MAX);
    }
    // Until midnight
    return MIN;
  }

  const out = {
    circadianEntity,
    getKelvin,
    updateKelvin,
  };
  return out;
}
