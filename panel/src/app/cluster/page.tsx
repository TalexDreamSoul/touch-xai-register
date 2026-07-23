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
  { value: "slave", label: "从节点 — 可连接多个主" },
] as const;

export default function ClusterPage() {
  const [cluster, setCluster] = useState<ClusterStatus | null>(null);
  const [role, setRole] = useState("standalone");
  const [nodeName, setNodeName] = useState("");
  const [masterURLs, setMasterURLs] = useState("");
  const [publicToken, setPublicToken] = useState("");
  const [statusPassword, setStatusPassword] = useState("");
  const [poolTarget, setPoolTarget] = useState("50");
  const [assignMin, setAssignMin] = useState("1");
  const [assignMax, setAssignMax] = useState("10");
  const [heartbeat, setHeartbeat] = useState("15");
  const [autoRegister, setAutoRegister] = useState(true);
  const [autoUpload, setAutoUpload] = useState(true);
  const [sharePoolList, setSharePoolList] = useState(false);
  const [sharePoolPull, setSharePoolPull] = useState(false);
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
    const urls =
      String(c.cluster_master_urls || "") ||
      String(c.cluster_master_url || "");
    setMasterURLs(urls);
    setPoolTarget(String(c.cluster_pool_target ?? 50));
    setAssignMin(String(c.cluster_assign_min ?? 1));
    setAssignMax(String(c.cluster_assign_max ?? 10));
    setHeartbeat(String(c.cluster_heartbeat_sec ?? 15));
    setAutoRegister(c.cluster_auto_register !== false);
    setAutoUpload(c.cluster_auto_upload !== false);
    setSharePoolList(c.cluster_share_pool_list === true);
    setSharePoolPull(c.cluster_share_pool_pull === true);
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
        cluster_master_urls: masterURLs,
        cluster_pool_target: parseInt(poolTarget, 10) || 0,
        cluster_assign_min: parseInt(assignMin, 10) || 1,
        cluster_assign_max: parseInt(assignMax, 10) || 10,
        cluster_heartbeat_sec: parseInt(heartbeat, 10) || 15,
        cluster_auto_register: autoRegister,
        cluster_auto_upload: autoUpload,
        cluster_share_pool_list: sharePoolList,
        cluster_share_pool_pull: sharePoolPull,
      };
      // keep legacy single field as first line
      const first = masterURLs
        .split(/[\n,;]+/)
        .map((s) => s.trim())
        .filter(Boolean)[0];
      if (first) body.cluster_master_url = first;
      if (publicToken.trim()) body.cluster_public_token = publicToken.trim();
      if (statusPassword.trim() || statusPassword === "") {
        // allow explicit clear with single space? only set when user typed something
      }
      if (statusPassword.length > 0) {
        body.cluster_status_password = statusPassword;
      }
      await api("/api/config", { method: "PUT", body: JSON.stringify(body) });
      setPublicToken("");
      setStatusPassword("");
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

  const links = cluster?.master_links || [];

  return (
    <AdminShell>
      <PageHeader
        title="主从调度"
        description="主暴露缺口；从可连多个主，按最大分配自动注册 1–10"
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
                placeholder="可选"
              />
              <Input
                label="主节点 URL 列表（从节点，每行一个或逗号分隔）"
                value={masterURLs}
                onChange={(e) => setMasterURLs(e.target.value)}
                placeholder={"https://master-a.example.com\nhttps://master-b.example.com"}
              />
              <Input
                label="联邦密钥（主从一致，可选）"
                type="password"
                value={publicToken}
                onChange={(e) => setPublicToken(e.target.value)}
                placeholder={
                  cluster?.public_token_set ? "已设置 · 留空不改" : "可选"
                }
              />
              <Input
                label="状态页密码（与联邦密钥独立；空=公开）"
                type="password"
                value={statusPassword}
                onChange={(e) => setStatusPassword(e.target.value)}
                placeholder={
                  cluster?.status_password_set
                    ? "已设置 · 留空不改"
                    : "可选，独立于联邦密钥"
                }
              />
              <Text size="xs" variant="secondary">
                公网状态页：<code>/status/</code> · API{" "}
                <code>/api/public/status</code>
              </Text>
            </div>
          </LayerCard.Primary>
        </LayerCard>

        <LayerCard>
          <LayerCard.Secondary>主策略 / 从行为</LayerCard.Secondary>
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
                label="从节点自动注册"
                checked={autoRegister}
                onCheckedChange={(v) => setAutoRegister(!!v)}
              />
              <Switch
                label="批次结束后尝试上传 CPA"
                checked={autoUpload}
                onCheckedChange={(v) => setAutoUpload(!!v)}
              />
              <Switch
                label="允许联邦查看号池列表（主）"
                checked={sharePoolList}
                onCheckedChange={(v) => {
                  const on = !!v;
                  setSharePoolList(on);
                  if (!on) setSharePoolPull(false);
                }}
              />
              <Switch
                label="允许联邦拉取/下载凭证（主）"
                checked={sharePoolPull}
                onCheckedChange={(v) => {
                  const on = !!v;
                  setSharePoolPull(on);
                  if (on) setSharePoolList(true);
                }}
              />
              <Text size="xs" variant="secondary">
                分享开关仅主节点生效：列表只暴露元数据；拉取会下载 JSON 凭证。
              </Text>
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
            <LayerCard.Secondary>
              已配置主节点{" "}
              {cluster.slave_connected ? (
                <Badge variant="primary">至少一个在线</Badge>
              ) : (
                <Badge variant="secondary">未连接</Badge>
              )}
            </LayerCard.Secondary>
            <LayerCard.Primary>
              {links.length === 0 ? (
                <Text variant="secondary">
                  尚未心跳 · 配置多个主 URL 后自动轮询
                  {cluster.slave_last_error
                    ? ` · ${cluster.slave_last_error}`
                    : ""}
                </Text>
              ) : (
                <div className="flex flex-col gap-3">
                  {links.map((l) => (
                    <div
                      key={l.url}
                      className="flex flex-wrap items-center justify-between gap-2 border-b border-kumo-hairline pb-2 last:border-0"
                    >
                      <div className="min-w-0">
                        <Text size="sm">
                          {l.master_name || l.url}{" "}
                          <Badge variant={l.ok ? "primary" : "secondary"}>
                            {l.ok ? "ok" : "down"}
                          </Badge>
                        </Text>
                        <Text size="xs" variant="secondary">
                          {l.url} · need {l.need} · assign {l.last_assign}
                          {l.last_error ? ` · ${l.last_error}` : ""}
                        </Text>
                      </div>
                    </div>
                  ))}
                  <Text size="xs" variant="secondary">
                    上次选用分配 {cluster.last_assign || 0}（取各主最大
                    assign）
                  </Text>
                </div>
              )}
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
          联邦 info{" "}
          <Button size="sm" variant="ghost" onClick={() => void probePublic()}>
            探测 /api/federation/info
          </Button>
        </LayerCard.Secondary>
        <LayerCard.Primary>
          <pre className="max-h-64 overflow-auto text-xs">
            {pubInfo || "主从通信用；状态页请用 /status/"}
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
        <Text variant="heading3" as="h3">
          {value}
        </Text>
      </LayerCard.Primary>
    </LayerCard>
  );
}
