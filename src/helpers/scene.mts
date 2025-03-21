import { TContext } from "@digital-alchemy/core";
import {
  ALL_DOMAINS,
  GetDomain,
  HassAreaMapping,
  PICK_ENTITY,
  PICK_FROM_AREA,
  TAreaId,
} from "@digital-alchemy/hass";

type SceneAwareDomains = "switch" | "light";
type RGB = [r: number, g: number, b: number];

export type LightOff = {
  state: "off";
};
export type LightOn = {
  brightness?: number;
  kelvin?: number;
  rgb_color?: RGB;
  state?: "on";
};

type EntitySceneType<DOMAIN extends SceneAwareDomains> = {
  light: LightOff | LightOn;
  switch: { state: "on" | "off" };
}[DOMAIN];

export type tSceneType<ENTITY extends PICK_ENTITY<SceneAwareDomains>> = EntitySceneType<
  GetDomain<ENTITY>
>;

export type tScene = {
  [key in PICK_ENTITY<SceneAwareDomains>]: tSceneType<key>;
};
export type SceneDescription<RoomNames extends string = string> = {
  global: string[];
  rooms: Partial<Record<RoomNames, string[]>>;
};
export interface AutomationLogicModuleConfiguration<
  SCENES extends string = string,
  ROOM extends TAreaId = TAreaId,
> {
  global_scenes?: Record<string, boolean>;
  room_configuration?: Record<string, RoomConfiguration<SCENES, ROOM>>;
}

export type AllowedSceneDomains = Extract<ALL_DOMAINS, "switch" | "light" | "fan">;

export const SCENE_ROOM_OPTIONS = "scene-room";

export type SceneSwitchState = { state: "on" | "off" };
export type SceneLightStateOn = {
  /**
   * Light will probably restore previous value
   */
  brightness: number;
  /**
   * If not provided, light will attempt to use color temp if possible
   */
  rgb_color?: {
    b: number;
    g: number;
    r: number;
  };
  state: "on";
};
export type SceneLightState = { state: "off" } | SceneLightStateOn;

type MappedDomains = {
  light: SceneLightState;
  switch: SceneSwitchState;
};

export type SceneDefinition<AREA extends TAreaId> = Partial<{
  [entity_id in PICK_FROM_AREA<AREA, keyof MappedDomains>]: MappedDomains[Extract<
    GetDomain<entity_id>,
    keyof MappedDomains
  >];
}>;

export type SceneList<AREA extends TAreaId, SCENES extends string> = Record<
  SCENES,
  Partial<Record<PICK_ENTITY<AllowedSceneDomains>, SceneDefinition<AREA>>>
>;

export type RoomConfiguration<SCENES extends string, ROOM extends TAreaId> = {
  context: TContext;
  /**
   * Friendly name
   */
  area?: ROOM;

  /**
   * Global scenes are required to be declared within the room
   */
  scenes: Record<SCENES, RoomScene<ROOM>>;
};

export type RoomScene<
  AREA extends TAreaId,
  DEFINITION extends SceneDefinition<AREA> = SceneDefinition<AREA>,
> = {
  /**
   * Ensure entities are maintained as the scene says they should be
   *
   * - Automatically revert changes made by pesky humans
   *   - how dare they?!
   *
   * - Ensure lights match the brightness / color the scene says they should be
   *   - sometimes things don't fully make brightness transitions, this will fix
   *
   * default: `true` (controlled by config)
   */
  aggressive?: boolean;
  /**
   * Human understandable description of this scene (long form)
   */
  description?: string;
  /**
   * Human understandable description of this scene (short form)
   */
  friendly_name?: string;
  definition: HassAreaMapping[`_${AREA}`] extends never ? never : DEFINITION;
};
