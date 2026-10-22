import { assertIdentityActive, getCurrentIdentityId, identityDatabaseIsShared, isSharedIdentityKey, readIdentityRuntime, IDENTITY_RUNTIME_KEY, IDENTITY_ACCESS_KEY } from "../identity-runtime";
import { kvGet, kvSetAsync } from "../kv-db";
import { updateIdentityDirectory } from "../identity-lifecycle";
import { createIdentityId } from "../identity-space";
import type { BackupOwner, DataModuleDefinition, IdentityBackupDirectory, ImportOptions, SourceBackup } from "./types";

export const IDENTITIES_KEY = "ai_phone_user_identities_v1";
const SHARED: BackupOwner = { kind: "shared" };
type IdentityCard = { id: string; name: string; [key: string]: unknown };
export function backupIdentityCards(): IdentityCard[] {
  const cards: unknown = JSON.parse(kvGet(IDENTITIES_KEY) ?? "[]");
  if (!Array.isArray(cards) || cards.some(card => typeof card?.id !== "string" || !card.id)) throw new Error("身份目录损坏，已停止备份或恢复");
  return cards;
}

export function createIdentityBackupDirectory(mode: "current" | "all" = "all"): IdentityBackupDirectory {
  assertIdentityActive();
  const state = readIdentityRuntime();
  if (!state?.activeUserId || state.deletingUserIds.length) throw new Error("身份尚未准备好或正在删除，请稍后备份");
  const cards = backupIdentityCards();
  const ids = mode === "all" ? state.userIds : [state.activeUserId];
  return { mode, users: ids.map(id => {
    const card = cards.find(item => item.id === id);
    if (!card) throw new Error("身份目录不完整，已停止备份");
    return { id, name: typeof card.slotName === "string" && card.slotName.trim() ? card.slotName.trim() : card.name || "未命名档位" };
  }) };
}

export function validIdentityDirectory(value: unknown): value is IdentityBackupDirectory {
  const item = value as IdentityBackupDirectory | undefined;
  return Boolean(item && (item.mode === "all" || item.mode === "current") && Array.isArray(item.users)
    && item.users.length > 0 && (item.mode !== "current" || item.users.length === 1)
    && item.users.every(user => typeof user?.id === "string" && user.id.length > 0 && typeof user.name === "string")
    && new Set(item.users.map(user => user.id)).size === item.users.length);
}

export function scopeBackupModules(modules: DataModuleDefinition[], directory: IdentityBackupDirectory): DataModuleDefinition[] {
  const legacy = readIdentityRuntime()?.legacyOwnerId ?? null;
  const owners: BackupOwner[] = [SHARED, ...directory.users.map(user => ({ kind: "user" as const, userId: user.id }))];
  return modules.map(module => ({ ...module, sources: module.sources.flatMap(source => owners
    .filter(owner => source.type !== "indexeddb" || identityDatabaseIsShared(source.dbName) === (owner.kind === "shared"))
    .map(owner => ({ ...source, backupOwner: owner, backupLegacyOwnerId: legacy, backupUserIds: directory.users.map(user => user.id) }))) }));
}

/** Explicit storage adapter: access to another user is limited to backup/restore callers. */
export function backupAccess(owner: BackupOwner, legacyOwnerId = readIdentityRuntime()?.legacyOwnerId ?? null, userIds?: string[]) {
  const revision = readIdentityRuntime()?.revision;
  const active = getCurrentIdentityId();
  const guard = () => {
    assertIdentityActive();
    const now = readIdentityRuntime();
    if (now?.revision !== revision || now?.activeUserId !== active || now?.deletingUserIds.length) throw new Error("身份已改变，请重新开始备份或恢复");
  };
  const prefix = owner.kind === "user" && owner.userId !== legacyOwnerId ? `identity:${encodeURIComponent(owner.userId)}:` : "";
  const accepts = (key: string) => key !== IDENTITY_RUNTIME_KEY && !key.startsWith("identity:")
    && isSharedIdentityKey(key) === (owner.kind === "shared");
  const logicalKey = (physical: string): string | null => {
    const key = prefix ? (physical.startsWith(prefix) ? physical.slice(prefix.length) : null) : physical;
    return key !== null && accepts(key) ? key : null;
  };
  return {
    owner, guard, accepts, logicalKey, userIds,
    isCurrent: owner.kind === "shared" || owner.userId === active,
    physicalKey(key: string) { guard(); if (!accepts(key)) throw new Error(`数据归属不匹配：${key}`); return `${prefix}${key}`; },
    databaseName(name: string) {
      guard();
      if (name.includes("::identity:") || identityDatabaseIsShared(name) !== (owner.kind === "shared") || ["AiPhoneKvDB", "AiPhoneIdentitySpacesDB", "AiPhoneIdentityRecoveryDB"].includes(name)) throw new Error(`数据库归属不匹配：${name}`);
      return prefix ? `${name}::${prefix.slice(0, -1)}` : name;
    },
    filterValue(key: string, value: string): string {
      if (key === IDENTITIES_KEY && userIds) return JSON.stringify((JSON.parse(value) as IdentityCard[]).filter(card => userIds.includes(card.id)));
      if (key === IDENTITY_ACCESS_KEY && userIds) return JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(value) as Record<string, string[]>).map(([id, users]) => [id, users.filter(user => userIds.includes(user))])));
      return value;
    },
  };
}
export type BackupAccess = ReturnType<typeof backupAccess>;

type LegacyDirectory = IdentityBackupDirectory & { sourceUserId?: string };
export function readLegacyIdentityHint(source: SourceBackup, directory: IdentityBackupDirectory): void {
  if (source.type === "indexeddb") return;
  for (const record of source.records) {
    if (record.key === IDENTITIES_KEY && !(directory as LegacyDirectory).sourceUserId) {
      const cards = JSON.parse(record.value);
      if (Array.isArray(cards) && typeof cards[0]?.id === "string") (directory as LegacyDirectory).sourceUserId = cards[0].id;
    }
    if (record.key === "ai_phone_bindings_v1") {
      const binding = JSON.parse(record.value);
      if (typeof binding?.globalDefaults?.userIdentityId === "string") (directory as LegacyDirectory).sourceUserId = binding.globalDefaults.userIdentityId;
    }
  }
}

export function validateOwnedSource(source: SourceBackup, directory: IdentityBackupDirectory): void {
  const owner = source.owner;
  if (!owner || (owner.kind !== "shared" && owner.kind !== "user") || (owner.kind === "user" && !directory.users.some(user => user.id === owner.userId))) throw new Error("备份数据缺少有效的身份归属");
  const access = backupAccess(owner);
  if (source.type === "indexeddb") {
    access.databaseName(source.dbName);
    if (source.error) throw new Error(`备份不完整：${source.error}`);
  } else {
    if (source.records.some(record => !access.accepts(record.key))) throw new Error("备份包含跨身份的数据键，已停止恢复");
    const ids = new Set(directory.users.map(user => user.id));
    for (const record of source.records) {
      if (record.key === IDENTITIES_KEY) {
        const cards = JSON.parse(record.value);
        if (!Array.isArray(cards) || cards.some(card => !ids.has(card?.id))) throw new Error("身份卡与备份归属清单不匹配");
      }
      if (record.key === IDENTITY_ACCESS_KEY) {
        const policies = JSON.parse(record.value);
        if (!policies || typeof policies !== "object" || Object.values(policies).some(users => !Array.isArray(users) || users.some(id => !ids.has(id)))) throw new Error("角色访问范围与备份身份不匹配");
      }
    }
  }
}

export async function registerBackupUsers(directory: IdentityBackupDirectory): Promise<void> {
  assertIdentityActive();
  const current = backupIdentityCards();
  const state = readIdentityRuntime();
  if (!state || state.deletingUserIds.length) throw new Error("身份正在变更，请稍后恢复");
  const ids = new Set(current.map(user => user.id));
  for (const user of directory.users) if (!ids.has(user.id)) current.push({ ...user, bio: "", gender: "保密", age: "", occupation: "", customSettings: "" });
  if (current.length !== ids.size) {
    await kvSetAsync(IDENTITIES_KEY, JSON.stringify(current));
    updateIdentityDirectory(current);
  }
}

export async function legacyImportDirectory(options: ImportOptions): Promise<IdentityBackupDirectory> {
  if (options.legacyTarget === "current") return createIdentityBackupDirectory("current");
  return { mode: "current", users: [{ id: `identity-import-${createIdentityId()}`, name: `导入存档 ${new Date().toLocaleDateString()}` }] };
}

/** Legacy archives are one unpartitioned save, regardless of how many persona cards they contain. */
export function routeLegacySource(source: SourceBackup, directory: IdentityBackupDirectory): SourceBackup[] {
  const user = directory.users[0];
  const sourceUserId = (directory as LegacyDirectory).sourceUserId;
  const owner: BackupOwner = { kind: "user", userId: user.id };
  const remap = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(remap);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
      (key === "userIdentityId" || key === "ownerUserId") && child === sourceUserId ? user.id : remap(child)]));
  };
  if (source.type === "indexeddb") return [{ ...source, owner: identityDatabaseIsShared(source.dbName) ? SHARED : owner,
    stores: source.stores.map(store => ({ ...store, records: store.records.map(record => ({ ...record, value: sourceUserId ? remap(record.value) : record.value })) })) }];
  const records = source.records.filter(record => record.key !== IDENTITY_RUNTIME_KEY && record.key !== IDENTITY_ACCESS_KEY && !record.key.startsWith("identity:"));
  return [SHARED, owner].map(target => ({ ...source, owner: target, records: records.filter(record => isSharedIdentityKey(record.key) === (target.kind === "shared")).map(record => {
    if (record.key === IDENTITIES_KEY) {
      const profiles = JSON.parse(record.value) as IdentityCard[];
      if (!Array.isArray(profiles)) throw new Error("旧存档身份信息格式错误");
      const profile = profiles.find(card => card.id === sourceUserId) ?? profiles[0];
      if (profile?.name) user.name = profile.name;
      return { ...record, value: JSON.stringify(profile ? [{ ...profile, id: user.id }] : []) };
    }
    if (record.key !== "ai_phone_bindings_v1") return record;
    const binding = JSON.parse(record.value);
    binding.globalDefaults = { ...binding.globalDefaults, userIdentityId: user.id };
    for (const row of binding.characterBindings ?? []) row.defaults = { ...row.defaults, userIdentityId: user.id };
    return { ...record, value: JSON.stringify(binding) };
  }) }));
}
