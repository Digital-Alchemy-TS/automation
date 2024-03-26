## 📘 Description

Welcome to `@digital-alchemy/automation`!

This project builds on the utilities provided by `@digital-alchemy/hass` & `@digital-alchemy/synapse` to create home automation focused utilities for easily coordinating entities.

- [Extended docs](https://docs.digital-alchemy.app/Automation)
- [Discord](https://discord.com/invite/mtWHk36upW)

## 💾 Install

You can install the custom component through HACS. See the repo for more detailed install instructions of the component: https://github.com/Digital-Alchemy-TS/synapse-extension

This library can be installed as a simple dependency
```bash
npm i @digital-alchemy/automation @digital-alchemy/synapse @digital-alchemy/hass
```

Then added to your project

```typescript
import { LIB_AUTOMATION } from "@digital-alchemy/automation";
import { LIB_HASS } from "@digital-alchemy/hass";
import { LIB_SYNAPSE } from "@digital-alchemy/synapse";

// application
const MY_APP = CreateApplication({
  libraries: [LIB_HASS, LIB_SYNAPSE, LIB_AUTOMATION],
  name: "home_automation",
})

// library
export const MY_LIBRARY = CreateLibrary({
  depends: [LIB_HASS, LIB_SYNAPSE, LIB_AUTOMATION],
  name: "special_logic",
})
```

## 🛠️ Utilities
### 🏠 Rooms w/ coordinated scenes

Create rooms, with the ability to coordinate sets of entities together in scenes.
```typescript
import { CronExpression, TServiceParams } from "@digital-alchemy/core";

export function ExampleRoom({
  automation,
  scheduler,
  hass,
  context,
}: TServiceParams) {
  // generate a room with scenes, sensors, etc
  const room = automation.room({
    context,
    name: "Example",
    scenes: {
      high: {
        definition: {
          "light.ceiling_fan": { brightness: 255, state: "on" },
        },
        friendly_name: "High",
      },
      off: {
        definition: {
          "light.ceiling_fan": { state: "off" },
        },
        friendly_name: "Off",
      },
    },
  });

  // easy bindings for setting scene
  scheduler.cron({
    exec: () => (room.scene = "high"),
    schedule: CronExpression.EVERY_DAY_AT_8AM,
  });

  // or set it through the service
  scheduler.cron({
    exec: async () => await hass.call.scene.turn_on({
      entity_id: "scene.example_off"
    }),
    schedule: CronExpression.EVERY_DAY_AT_8PM,
  });

  return room;
}
```
### 🔧 Active Management

Sometimes devices don't get the message the first time. Other times a pesky human comes by and bumps a switch, turning off a switch that really should be left on. `@digital-alchemy/automation` provides several tools to help ensure devices know what they "should" be.

Scenes defined by rooms will periodically recheck entity states in their listed definitions, ensuring that the device state matches your description of what it should be. The library also provides tools for rules-based state management of switches.

```typescript
import { TServiceParams } from "@digital-alchemy/core";

export function ExampleRoom({ automation, context }: TServiceParams) {
  // plant light should be on while the sun is up, but only until 5:30 PM
  automation.managed_switch({
    context,
    entity_id: "switch.plant_light",
    shouldBeOn() {

      // check sun position
      if (automation.solar.isBetween("dawn", "dusk")) {

        // create some reference points with dayjs
        const [PM530, NOW] = automation.utils.shortTime(["PM5:30", "NOW"]);
        return NOW.isBefore(PM530);
      }
      return false;
    },
  });
}
```
### 💡 Circadian Lighting

By default for lights defined in room scenes, if no particular color is defined, the temperature will be automatically managed for you.

You can see the current light temperature as a dedicated sensor. Updates for light temperature are rate-limited with some configurable settings. This allows you to easily keep a natural feeling light temperature in your home, without overloading your install.

### 🧩 Advanced Pattern Matching

The library includes some utilities for translating a specific pattern of events in Home Assistant into callbacks. This can enable new layers of functionality remotes, allowing for creating automations based on button sequences.

## 🤝 Related Projects

| GitHub                                                              | Description                                                                             | NPM                                                                                      |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [synapse](https://github.com/Digital-Alchemy-TS/synapse)            | Tools for generating entities within Home Assistant.                                    | [@digitial-alchemy/synapse](https://www.npmjs.com/package/@digital-alchemy/synapse)      |
| [type-writer](https://github.com/Digital-Alchemy-TS/terminal)       | Generate custom type definitions for your setup.                                        | [@digital-alchemy/type-writer](https://www.npmjs.com/package/@digital-alchemy/terminal)  |
| [automation-template](https://github.com/Digital-Alchemy-TS/gotify) | Start your own Home Automation project with the `@digital-alchemy` quick start template |                                                                                          |
