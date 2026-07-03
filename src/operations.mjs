import { localize, TARGETED_STATUS_IDS, HOOK_DAMAGE_APPLIED, HOOK_DAMAGE_UNDONE, HOOK_STATUS_APPLIED, HOOK_STATUS_UNDONE } from "./config.mjs";
import {
  applySquadMinionDamage,
  applySquadMinionHealing,
  getSquadCombatGroup,
  getStaminaSnapshot,
  isAreaAbility,
  restoreChangedMinionStates,
} from "./minion-automation.mjs";
import { userCanApplyForMessage, userCanApplyForTarget } from "./permissions.mjs";
import { getMessageAuthorId, getPart, resolveTarget } from "./target-utils.mjs";
import { getMessageState, mutateMessageState } from "./state.mjs";

function getIdFromUuid(uuid) {
  if (!uuid) return null;
  const parts = uuid.split(".");
  return parts.length > 1 ? parts[parts.length - 1] : null;
}

function buildHookPayload(operationType, status, record, message, state, contextUser, preResolvedItem) {
  const isApplied = status === "applied";
  const eventId = foundry?.utils?.randomID?.() ?? crypto.randomUUID();
  const timestamp = Date.now();

  let sourceActorUuid = state?.sourceActorUuid ?? null;
  let sourceTokenUuid = state?.sourceTokenUuid ?? null;
  let sourceUserId = state?.sourceUserId ?? null;
  let sourceUserName = state?.sourceUserName ?? null;

  let sourceItemName = null;
  let sourceItemUuid = null;
  let keywords = [];

  if (preResolvedItem) {
    sourceItemName = preResolvedItem.name ?? null;
    sourceItemUuid = preResolvedItem.uuid ?? null;
    if (Array.isArray(preResolvedItem.system?.keywords)) {
      keywords = [...preResolvedItem.system.keywords];
    }
  } else if (state?.abilityUuid) {
    sourceItemUuid = state.abilityUuid;
  }

  let targetActorUuid = null;
  let targetTokenUuid = null;
  let targetActorName = null;

  if (record?.target) {
    targetActorUuid = record.target.actorUuid ?? null;
    targetTokenUuid = record.target.tokenUuid ?? null;
    targetActorName = record.target.name ?? null;
  }

  const payload = {
    operationType,
    status,
    sourceActorId: getIdFromUuid(sourceActorUuid),
    sourceActorUuid,
    sourceTokenId: getIdFromUuid(sourceTokenUuid),
    sourceTokenUuid,
    sourceItemName,
    sourceItemUuid,
    sourceUserId,
    sourceUserName,
    targetActorId: getIdFromUuid(targetActorUuid),
    targetActorUuid,
    targetTokenId: getIdFromUuid(targetTokenUuid),
    targetTokenUuid,
    targetActorName,
    keywords,
    eventId,
    timestamp,
    isApplied,
  };

  if (operationType === "damage" || operationType === "healing") {
    payload.amount = record?.amount ?? null;
    payload.originalAmount = record?.originalAmount ?? null;
    payload.halfDamage = record?.halfDamage ?? false;
    payload.damageType = record?.damageType ?? null;
    payload.typeLabel = record?.typeLabel ?? null;
    payload.isHealing = operationType === "healing";
    payload.isCritical = record?.isCritical ?? false;
  }

  if (operationType === "status") {
    payload.effectId = record?.effectId ?? null;
    payload.effectUuid = record?.effectUuid ?? null;
    payload.statusName = record?.statusName ?? null;
    payload.tier = record?.tier ?? null;
  }

  return payload;
}

export async function applyDamageOperation(payload, context) {
  const { message, roll } = getRollContext(payload, { allowSynthetic: !!payload.syntheticDamage });
  const state = getMessageState(message);

  const override = payload.damageOverride ?? null;
  const synthetic = payload.syntheticDamage ?? null;
  const syntheticAmount = synthetic ? await evaluateSyntheticDamageAmount(synthetic, message) : null;
  const baseAmount = override?.amount != null ? Number(override.amount) : Number(roll?.total ?? syntheticAmount ?? 0);
  const damageType = override?.damageType ?? roll?.type ?? synthetic?.damageType ?? "";
  const typeLabel = override?.typeLabel ?? roll?.typeLabel ?? synthetic?.typeLabel ?? "";
  const isHeal = roll?.isHeal ?? synthetic?.isHeal ?? false;
  const areaAbility = await resolveIsAreaAbility(state.abilityUuid ?? payload.abilityUuid);

  const amount = payload.halfDamage ? Math.floor(baseAmount / 2) : baseAmount;
  const applicationTargets = getApplicationTargets(payload);
  assertCanApplyForTargets(context.user, message, state, applicationTargets, payload);
  const operationTargets = areaAbility ? getContextTargets(payload, applicationTargets) : applicationTargets;
  const surgeSpend = await prepareSurgeSpend(message, state, override, isHeal, applicationTargets.length);
  const preResolvedItem = state?.abilityUuid ? await fromUuid(state.abilityUuid).catch(() => null) : null;
  const operationType = isHeal ? "healing" : "damage";
  const records = [];

  let surgesSpent = false;
  try {
    if (surgeSpend) {
      await spendDamageSurges(surgeSpend);
      surgesSpent = true;
    }

    for (const target of applicationTargets) {
      records.push(await applyDamageToTarget(target, {
        kind: isHeal ? "healing" : "damage",
        isHeal,
        healType: roll?.type ?? synthetic?.damageType,
        amount,
        originalAmount: Number(roll?.total ?? syntheticAmount ?? 0),
        halfDamage: !!payload.halfDamage,
        damageType,
        typeLabel,
        override,
        surgeSpend,
        ignoredImmunities: roll?.ignoredImmunities ?? synthetic?.ignoredImmunities ?? [],
        operationTargets,
        isAreaAbility: areaAbility,
        partId: payload.partId,
        rollIndex: Number.isFinite(Number(payload.rollIndex)) ? Number(payload.rollIndex) : payload.rollIndex,
      }, context.user));
    }
  } catch (error) {
    if (surgesSpent) {
      await refundDamageSurges(surgeSpend).catch(refundError => {
        console.warn("draw-steel-target-damage | Could not refund surges after failed damage application", refundError);
      });
    }
    throw error;
  }

  const record = makeStackRecord(payload, records);

  if (payload.selectedTokenStack) await pushApplicationRecord(message.id, payload.operationId, record, payload, context.user);
  else await writeApplicationRecord(message.id, payload.operationId, record, payload, context.user);

  for (const targetRecord of records) {
    const hookPayload = buildHookPayload(operationType, "applied", targetRecord, message, state, context.user, preResolvedItem);
    try {
      Hooks.callAll(HOOK_DAMAGE_APPLIED, hookPayload);
    } catch (error) {
      console.warn("draw-steel-target-damage | Hook dstd:damageApplied failed:", error);
    }
  }

  return { success: true, record };
}

export async function undoDamageOperation(payload, context) {
  const message = getMessageOrThrow(payload.messageId);
  const state = getMessageState(message);
  const entry = state.applications?.[payload.operationId];
  const prior = getLatestAppliedRecord(entry);
  if (!prior) throw new Error("No applied damage record was found");
  assertCanApplyForTargets(context.user, message, state, getRecordTargets(prior), payload);

  const preResolvedItem = state?.abilityUuid ? await fromUuid(state.abilityUuid).catch(() => null) : null;

  const record = Array.isArray(prior.records)
    ? await undoDamageBatch(prior, context.user)
    : await undoDamageRecord(prior, context.user);

  if (payload.selectedTokenStack || isStackedApplication(entry)) await popApplicationRecord(message.id, payload.operationId, record, payload, context.user);
  else await writeApplicationRecord(message.id, payload.operationId, record, payload, context.user);

  const operationType = record.kind === "healing" ? "healing" : "damage";
  const undoRecords = Array.isArray(record.records) ? record.records : [record];
  for (const undoRecord of undoRecords) {
    const hookPayload = buildHookPayload(operationType, "undone", undoRecord, message, state, context.user, preResolvedItem);
    try {
      Hooks.callAll(HOOK_DAMAGE_UNDONE, hookPayload);
    } catch (error) {
      console.warn("draw-steel-target-damage | Hook dstd:damageUndone failed:", error);
    }
  }

  return { success: true, record };
}

async function applyDamageToTarget(target, data, user) {
  const { actor, tokenDocument } = await resolveTargetOrThrow(target);
  const before = getStaminaSnapshot(actor, tokenDocument);
  const squadGroup = getSquadCombatGroup(actor, tokenDocument);

  if (data.isHeal) {
    const isTemporary = data.healType !== "value";
    if (!isTemporary && squadGroup) await applySquadMinionHealing(squadGroup, data.amount, {
      targetTokenDocument: tokenDocument,
      operationTargets: data.operationTargets,
      isAreaAbility: data.isAreaAbility,
    });
    else await actor.modifyTokenAttribute(isTemporary ? "stamina.temporary" : "stamina", data.amount, !isTemporary, !isTemporary);
  } else if (squadGroup) {
    await applySquadMinionDamage(actor, squadGroup, data, tokenDocument);
  } else {
    await actor.system.takeDamage(data.amount, {
      type: data.damageType,
      ignoredImmunities: data.ignoredImmunities,
    });
  }

  return {
    kind: data.kind,
    status: "applied",
    target,
    partId: data.partId,
    rollIndex: data.rollIndex,
    amount: data.amount,
    originalAmount: data.originalAmount,
    halfDamage: data.halfDamage,
    damageType: data.damageType,
    typeLabel: data.typeLabel,
    override: data.override ?? null,
    surgeSpend: data.surgeSpend ?? null,
    before,
    after: getStaminaSnapshot(actor, tokenDocument),
    appliedByUserId: user?.id ?? game.user.id,
    appliedByUserName: user?.name ?? game.user.name,
    appliedAt: Date.now(),
  };
}

async function undoDamageRecord(prior, user) {
  if (!prior?.before) throw new Error("No applied damage record was found");

  const { actor, tokenDocument } = await resolveTargetOrThrow(prior.target);
  const squadGroup = await resolveSnapshotSquadGroup(prior.before, actor, tokenDocument);

  if (squadGroup) {
    // Delta-based undo: only add back the damage this specific operation applied,
    // so parallel AoE applications to the same squad pool don't interfere.
    const currentPool = Number(squadGroup.system?.staminaValue ?? 0);
    const poolMax = Number(squadGroup.system?.staminaMax ?? prior.before.max ?? Infinity);
    const appliedDelta = (prior.after?.value ?? prior.before.value) - prior.before.value; // negative = damage
    const newPool = Math.min(Math.max(0, currentPool - appliedDelta), poolMax);
    await squadGroup.update({ "system.staminaValue": newPool }, { dstd: { skipMinionAutomationHook: true } });
    // Only un-defeat minions whose state changed in this specific operation.
    await restoreChangedMinionStates(squadGroup, prior.before.minions ?? [], prior.after?.minions ?? []);
  } else {
    await actor.update({
      "system.stamina.value": prior.before.value,
      "system.stamina.temporary": prior.before.temporary,
    });
  }

  if (prior.surgeSpend?.surges) await refundDamageSurges(prior.surgeSpend);

  return {
    ...prior,
    status: "undone",
    undoneByUserId: user?.id ?? game.user.id,
    undoneByUserName: user?.name ?? game.user.name,
    undoneAt: Date.now(),
    afterUndo: getStaminaSnapshot(actor, tokenDocument),
  };
}

async function undoDamageBatch(prior, user) {
  const records = [];
  for (const record of Array.from(prior.records).reverse()) records.unshift(await undoDamageRecord(record, user));
  return {
    ...prior,
    status: "undone",
    records,
    undoneByUserId: user?.id ?? game.user.id,
    undoneByUserName: user?.name ?? game.user.name,
    undoneAt: Date.now(),
  };
}

export async function applyStatusOperation(payload, context) {
  const message = getMessageOrThrow(payload.messageId);
  const state = getMessageState(message);
  const powerEffect = payload.effectUuid ? await fromUuid(payload.effectUuid) : null;
  const statusName = getStatusName(powerEffect, payload.effectId);
  const applicationTargets = getApplicationTargets(payload);
  assertCanApplyForTargets(context.user, message, state, applicationTargets, payload);
  const preResolvedItem = state?.abilityUuid ? await fromUuid(state.abilityUuid).catch(() => null) : null;
  const records = [];

  for (const target of applicationTargets) {
    records.push(await applyStatusToTarget(target, {
      payload,
      powerEffect,
      statusName,
      sourceActorUuid: state.sourceActorUuid,
    }, context.user));
  }

  const record = makeStackRecord(payload, records);

  if (payload.selectedTokenStack) await pushApplicationRecord(message.id, payload.operationId, record, payload, context.user);
  else await writeApplicationRecord(message.id, payload.operationId, record, payload, context.user);

  for (const targetRecord of records) {
    const hookPayload = buildHookPayload("status", "applied", targetRecord, message, state, context.user, preResolvedItem);
    try {
      Hooks.callAll(HOOK_STATUS_APPLIED, hookPayload);
    } catch (error) {
      console.warn("draw-steel-target-damage | Hook dstd:statusApplied failed:", error);
    }
  }

  return { success: true, record };
}

export async function undoStatusOperation(payload, context) {
  const message = getMessageOrThrow(payload.messageId);
  const state = getMessageState(message);
  const entry = state.applications?.[payload.operationId];
  const prior = getLatestAppliedRecord(entry);
  if (!prior) throw new Error("No applied status record was found");
  assertCanApplyForTargets(context.user, message, state, getRecordTargets(prior), payload);

  const preResolvedItem = state?.abilityUuid ? await fromUuid(state.abilityUuid).catch(() => null) : null;

  const record = Array.isArray(prior.records)
    ? await undoStatusBatch(prior, context.user)
    : await undoStatusRecord(prior, context.user);

  if (payload.selectedTokenStack || isStackedApplication(entry)) await popApplicationRecord(message.id, payload.operationId, record, payload, context.user);
  else await writeApplicationRecord(message.id, payload.operationId, record, payload, context.user);

  const undoRecords = Array.isArray(record.records) ? record.records : [record];
  for (const undoRecord of undoRecords) {
    const hookPayload = buildHookPayload("status", "undone", undoRecord, message, state, context.user, preResolvedItem);
    try {
      Hooks.callAll(HOOK_STATUS_UNDONE, hookPayload);
    } catch (error) {
      console.warn("draw-steel-target-damage | Hook dstd:statusUndone failed:", error);
    }
  }

  return { success: true, record };
}

async function applyStatusToTarget(target, data, user) {
  const { actor } = await resolveTargetOrThrow(target);
  const { payload, powerEffect, statusName } = data;
  const beforeEffects = findMatchingEffects(actor, payload.effectId, statusName).map(effect => effect.toObject());

  if (powerEffect?.applyEffect) {
    await powerEffect.applyEffect(`tier${Number(payload.tier)}`, payload.effectId, { targets: [actor] });
  } else if (CONFIG.statusEffects.find(effect => effect.id === payload.effectId)) {
    await actor.toggleStatusEffect(payload.effectId, { active: true, overlay: false });
  } else if (powerEffect?.documentName === "ActiveEffect") {
    const effectData = powerEffect.toObject();
    delete effectData._id;
    await actor.createEmbeddedDocuments("ActiveEffect", [effectData]);
  } else {
    throw new Error(`Cannot resolve status effect ${payload.effectId}`);
  }

  const afterEffects = findMatchingEffects(actor, payload.effectId, statusName);
  if (TARGETED_STATUS_IDS.has(payload.effectId)) {
    await addTargetedStatusSource(afterEffects, payload.effectId, data.sourceActorUuid ?? powerEffect?.item?.actor?.uuid);
  }

  return {
    kind: "status",
    status: "applied",
    target,
    partId: payload.partId,
    tier: Number(payload.tier),
    effectId: payload.effectId,
    effectUuid: payload.effectUuid,
    statusName,
    targeted: TARGETED_STATUS_IDS.has(payload.effectId),
    beforeEffects,
    afterEffectIds: afterEffects.map(effect => effect.id),
    appliedByUserId: user?.id ?? game.user.id,
    appliedByUserName: user?.name ?? game.user.name,
    appliedAt: Date.now(),
  };
}

async function undoStatusRecord(prior, user) {
  const { actor } = await resolveTargetOrThrow(prior.target);
  const idsToDelete = (prior.afterEffectIds ?? []).filter(id => actor.effects.get(id));
  if (idsToDelete.length) await actor.deleteEmbeddedDocuments("ActiveEffect", idsToDelete);

  const restoreEffects = (prior.beforeEffects ?? []).filter(effectData => {
    const id = effectData._id ?? effectData.id;
    return id && !actor.effects.get(id);
  });
  if (restoreEffects.length) await actor.createEmbeddedDocuments("ActiveEffect", restoreEffects, { keepId: true });

  return {
    ...prior,
    status: "undone",
    undoneByUserId: user?.id ?? game.user.id,
    undoneByUserName: user?.name ?? game.user.name,
    undoneAt: Date.now(),
  };
}

async function undoStatusBatch(prior, user) {
  const records = [];
  for (const record of prior.records) records.push(await undoStatusRecord(record, user));
  return {
    ...prior,
    status: "undone",
    records,
    undoneByUserId: user?.id ?? game.user.id,
    undoneByUserName: user?.name ?? game.user.name,
    undoneAt: Date.now(),
  };
}

export async function rollReactiveOperation(payload, context) {
  const { actor } = await resolveTargetOrThrow(payload.target);
  if (!canUserRollActor(context.user, actor)) throw new Error(localize("Notify.NoPermission"));

  const rollMessage = await actor.rollCharacteristic(payload.characteristic, { resultSource: payload.abilityUuid });
  await waitForDiceAnimation(rollMessage);
  const result = extractReactiveRollResult(rollMessage);
  if (!result) return { success: false, cancelled: true, error: localize("Notify.RollCancelled") };

  return saveReactiveResultOperation({ ...payload, result }, context);
}

export async function saveReactiveResultOperation(payload, context) {
  const message = getMessageOrThrow(payload.messageId);
  const { actor } = await resolveTargetOrThrow(payload.target);
  const authorId = getMessageAuthorId(message);

  if (!context.user?.isGM && authorId !== context.user?.id && !canUserRollActor(context.user, actor)) {
    throw new Error(localize("Notify.NoPermission"));
  }

  const record = {
    target: payload.target,
    characteristic: payload.characteristic,
    abilityUuid: payload.abilityUuid,
    tier: Number(payload.result.tier),
    total: Number(payload.result.total),
    rollMessageId: payload.result.messageId,
    rolledByUserId: context.user?.id ?? game.user.id,
    rolledByUserName: context.user?.name ?? game.user.name,
    rolledAt: Date.now(),
  };

  await mutateMessageState(message.id, state => {
    state.reactiveResults[payload.operationId] = record;
    state.updatedAt = Date.now();
    return state;
  });

  return { success: true, record };
}

export async function updateTargetsOperation(payload, context) {
  const message = getMessageOrThrow(payload.messageId);
  const state = getMessageState(message);
  if (!canUserMutateMessage(context.user, message, state)) throw new Error(localize("Notify.NoPermission"));

  await mutateMessageState(message.id, state => {
    state.targets = payload.targets ?? [];
    state.targetingUserId = context.user?.id ?? game.user.id;
    state.targetingUserName = context.user?.name ?? game.user.name;
    state.updatedAt = Date.now();
    return state;
  });

  return { success: true };
}

export async function updateRollOverrideOperation(payload, context) {
  const message = getMessageOrThrow(payload.messageId);
  const messageState = getMessageState(message);
  if (!canUserMutateMessage(context.user, message, messageState)) throw new Error(localize("Notify.NoPermission"));

  await mutateMessageState(message.id, state => {
    state.tierOverrides = state.tierOverrides ?? {};
    state.tierOverrides[payload.targetKey] = payload.override;
    state.updatedAt = Date.now();
    return state;
  });

  return { success: true };
}

export async function updateDamageOverrideOperation(payload, context) {
  const message = getMessageOrThrow(payload.messageId);
  const messageState = getMessageState(message);
  if (!canUserMutateMessage(context.user, message, messageState)) throw new Error(localize("Notify.NoPermission"));

  await mutateMessageState(message.id, state => {
    state.damageOverrides = state.damageOverrides ?? {};
    state.damageOverrides[payload.operationId] = payload.override;
    state.updatedAt = Date.now();
    return state;
  });

  return { success: true };
}

export function extractReactiveRollResult(message) {
  if (!message) return null;

  let roll = Array.from(message.rolls ?? []).reverse().find(candidate => Number(candidate.product));
  if (!roll) {
    const testPart = Array.from(message.system?.parts?.values?.() ?? [])
      .find(part => part.type === "test" && part.rolls?.length);
    roll = testPart?.rolls?.at(-1);
  }

  if (!roll) return null;
  return {
    messageId: message.id,
    tier: Number(roll.product),
    total: Number(roll.total),
  };
}

function getApplicationTargets(payload) {
  const targets = Array.isArray(payload.targets) && payload.targets.length ? payload.targets : [payload.target];
  const validTargets = targets.filter(target => target?.tokenUuid || target?.actorUuid);
  if (!validTargets.length) throw new Error("Target actor not found");
  return validTargets;
}

function getContextTargets(payload, fallbackTargets) {
  const validTargets = Array.isArray(payload.contextTargets)
    ? payload.contextTargets.filter(target => target?.tokenUuid || target?.actorUuid)
    : [];
  return validTargets.length ? validTargets : fallbackTargets;
}

function makeStackRecord(payload, records) {
  if (!records.length) throw new Error("No application records were created");
  if (!payload.selectedTokenStack || records.length === 1) return records[0];

  const first = records[0];
  return {
    ...first,
    target: {
      selectedToken: true,
      name: `${records.length} selected tokens`,
    },
    targetCount: records.length,
    records,
  };
}

async function writeApplicationRecord(messageId, operationId, record, payload = null, user = game.user) {
  const message = getMessageOrThrow(messageId);
  await mutateMessageState(message.id, state => {
    applyInteractionStatePatch(state, payload, user, message);
    state.applications = state.applications ?? {};
    state.applications[operationId] = record;
    state.updatedAt = Date.now();
    return state;
  });
}

async function pushApplicationRecord(messageId, operationId, record, payload = null, user = game.user) {
  const message = getMessageOrThrow(messageId);
  await mutateMessageState(message.id, state => {
    applyInteractionStatePatch(state, payload, user, message);
    state.applications = state.applications ?? {};
    const current = state.applications[operationId];
    const stack = getApplicationStack(current).concat(record);
    state.applications[operationId] = {
      ...record,
      stack,
      stackCount: stack.length,
      history: current?.history ?? [],
    };
    state.updatedAt = Date.now();
    return state;
  });
}

async function popApplicationRecord(messageId, operationId, undoRecord, payload = null, user = game.user) {
  const message = getMessageOrThrow(messageId);
  await mutateMessageState(message.id, state => {
    applyInteractionStatePatch(state, payload, user, message);
    state.applications = state.applications ?? {};
    const current = state.applications[operationId];
    const stack = getApplicationStack(current);
    stack.pop();
    const history = [...(current?.history ?? []), undoRecord];

    state.applications[operationId] = stack.length
      ? {
        ...stack.at(-1),
        stack,
        stackCount: stack.length,
        history,
      }
      : {
        kind: undoRecord.kind,
        status: "undone",
        target: undoRecord.target,
        stack: [],
        stackCount: 0,
        history,
        lastUndone: undoRecord,
        undoneAt: undoRecord.undoneAt,
      };

    state.updatedAt = Date.now();
    return state;
  });
}

function applyInteractionStatePatch(state, payload, user, message) {
  if (!payload || !canUserMutateMessage(user, message, state)) return;

  if (payload.targetKey && payload.tierOverride) {
    state.tierOverrides = state.tierOverrides ?? {};
    state.tierOverrides[payload.targetKey] = payload.tierOverride;
  }

  if (payload.operationId && payload.damageOverride) {
    state.damageOverrides = state.damageOverrides ?? {};
    state.damageOverrides[payload.operationId] = payload.damageOverride;
  }
}

function getLatestAppliedRecord(entry) {
  if (Array.isArray(entry?.stack) && entry.stack.length) return entry.stack.at(-1);
  return entry?.status === "applied" ? entry : null;
}

function getApplicationStack(entry) {
  if (Array.isArray(entry?.stack)) return entry.stack.filter(record => record?.status === "applied");
  return entry?.status === "applied" ? [entry] : [];
}

function isStackedApplication(entry) {
  return Array.isArray(entry?.stack);
}

function getRollContext(payload, { allowSynthetic = false } = {}) {
  const message = getMessageOrThrow(payload.messageId);
  const part = getPart(message, payload.partId);
  const rollIndex = Number(payload.rollIndex);
  const roll = part?.rolls?.[rollIndex] ?? message.rolls?.[rollIndex];
  if (!roll && !allowSynthetic) throw new Error("Damage roll not found");
  return { message, part, roll };
}

async function evaluateSyntheticDamageAmount(synthetic, message) {
  const numeric = Number(synthetic.amount);
  if (Number.isFinite(numeric)) return numeric;

  const state = getMessageState(message);
  const ability = state.abilityUuid ? await fromUuid(state.abilityUuid) : null;
  const roll = new Roll(String(synthetic.formula ?? synthetic.amount ?? "0"), ability?.getRollData?.() ?? {});
  await roll.evaluate();
  return Number(roll.total ?? 0);
}

async function prepareSurgeSpend(message, state, override, isHeal, targetCount) {
  const surges = Number(override?.surges ?? 0) || 0;
  if (isHeal || surges <= 0) return null;
  if (targetCount !== 1) throw new Error(localize("Notify.SurgesSingleTarget"));

  const actor = await resolveSurgeSourceActor(message, state);
  if (!actor) throw new Error(localize("Notify.NoSurgeActor"));

  const available = Number(actor.system?.hero?.surges ?? 0) || 0;
  if (available < surges) throw new Error(localize("Notify.NotEnoughSurges"));

  return {
    actorUuid: actor.uuid,
    actorName: actor.name,
    surges,
    before: available,
    after: available - surges,
    surgeDamage: Number(override?.surgeDamage ?? actor.getRollData?.()?.chr ?? 0) || 0,
  };
}

async function spendDamageSurges(surgeSpend) {
  const actor = await fromUuid(surgeSpend.actorUuid);
  if (!actor) throw new Error(localize("Notify.NoSurgeActor"));
  await actor.modifyTokenAttribute("hero.surges", -1 * Number(surgeSpend.surges ?? 0), true, false);
}

async function refundDamageSurges(surgeSpend) {
  const actor = await fromUuid(surgeSpend.actorUuid);
  if (!actor) throw new Error(localize("Notify.NoSurgeActor"));
  await actor.modifyTokenAttribute("hero.surges", Number(surgeSpend.surges ?? 0), true, false);
}

async function resolveSurgeSourceActor(message, state) {
  let sourceActor = null;
  if (state?.sourceActorUuid) {
    try {
      sourceActor = await fromUuid(state.sourceActorUuid);
    } catch (error) {
      console.warn("draw-steel-target-damage | Could not resolve source actor for surges", error);
    }
  }

  if (!sourceActor && state?.abilityUuid) {
    try {
      sourceActor = (await fromUuid(state.abilityUuid))?.actor ?? null;
    } catch (error) {
      console.warn("draw-steel-target-damage | Could not resolve ability actor for surges", error);
    }
  }

  if (!sourceActor && message?.speaker?.actor) sourceActor = game.actors.get(message.speaker.actor) ?? null;
  if (sourceActor?.type === "retainer") sourceActor = sourceActor.system?.retainer?.mentor ?? null;
  return sourceActor?.type === "hero" ? sourceActor : null;
}

async function resolveIsAreaAbility(abilityUuid) {
  if (!abilityUuid) return false;
  try {
    return isAreaAbility(await fromUuid(abilityUuid));
  } catch (error) {
    console.warn(`draw-steel-target-damage | Could not resolve ability ${abilityUuid}`, error);
    return false;
  }
}

function getMessageOrThrow(messageId) {
  const message = game.messages.get(messageId);
  if (!message) throw new Error("Chat message not found");
  return message;
}

function waitForDiceAnimation(message, timeoutMs = 4500) {
  const diceSoNiceActive = game.modules.get("dice-so-nice")?.active;
  if (!diceSoNiceActive || !message?.id) return Promise.resolve();

  return new Promise(resolve => {
    let timeoutId = null;
    const finish = () => {
      if (timeoutId) window.clearTimeout(timeoutId);
      Hooks.off("diceSoNiceRollComplete", onComplete);
      resolve();
    };
    const onComplete = messageId => {
      if (messageId === message.id) finish();
    };

    Hooks.on("diceSoNiceRollComplete", onComplete);
    timeoutId = window.setTimeout(finish, timeoutMs);
  });
}

async function resolveTargetOrThrow(target) {
  const resolved = await resolveTarget(target);
  if (!resolved.actor) throw new Error("Target actor not found");
  return resolved;
}

function assertCanApplyForMessage(user, message, state = getMessageState(message)) {
  if (!userCanApplyForMessage(user, message, state)) throw new Error(localize("Notify.NoPermission"));
}

function assertCanApplyForTargets(user, message, state, targets = [], payload = {}) {
  if (payload.selectedTokenStack) return assertCanApplyForMessage(user, message, state);
  const validTargets = targets.filter(target => target?.tokenUuid || target?.actorUuid);
  if (!validTargets.length) return assertCanApplyForMessage(user, message, state);
  if (!validTargets.every(target => userCanApplyForTarget(user, message, state, target))) {
    throw new Error(localize("Notify.NoPermission"));
  }
}

function getRecordTargets(record) {
  return Array.isArray(record?.records) ? record.records.map(entry => entry.target) : [record?.target];
}

function canUserRollActor(user, actor) {
  if (user?.isGM) return true;
  return actor?.testUserPermission?.(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) ?? false;
}

function canUserMutateMessage(user, message, state = getMessageState(message)) {
  if (user?.isGM) return true;
  if (!user) return false;
  if (getMessageAuthorId(message) === user.id || state.sourceUserId === user.id) return true;
  return message.testUserPermission?.(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) ?? false;
}

async function resolveSnapshotSquadGroup(snapshot, actor, tokenDocument) {
  if (snapshot?.groupUuid) {
    try {
      const group = await fromUuid(snapshot.groupUuid);
      if (group) return group;
    } catch (_) {}
  }
  return getSquadCombatGroup(actor, tokenDocument);
}

function getStatusName(powerEffect, effectId) {
  if (powerEffect?.name) return powerEffect.name;
  const itemEffect = powerEffect?.item?.effects?.get(effectId);
  if (itemEffect?.name) return itemEffect.name;
  const status = CONFIG.statusEffects.find(effect => effect.id === effectId);
  return status?.name ? game.i18n.localize(status.name) : effectId;
}

async function addTargetedStatusSource(effects, statusId, sourceActorUuid) {
  if (!sourceActorUuid) return;
  const key = `system.statuses.${statusId}.sources`;

  for (const effect of effects) {
    const changes = effect.changes?.map(change => change.toObject?.() ?? change) ?? [];
    if (changes.some(change => change.key === key && change.value === sourceActorUuid)) continue;
    await effect.update({
      changes: changes.concat({
        key,
        mode: CONST.ACTIVE_EFFECT_MODES.ADD,
        value: sourceActorUuid,
      }),
    });
  }
}

function findMatchingEffects(actor, effectId, statusName) {
  const lowerName = String(statusName ?? "").toLowerCase();
  return actor.effects.filter(effect => {
    if (effect.id === effectId) return true;
    if (effect.statuses?.has(effectId)) return true;
    return lowerName && String(effect.name ?? "").toLowerCase() === lowerName;
  });
}