"use client";

import { useEffect, useState } from "react";
import { Button, LayerCard, Text } from "@cloudflare/kumo";
import { AdminShell } from "@/components/admin-shell";
import { PageHeader } from "@/components/page-header";
import { api } from "@/lib/api";

type Overview = {
  overview?: {
    healthy: number;
    rate_limited: number;
    dead: number;
    disabled: number;
    total: number;
    quota_estimate: number;
  };
  cleanup?: {
    enabled: boolean;
    dry_run: boolean;
    last_reason?: string;
    last?: { scanned?: number; quota_hits?: number; deleted?: number; would_delete?: number };
  };
};

export default function PoolPage() {
  const [ov, setOv] = useState<Overview | null>(null);
  const [logs, setLogs] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const [o, l] = await Promise.all([
      api<Overview>("/api/pool/overview"),
      api<{ text?: string; lines?: string[] }>("/api/pool/logs?tail=200"),
    ]);
    setOv(o);
    setLogs(l.text || (l.lines || []).join("\n"));
  }

  useEffect(() => {
    void load().catch((e: unknown) =>
      setMsg(e instanceof Error ? e.message : "加载失败"),
    );
  }, []);

  async function patrol(mode: "light" | "deep") {
    setBusy(true);
    try {
      await api("/api/pool/patrol", { method: "POST", body: JSON.stringify({ mode }) });
      setMsg(`${mode} 巡检已触发`);
      setTimeout(() => void load(), 1500);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "巡检失败");
    } finally {
      setBusy(false);
    }
  }

  async function cleanup() {
    if (!confirm("清理限额耗尽号？（纯 429 保留；演练模式只报告）")) return;
    setBusy(true);
    try {
      const d = await api<{ result?: { reason?: string } }>("/api/pool/cleanup", {
        method: "POST",
        body: JSON.stringify({ force: true }),
      });
      setMsg(d.result?.reason || "清理完成");
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "清理失败");
    } finally {
      setBusy(false);
    }
  }

  const o = ov?.overview;
  const c = ov?.cleanup;

  return (
    <AdminShell>
      <PageHeader
        title="号池"
        description="巡检 · 清理限额耗尽 · 日志"
        actions={
          <>
            <Button size="sm" variant="secondary" loading={busy} onClick={() => void patrol("light")}>
              轻检
            </Button>
            <Button size="sm" variant="secondary" loading={busy} onClick={() => void patrol("deep")}>
              深检
            </Button>
            <Button size="sm" loading={busy} onClick={() => void cleanup()}>
              清理耗尽
            </Button>
          </>
        }
      />
      {msg ? <div className="mb-3"><Text>{msg}</Text></div> : null}
      <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="健康" value={o?.healthy} />
        <Stat label="限流" value={o?.rate_limited} />
        <Stat label="死号" value={o?.dead} />
        <Stat label="总量" value={o?.total} />
        <Stat label="额度估算" value={o?.quota_estimate} />
      </div>
      <LayerCard className="mb-4">
        <LayerCard.Secondary>清理</LayerCard.Secondary>
        <LayerCard.Primary>
          <Text size="sm">
            {c?.enabled ? "已启用定时" : "未启用定时（可手动）"}
            {c?.dry_run ? " · 演练" : ""}
            {c?.last_reason ? ` · ${c.last_reason}` : ""}
          </Text>
        </LayerCard.Primary>
      </LayerCard>
      <LayerCard>
        <LayerCard.Secondary>巡检 / 清理日志</LayerCard.Secondary>
        <LayerCard.Primary>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap text-xs">
            {logs || "（暂无）"}
          </pre>
        </LayerCard.Primary>
      </LayerCard>
    </AdminShell>
  );
}

function Stat({ label, value }: { label: string; value?: number }) {
  return (
    <LayerCard>
      <LayerCard.Secondary>{label}</LayerCard.Secondary>
      <LayerCard.Primary>
        <Text variant="heading3" as="h3">{value ?? "—"}</Text>
      </LayerCard.Primary>
    </LayerCard>
  );
}
