"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Input,
  LayerCard,
  Select,
  Tabs,
  Text,
} from "@cloudflare/kumo";
import { AdminShell } from "@/components/admin-shell";
import { PageHeader } from "@/components/page-header";
import { api, getToken, type ClusterStatus } from "@/lib/api";

type LocalPoolItem = {
  name: string;
  email?: string;
  source_run?: string;
  size: number;
  added_at: string;
  synced_at?: string;
  sync_error?: string;
};

type CloudPoolItem = {
  name: string;
  provider?: string;
  type?: string;
  status?: string;
  status_message?: string;
  email?: string;
  disabled?: boolean;
  size?: number;
  success?: number;
  failed?: number;
};

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
    last?: {
      scanned?: number;
      quota_hits?: number;
      deleted?: number;
      would_delete?: number;
    };
  };
};

type PoolSource = "local" | "cloud" | "federation";
type TabKey = "list" | "patrol";

const PAGE_SIZE = 10;

function Pager({
  page,
  totalPages,
  total,
  label,
  onChange,
}: {
  page: number;
  totalPages: number;
  total: number;
  label: string;
  onChange: (p: number) => void;
}) {
  if (total <= 0) return null;
  const pages = Math.max(1, totalPages);
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-kumo-hairline pt-3">
      <Text size="xs" variant="secondary">
        {label} · 共 {total} · 第 {page}/{pages} 页
      </Text>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => onChange(1)}>
          首页
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
        >
          上一页
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={page >= pages}
          onClick={() => onChange(page + 1)}
        >
          下一页
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={page >= pages}
          onClick={() => onChange(pages)}
        >
          末页
        </Button>
      </div>
    </div>
  );
}

export default function PoolPage() {
  const [tab, setTab] = useState<TabKey>("list");
  const [poolSource, setPoolSource] = useState<PoolSource>("local");
  const [masterURL, setMasterURL] = useState("");
  const [masters, setMasters] = useState<string[]>([]);
  const [localItems, setLocalItems] = useState<LocalPoolItem[]>([]);
  const [cloudItems, setCloudItems] = useState<CloudPoolItem[]>([]);
  const [poolTotal, setPoolTotal] = useState(0);
  const [poolTotalPages, setPoolTotalPages] = useState(0);
  const [poolPage, setPoolPage] = useState(1);
  const [poolUnsynced, setPoolUnsynced] = useState(0);
  const [fedCanPull, setFedCanPull] = useState(false);
  const [fedShareList, setFedShareList] = useState(true);
  const [poolError, setPoolError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const [ov, setOv] = useState<Overview | null>(null);
  const [patrolLogs, setPatrolLogs] = useState("");

  const refreshMasters = useCallback(async () => {
    try {
      const [cfg, cl] = await Promise.all([
        api<{ config?: Record<string, unknown> }>("/api/config").catch(() => ({
          config: {} as Record<string, unknown>,
        })),
        api<{ cluster?: ClusterStatus }>("/api/cluster/status").catch(() => ({
          cluster: undefined,
        })),
      ]);
      const conf = cfg.config || {};
      const masterList =
        cl.cluster?.masters?.filter(Boolean) ||
        String(conf.cluster_master_urls || conf.cluster_master_url || "")
          .split(/[\n,;\s]+/)
          .map((s) => s.trim().replace(/\/$/, ""))
          .filter(Boolean);
      setMasters(masterList);
      setMasterURL((prev) => prev || masterList[0] || "");
    } catch {
      /* ignore */
    }
  }, []);

  const refreshPool = useCallback(
    async (page: number, source: PoolSource, master: string) => {
      setPoolError("");
      try {
        if (source === "local") {
          const lp = await api<{
            items?: LocalPoolItem[];
            total?: number;
            unsynced?: number;
            total_pages?: number;
          }>(`/api/pool/list?source=local&page=${page}&limit=${PAGE_SIZE}`);
          setLocalItems(lp.items || []);
          setCloudItems([]);
          setPoolTotal(lp.total || 0);
          setPoolUnsynced(lp.unsynced || 0);
          setPoolTotalPages(lp.total_pages || 0);
          setFedCanPull(false);
          setFedShareList(true);
          return;
        }
        if (source === "cloud") {
          const cp = await api<{
            files?: CloudPoolItem[];
            total?: number;
            total_pages?: number;
            can_pull?: boolean;
          }>(`/api/pool/list?source=cloud&page=${page}&limit=${PAGE_SIZE}`);
          setCloudItems(cp.files || []);
          setLocalItems([]);
          setPoolTotal(cp.total || 0);
          setPoolTotalPages(cp.total_pages || 0);
          setPoolUnsynced(0);
          setFedCanPull(cp.can_pull !== false);
          setFedShareList(true);
          return;
        }
        if (!master) {
          setLocalItems([]);
          setCloudItems([]);
          setPoolTotal(0);
          setPoolTotalPages(0);
          setPoolError("请选择联邦主节点");
          return;
        }
        const fp = await api<{
          files?: CloudPoolItem[];
          total?: number;
          total_pages?: number;
          share_pool_list?: boolean;
          share_pool_pull?: boolean;
        }>(
          `/api/pool/list?source=federation&master=${encodeURIComponent(master)}&page=${page}&limit=${PAGE_SIZE}`,
        );
        setCloudItems(fp.files || []);
        setLocalItems([]);
        setPoolTotal(fp.total || 0);
        setPoolTotalPages(fp.total_pages || 0);
        setPoolUnsynced(0);
        setFedShareList(fp.share_pool_list !== false);
        setFedCanPull(!!fp.share_pool_pull);
      } catch (e) {
        setLocalItems([]);
        setCloudItems([]);
        setPoolTotal(0);
        setPoolTotalPages(0);
        setPoolError(e instanceof Error ? e.message : "加载号池失败");
      }
    },
    [],
  );

  const loadPatrol = useCallback(async () => {
    const [o, l] = await Promise.all([
      api<Overview>("/api/pool/overview"),
      api<{ text?: string; lines?: string[] }>("/api/pool/logs?tail=200"),
    ]);
    setOv(o);
    setPatrolLogs(l.text || (l.lines || []).join("\n"));
  }, []);

  useEffect(() => {
    void refreshMasters();
  }, [refreshMasters]);

  useEffect(() => {
    if (tab !== "list") return;
    void refreshPool(poolPage, poolSource, masterURL);
  }, [tab, poolPage, poolSource, masterURL, refreshPool]);

  useEffect(() => {
    if (tab !== "patrol") return;
    void loadPatrol().catch((e: unknown) =>
      setMsg(e instanceof Error ? e.message : "加载巡检失败"),
    );
  }, [tab, loadPatrol]);

  async function syncLocal() {
    setBusy(true);
    try {
      const d = await api<{ synced?: number; failed?: number; total?: number }>(
        "/api/local-pool/sync",
        { method: "POST", body: JSON.stringify({ all: false }) },
      );
      setMsg(
        `同步完成：成功 ${d.synced ?? 0} / 失败 ${d.failed ?? 0}（共 ${d.total ?? 0}）`,
      );
      await refreshPool(poolPage, "local", masterURL);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "同步失败");
    } finally {
      setBusy(false);
    }
  }

  async function importLatest() {
    setBusy(true);
    try {
      const d = await api<{ added?: number; run_id?: string }>(
        "/api/local-pool/import",
        { method: "POST", body: JSON.stringify({}) },
      );
      setMsg(`已入库 ${d.added ?? 0} 个（run ${d.run_id || "latest"}）`);
      setPoolSource("local");
      setPoolPage(1);
      await refreshPool(1, "local", masterURL);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "入库失败");
    } finally {
      setBusy(false);
    }
  }

  async function patrol(mode: "light" | "deep") {
    setBusy(true);
    try {
      await api("/api/pool/patrol", {
        method: "POST",
        body: JSON.stringify({ mode }),
      });
      setMsg(`${mode} 巡检已触发`);
      setTimeout(() => void loadPatrol(), 1500);
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
      await loadPatrol();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "清理失败");
    } finally {
      setBusy(false);
    }
  }

  function pullCredential(name: string) {
    const tok = getToken();
    const params = new URLSearchParams();
    if (poolSource === "federation") {
      params.set("source", "federation");
      params.set("master", masterURL);
    } else {
      params.set("source", "cloud");
    }
    params.set("name", name);
    if (tok) params.set("token", tok);
    window.open(`/api/pool/pull?${params.toString()}`, "_blank");
  }

  const tabItems = useMemo(
    () => [
      { value: "list", label: `凭证列表${poolTotal ? ` (${poolTotal})` : ""}` },
      { value: "patrol", label: "巡检运维" },
    ],
    [poolTotal],
  );

  const o = ov?.overview;
  const c = ov?.cleanup;

  return (
    <AdminShell>
      <PageHeader
        title="号池"
        description="本地 · 云端 CPA · 联邦主节点 · 巡检"
        actions={
          tab === "list" ? (
            <>
              <Button
                size="sm"
                variant="secondary"
                loading={busy}
                onClick={() => void importLatest()}
              >
                入库最新注册结果
              </Button>
              {poolSource === "local" ? (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy}
                  onClick={() => void syncLocal()}
                >
                  同步未上传到云端
                </Button>
              ) : null}
            </>
          ) : (
            <>
              <Button
                size="sm"
                variant="secondary"
                loading={busy}
                onClick={() => void patrol("light")}
              >
                轻检
              </Button>
              <Button
                size="sm"
                variant="secondary"
                loading={busy}
                onClick={() => void patrol("deep")}
              >
                深检
              </Button>
              <Button size="sm" loading={busy} onClick={() => void cleanup()}>
                清理耗尽
              </Button>
            </>
          )
        }
      />

      {msg ? (
        <div className="mb-3 rounded-md bg-kumo-contrast/5 px-3 py-2">
          <Text>{msg}</Text>
        </div>
      ) : null}

      <div className="mb-3">
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

      {tab === "list" ? (
        <LayerCard>
          <LayerCard.Secondary>
            凭证{" "}
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void refreshPool(poolPage, poolSource, masterURL)}
            >
              刷新
            </Button>
          </LayerCard.Secondary>
          <LayerCard.Primary>
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
              <div className="min-w-[180px]">
                <Select
                  label="来源"
                  value={poolSource}
                  onValueChange={(v) => {
                    if (!v) return;
                    setPoolSource(v as PoolSource);
                    setPoolPage(1);
                  }}
                >
                  <Select.Option value="local">本地号池</Select.Option>
                  <Select.Option value="cloud">云端 CPA</Select.Option>
                  <Select.Option value="federation">联邦主节点</Select.Option>
                </Select>
              </div>
              {poolSource === "federation" ? (
                <div className="min-w-[260px] flex-1">
                  {masters.length > 0 ? (
                    <Select
                      label="联邦主节点"
                      value={masterURL}
                      onValueChange={(v) => {
                        if (!v) return;
                        setMasterURL(v);
                        setPoolPage(1);
                      }}
                    >
                      {masters.map((m) => (
                        <Select.Option key={m} value={m}>
                          {m}
                        </Select.Option>
                      ))}
                    </Select>
                  ) : (
                    <Input
                      label="联邦主节点 URL"
                      value={masterURL}
                      onChange={(e) => setMasterURL(e.target.value.trim())}
                      placeholder="https://master.example.com"
                    />
                  )}
                </div>
              ) : null}
            </div>

            {poolSource === "federation" ? (
              <div className="mb-3 flex flex-wrap gap-2">
                <Badge variant={fedShareList ? "primary" : "secondary"}>
                  {fedShareList ? "允许看列表" : "禁止看列表"}
                </Badge>
                <Badge variant={fedCanPull ? "primary" : "secondary"}>
                  {fedCanPull ? "允许拉取凭证" : "禁止拉取凭证"}
                </Badge>
                <Text size="xs" variant="secondary">
                  权限由主节点联邦配置控制
                </Text>
              </div>
            ) : null}

            {poolSource === "local" && poolUnsynced > 0 ? (
              <div className="mb-3">
                <Text size="xs" variant="secondary">
                  未同步到云端：{poolUnsynced}
                </Text>
              </div>
            ) : null}

            {poolError ? (
              <Text variant="secondary">{poolError}</Text>
            ) : poolSource === "local" ? (
              localItems.length === 0 ? (
                <Text variant="secondary">
                  本地号池为空 — 注册成功后入库，或点「入库最新注册结果」
                </Text>
              ) : (
                <div className="flex flex-col gap-3">
                  {localItems.map((p) => (
                    <div
                      key={p.name}
                      className="flex flex-wrap items-center justify-between gap-2 border-b border-kumo-hairline pb-2 last:border-0"
                    >
                      <div className="min-w-0">
                        <Text size="sm">
                          {p.email || p.name}{" "}
                          {p.synced_at ? (
                            <Badge variant="primary">已同步云端</Badge>
                          ) : (
                            <Badge variant="secondary">未同步</Badge>
                          )}
                        </Text>
                        <Text size="xs" variant="secondary">
                          {p.name}
                          {p.source_run ? ` · run ${p.source_run}` : ""}
                          {p.sync_error ? ` · ${p.sync_error}` : ""}
                        </Text>
                      </div>
                    </div>
                  ))}
                </div>
              )
            ) : cloudItems.length === 0 ? (
              <Text variant="secondary">
                {poolSource === "cloud"
                  ? "云端 CPA 暂无条目（检查 CPA_MANAGEMENT 配置）"
                  : "联邦主节点无列表或未授权"}
              </Text>
            ) : (
              <div className="flex flex-col gap-3">
                {cloudItems.map((p) => (
                  <div
                    key={p.name}
                    className="flex flex-wrap items-center justify-between gap-2 border-b border-kumo-hairline pb-2 last:border-0"
                  >
                    <div className="min-w-0">
                      <Text size="sm">
                        {p.email || p.name}{" "}
                        {p.disabled ? (
                          <Badge variant="secondary">disabled</Badge>
                        ) : (
                          <Badge variant="primary">{p.status || "active"}</Badge>
                        )}
                      </Text>
                      <Text size="xs" variant="secondary">
                        {p.name}
                        {p.provider ? ` · ${p.provider}` : ""}
                        {p.status_message ? ` · ${p.status_message}` : ""}
                      </Text>
                    </div>
                    {(poolSource === "cloud" || fedCanPull) && p.name ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => pullCredential(p.name)}
                      >
                        下载凭证
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>
            )}

            <Pager
              page={poolPage}
              totalPages={poolTotalPages}
              total={poolTotal}
              label={
                poolSource === "local"
                  ? "本地号池"
                  : poolSource === "cloud"
                    ? "云端 CPA"
                    : "联邦号池"
              }
              onChange={setPoolPage}
            />
          </LayerCard.Primary>
        </LayerCard>
      ) : (
        <>
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
                {patrolLogs || "（暂无）"}
              </pre>
            </LayerCard.Primary>
          </LayerCard>
        </>
      )}
    </AdminShell>
  );
}

function Stat({ label, value }: { label: string; value?: number }) {
  return (
    <LayerCard>
      <LayerCard.Secondary>{label}</LayerCard.Secondary>
      <LayerCard.Primary>
        <Text variant="heading3" as="h3">
          {value ?? "—"}
        </Text>
      </LayerCard.Primary>
    </LayerCard>
  );
}
