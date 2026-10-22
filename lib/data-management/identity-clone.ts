import { assertIdentityActive, getCurrentIdentityId, identityDatabaseIsShared, IDENTITY_ACCESS_KEY } from "../identity-runtime";
import { kvGet, kvSetAsync } from "../kv-db";
import { DATA_MODULES } from "./modules";
import { exportSource, importSource } from "./idb";
import { scopeBackupModules } from "./identity-backup";
import { createMediaCollector } from "./serializers";
import type { DataSource, IdentityBackupDirectory, SourceBackup } from "./types";

type ThemeAssetRecord = {
  id: string;
  type: string;
  ownerUserId?: string;
  updatedAt?: string;
  [key: string]: unknown;
};

const SLOT_OWNED_THEME_ASSET_TYPES = new Set(["chat_bg", "vn_scene", "vn_sprite"]);
const THEME_DB_NAME = "ai_phone_theme_db_v1";
const THEME_ASSET_STORE = "assets";

function createCopiedAssetId(type: string): string {
  const suffix = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return `${type}_${suffix}`;
}

async function openThemeAssetDbIfPresent(): Promise<IDBDatabase | null> {
  if (typeof indexedDB.databases === "function") {
    const databases = await indexedDB.databases();
    if (!databases.some(database => database.name === THEME_DB_NAME)) return null;
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(THEME_DB_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法读取角色场景素材库"));
  });
}

async function cloneOwnedThemeAssets(sourceId: string, targetId: string): Promise<{ idMap: Map<string, string>; createdIds: string[] }> {
  const db = await openThemeAssetDbIfPresent();
  if (!db) return { idMap: new Map(), createdIds: [] };
  try {
    if (!db.objectStoreNames.contains(THEME_ASSET_STORE)) return { idMap: new Map(), createdIds: [] };

    const originals = await new Promise<ThemeAssetRecord[]>((resolve, reject) => {
      const result: ThemeAssetRecord[] = [];
      const request = db.transaction(THEME_ASSET_STORE, "readonly").objectStore(THEME_ASSET_STORE).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve(result);
        const asset = cursor.value as ThemeAssetRecord;
        if (asset.ownerUserId === sourceId && SLOT_OWNED_THEME_ASSET_TYPES.has(asset.type)) result.push(asset);
        cursor.continue();
      };
      request.onerror = () => reject(request.error ?? new Error("无法读取档位素材"));
    });
    if (originals.length === 0) return { idMap: new Map(), createdIds: [] };

    const idMap = new Map<string, string>();
    const copies = originals.map(asset => {
      const id = createCopiedAssetId(asset.type);
      idMap.set(asset.id, id);
      return { ...asset, id, ownerUserId: targetId, updatedAt: new Date().toISOString() };
    });

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(THEME_ASSET_STORE, "readwrite");
      const store = tx.objectStore(THEME_ASSET_STORE);
      for (const asset of copies) store.add(asset);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("复制档位素材失败"));
      tx.onabort = () => reject(tx.error ?? new Error("复制档位素材已取消"));
    });

    return { idMap, createdIds: copies.map(asset => asset.id) };
  } finally {
    db.close();
  }
}

async function removeCopiedThemeAssets(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await openThemeAssetDbIfPresent();
  if (!db) return;
  try {
    if (!db.objectStoreNames.contains(THEME_ASSET_STORE)) return;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(THEME_ASSET_STORE, "readwrite");
      const store = tx.objectStore(THEME_ASSET_STORE);
      for (const id of ids) store.delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("回滚复制素材失败"));
      tx.onabort = () => reject(tx.error ?? new Error("回滚复制素材已取消"));
    });
  } finally {
    db.close();
  }
}

function remapIdentityReferences(
  value: unknown,
  sourceId: string,
  targetId: string,
  assetIdMap: Map<string, string>,
): unknown {
  if (Array.isArray(value)) return value.map(item => remapIdentityReferences(item, sourceId, targetId, assetIdMap));
  if (typeof value === "string") {
    const directAssetId = assetIdMap.get(value);
    if (directAssetId) return directAssetId;
    const mayContainReference = value.includes(sourceId) || [...assetIdMap.keys()].some(id => value.includes(id));
    if (mayContainReference) {
      try {
        const parsed: unknown = JSON.parse(value);
        const mapped = remapIdentityReferences(parsed, sourceId, targetId, assetIdMap);
        return JSON.stringify(mapped);
      } catch {
        return value;
      }
    }
    return value;
  }
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(record).map(([key, child]) => {
    if ((key === "userIdentityId" || key === "ownerUserId") && child === sourceId) {
      return [key, targetId];
    }
    return [key, remapIdentityReferences(child, sourceId, targetId, assetIdMap)];
  }));
}

function prepareTargetPayload(payload: SourceBackup, sourceId: string, targetId: string, assetIdMap: Map<string, string>): SourceBackup {
  const owner = { kind: "user" as const, userId: targetId };
  if (payload.type === "indexeddb") {
    return {
      ...payload,
      owner,
      stores: payload.stores.map(store => ({
        ...store,
        records: store.records.map(record => ({
          ...record,
          key: remapIdentityReferences(record.key, sourceId, targetId, assetIdMap),
          value: remapIdentityReferences(record.value, sourceId, targetId, assetIdMap),
        })),
      })),
    };
  }

  return {
    ...payload,
    owner,
    records: payload.records.map(record => ({
      ...record,
      value: remapIdentityReferences(record.value, sourceId, targetId, assetIdMap) as string,
    })),
  };
}

async function grantCloneCharacterAccess(sourceId: string, targetId: string): Promise<void> {
  const raw = kvGet(IDENTITY_ACCESS_KEY);
  let access: Record<string, unknown>;
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    access = parsed as Record<string, unknown>;
  } catch {
    throw new Error("角色访问权限数据格式异常，已停止复制");
  }

  let changed = false;
  const next: Record<string, string[]> = {};
  for (const [characterId, value] of Object.entries(access)) {
    if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
      throw new Error("角色访问权限数据格式异常，已停止复制");
    }
    const ids = [...value] as string[];
    if (ids.includes(sourceId) && !ids.includes(targetId)) {
      ids.push(targetId);
      changed = true;
    }
    next[characterId] = ids;
  }
  if (changed) await kvSetAsync(IDENTITY_ACCESS_KEY, JSON.stringify(next));
}

async function removeCloneCharacterAccess(targetId: string): Promise<void> {
  const raw = kvGet(IDENTITY_ACCESS_KEY);
  if (!raw) return;
  let access: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    access = parsed as Record<string, unknown>;
  } catch {
    return;
  }

  let changed = false;
  const next: Record<string, string[]> = {};
  for (const [characterId, value] of Object.entries(access)) {
    if (!Array.isArray(value) || value.some(item => typeof item !== "string")) continue;
    const ids = (value as string[]).filter(id => id !== targetId);
    if (ids.length !== value.length) changed = true;
    next[characterId] = ids;
  }
  if (changed) await kvSetAsync(IDENTITY_ACCESS_KEY, JSON.stringify(next));
}

async function clearTargetIdentityNamespace(targetId: string): Promise<void> {
  const encoded = encodeURIComponent(targetId);
  const prefix = `identity:${encoded}:`;
  const suffix = `::identity:${encoded}`;
  const databaseNames = new Set<string>();

  for (const database of await (typeof indexedDB.databases === "function" ? indexedDB.databases() : Promise.resolve([]))) {
    if (database.name?.endsWith(suffix)) databaseNames.add(database.name);
  }
  for (const module of DATA_MODULES) {
    for (const source of module.sources) {
      if (source.type !== "indexeddb" || identityDatabaseIsShared(source.dbName)) continue;
      databaseNames.add(`${source.dbName}${suffix}`);
    }
  }
  await Promise.all([...databaseNames].map(name => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`无法清理数据库 ${name}`));
    request.onblocked = () => reject(new Error(`数据库 ${name} 仍被其他页面占用，清理未完成`));
  })));

  // The key-value database is shared physically; remove only this slot's prefix.
  const { default: Dexie } = await import("dexie");
  const kv = new Dexie("AiPhoneKvDB");
  kv.version(1).stores({ entries: "key" });
  try {
    await kv.table("entries").where("key").startsWith(prefix).delete();
  } finally {
    kv.close();
  }

  if (typeof window !== "undefined") {
    const remove: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(prefix)) remove.push(key);
    }
    for (const key of remove) window.localStorage.removeItem(key);
  }
}

/**
 * Clone one save slot's private app data into a new identity namespace.
 * Character/resource libraries are deliberately excluded because they are shared
 * by the host; chats, memories, app state and other user-owned stores are copied.
 *
 * The caller must create/register the target identity card first. The source may
 * be active or inactive; backupAccess provides the explicit cross-identity read
 * path while guarding against an identity switch during the copy.
 */
export async function cloneIdentitySlotData(sourceId: string, targetId: string): Promise<{ sourcesCopied: number; recordsCopied: number }> {
  if (!sourceId || !targetId || sourceId === targetId) throw new Error("复制档位的来源或目标无效");
  assertIdentityActive();
  const activeAtStart = getCurrentIdentityId();
  const directory: IdentityBackupDirectory = { mode: "current", users: [{ id: sourceId, name: "档位副本来源" }] };
  const modules = scopeBackupModules(DATA_MODULES, directory);
  let sourcesCopied = 0;
  let recordsCopied = 0;
  let assetIdMap = new Map<string, string>();
  let clonedAssetIds: string[] = [];

  try {
    const clonedAssets = await cloneOwnedThemeAssets(sourceId, targetId);
    assetIdMap = clonedAssets.idMap;
    clonedAssetIds = clonedAssets.createdIds;

    for (const module of modules) {
      for (let index = 0; index < module.sources.length; index += 1) {
        const source = module.sources[index] as DataSource;
        if (source.backupOwner?.kind !== "user" || source.backupOwner.userId !== sourceId) continue;
  
        assertIdentityActive();
        if (getCurrentIdentityId() !== activeAtStart) throw new Error("复制期间当前档位发生变化，已中止");
        const collector = createMediaCollector();
        const payload = await exportSource(source, collector);
        if (payload.type === "indexeddb" && payload.error) {
          throw new Error(`无法复制「${module.label}」数据：${payload.error}`);
        }
  
        const targetPayload = prepareTargetPayload(payload, sourceId, targetId, assetIdMap);
        const result = await importSource(targetPayload, true, async ref => collector.media.get(ref) ?? null);
        collector.media.clear();
        if (result.errors.length > 0) {
          throw new Error(`复制「${module.label}」时有数据未能写入：${result.errors.slice(0, 3).join("；")}`);
        }
        sourcesCopied += 1;
        recordsCopied += result.added + result.overwritten;
      }
    }
    assertIdentityActive();
    if (getCurrentIdentityId() !== activeAtStart) throw new Error("复制期间当前档位发生变化，已中止");
    await grantCloneCharacterAccess(sourceId, targetId);
  } catch (error) {
    const cleanup = await Promise.allSettled([
      clearTargetIdentityNamespace(targetId),
      removeCopiedThemeAssets(clonedAssetIds),
      removeCloneCharacterAccess(targetId),
    ]);
    const failures = cleanup.flatMap(result => result.status === "rejected"
      ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
      : []);
    if (failures.length > 0) {
      throw new Error(`复制失败，自动清理未能全部完成（${failures.join("；")}）。目标档位可能残留部分数据，请先不要使用它。`);
    }
    throw error;
  }

  return { sourcesCopied, recordsCopied };
}
