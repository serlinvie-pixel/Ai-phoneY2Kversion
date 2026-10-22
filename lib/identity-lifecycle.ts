import Dexie from "dexie";
import { createIdentityId, initializeIdentitySpace, switchIdentitySpace, beginIdentityDeletion, finishIdentityDeletion } from "./identity-space";
import {
  readIdentityRuntime, installIdentityRuntime, silenceIdentityRuntime, getCurrentIdentityId,
  isSharedIdentityKey, identityDatabaseIsShared, IDENTITY_ACCESS_KEY, IDENTITY_BASE_BINDING_KEY,
  pauseIdentityDispatch,
} from "./identity-runtime";
import { purgeIdentityRecoveryData, readIdentityOperation, saveIdentityOperation, removeIdentityOperation } from "./identity-recovery";
import { planIdentityMediaDeletion, removeIdentityMediaIds } from "./identity-media-cleanup";
import { requestPhoneSessionRemount } from "./phone-session-protocol";
import { withBackupOperation } from "./data-management/operation-lock";

let initializing: Promise<void> | null = null;
const IDENTITIES = "ai_phone_user_identities_v1";
const BINDINGS = "ai_phone_bindings_v1";
function parse<T>(raw: string | undefined | null, fallback: T): T { try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } }

export function initializePhoneIdentity(cache: Map<string, string>): Promise<void> {
  const state = readIdentityRuntime();
  if (state?.deletingUserIds.length) return deletePhoneIdentity(state.deletingUserIds[0]);
  if (state) return Promise.resolve();
  if (initializing) return initializing;
  initializing = (async () => {
    // Initialization only assigns namespaces; it does not rewrite legacy data.
    // A second full copy is optional and must not make a nearly-full phone unusable.
    const identities = parse<Array<{ id: string }>>(cache.get(IDENTITIES), []);
    if (!identities.length) {
      const identity = newDefaultIdentity();
      identities.push(identity);
      const { kvSetAsync } = await import("./kv-db");
      await kvSetAsync(IDENTITIES, JSON.stringify(identities));
    }
    const binding = parse<{ globalDefaults?: Record<string, unknown>; characterBindings?: Array<{ characterId: string; defaults?: { userIdentityId?: string } }> }>(cache.get(BINDINGS), {});
    const initial = initializeIdentitySpace(identities.map(identity => identity.id), binding.globalDefaults?.userIdentityId as string | undefined);
    const { kvSetAsync } = await import("./kv-db");
    const baseline = { ...binding, globalDefaults: { ...binding.globalDefaults, userIdentityId: undefined }, characterBindings: [] };
    await kvSetAsync(IDENTITY_BASE_BINDING_KEY, JSON.stringify(baseline));
    const access = Object.fromEntries((binding.characterBindings ?? []).filter(row => row.defaults?.userIdentityId)
      .map(row => [row.characterId, [row.defaults!.userIdentityId!]]));
    await kvSetAsync(IDENTITY_ACCESS_KEY, JSON.stringify(access));
    installIdentityRuntime(initial);
  })();
  return initializing;
}

function newDefaultIdentity() {
  return { id: `identity-${createIdentityId()}`, name: "默认身份", bio: "", gender: "保密", age: "", occupation: "", customSettings: "" };
}

async function suspendCloud(): Promise<void> {
  const { isPersonalPushCloudActive, setPersonalPushCloudScheduled, personalPushFetch } = await import("./personal-push-cloud");
  if (isPersonalPushCloudActive()) {
    await setPersonalPushCloudScheduled(false, true);
    for (const triggerPrefix of ["reply:", "followup:", "idle:", "timedwake:", "periodcare:"]) {
      const response = await personalPushFetch("jobs", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ triggerPrefix }) }, undefined, true);
      if (!response.ok) throw new Error("无法撤销旧身份的云端任务");
    }
    const { loadBridgeRules } = await import("./reality-bridge/storage");
    const { SCREEN_CHAT_SNAPSHOT_ID } = await import("./push-bridge-shared");
    const response = await personalPushFetch("bridge-sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rules: [], snapshots: [], deleteRuleIds: [...loadBridgeRules().map(rule => rule.id), SCREEN_CHAT_SNAPSHOT_ID], shortcutActions: [], ruleRuns: {} }) }, undefined, true);
    if (!response.ok) throw new Error("无法暂停旧身份的云端联动");
  }
  const { hasAccountPushSubscription, disableOfflinePush } = await import("./push-client");
  if (await hasAccountPushSubscription()) {
    const result = await disableOfflinePush(true);
    if (!result.ok) throw new Error(result.error || "无法暂停旧身份的离线推送");
  }
}

let transition: Promise<void> | null = null;
export function switchPhoneIdentity(userId: string): Promise<void> {
  if (transition) return transition;
  transition = withBackupOperation(async () => {
    const state = readIdentityRuntime();
    if (!state) throw new Error("身份空间尚未初始化");
    if (state.activeUserId === userId) return;
    const next = switchIdentitySpace(state, userId);
    const { retryFailedKvWrites } = await import("./kv-db");
    await retryFailedKvWrites();
    // Failed backup/cloud pause leaves the active identity unchanged.
    pauseIdentityDispatch(true);
    await suspendCloud();
    // Each slot keeps its own scheduled-action records. The old runtime is silenced below,\n    // and suspendCloud retires server-side jobs; do not erase resumable local state.
    silenceIdentityRuntime();
    installIdentityRuntime(next);
    requestPhoneSessionRemount();
  }).finally(() => { transition = null; pauseIdentityDispatch(false); });
  return transition;
}


function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("其他页面仍在使用身份数据，请关闭该页面后重试"));
  });
}

export function deletePhoneIdentity(userId: string): Promise<void> {
  if (transition) return transition;
  transition = withBackupOperation(() => deletePhoneIdentityOnce(userId)).finally(() => { transition = null; pauseIdentityDispatch(false); });
  return transition;
}
async function deletePhoneIdentityOnce(userId: string): Promise<void> {
  const state = readIdentityRuntime();
  if (!state) throw new Error("身份空间尚未初始化");
  pauseIdentityDispatch(true);
  if (!state.deletingUserIds.includes(userId)) await suspendCloud();
  const deleting = beginIdentityDeletion(state, userId);
  silenceIdentityRuntime();
  installIdentityRuntime(deleting);
  const kv = new Dexie("AiPhoneKvDB"); kv.version(1).stores({ entries: "key" });
  try {
    const table = kv.table<{ key: string; value: string }, string>("entries");
    const rows = (await table.bulkGet([IDENTITIES, IDENTITY_ACCESS_KEY])).filter((row): row is { key: string; value: string } => Boolean(row));
    const directory: Array<{ id: string }> = JSON.parse(rows.find(row => row.key === IDENTITIES)?.value || "null");
    const policies: Record<string, string[]> = JSON.parse(rows.find(row => row.key === IDENTITY_ACCESS_KEY)?.value || "{}");
    if (!Array.isArray(directory) || directory.some(identity => !identity || typeof identity.id !== "string")
      || !policies || typeof policies !== "object" || Object.values(policies).some(ids => !Array.isArray(ids))) {
      throw new Error("身份目录或权限数据损坏，已暂停删除，请先恢复备份");
    }
    const prefix = `identity:${encodeURIComponent(userId)}:`;
    const owns = (key: string) => userId === state.legacyOwnerId
      ? !key.startsWith("identity:") && !isSharedIdentityKey(key) : key.startsWith(prefix);
    type Deletion = { removedAssets: string[]; databases: string[]; completed: string[] };
    const journalId = `delete:${userId}`;
    let journal = await readIdentityOperation<Deletion>(journalId);
    const databases = await indexedDB.databases();
    if (!journal) {
      const ownedNames: string[] = [];
      for (const entry of databases) {
        if (!entry.name || identityDatabaseIsShared(entry.name)) continue;
        const owned = userId === state.legacyOwnerId ? !entry.name.includes("::identity:")
          : entry.name.endsWith(`::identity:${encodeURIComponent(userId)}`);
        if (owned) ownedNames.push(entry.name);
      }
      journal = { removedAssets: await planIdentityMediaDeletion(userId, state.legacyOwnerId, owns), databases: ownedNames, completed: [] };
      await saveIdentityOperation(journalId, journal);
    }
    // Keep media and recovery copies while any database is blocked. The plan
    // survives a reload, including references from databases already deleted.
    for (const name of journal.databases) {
      if (journal.completed.includes(name)) continue;
      await deleteDatabase(name);
      journal.completed.push(name);
      await saveIdentityOperation(journalId, journal);
    }
    await table.bulkDelete((await table.toCollection().primaryKeys()).filter(owns));
    for (const key of Object.keys(window.localStorage)) if (owns(key) && key !== "float_identity_runtime_v1") window.localStorage.removeItem(key);
    const identities = directory.filter(identity => identity.id !== userId);
    if (!identities.length) identities.push(newDefaultIdentity());
    await kv.table("entries").bulkPut([
      { key: IDENTITIES, value: JSON.stringify(identities) },
      { key: IDENTITY_ACCESS_KEY, value: JSON.stringify(Object.fromEntries(Object.entries(policies).map(([charId, ids]) => [charId, ids.filter(id => id !== userId)]))) },
    ]);
    await removeIdentityMediaIds(journal.removedAssets);
    await purgeIdentityRecoveryData(userId, state.legacyOwnerId, journal.removedAssets);
    const finished = finishIdentityDeletion(deleting, userId);
    installIdentityRuntime({ ...finished, userIds: identities.map(identity => identity.id), activeUserId: finished.activeUserId ?? identities[0].id });
    await removeIdentityOperation(journalId);
    requestPhoneSessionRemount();
  } finally { kv.close(); }
}

export function currentIdentityMatches(id: string): boolean { return getCurrentIdentityId() === id; }
