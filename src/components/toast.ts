import type { MessageInstance } from "antd/es/message/interface";

// Module-level ref populated by ToastProvider (mounted inside antd App context)
export const _msgRef: { current: MessageInstance | null } = { current: null };

export const toast = {
  success: (content: string, duration?: number) =>
    _msgRef.current?.success(content, duration),
  error: (content: string, duration?: number) =>
    _msgRef.current?.error(content, duration),
  info: (content: string, duration?: number) =>
    _msgRef.current?.info(content, duration),
  warning: (content: string, duration?: number) =>
    _msgRef.current?.warning(content, duration),
};
