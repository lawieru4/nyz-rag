import { reactive } from "vue";

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  /** 确认按钮使用危险样式（删除、停用等不可轻易撤销的操作）。 */
  destructive?: boolean;
}

export const confirmState = reactive<{ open: boolean; options: ConfirmOptions; resolve?: (value: boolean) => void }>({
  open: false,
  options: { title: "" },
});

/** 替代 `window.confirm()`：页面中需挂载一个 `<ConfirmDialog />`。同一时间只有一个确认框，新的请求会取消旧的。 */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  confirmState.resolve?.(false);
  return new Promise((resolve) => {
    Object.assign(confirmState, { open: true, options, resolve });
  });
}

export function settleConfirm(value: boolean) {
  const resolve = confirmState.resolve;
  confirmState.resolve = undefined;
  confirmState.open = false;
  resolve?.(value);
}
