"use client";

import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  Input,
  LayerCard,
  Select,
  Switch,
  Text,
} from "@cloudflare/kumo";
import { AdminShell } from "@/components/admin-shell";
import { PageHeader } from "@/components/page-header";
import { api, type ClusterStatus, type PanelConfig } from "@/lib/api";

const ROLE_OPTIONS = [
  { value: "standalone", label: "独立（不参与主从）" },
  { value: "master", label: "主节点 — 暴露需求 / 调度从节点" },
  { value: "slave", label: "从节点 — 连接主节点自动补号" },
] as const;

export default function ClusterPage() {
  const [cluster, setCluster] = useState<ClusterStatus | null>(null);
  const [role, setRole] = useState("standalone");
  const [nodeName, setNodeName] = useState("");
  const [masterURL, setMasterURL] = useState("");
  const [publicToken, setPublicToken] = useState("");
  const [poolTarget, setPoolTarget] = useState("50");
  const [assignMin, setAssignMin] = useState("1");
  const [assignMax, setAssignMax] = useState("10");
  const [heartbeat, setHeartbeat] = useState("15");
  const [autoRegister, setAutoRegister] = useState(true);
  const [autoUpload, setAutoUpload] = useState(true);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [pubInfo, setPubInfo] = useState("");

  async function load() {
    const [cl, cfg] = await Promise.all([
      api<{ cluster: ClusterStatus }>("/api/cluster/status"),
      api<{ config: PanelConfig }>("/api/config"),
    ]);
    setCluster(cl.cluster);
    const c = cfg.config;
    setRole(String(c.cluster_role || "standalone"));
    setNodeName(String(c.cluster_node_name || ""));
    setMasterURL(String(c.cluster_master_url || ""));
    setPoolTarget(String(c.cluster_pool_target ?? 50));
    setAssignMin(String(c.cluster_assign_min ?? 1));
    setAssignMax(String(c.cluster_assign_max ?? 10));
    setHeartbeat(String(c.cluster_heartbeat_sec ?? 15));
    setAutoRegister(c.cluster_auto_register !== false);
    setAutoUpload(c.cluster_auto_upload !== false);
  }

  useEffect(() => {
    void load().catch((e: unknown) =>
      setMsg(e instanceof Error ? e.message : "加载失败"),
    );
    const t = setInterval(() => {
      void api<{ cluster: ClusterStatus }>("/api/cluster/status")
        .then((d) => setCluster(d.cluster))
        .catch(() => undefined);
    }, 5000);
    return () => clearInterval(t);
  }, []);

  async function save() {
    setBusy(true);
    setMsg("");
    try {
      const body: Record<string, string | number | boolean> = {
        cluster_role: role,
        cluster_node_name: nodeName,
        cluster_master_url: masterURL,
        cluster_pool_target: parseInt(poolTarget, 10) || 0,
        cluster_assign_min: parseInt(assignMin, 10) || 1,
        cluster_assign_max: parseInt(assignMax, 10) || 10,
        cluster_heartbeat_sec: parseInt(heartbeat, 10) || 15,
        cluster_auto_register: autoRegister,
        cluster_auto_upload: autoUpload,
      };
      if (publicToken.trim()) body.cluster_public_token = publicToken.trim();
      await api("/api/config", { method: "PUT", body: JSON.stringify(body) });
      setPublicToken("");
      setMsg("已保存主从配置");
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function kick(id: string) {
    await api("/api/cluster/kick", {
      method: "POST",
      body: JSON.stringify({ node_id: id }),
    });
    await load();
  }

  async function probePublic() {
    try {
      const d: unknown = await fetch("/api/federation/info").then((r) => r.json());
      setPubInfo(JSON.stringify(d, null, 2));
    } catch (e) {
      setPubInfo(e instanceof Error ? e.message : "probe failed");
    }
  }

  return (
    <AdminShell>
      <PageHeader
        title="主从调度"
        description="主节点暴露缺口；从节点定时心跳，按分配自动注册 1–10 并上传"
        actions={
          <Button size="sm" loading={busy} onClick={() => void save()}>
            保存配置
          </Button>
        }
      />
      {msg ? (
        <div className="mb-3">
          <Text>{msg}</Text>
        </div>
      ) : null}

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <LayerCard>
          <LayerCard.Secondary>角色与连接</LayerCard.Secondary>
          <LayerCard.Primary>
            <div className="flex flex-col gap-3">
              <Select
                label="角色"
                value={role}
                onValueChange={(v) => setRole(String(v))}
              >
                {ROLE_OPTIONS.map((r) => (
                  <Select.Option key={r.value} value={r.value}>
                    {r.label}
                  </Select.Option>
                ))}
              </Select>
              <Input
                label="节点名称"
                value={nodeName}
                onChange={(e) => setNodeName(e.target.value)}
                placeholder="可选，显示在主节点列表"
              />
              <Input
                label="主节点 URL（从节点填写）"
                value={masterURL}
                onChange={(e) => setMasterURL(e.target.value)}
                placeholder="https://panel.example.com"
              />
              <Input
                label="联邦密钥（可选，主从一致）"
                type="password"
                value={publicToken}
                onChange={(e) => setPublicToken(e.target.value)}
                placeholder={
                  cluster?.public_token_set ? "已设置 · 留空不改" : "可选"
                }
              />
            </div>
          </LayerCard.Primary>
        </LayerCard>

        <LayerCard>
          <LayerCard.Secondary>主节点策略 / 从节点行为</LayerCard.Secondary>
          <LayerCard.Primary>
            <div className="flex flex-col gap-3">
              <Input
                label="号池维持数量（主）"
                value={poolTarget}
                onChange={(e) => setPoolTarget(e.target.value)}
              />
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="单次分配最小"
                  value={assignMin}
                  onChange={(e) => setAssignMin(e.target.value)}
                />
                <Input
                  label="单次分配最大"
                  value={assignMax}
                  onChange={(e) => setAssignMax(e.target.value)}
                />
              </div>
              <Input
                label="心跳间隔（秒）"
                value={heartbeat}
                onChange={(e) => setHeartbeat(e.target.value)}
              />
              <Switch
                label="从节点自动注册（收到分配后 start）"
                checked={autoRegister}
                onCheckedChange={(v) => setAutoRegister(!!v)}
              />
              <Switch
                label="批次结束后尝试上传 CPA"
                checked={autoUpload}
                onCheckedChange={(v) => setAutoUpload(!!v)}
              />
            </div>
          </LayerCard.Primary>
        </LayerCard>
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <Stat label="当前角色" value={cluster?.role || "—"} />
        <Stat
          label="缺口 / 目标"
          value={`${cluster?.need ?? "—"} / ${cluster?.pool_target ?? "—"}`}
        />
        <Stat
          label="在线从节点"
          value={String(cluster?.nodes?.filter((n) => n.online).length ?? 0)}
        />
      </div>

      {cluster?.role === "slave" ? (
        <div className="mb-4">
          <LayerCard>
            <LayerCard.Secondary>从节点状态</LayerCard.Secondary>
            <LayerCard.Primary>
              <Text size="sm">
                {cluster.slave_connected ? (
                  <Badge variant="primary">已连接主节点</Badge>
                ) : (
                  <Badge variant="secondary">未连接</Badge>
                )}{" "}
                上次分配 {cluster.last_assign || 0}
                {cluster.slave_last_error
                  ? ` · 错误：${cluster.slave_last_error}`
                  : ""}
              </Text>
            </LayerCard.Primary>
          </LayerCard>
        </div>
      ) : null}

      <div className="mb-4">
        <LayerCard>
          <LayerCard.Secondary>已连接从节点（主）</LayerCard.Secondary>
          <LayerCard.Primary>
            {(cluster?.nodes || []).length === 0 ? (
              <Text variant="secondary">暂无从节点心跳</Text>
            ) : (
              <div className="flex flex-col gap-3">
                {cluster?.nodes.map((n) => (
                  <div
                    key={n.id}
                    className="flex flex-wrap items-center justify-between gap-2 border-b border-kumo-hairline pb-3 last:border-0"
                  >
                    <div className="min-w-0">
                      <Text size="sm">
                        {n.name}{" "}
                        <Badge variant={n.online ? "primary" : "secondary"}>
                          {n.online ? "online" : "offline"}
                        </Badge>{" "}
                        {n.busy ? <Badge variant="secondary">busy</Badge> : null}
                      </Text>
                      <Text size="xs" variant="secondary">
                        id {n.id.slice(0, 12)}… · 分配 {n.assigned} · 完成{" "}
                        {n.completed_total} · {n.remote_addr || ""}
                      </Text>
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void kick(n.id)}
                    >
                      移除
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </LayerCard.Primary>
        </LayerCard>
      </div>

      <LayerCard>
        <LayerCard.Secondary>
          公网联邦信息{" "}
          <Button size="sm" variant="ghost" onClick={() => void probePublic()}>
            探测 /api/federation/info
          </Button>
        </LayerCard.Secondary>
        <LayerCard.Primary>
          <pre className="max-h-64 overflow-auto text-xs">
            {pubInfo ||
              "主节点可将此 URL 暴露给从节点。可选 CLUSTER_PUBLIC_TOKEN。"}
          </pre>
        </LayerCard.Primary>
      </LayerCard>
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
