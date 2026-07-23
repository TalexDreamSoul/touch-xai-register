"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Input,
  LayerCard,
  Select,
  Switch,
  Tabs,
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

const MASTER_PAGE_SIZE = 8;

type TabKey = "role" | "masters" | "policy" | "runtime";

function parseMasterList(raw: string): string[] {
  return raw
    .split(/[\n,;]+/)
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

function joinMasters(list: string[]): string {
  return list.join("\n");
}

function CardSaveBar({
  dirty,
  busy,
  onSave,
  label = "保存此卡片",
}: {
  dirty: boolean;
  busy: boolean;
  onSave: () => void;
  label?: string;
}) {
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-kumo-hairline pt-3">
      <div>
        {dirty ? (
          <Badge variant="primary">未保存</Badge>
        ) : (
          <Badge variant="secondary">已保存</Badge>
        )}
      </div>
      <Button
        size="lg"
        loading={busy}
        disabled={!dirty && !busy}
        onClick={onSave}
        className="!h-11 !min-w-[140px] !px-6 !text-base !font-semibold"
      >
        {label}
      </Button>
    </div>
  );
}

export default function ClusterPage() {
  const [cluster, setCluster] = useState<ClusterStatus | null>(null);
  const [tab, setTab] = useState<TabKey>("role");

  const [role, setRole] = useState("standalone");
  const [nodeName, setNodeName] = useState("");
  const [masters, setMasters] = useState<string[]>([]);
  const [newMaster, setNewMaster] = useState("");
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [editURL, setEditURL] = useState("");
  const [masterPage, setMasterPage] = useState(1);

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

  const [saved, setSaved] = useState({
    role: "",
    nodeName: "",
    masters: "",
    poolTarget: "",
    assignMin: "",
    assignMax: "",
    heartbeat: "",
    autoRegister: true,
    autoUpload: true,
    sharePoolList: false,
    sharePoolPull: false,
  });

  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [pubInfo, setPubInfo] = useState("");

  const dirtyRole =
    role !== saved.role ||
    nodeName !== saved.nodeName ||
    publicToken.trim().length > 0 ||
    statusPassword.length > 0;
  const dirtyMasters = joinMasters(masters) !== saved.masters;
  const dirtyPolicy =
    poolTarget !== saved.poolTarget ||
    assignMin !== saved.assignMin ||
    assignMax !== saved.assignMax ||
    heartbeat !== saved.heartbeat ||
    autoRegister !== saved.autoRegister ||
    autoUpload !== saved.autoUpload ||
    sharePoolList !== saved.sharePoolList ||
    sharePoolPull !== saved.sharePoolPull;
  const anyDirty = dirtyRole || dirtyMasters || dirtyPolicy;

  async function load() {
    const [cl, cfg] = await Promise.all([
      api<{ cluster: ClusterStatus }>("/api/cluster/status"),
      api<{ config: PanelConfig }>("/api/config"),
    ]);
    setCluster(cl.cluster);
    const c = cfg.config;
    const nextRole = String(c.cluster_role || "standalone");
    const nextName = String(c.cluster_node_name || "");
    const urls =
      String(c.cluster_master_urls || "") ||
      String(c.cluster_master_url || "");
    const nextMasters = parseMasterList(urls);
    const nextPool = String(c.cluster_pool_target ?? 50);
    const nextMin = String(c.cluster_assign_min ?? 1);
    const nextMax = String(c.cluster_assign_max ?? 10);
    const nextHb = String(c.cluster_heartbeat_sec ?? 15);
    const nextAR = c.cluster_auto_register !== false;
    const nextAU = c.cluster_auto_upload !== false;
    const nextSL = c.cluster_share_pool_list === true;
    const nextSP = c.cluster_share_pool_pull === true;

    setRole(nextRole);
    setNodeName(nextName);
    setMasters(nextMasters);
    setPoolTarget(nextPool);
    setAssignMin(nextMin);
    setAssignMax(nextMax);
    setHeartbeat(nextHb);
    setAutoRegister(nextAR);
    setAutoUpload(nextAU);
    setSharePoolList(nextSL);
    setSharePoolPull(nextSP);
    setPublicToken("");
    setStatusPassword("");
    setSaved({
      role: nextRole,
      nodeName: nextName,
      masters: joinMasters(nextMasters),
      poolTarget: nextPool,
      assignMin: nextMin,
      assignMax: nextMax,
      heartbeat: nextHb,
      autoRegister: nextAR,
      autoUpload: nextAU,
      sharePoolList: nextSL,
      sharePoolPull: nextSP,
    });
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

  // when role changes, jump to relevant tab
  useEffect(() => {
    if (role === "slave" && tab === "policy") {
      // keep
    }
  }, [role, tab]);

  async function savePatch(body: Record<string, string | number | boolean>) {
    setBusy(true);
    setMsg("");
    try {
      await api("/api/config", { method: "PUT", body: JSON.stringify(body) });
      setMsg("已保存");
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function saveRoleCard() {
    const body: Record<string, string | number | boolean> = {
      cluster_role: role,
      cluster_node_name: nodeName,
    };
    if (publicToken.trim()) body.cluster_public_token = publicToken.trim();
    if (statusPassword.length > 0) {
      body.cluster_status_password = statusPassword;
    }
    await savePatch(body);
  }

  async function saveMastersCard() {
    const list = masters.map((u) => u.replace(/\/$/, "")).filter(Boolean);
    const body: Record<string, string | number | boolean> = {
      cluster_master_urls: joinMasters(list),
    };
    if (list[0]) body.cluster_master_url = list[0];
    else body.cluster_master_url = "";
    await savePatch(body);
  }

  async function savePolicyCard() {
    await savePatch({
      cluster_pool_target: parseInt(poolTarget, 10) || 0,
      cluster_assign_min: parseInt(assignMin, 10) || 1,
      cluster_assign_max: parseInt(assignMax, 10) || 10,
      cluster_heartbeat_sec: parseInt(heartbeat, 10) || 15,
      cluster_auto_register: autoRegister,
      cluster_auto_upload: autoUpload,
      cluster_share_pool_list: sharePoolList,
      cluster_share_pool_pull: sharePoolPull,
    });
  }

  async function saveAll() {
    setBusy(true);
    setMsg("");
    try {
      const list = masters.map((u) => u.replace(/\/$/, "")).filter(Boolean);
      const body: Record<string, string | number | boolean> = {
        cluster_role: role,
        cluster_node_name: nodeName,
        cluster_master_urls: joinMasters(list),
        cluster_pool_target: parseInt(poolTarget, 10) || 0,
        cluster_assign_min: parseInt(assignMin, 10) || 1,
        cluster_assign_max: parseInt(assignMax, 10) || 10,
        cluster_heartbeat_sec: parseInt(heartbeat, 10) || 15,
        cluster_auto_register: autoRegister,
        cluster_auto_upload: autoUpload,
        cluster_share_pool_list: sharePoolList,
        cluster_share_pool_pull: sharePoolPull,
      };
      if (list[0]) body.cluster_master_url = list[0];
      else body.cluster_master_url = "";
      if (publicToken.trim()) body.cluster_public_token = publicToken.trim();
      if (statusPassword.length > 0) {
        body.cluster_status_password = statusPassword;
      }
      await api("/api/config", { method: "PUT", body: JSON.stringify(body) });
      setMsg("已保存全部配置");
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
      const d: unknown = await fetch("/api/federation/info").then((r) =>
        r.json(),
      );
      setPubInfo(JSON.stringify(d, null, 2));
    } catch (e) {
      setPubInfo(e instanceof Error ? e.message : "probe failed");
    }
  }

  function addMaster() {
    const u = newMaster.trim().replace(/\/$/, "");
    if (!u) return;
    if (masters.includes(u)) {
      setMsg("该主节点 URL 已存在");
      return;
    }
    setMasters((prev) => [u, ...prev]);
    setNewMaster("");
    setMasterPage(1);
  }

  function removeMaster(i: number) {
    setMasters((prev) => prev.filter((_, idx) => idx !== i));
    if (editIdx === i) {
      setEditIdx(null);
      setEditURL("");
    }
  }

  function startEdit(i: number) {
    setEditIdx(i);
    setEditURL(masters[i] || "");
  }

  function commitEdit() {
    if (editIdx == null) return;
    const u = editURL.trim().replace(/\/$/, "");
    if (!u) return;
    setMasters((prev) =>
      prev.map((m, i) => (i === editIdx ? u : m)).filter((m, i, arr) => arr.indexOf(m) === i),
    );
    setEditIdx(null);
    setEditURL("");
  }

  const masterTotalPages = Math.max(
    1,
    Math.ceil(masters.length / MASTER_PAGE_SIZE) || 1,
  );
  const masterSlice = masters.slice(
    (masterPage - 1) * MASTER_PAGE_SIZE,
    masterPage * MASTER_PAGE_SIZE,
  );

  const links = cluster?.master_links || [];

  const tabItems = useMemo(() => {
    const items: { value: string; label: string }[] = [
      { value: "role", label: dirtyRole ? "角色 ·" : "角色" },
    ];
    if (role === "slave") {
      items.push({
        value: "masters",
        label: dirtyMasters
          ? `主节点 (${masters.length}) ·`
          : `主节点 (${masters.length})`,
      });
    }
    if (role === "master" || role === "slave") {
      items.push({
        value: "policy",
        label: dirtyPolicy
          ? role === "master"
            ? "主策略 ·"
            : "从行为 ·"
          : role === "master"
            ? "主策略"
            : "从行为",
      });
    }
    items.push({ value: "runtime", label: "运行态" });
    return items;
  }, [role, masters.length, dirtyRole, dirtyMasters, dirtyPolicy]);

  // if current tab not in list (role switch), reset
  useEffect(() => {
    if (!tabItems.some((t) => t.value === tab)) {
      setTab("role");
    }
  }, [tabItems, tab]);

  return (
    <AdminShell>
      <PageHeader
        title="主从调度"
        description="按角色显示设置 · 主节点 URL 表格 CRUD · 每卡可单独保存"
        actions={
          <>
            {anyDirty ? <Badge variant="primary">有未保存</Badge> : null}
            <Button
              size="lg"
              loading={busy}
              onClick={() => void saveAll()}
              className="!h-11 !min-w-[140px] !px-5 !text-base !font-semibold"
            >
              {anyDirty ? "保存全部" : "已全部保存"}
            </Button>
          </>
        }
      />

      {anyDirty ? (
        <div className="mb-3 rounded-md border border-amber-400/50 bg-amber-500/10 px-3 py-2">
          <Text size="sm">
            有未保存更改
            {dirtyRole ? " · 角色" : ""}
            {dirtyMasters ? " · 主节点列表" : ""}
            {dirtyPolicy ? " · 策略" : ""}
            。可点各卡片「保存此卡片」，或右上角「保存全部」。
          </Text>
        </div>
      ) : null}
      {msg ? (
        <div className="mb-3 rounded-md bg-kumo-contrast/5 px-3 py-2">
          <Text>{msg}</Text>
        </div>
      ) : null}

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

      <div className="mb-4">
        <Tabs
          variant="segmented"
          tabs={tabItems}
          value={tab}
          onValueChange={(v) => {
            if (!v) return;
            setTab(v as TabKey);
          }}
        />
      </div>

      {tab === "role" ? (
        <LayerCard>
          <LayerCard.Secondary>角色与安全</LayerCard.Secondary>
          <LayerCard.Primary>
            <div className="flex flex-col gap-3 sm:max-w-xl">
              <Select
                label="角色"
                value={role}
                onValueChange={(v) => {
                  if (!v) return;
                  setRole(String(v));
                }}
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
                label="联邦密钥（主从一致，可选）"
                type="password"
                value={publicToken}
                onChange={(e) => setPublicToken(e.target.value)}
                placeholder={
                  cluster?.public_token_set ? "已设置 · 留空不改" : "可选"
                }
              />
              <Input
                label="状态页密码（与联邦密钥独立）"
                type="password"
                value={statusPassword}
                onChange={(e) => setStatusPassword(e.target.value)}
                placeholder={
                  cluster?.status_password_set
                    ? "已设置 · 留空不改"
                    : "可选，空=公开"
                }
              />
              <Text size="xs" variant="secondary">
                切换为「从节点」后会出现主节点 URL 表格；「主节点」显示调度策略与分享权限。
              </Text>
            </div>
            <CardSaveBar
              dirty={dirtyRole}
              busy={busy}
              onSave={() => void saveRoleCard()}
            />
          </LayerCard.Primary>
        </LayerCard>
      ) : null}

      {tab === "masters" && role === "slave" ? (
        <LayerCard>
          <LayerCard.Secondary>
            主节点 URL 列表{" "}
            <Badge variant="secondary">{masters.length} 条</Badge>
          </LayerCard.Secondary>
          <LayerCard.Primary>
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="min-w-0 flex-1">
                <Input
                  label="新增主节点 URL"
                  value={newMaster}
                  onChange={(e) => setNewMaster(e.target.value)}
                  placeholder="https://master.example.com"
                />
              </div>
              <Button size="lg" onClick={addMaster} className="!h-11 !px-5">
                添加
              </Button>
            </div>

            {masters.length === 0 ? (
              <Text variant="secondary">暂无主节点 — 添加后可分页管理</Text>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="grid grid-cols-[1fr_auto] gap-2 border-b border-kumo-hairline pb-2">
                  <Text size="xs" variant="secondary">
                    URL
                  </Text>
                  <Text size="xs" variant="secondary">
                    操作
                  </Text>
                </div>
                {masterSlice.map((url, localIdx) => {
                  const i = (masterPage - 1) * MASTER_PAGE_SIZE + localIdx;
                  const link = links.find((l) => l.url.replace(/\/$/, "") === url);
                  return (
                    <div
                      key={`${url}-${i}`}
                      className="grid grid-cols-[1fr_auto] items-center gap-2 border-b border-kumo-hairline py-2 last:border-0"
                    >
                      <div className="min-w-0">
                        {editIdx === i ? (
                          <Input
                            value={editURL}
                            onChange={(e) => setEditURL(e.target.value)}
                          />
                        ) : (
                          <>
                            <Text size="sm">
                              <code className="break-all">{url}</code>{" "}
                              {link ? (
                                <Badge variant={link.ok ? "primary" : "secondary"}>
                                  {link.ok ? "心跳 ok" : "down"}
                                </Badge>
                              ) : (
                                <Badge variant="secondary">未心跳</Badge>
                              )}
                            </Text>
                            {link ? (
                              <Text size="xs" variant="secondary">
                                {link.master_name || ""} need {link.need} · assign{" "}
                                {link.last_assign}
                                {link.last_error ? ` · ${link.last_error}` : ""}
                              </Text>
                            ) : null}
                          </>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {editIdx === i ? (
                          <>
                            <Button size="sm" onClick={commitEdit}>
                              确定
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => {
                                setEditIdx(null);
                                setEditURL("");
                              }}
                            >
                              取消
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => startEdit(i)}
                            >
                              编辑
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => removeMaster(i)}
                            >
                              删除
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {masters.length > MASTER_PAGE_SIZE ? (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <Text size="xs" variant="secondary">
                  第 {masterPage}/{masterTotalPages} 页 · 共 {masters.length}
                </Text>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={masterPage <= 1}
                    onClick={() => setMasterPage((p) => Math.max(1, p - 1))}
                  >
                    上一页
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={masterPage >= masterTotalPages}
                    onClick={() =>
                      setMasterPage((p) => Math.min(masterTotalPages, p + 1))
                    }
                  >
                    下一页
                  </Button>
                </div>
              </div>
            ) : null}

            <CardSaveBar
              dirty={dirtyMasters}
              busy={busy}
              onSave={() => void saveMastersCard()}
              label="保存主节点列表"
            />
          </LayerCard.Primary>
        </LayerCard>
      ) : null}

      {tab === "policy" && (role === "master" || role === "slave") ? (
        <LayerCard>
          <LayerCard.Secondary>
            {role === "master" ? "主节点策略 / 分享" : "从节点行为"}
          </LayerCard.Secondary>
          <LayerCard.Primary>
            <div className="flex flex-col gap-3 sm:max-w-xl">
              {role === "master" ? (
                <>
                  <Input
                    label="号池维持数量"
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
                  <Switch
                    label="允许联邦查看号池列表"
                    checked={sharePoolList}
                    onCheckedChange={(v) => {
                      const on = !!v;
                      setSharePoolList(on);
                      if (!on) setSharePoolPull(false);
                    }}
                  />
                  <Switch
                    label="允许联邦拉取/下载凭证"
                    checked={sharePoolPull}
                    onCheckedChange={(v) => {
                      const on = !!v;
                      setSharePoolPull(on);
                      if (on) setSharePoolList(true);
                    }}
                  />
                  <Text size="xs" variant="secondary">
                    分享开关仅主节点生效：列表元数据 / 拉取 JSON 凭证。
                  </Text>
                </>
              ) : (
                <>
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
                </>
              )}
            </div>
            <CardSaveBar
              dirty={dirtyPolicy}
              busy={busy}
              onSave={() => void savePolicyCard()}
            />
          </LayerCard.Primary>
        </LayerCard>
      ) : null}

      {tab === "runtime" ? (
        <div className="flex flex-col gap-4">
          {role === "slave" || cluster?.role === "slave" ? (
            <LayerCard>
              <LayerCard.Secondary>
                主节点心跳{" "}
                {cluster?.slave_connected ? (
                  <Badge variant="primary">至少一个在线</Badge>
                ) : (
                  <Badge variant="secondary">未连接</Badge>
                )}
              </LayerCard.Secondary>
              <LayerCard.Primary>
                {links.length === 0 ? (
                  <Text variant="secondary">
                    尚未心跳
                    {cluster?.slave_last_error
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
                          </Text>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </LayerCard.Primary>
            </LayerCard>
          ) : null}

          {role === "master" || cluster?.role === "master" ? (
            <LayerCard>
              <LayerCard.Secondary>已连接从节点</LayerCard.Secondary>
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
                            </Badge>
                          </Text>
                          <Text size="xs" variant="secondary">
                            id {n.id.slice(0, 12)}… · 分配 {n.assigned} · 完成{" "}
                            {n.completed_total}
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
          ) : null}

          <LayerCard>
            <LayerCard.Secondary>
              联邦 info{" "}
              <Button size="sm" variant="ghost" onClick={() => void probePublic()}>
                探测
              </Button>
            </LayerCard.Secondary>
            <LayerCard.Primary>
              <pre className="max-h-64 overflow-auto text-xs">
                {pubInfo || "主从通信用；状态页请用 /status/"}
              </pre>
            </LayerCard.Primary>
          </LayerCard>
        </div>
      ) : null}
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
