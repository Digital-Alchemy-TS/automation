import { CronExpression, is, SINGLE, TContext, TServiceParams } from "@digital-alchemy/core";

import { ManagedSwitchOptions, PickASwitch } from "../helpers/index.mts";

export function ManagedSwitch({ logger, hass, scheduler, lifecycle }: TServiceParams) {
  /**
   * Logic runner for the state enforcer
   */
  async function updateEntities(
    current: boolean,
    switches: PickASwitch[],
    context: TContext,
  ): Promise<void> {
    // ? Bail out if no action can be taken
    if (hass.socket.connectionState !== "connected") {
      logger.warn(
        { context, name: updateEntities },
        `skipping state enforce attempt, socket not available`,
      );
      return;
    }
    // Annotation can be used on property getter, or directly on a plain property (that some other logic updates)
    const action = current ? "turn_on" : "turn_off";
    const entity_id = [switches].flat().map(i => (is.string(i) ? i : i.entity_id));

    const shouldExecute = entity_id.some(
      id => !action.includes(hass.refBy.id(id)?.state?.toLocaleLowerCase()),
    );
    if (!shouldExecute) {
      return;
    }
    // * Notify and execute!
    if (entity_id.length === SINGLE) {
      logger.debug({ entity_id, name: updateEntities }, action);
    } else {
      logger.debug({ action, entity_id, name: updateEntities });
    }
    await hass.call.switch[action]({ entity_id });
  }

  function ManageSwitch({
    context,
    entity_id,
    schedule = CronExpression.EVERY_MINUTE,
    shouldBeOn,
    onUpdate = [],
  }: ManagedSwitchOptions) {
    lifecycle.onReady(() => {
      logger.trace({ context, entity_id, name: ManageSwitch }, `setting up managed switch`);
      const entityList = is.array(entity_id) ? entity_id : [entity_id];

      // * Check if there should be a change
      const update = async () => {
        const expected = shouldBeOn();
        if (!is.boolean(expected)) {
          if (!is.undefined(expected)) {
            logger.error(
              { context, entity_id, expected, name: ManageSwitch },
              `Invalid value from switch manage function`,
            );
            return;
          }
          return;
        }
        await updateEntities(expected, entityList, context);
      };

      // * Always run on a schedule
      scheduler.cron({ exec: async () => await update(), schedule });

      // * Update when relevant things update
      if (!is.empty(onUpdate)) {
        [onUpdate].flat().forEach(i => {
          if (is.object(i) && !("entity_id" in i)) {
            const onUpdate = i.onUpdate;
            if (!is.function(onUpdate)) {
              return;
            }
            i.onUpdate(async () => await update());
            return;
          }
          hass.refBy.id(is.object(i) ? i.entity_id : i).onUpdate(async () => await update());
        });
      }
    });
  }
  return ManageSwitch;
}
