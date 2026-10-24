import { ref } from "vue";

/** 按 ID 记录进行中的写操作：同一 ID 的操作完成前再次触发直接忽略，界面据此禁用对应按钮。 */
export function usePending() {
  const pending = ref(new Set<string>());

  async function run(id: string, action: () => Promise<void>) {
    if (pending.value.has(id)) return;
    pending.value.add(id);
    try {
      await action();
    } finally {
      pending.value.delete(id);
    }
  }

  return { isPending: (id: string) => pending.value.has(id), run };
}
