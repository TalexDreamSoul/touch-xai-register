"use client";

import { useEffect, useState } from "react";
import { Badge, Button, LayerCard, Text } from "@cloudflare/kumo";
import { AdminShell } from "@/components/admin-shell";
import { PageHeader } from "@/components/page-header";
import { api, type ClusterStatus, type RunStatus } from "@/lib/api";

type OverviewResp = {
  ok: boolean;
  overview?: {
    healthy: number;
    rate_limited: number;
    dead: number;
    disabled: number;
    total: number;
    quota_estimate: number;
  };
  patrol?: { enabled: boolean; running: boolean };
  refill?: { enabled: boolean; min_healthy: number; batch: number };
  cleanup?: { enabled: boolean; dry_run: boolean };
};

export default function OverviewPage() {
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [pool, setPool] = useState<OverviewResp | null>(null);
  const [cluster, setCluster] = useState<ClusterStatus | null>(null);
  const [error, setError] = useState("");

  async function load() {
    try {
      const [st, ov, cl] = await Promise.all([
        api<{ ok: boolean; status: RunStatus }>("/api/status"),
        api<OverviewResp>("/api/pool/overview"),
        api<{ ok: boolean; cluster: ClusterStatus }>("/api/cluster/status"),
      ]);
      setStatus(st.status || null);
      setPool(ov);
      setCluster(cl.cluster);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    }
  }

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, []);

  const o = pool?.overview;

  return (
    <AdminShell>
      <PageHeader
        title="概览"
        description="注册状态 · 号池 · 主从调度"
        actions={
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            刷新
          </Button>
        }
      />
      {error ? <Text variant="error">{error}</Text> : null}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="注册状态" value={status?.status || "—"} />
        <Stat label="目标 / 成功" value={`${status?.target ?? "—"} / ${status?.success ?? "—"}`} />
        <Stat label="健康号" value={String(o?.healthy ?? "—")} />
        <Stat label="号池总量" value={String(o?.total ?? "—")} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <LayerCard>
          <LayerCard.Secondary>注册流水线</LayerCard.Secondary>
          <LayerCard.Primary>
            <div className="flex flex-col gap-2">
              <Text size="sm">阶段：{status?.phase || status?.phase_detail || "—"}</Text>
              <Text size="sm" variant="secondary">
                PID {status?.pid || "—"} · run {status?.run_id || "—"}
              </Text>
              <div className="flex gap-2">
                <Badge variant={status?.status === "running" ? "primary" : "secondary"}>
                  {status?.status || "stopped"}
                </Badge>
                <Badge variant="secondary">fail {status?.fail ?? 0}</Badge>
              </div>
            </div>
          </LayerCard.Primary>
        </LayerCard>

        <LayerCard>
          <LayerCard.Secondary>主从</LayerCard.Secondary>
          <LayerCard.Primary>
            <div className="flex flex-col gap-2">
              <Text size="sm">
                角色：<strong>{cluster?.role || "standalone"}</strong>
              </Text>
              <Text size="sm" variant="secondary">
                节点 {cluster?.node_name || cluster?.node_id?.slice(0, 8) || "—"}
              </Text>
              {cluster?.role === "master" ? (
                <Text size="sm">
                  目标 {cluster.pool_target} · 缺口 {cluster.need} · 从节点{" "}
                  {cluster.nodes?.filter((n) => n.online).length || 0}/
                  {cluster.nodes?.length || 0}
                </Text>
              ) : null}
              {cluster?.role === "slave" ? (
                <Text size="sm">
                  主地址 {cluster.master_url || "未配置"} ·{" "}
                  {cluster.slave_connected ? "已连接" : "未连接"}
                  {cluster.last_assign ? ` · 上次分配 ${cluster.last_assign}` : ""}
                </Text>
              ) : null}
            </div>
          </LayerCard.Primary>
        </LayerCard>
      </div>
    </AdminShell>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <LayerCard>
      <LayerCard.Secondary>{label}</LayerCard.Secondary>
      <LayerCard.Primary>
        <Text variant="heading3" as="h3">{value}</Text>
      </LayerCard.Primary>
    </LayerCard>
  );
}
