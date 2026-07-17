import React from "react";
import type { MessageInstance } from "antd/es/message/interface";
import type { NotificationInstance } from "antd/es/notification/interface";

// Module-level refs populated by ToastProvider (mounted inside antd App context)
export const _msgRef: { current: MessageInstance | null } = { current: null };
export const _notifRef: { current: NotificationInstance | null } = { current: null };

export const toast = {
  success: (content: string, duration?: number) =>
    _msgRef.current?.success(content, duration),
  error: (content: string, duration?: number) =>
    _msgRef.current?.error(content, duration),
  info: (content: string, duration?: number) =>
    _msgRef.current?.info(content, duration),
  warning: (content: string, duration?: number) =>
    _msgRef.current?.warning(content, duration),

  /**
   * Persistent (does not auto-dismiss) notification for docker/environment
   * failures — these are multi-line, actionable diagnoses (see
   * runner/src/docker_diag.rs) that a 3s transient toast can't hold long
   * enough to read or copy.
   */
  dockerError: (content: string, title = "操作失败") =>
    _notifRef.current?.error({
      message: title,
      description: React.createElement(
        "div",
        {
          style: {
            whiteSpace: "pre-wrap",
            fontFamily: "'IBM Plex Mono','Cascadia Code','Courier New',monospace",
            fontSize: 12,
            lineHeight: 1.6,
          },
        },
        content,
      ),
      duration: 0,
      style: { width: 420 },
    }),
};
