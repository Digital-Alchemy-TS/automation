import { each, is, TContext, TServiceParams } from "@digital-alchemy/core";
import { domain, ENTITY_STATE, PICK_ENTITY } from "@digital-alchemy/hass";

import {
  AGGRESSIVE_SCENES_ADJUSTMENT,
  AggressiveScenesAdjustmentData,
  RoomScene,
  SceneDefinition,
  SceneSwitchState,
} from "../helpers";

type TValidateOptions = {
  context: TContext;
  room: string;
  name: string;
  scene: RoomScene;
};

export function AggressiveScenes({
  logger,
  config,
  hass,
  event,
  automation,
}: TServiceParams) {
  // eslint-disable-next-line sonarjs/cognitive-complexity
  async function manageSwitch(
    entity: ENTITY_STATE<PICK_ENTITY<"switch">>,
    scene: SceneDefinition,
  ) {
    const entity_id = entity.entity_id as PICK_ENTITY<"switch">;
    const expected = scene[entity_id] as SceneSwitchState;
    if (is.empty(expected)) {
      // ??
      return;
    }
    if (entity.state === "unavailable") {
      logger.warn(
        { entity_id, name: manageSwitch },
        `{unavailable} entity, cannot manage state`,
      );
      return;
    }
    let performedUpdate = false;
    if (entity.state !== expected.state) {
      await matchSwitchToScene(entity, expected);
      performedUpdate = true;
    }
    if (performedUpdate) {
      return;
    }

    if ("entity_id" in entity.attributes) {
      // ? This is a group
      const id = entity.attributes.entity_id;
      if (is.array(id) && !is.empty(id)) {
        await each(
          entity.attributes.entity_id as PICK_ENTITY<"switch">[],
          async child_id => {
            const child = hass.entity.byId(child_id);
            if (!child) {
              logger.warn(
                { name: manageSwitch },
                `%s => %s child entity of group cannot be found`,
                entity_id,
                child_id,
              );
              return;
            }
            if (child.state === "unavailable") {
              logger.warn(
                { child_id, name: manageSwitch },
                `{unavailable} entity, cannot manage state`,
              );
              return;
            }
            if (child.state !== expected.state) {
              await matchSwitchToScene(child, expected);
            }
          },
        );
      }
    }
  }

  async function matchSwitchToScene(
    entity: ENTITY_STATE<PICK_ENTITY<"switch">>,
    expected: SceneSwitchState,
  ) {
    const entity_id = entity.entity_id;
    logger.debug(
      { entity_id, name: matchSwitchToScene, state: expected.state },
      `changing state`,
    );
    event.emit(AGGRESSIVE_SCENES_ADJUSTMENT, {
      entity_id,
      type: "switch_on_off",
    } as AggressiveScenesAdjustmentData);
    if (expected.state === "on") {
      await hass.call.switch.turn_on({ entity_id });
      return;
    }
    await hass.call.switch.turn_off({ entity_id });
  }

  /**
   * This function should **NOT** emit logs on noop
   *
   * - errors
   * - warnings
   * - state changes
   */
  async function validateRoomScene({
    scene,
    room,
    name,
    context,
  }: TValidateOptions): Promise<void> {
    if (
      config.automation.AGGRESSIVE_SCENES === false ||
      scene?.aggressive === false
    ) {
      // nothing to do
      return;
    }
    if (!scene?.definition) {
      logger.warn(
        { context, name: validateRoomScene, room, scene },
        `[%s] cannot validate room scene`,
        name,
      );
      return;
    }
    if (!is.object(scene.definition) || is.empty(scene.definition)) {
      // ? There currently is no use case for a scene with no entities in it
      // Not technically an error though
      logger.warn({ name: validateRoomScene, room: name }, "no definition");
      return;
    }
    const entities = Object.keys(scene.definition) as PICK_ENTITY[];
    await each(entities, async entity_id => {
      const entity = hass.entity.byId(entity_id);
      if (!entity) {
        // * Home assistant outright does not send an entity for this id
        // The wrong id was probably input
        //
        // ? This is distinct from "unavailable" entities
        logger.error(
          { entity_id, name: validateRoomScene },
          `cannot find entity`,
        );
        return;
      }
      const entityDomain = domain(entity_id);
      switch (entityDomain) {
        case "light":
          await automation.light.manageLight(
            entity as ENTITY_STATE<PICK_ENTITY<"light">>,
            scene.definition,
          );
          return;
        case "switch":
          await manageSwitch(
            entity as ENTITY_STATE<PICK_ENTITY<"switch">>,
            scene.definition,
          );
          return;
        default:
          logger.debug(
            { name: validateRoomScene },
            `{%s} no actions set for domain`,
            entityDomain,
          );
      }
    });
  }

  return {
    validateRoomScene,
  };
}
