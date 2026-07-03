import { MODULE_ID, SYSTEM_ID, HOOK_DAMAGE_APPLIED, HOOK_DAMAGE_UNDONE, HOOK_STATUS_APPLIED, HOOK_STATUS_UNDONE } from "./config.mjs";
import { initializeAoeTargeting } from "./aoe-targeting.mjs";
import { initializeMinionAutomation } from "./minion-automation.mjs";
import { applyHideSystemButtons, registerSettings } from "./settings.mjs";
import { registerSocketHandlers } from "./socket.mjs";
import { getChatTargetingDebugInfo, initializeChatTargeting } from "./chat-targeting.mjs";
import {
  applyDamageOperation,
  applyStatusOperation,
  rollReactiveOperation,
  saveReactiveResultOperation,
  undoDamageOperation,
  undoStatusOperation,
  updateDamageOverrideOperation,
  updateRollOverrideOperation,
  updateTargetsOperation,
} from "./operations.mjs";

console.log(`${MODULE_ID} | module.mjs executing`);

Hooks.once("init", () => {
  registerSettings();
  // Always expose the api object so debugLastMessage() is available
  // even if the ready hook bails early.
  game.modules.get(MODULE_ID).api = {
    debugLastMessage: getChatTargetingDebugInfo,
    HOOK_DAMAGE_APPLIED,
    HOOK_DAMAGE_UNDONE,
    HOOK_STATUS_APPLIED,
    HOOK_STATUS_UNDONE,
  };
  console.log(`${MODULE_ID} | init complete, api exposed`);
});

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | ready hook, system=${game.system.id}`);
  if (game.system.id !== SYSTEM_ID) {
    console.warn(`${MODULE_ID} | This module only runs with the Draw Steel system (detected: ${game.system.id}).`);
    return;
  }

  registerSocketHandlers({
    applyDamage: applyDamageOperation,
    undoDamage: undoDamageOperation,
    applyStatus: applyStatusOperation,
    undoStatus: undoStatusOperation,
    rollReactive: rollReactiveOperation,
    saveReactiveResult: saveReactiveResultOperation,
    updateTargets: updateTargetsOperation,
    updateRollOverride: updateRollOverrideOperation,
    updateDamageOverride: updateDamageOverrideOperation,
  });

  initializeChatTargeting();
  initializeAoeTargeting();
  initializeMinionAutomation();
  applyHideSystemButtons();
  console.info(`${MODULE_ID} | Ready; chat targeting hooks registered.`);
});