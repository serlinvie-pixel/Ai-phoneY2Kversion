"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowRightLeft, Copy, FolderPlus, Loader2, Trash2 } from "lucide-react";
import { ConfirmDialog } from "../ui/modal";
import { createIdentityId } from "@/lib/identity-space";
import { switchPhoneIdentity, deletePhoneIdentity } from "@/lib/identity-lifecycle";
import { getCurrentIdentityId } from "@/lib/identity-runtime";
import { loadUserIdentities, saveUserIdentities } from "@/lib/settings-storage";
import type { UserIdentity } from "./user-identity";

function slotLabel(slot: UserIdentity): string {
  return slot.slotName?.trim() || slot.name?.trim() || "未命名档位";
}

function newSlotId(): string {
  return `identity-${createIdentityId()}`;
}

export function SaveSlotsSettings() {
  const [slots, setSlots] = useState<UserIdentity[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setSlots(loadUserIdentities());
    setActiveId(getCurrentIdentityId());
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const persistSlots = (next: UserIdentity[]) => {
    saveUserIdentities(next);
    setSlots(next);
  };

  const createBlankSlot = async () => {
    if (busyId) return;
    setBusyId("new");
    setStatus("");
    const slot: UserIdentity = {
      id: newSlotId(),
      slotName: `新档位 ${slots.length + 1}`,
      name: "",
      bio: "",
      gender: "保密",
      age: "",
      occupation: "",
      customSettings: "",
    };
    const next = [slot, ...slots];
    persistSlots(next);
    try {
      await switchPhoneIdentity(slot.id);
      setActiveId(slot.id);
      setBusyId(null);
      setStatus("空白档位已创建并切换。可到「用户身份」中填写人物设定。");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "档位已创建，但切换失败。");
      setBusyId(null);
    }
  };

  const duplicateSlot = async (source: UserIdentity) => {
    if (busyId) return;
    setBusyId(source.id);
    setStatus("");
    const copy: UserIdentity = {
      ...source,
      id: newSlotId(),
      slotName: `${slotLabel(source)} 副本`,
      previousNames: undefined,
    };
    const next = [copy, ...slots];
    persistSlots(next);
    let cloned = false;
    try {
      const { cloneIdentitySlotData } = await import("@/lib/data-management/identity-clone");
      const result = await cloneIdentitySlotData(source.id, copy.id);
      cloned = true;
      setStatus(`已复制「${slotLabel(source)}」的档位数据（${result.recordsCopied.toLocaleString()} 条记录），正在切换到副本。`);
      await switchPhoneIdentity(copy.id);
      setActiveId(copy.id);
      setBusyId(null);
    } catch (error) {
      if (!cloned) {
        // The clone helper rolls back the target's private storage on data-copy errors.
        const remaining = loadUserIdentities().filter(slot => slot.id !== copy.id);
        persistSlots(remaining);
        setStatus(error instanceof Error ? `复制失败：${error.message}` : "复制失败，请检查存储空间后重试。");
      } else {
        setStatus(error instanceof Error ? `副本已创建，但切换失败：${error.message}` : "副本已创建，但切换失败。");
      }
      setBusyId(null);
    }
  };

  const switchSlot = async (slotId: string) => {
    if (busyId || slotId === activeId) return;
    setBusyId(slotId);
    setStatus("");
    try {
      await switchPhoneIdentity(slotId);
      setActiveId(slotId);
      setStatus("已切换档位。");
      setBusyId(null);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "切换失败，请重试。");
      setBusyId(null);
    }
  };

  const removeSlot = async () => {
    const slot = slots.find(item => item.id === deleteId);
    if (!slot || slots.length <= 1 || busyId) return;
    setBusyId(slot.id);
    setStatus("");
    try {
      await deletePhoneIdentity(slot.id);
      const remaining = slots.filter(item => item.id !== slot.id);
      persistSlots(remaining);
      setActiveId(getCurrentIdentityId());
      setDeleteId(null);
      setStatus(`已删除档位「${slotLabel(slot)}」。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "删除未完成，请检查存储空间后重试。");
    } finally {
      setBusyId(null);
    }
  };

  const renameSlot = (slotId: string, name: string) => {
    const next = slots.map(slot => slot.id === slotId ? { ...slot, slotName: name } : slot);
    persistSlots(next);
  };

  const deletingSlot = slots.find(item => item.id === deleteId);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="m-0 mx-2 ts-28 font-bold italic leading-none text-black">存档档位</h2>
        <p className="menu-desc mx-2">
          每个档位独立保存聊天、记忆、关系和应用进度。角色基础设定与角色资源库共享。
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {slots.map(slot => {
          const active = slot.id === activeId;
          const busy = busyId === slot.id || (busyId === "new" && slot.id === activeId);
          return (
            <section key={slot.id} className="ui-config-card flex flex-col gap-3" style={{ padding: 14 }}>
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <label className="menu-desc mb-1 block">档位名称</label>
                  <input
                    type="text"
                    value={slot.slotName ?? slot.name ?? ""}
                    onChange={event => renameSlot(slot.id, event.target.value)}
                    placeholder={slot.name || "给这个世界线起个名字"}
                    maxLength={64}
                    className="ui-input w-full"
                    aria-label={`${slotLabel(slot)} 档位名称`}
                  />
                  <div className="menu-desc mt-2">
                    人物设定：{slot.name?.trim() || "尚未命名"}{slot.gender ? ` · ${slot.gender}` : ""}
                  </div>
                </div>
                {active && (
                  <span className="shrink-0 rounded-full border px-2 py-1 ts-11" style={{ borderColor: "var(--c-border)", color: "var(--c-text)" }}>
                    当前档位
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {!active && (
                  <button type="button" className="ui-btn ui-btn-primary py-2 px-3 ts-12" onClick={() => void switchSlot(slot.id)} disabled={Boolean(busyId)}>
                    {busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowRightLeft size={14} />}
                    切换
                  </button>
                )}
                <button type="button" className="ui-btn ui-btn-outline py-2 px-3 ts-12" onClick={() => void duplicateSlot(slot)} disabled={Boolean(busyId)}>
                  {busyId === slot.id ? <Loader2 size={14} className="animate-spin" /> : <Copy size={14} />}
                  复制档位
                </button>
                <button type="button" className="ui-btn ui-btn-outline py-2 px-3 ts-12" onClick={() => setDeleteId(slot.id)} disabled={Boolean(busyId) || slots.length <= 1} style={{ color: "var(--c-danger)" }}>
                  <Trash2 size={14} />
                  删除
                </button>
              </div>
            </section>
          );
        })}
      </div>

      <button type="button" className="ui-btn ui-btn-primary w-full justify-center py-3" onClick={() => void createBlankSlot()} disabled={Boolean(busyId)}>
        {busyId === "new" ? <Loader2 size={16} className="animate-spin" /> : <FolderPlus size={16} />}
        新建空白档位
      </button>

      {busyId && (
        <p role="status" className="menu-desc mx-2">
          {busyId === "new" ? "正在创建并切换档位…" : slots.some(slot => slot.id === busyId) ? "正在处理档位…" : "正在处理档位…"}
        </p>
      )}
      {status && <p role="status" className="menu-desc mx-2">{status}</p>}

      {deletingSlot && (
        <ConfirmDialog
          title="删除这个档位？"
          message={`将永久删除「${slotLabel(deletingSlot)}」中的聊天、记忆、关系及应用数据；共享角色设定不会删除。此操作无法撤销。`}
          icon={Trash2}
          variant="danger"
          confirmLabel="确认删除"
          cancelLabel="取消"
          onConfirm={() => { void removeSlot(); }}
          onCancel={() => setDeleteId(null)}
        />
      )}
    </div>
  );
}
