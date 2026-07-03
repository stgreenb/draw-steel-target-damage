export const MODULE_ID = "draw-steel-target-damage";
export const SYSTEM_ID = "draw-steel";
export const FLAG_STATE = "state";
export const SOCKET_NAME = `module.${MODULE_ID}`;

export const TARGETED_STATUS_IDS = new Set(["frightened", "grabbed", "taunted"]);

export const HOOK_DAMAGE_APPLIED = "dstd:damageApplied";
export const HOOK_DAMAGE_UNDONE = "dstd:damageUndone";
export const HOOK_STATUS_APPLIED = "dstd:statusApplied";
export const HOOK_STATUS_UNDONE = "dstd:statusUndone";

export function localize(key, data = {}) {
  const fullKey = key.startsWith("DSTD.") ? key : `DSTD.${key}`;
  return Object.keys(data).length
    ? game.i18n.format(fullKey, data)
    : game.i18n.localize(fullKey);
}