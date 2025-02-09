import {
  CronExpression,
  eachSeries,
  FIRST,
  InternalError,
  TServiceParams,
  VALUE,
} from "@digital-alchemy/core";
import {
  ALL_DOMAINS,
  ByIdProxy,
  PICK_ENTITY,
  PICK_FROM_AREA,
  TAreaId,
} from "@digital-alchemy/hass";

import {
  RoomConfiguration,
  RoomScene,
  SceneDefinition,
  SceneLightState,
} from "../helpers/index.mts";

function toHassId<DOMAIN extends ALL_DOMAINS>(domain: DOMAIN, ...parts: string[]) {
  const name = parts.join(" ").toLowerCase().replaceAll(/\s+/g, "_").replaceAll(/\W/g, "");
  return `${domain}.${name}` as PICK_ENTITY<DOMAIN>;
}

export type RoomDefinition<SCENES extends string = string, ROOM extends TAreaId = TAreaId> = {
  scene: SCENES;
  currentSceneDefinition: RoomScene<ROOM>;
  currentSceneEntity: ByIdProxy<PICK_ENTITY<"sensor">>;
  sceneId: (scene: SCENES) => PICK_ENTITY<"scene">;
  name: ROOM;
};
interface HasKelvin {
  kelvin: number;
}

export function Room({
  logger,
  hass,
  synapse,
  internal: {
    utils: { is },
  },
  scheduler,
  automation,
  context: parentContext,
}: TServiceParams) {
  return function <SCENES extends string, ROOM extends TAreaId>({
    area: name,
    context,
    scenes,
  }: RoomConfiguration<SCENES, ROOM>): RoomDefinition<SCENES> {
    logger.debug({ name }, `create room`);
    const SCENE_LIST = Object.keys(scenes) as SCENES[];

    const sensorName = `${name} current scene`;

    const currentScene = synapse.select({
      context,
      current_option: SCENE_LIST[FIRST],
      managed: false,
      name: sensorName,
      options: SCENE_LIST,
      select_option: async ({ option }) => await setScene(option as SCENES),
    });

    scheduler.cron({
      exec: async () => {
        const current = currentScene.storage.get("current_option") as SCENES;
        await automation.aggressive.validateRoomScene({
          context,
          name: current,
          room: name,
          scene: scenes[current],
        });
      },
      schedule: CronExpression.EVERY_30_SECONDS,
    });

    /**
     * Should circadian if:
     *  - auto circadian is not disabled
     *  - is a light, that is currently on
     *  - the light was recently turned off (<5s)
     */
    function shouldCircadian(entity_id: PICK_ENTITY<"light">, target?: string): boolean {
      if (!is.domain(entity_id, "light")) {
        return false;
      }
      if (!is.empty(target) && target !== "on") {
        return false;
      }
      const current = (scenes[currentScene.storage.get("current_option") as SCENES] ??
        {}) as RoomScene<ROOM>;
      const definition = current.definition;
      if (entity_id in definition) {
        const state = definition[entity_id] as SceneLightState;
        return Object.keys(state).every(i => ["state", "brightness"].includes(i));
      }
      return true;
    }

    function dynamicProperties(sceneName: SCENES) {
      const { definition } = scenes[sceneName] as RoomScene<ROOM, SceneDefinition<ROOM>>;
      if (!is.object(definition)) {
        return { lights: {}, scene: {} };
      }
      const entities = Object.keys(definition) as PICK_FROM_AREA<ROOM>[];
      const kelvin = automation.circadian.getKelvin();
      const list = entities
        .map(name => {
          const value = definition[name] as SceneLightState;

          if (is.domain(name, "switch")) {
            return [name, value];
          }
          if (!is.domain(name, "light")) {
            return undefined;
          }
          if (!shouldCircadian(name, value?.state)) {
            return [name, value];
          }
          return [name, { kelvin, ...value }];
        })
        .filter(i => !is.undefined(i));

      return {
        lights: Object.fromEntries(list.filter(i => !is.undefined((i[VALUE] as HasKelvin).kelvin))),
        scene: Object.fromEntries(list.filter(i => is.undefined((i[VALUE] as HasKelvin).kelvin))),
      };
    }

    async function sceneApply(sceneName: SCENES) {
      const { scene, lights } = dynamicProperties(sceneName);
      // Send most things through the expected scene apply
      // Send requests to set lights to a specific temperature through the `light.turn_on` call
      await Promise.all([
        // Normal scene set
        new Promise<void>(async done => {
          if (!is.empty(scene)) {
            await hass.call.scene.apply({
              entities: scene,
            });
          }
          done();
        }),
        // Set lights to current color temp
        new Promise<void>(async done => {
          await eachSeries(
            Object.keys(lights) as PICK_ENTITY<"light">[],
            async (entity_id: PICK_ENTITY<"light">) => {
              const change = lights[entity_id];
              await hass.call.light.turn_on({
                brightness: change.brightness,
                entity_id,
                kelvin: change.kelvin,
              });
            },
          );
          done();
        }),
      ]);
    }

    async function setScene(sceneName: SCENES) {
      // ensure not garbage inputs
      if (!is.string(sceneName) || !is.object(scenes[sceneName])) {
        throw new InternalError(
          parentContext,
          "INVALID_SCENE",
          `scene does not exist on room ${name}`,
        );
      }
      logger.info({ name }, `set scene {%s}`, sceneName);
      currentScene.storage.set("current_option", sceneName);
      await sceneApply(sceneName);
    }

    SCENE_LIST.forEach(scene => {
      const sceneName = `${name} ${scene}`;
      synapse.scene({
        async activate() {
          logger.trace({ name: sceneName }, `scene activate`);
          await setScene(scene as SCENES);
        },
        context,
        name: sceneName,
      });
    });

    const out = new Proxy({} as RoomDefinition<SCENES>, {
      get: (_, property: keyof RoomDefinition<SCENES>) => {
        if (property === "scene") {
          return currentScene.storage.get("current_option");
        }
        if (property === "sceneId") {
          return (scene: SCENES) => {
            return toHassId("scene", name, scene);
          };
        }
        if (property === "name") {
          return name;
        }
        if (property === "currentSceneEntity") {
          return currentScene.getEntity();
        }
        if (property === "currentSceneDefinition") {
          return scenes[currentScene.storage.get("current_option") as SCENES];
        }
        return undefined;
      },
      set: (_, property: keyof RoomDefinition<SCENES>, value) => {
        if (property === "scene") {
          setImmediate(
            async () =>
              // ? This way adds a network hop, allows hass to create a logbook entry for the call
              await hass.call.scene.turn_on({
                entity_id: toHassId("scene", name, value),
              }),
          );
          return true;
        }
        logger.error({ property }, `cannot set property on room`);
        return false;
      },
    });

    // FIXME: This casting shouldn't be needed, why is string not assignable to string?
    // No idea, but I spent 30 minutes trying to figure it out, and I'm really mad at it
    automation.light.registerRoom(out as unknown as RoomDefinition);

    return out;
  };
}
