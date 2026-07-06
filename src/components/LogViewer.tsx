import React, { useRef, useState, useEffect, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button, Input, Select, Space, Tooltip } from "antd";
import { ArrowDownToLine, Copy, Pause, Search } from "lucide-react";

export type LogCls = "meta" | "stderr" | "";

export interface LogLine {
  text: string;
  cls: LogCls;
}

interface Props {
  lines: LogLine[];
  height?: number;
}

const ROW_H = 20; // 12px mono × 1.6 line-height ≈ 19.2px

const CLS_COLOR: Record<LogCls, string> = {
  meta:   "#5b8ef0",
  stderr: "#f87171",
  "":     "#e2e4ef",
};

export function LogViewer({ lines, height = 300 }: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [search, setSearch] = useState("");
  const [level, setLevel] = useState<"all" | "meta" | "stderr">("all");
  const userScrolled = useRef(false);

  // Filter
  const filtered = React.useMemo(() => {
    let result = lines;
    if (level !== "all") result = result.filter((l) => l.cls === level);
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((l) => l.text.toLowerCase().includes(q));
    }
    return result;
  }, [lines, level, search]);

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_H,
    overscan: 30,
  });

  // Auto-follow: scroll to bottom on new lines (only if follow is on)
  useEffect(() => {
    if (follow && filtered.length > 0 && !userScrolled.current) {
      virtualizer.scrollToIndex(filtered.length - 1, { behavior: "auto" });
    }
  }, [filtered.length, follow]);

  // Detect manual scroll to pause auto-follow
  const onScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom) {
      userScrolled.current = false;
      setFollow(true);
    } else {
      userScrolled.current = true;
      setFollow(false);
    }
  }, []);

  function resumeFollow() {
    userScrolled.current = false;
    setFollow(true);
    if (filtered.length > 0) {
      virtualizer.scrollToIndex(filtered.length - 1, { behavior: "smooth" });
    }
  }

  function copyAll() {
    navigator.clipboard.writeText(lines.map((l) => l.text).join("\n")).catch(() => {});
  }

  return (
    <div>
      {/* Controls */}
      <div style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}>
        <Input
          size="small"
          prefix={<Search size={11} style={{ color: "#6a718f" }} />}
          placeholder="搜索日志…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          allowClear
          style={{ width: 180 }}
        />
        <Select
          size="small"
          value={level}
          onChange={setLevel}
          style={{ width: 90 }}
          options={[
            { label: "全部", value: "all" },
            { label: "stderr", value: "stderr" },
            { label: "系统", value: "meta" },
          ]}
        />
        <Space size={4} style={{ marginLeft: "auto" }}>
          <Tooltip title={follow ? "暂停跟随" : "跟随到底部"}>
            <Button
              size="small"
              type={follow ? "primary" : "default"}
              icon={follow ? <Pause size={11} /> : <ArrowDownToLine size={11} />}
              onClick={follow ? () => setFollow(false) : resumeFollow}
            />
          </Tooltip>
          <Tooltip title="复制全部日志">
            <Button size="small" icon={<Copy size={11} />} onClick={copyAll} />
          </Tooltip>
        </Space>
      </div>

      {/* Virtual scroll container */}
      <div
        ref={parentRef}
        onScroll={onScroll}
        style={{
          height,
          overflow: "auto",
          background: "#0a0c12",
          border: "1px solid #2e3148",
          borderRadius: 6,
          padding: "8px 12px",
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          fontSize: 12,
          lineHeight: `${ROW_H}px`,
        }}
      >
        {filtered.length === 0 ? (
          <div style={{ color: "#6a718f", paddingTop: 8 }}>
            {lines.length === 0 ? "等待日志输出…" : "无匹配日志"}
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((vItem) => {
              const line = filtered[vItem.index];
              return (
                <div
                  key={vItem.key}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    height: ROW_H,
                    transform: `translateY(${vItem.start}px)`,
                    color: CLS_COLOR[line.cls],
                    whiteSpace: "pre",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {line.text}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Line count */}
      <div style={{ fontSize: 11, color: "#6a718f", marginTop: 4, textAlign: "right" }}>
        {filtered.length !== lines.length
          ? `${filtered.length} / ${lines.length} 行`
          : `${lines.length} 行`}
      </div>
    </div>
  );
}
