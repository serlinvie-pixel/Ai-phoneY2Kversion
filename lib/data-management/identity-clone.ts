import { assertIdentityActive, getCurrentIdentityId } from "../identity-runtime";
import { DATA_MODULES } from "./modules";
import { exportSource, importSource } from "./idb";
import { scopeBackupModules } from "./identity-backup";
import { createMediaCollector } from "./serializers";
import type { DataSource, IdentityBackupDirectory, SourceBackup } from "./types";

function remapIdentityReferences(value: unknown, sourceId: string, targetId: string): unknown {
  if (Array.isArray(value)) return value.map(item => remapIdentityReferences(item, sourceId, targetId));
  if (typeof value === "string" && value.includes(sourceId)) {
    try {
      const parsed: unknown = JSON.parse(value);
      const mapped = remapIdentityReferences(parsed, sourceId, targetId);
      return JSON.stringify(mapped);
    } catch {
      return value;
    }
  }
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(record).map(([key, child]) => {
    if ((key === "userIdentityId" || key === "ownerUserId") && child === sourceId) {
      return [key, targetId];
    }
    return [key, remapIdentityReferences(child, sourceId, targetId)];
  }));
}

function prepareTargetPayload(payload: SourceBackup, sourceId: string, targetId: string): SourceBackup {
  const owner = { kind: "user" as const, userId: targetId };
  if (payload.type === "indexeddb") {
    return {
      ...payload,
      owner,
      stores: payload.stores.map(store => ({
        ...store,
        records: store.records.map(record => ({
          ...record,
          key: remapIdentityReferences(record.key, sourceId, targetId),
          value: remapIdentityReferences(record.value, sourceId, targetId),
        })),
      })),
    };
  }

  return {
    ...payload,
    owner,
    records: payload.records.map(record => ({
      ...record,
      value: remapIdentityReferences(record.value, sourceId, targetId) as string,
    })),
  };
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

      const targetPayload = prepareTargetPayload(payload, sourceId, targetId);
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
  return { sourcesCopied, recordsCopied };
}
