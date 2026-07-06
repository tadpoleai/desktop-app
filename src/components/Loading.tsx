import React from "react";
import { Skeleton, Spin } from "antd";

export function PageLoading() {
  return (
    <div style={{ padding: 24 }}>
      <Skeleton active paragraph={{ rows: 4 }} />
    </div>
  );
}

export function InlineLoading({ tip = "加载中…" }: { tip?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "32px 0", justifyContent: "center", color: "#8890b0", fontSize: 13 }}>
      <Spin size="small" />
      <span>{tip}</span>
    </div>
  );
}
