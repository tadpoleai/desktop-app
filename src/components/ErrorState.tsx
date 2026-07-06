import React from "react";
import { Button, Result } from "antd";

interface Props {
  message?: string;
  onRetry?: () => void;
}

export function ErrorState({ message = "加载失败", onRetry }: Props) {
  return (
    <Result
      status="error"
      title={message}
      extra={
        onRetry && (
          <Button type="primary" size="small" onClick={onRetry}>
            重试
          </Button>
        )
      }
      style={{ padding: "32px 0" }}
    />
  );
}
