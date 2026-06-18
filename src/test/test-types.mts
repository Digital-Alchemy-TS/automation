/**
 * Module augmentation: register test entity IDs into HassEntitySetupMapping.
 *
 * These declarations make test entity strings assignable to PICK_ENTITY<"switch">
 * so the ManagedSwitch tests can pass them without casting.
 *
 * NOTE: This file is test-only and must not be imported from production code.
 */

declare module "@digital-alchemy/hass" {
  interface HassEntitySetupMapping {
    "switch.test_managed_switch": {
      attributes: Record<string, unknown>;
      state: string;
    };
  }
}

export {};
