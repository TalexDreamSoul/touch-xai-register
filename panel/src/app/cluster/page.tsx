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

type MasterRow = {
  url: string;
  token: string; // draft token; empty means keep existing / use global
  tokenSet: boolean; // server had a per-master token
};

type MasterEndpointView = {
  url?: string;
  token_set?: boolean;
};

function CardSaveBar({
  dirty,
  busy,
  onSave,
  label = "保存",
}: {
  dirty: boolean;
  busy: boolean;
  onSave: () => void;
  label?: string;
}) {
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-kumo-hairline pt-3">
      {dirty ? (
        <Badge variant="primary">未保存</Badge>
      ) : (
        <Badge variant="secondary">已保存</Badge>
      )}
      <Button size="sm" loading={busy} disabled={!dirty && !busy} onClick={onSave}>
        {label}
      </Button>
    </div>
  );
}

function parseLegacyMasters(raw: string): MasterRow[] {
  return raw
    .split(/[\n,;]+/)
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean)
    .map((url) => ({ url, token: "", tokenSet: false }));
}

function serializeMasters(rows: MasterRow[]): string {
  // Persist as JSON so per-master tokens survive
  const payload = rows
    .map((r) => ({
      url: r.url.replace(/\/$/, ""),
      token: r.token.trim(),
    }))
    .filter((r) => r.url);
  // If no tokens at all, still use JSON for stable round-trip
  return JSON.stringify(payload);
}

function mastersFingerprint(rows: MasterRow[]): string {
  return JSON.stringify(
    rows.map((r) => ({
      url: r.url.replace(/\/$/, ""),
      token: r.token,
      tokenSet: r.tokenSet,
    })),
  );
}

export default function ClusterPage() {
  const [cluster, setCluster] = useState<ClusterStatus | null>(null);
  const [tab, setTab] = useState<TabKey>("role");

  const [role, setRole] = useState("standalone");
  const [nodeName, setNodeName] = useState("");
  const [masters, setMasters] = useState<MasterRow[]>([]);
  const [newMasterURL, setNewMasterURL] = useState("");
  const [newMasterToken, setNewMasterToken] = useState("");
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [editURL, setEditURL] = useState("");
  const [editToken, setEditToken] = useState("");
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
  const dirtyMasters = mastersFingerprint(masters) !== saved.masters;
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
      api<{ config: PanelConfig & { cluster_master_endpoints?: MasterEndpointView[] } }>(
        "/api/config",
      ),
    ]);
    setCluster(cl.cluster);
    const c = cfg.config;
    const nextRole = String(c.cluster_role || "standalone");
    const nextName = String(c.cluster_node_name || "");

    let nextMasters: MasterRow[] = [];
    const eps = c.cluster_master_endpoints;
    if (Array.isArray(eps) && eps.length > 0) {
      nextMasters = eps
        .map((e) => ({
          url: String(e.url || "").replace(/\/$/, ""),
          token: "",
          tokenSet: !!e.token_set,
        }))
        .filter((e) => e.url);
    } else {
      const urls =
        String(c.cluster_master_urls || "") ||
        String(c.cluster_master_url || "");
      nextMasters = parseLegacyMasters(urls);
    }

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
    setEditIdx(null);
    setEditURL("");
    setEditToken("");
    setSaved({
      role: nextRole,
      nodeName: nextName,
      masters: mastersFingerprint(nextMasters),
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
    // Blank token → server keeps previous per-URL secret (or falls back to global).
    const body: Record<string, string | number | boolean> = {
      cluster_master_urls: serializeMasters(masters),
    };
    if (masters[0]) body.cluster_master_url = masters[0].url.replace(/\/$/, "");
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
      const body: Record<string, string | number | boolean> = {
        cluster_role: role,
        cluster_node_name: nodeName,
        cluster_master_urls: serializeMasters(masters),
        cluster_pool_target: parseInt(poolTarget, 10) || 0,
        cluster_assign_min: parseInt(assignMin, 10) || 1,
        cluster_assign_max: parseInt(assignMax, 10) || 10,
        cluster_heartbeat_sec: parseInt(heartbeat, 10) || 15,
        cluster_auto_register: autoRegister,
        cluster_auto_upload: autoUpload,
        cluster_share_pool_list: sharePoolList,
        cluster_share_pool_pull: sharePoolPull,
      };
      if (masters[0]) body.cluster_master_url = masters[0].url.replace(/\/$/, "");
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
    const u = newMasterURL.trim().replace(/\/$/, "");
    if (!u) return;
    if (masters.some((m) => m.url === u)) {
      setMsg("该主节点 URL 已存在");
      return;
    }
    setMasters((prev) => [
      {
        url: u,
        token: newMasterToken.trim(),
        tokenSet: !!newMasterToken.trim(),
      },
      ...prev,
    ]);
    setNewMasterURL("");
    setNewMasterToken("");
    setMasterPage(1);
  }

  function removeMaster(i: number) {
    setMasters((prev) => prev.filter((_, idx) => idx !== i));
    if (editIdx === i) {
      setEditIdx(null);
      setEditURL("");
      setEditToken("");
    }
  }

  function startEdit(i: number) {
    setEditIdx(i);
    setEditURL(masters[i]?.url || "");
    setEditToken(""); // re-enter to change; blank keeps
  }

  function commitEdit() {
    if (editIdx == null) return;
    const u = editURL.trim().replace(/\/$/, "");
    if (!u) return;
    setMasters((prev) => {
      const next = prev.map((m, i) => {
        if (i !== editIdx) return m;
        return {
          url: u,
          token: editToken.trim() ? editToken.trim() : m.token,
          tokenSet: editToken.trim() ? true : m.tokenSet,
        };
      });
      // dedupe by url keep first
      const seen = new Set<string>();
      return next.filter((m) => {
        if (seen.has(m.url)) return false;
        seen.add(m.url);
        return true;
      });
    });
    setEditIdx(null);
    setEditURL("");
    setEditToken("");
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

  useEffect(() => {
    if (!tabItems.some((t) => t.value === tab)) {
      setTab("role");
    }
  }, [tabItems, tab]);

  return (
    <AdminShell>
      <PageHeader
        title="主从调度"
        description="按角色显示设置 · 主节点 URL+密码 · 分卡保存"
        actions={
          <>
            {anyDirty ? <Badge variant="primary">有未保存</Badge> : null}
            <Button size="sm" loading={busy} onClick={() => void saveAll()}>
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
            。可用各卡片「保存」，或右上角「保存全部」。
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
                label="全局联邦密钥（默认，主从一致）"
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
                从节点可在「主节点」表为每个主单独设置密码；留空则用全局联邦密钥。
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
            主节点列表 <Badge variant="secondary">{masters.length} 条</Badge>
          </LayerCard.Secondary>
          <LayerCard.Primary>
            <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <Input
                label="主节点 URL"
                value={newMasterURL}
                onChange={(e) => setNewMasterURL(e.target.value)}
                placeholder="https://master.example.com"
              />
              <Input
                label="密码 / 联邦密钥（可选）"
                type="password"
                value={newMasterToken}
                onChange={(e) => setNewMasterToken(e.target.value)}
                placeholder="空=用全局密钥"
              />
              <Button size="sm" onClick={addMaster}>
                添加
              </Button>
            </div>

            {masters.length === 0 ? (
              <Text variant="secondary">暂无主节点 — 填写 URL 与可选密码后添加</Text>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="grid grid-cols-[1.2fr_1fr_auto] gap-2 border-b border-kumo-hairline pb-2">
                  <Text size="xs" variant="secondary">
                    URL
                  </Text>
                  <Text size="xs" variant="secondary">
                    密码
                  </Text>
                  <Text size="xs" variant="secondary">
                    操作
                  </Text>
                </div>
                {masterSlice.map((row, localIdx) => {
                  const i = (masterPage - 1) * MASTER_PAGE_SIZE + localIdx;
                  const link = links.find(
                    (l) => l.url.replace(/\/$/, "") === row.url,
                  );
                  return (
                    <div
                      key={`${row.url}-${i}`}
                      className="grid grid-cols-[1.2fr_1fr_auto] items-start gap-2 border-b border-kumo-hairline py-2 last:border-0"
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
                              <code className="break-all">{row.url}</code>{" "}
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
                              </Text>
                            ) : null}
                          </>
                        )}
                      </div>
                      <div className="min-w-0">
                        {editIdx === i ? (
                          <Input
                            type="password"
                            value={editToken}
                            onChange={(e) => setEditToken(e.target.value)}
                            placeholder={
                              row.tokenSet || row.token
                                ? "已设置 · 留空保持"
                                : "空=全局密钥"
                            }
                          />
                        ) : (
                          <Text size="sm">
                            {row.token ? (
                              <Badge variant="primary">本次将更新</Badge>
                            ) : row.tokenSet ? (
                              <Badge variant="secondary">已设置</Badge>
                            ) : (
                              <Badge variant="secondary">用全局</Badge>
                            )}
                          </Text>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-1">
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
                                setEditToken("");
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
