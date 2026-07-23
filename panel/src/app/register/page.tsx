"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
import {
  api,
  getToken,
  tokenQuery,
  type ClusterStatus,
  type RunStatus,
} from "@/lib/api";

type RunInfo = {
  id: string;
  cpa_count: number;
  sso_files: number;
  mod_time?: string;
};

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

type TabKey = "logs" | "results" | "pool";
type PoolSource = "local" | "cloud" | "federation";

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

export default function RegisterPage() {
  const [tab, setTab] = useState<TabKey>("logs");
  const [target, setTarget] = useState("10");
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [log, setLog] = useState("");
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [runsTotal, setRunsTotal] = useState(0);
  const [runsTotalPages, setRunsTotalPages] = useState(0);
  const [runsPage, setRunsPage] = useState(1);

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

  const [autoImport, setAutoImport] = useState(true);
  const [autoSync, setAutoSync] = useState(false);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const running = useMemo(
    () => String(status?.status || "").toLowerCase() === "running",
    [status],
  );

  const refreshCore = useCallback(async () => {
    try {
      const [st, lg, cfg, cl] = await Promise.all([
        api<{ status: RunStatus }>("/api/status"),
        api<{ log?: string }>("/api/logs?tail=300"),
        api<{ config?: Record<string, unknown> }>("/api/config").catch(() => ({
          config: {} as Record<string, unknown>,
        })),
        api<{ cluster?: ClusterStatus }>("/api/cluster/status").catch(() => ({
          cluster: undefined,
        })),
      ]);
      setStatus(st.status);
      setLog(lg.log || "");
      const conf = cfg.config || {};
      if (typeof conf.local_pool_auto_import === "boolean") {
        setAutoImport(conf.local_pool_auto_import);
      }
      if (typeof conf.local_pool_auto_sync === "boolean") {
        setAutoSync(conf.local_pool_auto_sync);
      }
      const masterList =
        cl.cluster?.masters?.filter(Boolean) ||
        String(conf.cluster_master_urls || conf.cluster_master_url || "")
          .split(/[\n,;\s]+/)
          .map((s) => s.trim().replace(/\/$/, ""))
          .filter(Boolean);
      setMasters(masterList);
      setMasterURL((prev) => prev || masterList[0] || "");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "刷新失败");
    }
  }, []);

  const refreshRuns = useCallback(async (page: number) => {
    try {
      const rs = await api<{
        runs?: RunInfo[];
        total?: number;
        page?: number;
        total_pages?: number;
      }>(`/api/runs?page=${page}&limit=${PAGE_SIZE}`);
      setRuns(rs.runs || []);
      setRunsTotal(rs.total || 0);
      setRunsTotalPages(rs.total_pages || 0);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "加载注册结果失败");
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
            error?: string;
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
        // federation
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
          error?: string;
          master_name?: string;
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

  useEffect(() => {
    void refreshCore();
    const t = setInterval(() => void refreshCore(), 3000);
    return () => clearInterval(t);
  }, [refreshCore]);

  useEffect(() => {
    if (tab !== "results") return;
    void refreshRuns(runsPage);
  }, [tab, runsPage, refreshRuns]);

  useEffect(() => {
    if (tab !== "pool") return;
    void refreshPool(poolPage, poolSource, masterURL);
  }, [tab, poolPage, poolSource, masterURL, refreshPool]);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      if (tab === "results") void refreshRuns(runsPage);
      if (tab === "pool" && poolSource === "local") {
        void refreshPool(poolPage, "local", masterURL);
      }
    }, 5000);
    return () => clearInterval(t);
  }, [running, tab, runsPage, poolPage, poolSource, masterURL, refreshRuns, refreshPool]);

  async function start() {
    setBusy(true);
    setMsg("");
    try {
      const n = Math.max(1, Math.min(10000, parseInt(target, 10) || 10));
      await api("/api/start", { method: "POST", body: JSON.stringify({ target: n }) });
      setMsg(`已启动 target=${n}`);
      setTab("logs");
      await refreshCore();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "启动失败");
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    try {
      await api("/api/stop", { method: "POST", body: "{}" });
      setMsg("已停止");
      try {
        await api("/api/local-pool/import", {
          method: "POST",
          body: JSON.stringify({}),
        });
      } catch {
        /* optional */
      }
      await refreshCore();
      setPoolPage(1);
      if (tab === "results") await refreshRuns(runsPage);
      if (tab === "pool") await refreshPool(1, poolSource, masterURL);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "停止失败");
    } finally {
      setBusy(false);
    }
  }

  async function savePoolFlags(nextImport: boolean, nextSync: boolean) {
    setAutoImport(nextImport);
    setAutoSync(nextSync);
    try {
      await api("/api/config", {
        method: "PUT",
        body: JSON.stringify({
          local_pool_auto_import: nextImport,
          local_pool_auto_sync: nextSync,
        }),
      });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "保存自动入库设置失败");
    }
  }

  async function importPool(runId?: string) {
    setBusy(true);
    try {
      const d = await api<{ added?: number; run_id?: string }>(
        "/api/local-pool/import",
        {
          method: "POST",
          body: JSON.stringify(runId ? { run_id: runId } : {}),
        },
      );
      setMsg(`已入库 ${d.added ?? 0} 个（run ${d.run_id || "latest"}）`);
      setPoolSource("local");
      setPoolPage(1);
      setTab("pool");
      await refreshPool(1, "local", masterURL);
      await refreshRuns(runsPage);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "入库失败");
    } finally {
      setBusy(false);
    }
  }

  async function syncPool() {
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
      { value: "logs", label: "日志" },
      { value: "results", label: `结果${runsTotal ? ` (${runsTotal})` : ""}` },
      { value: "pool", label: `号池${poolTotal ? ` (${poolTotal})` : ""}` },
    ],
    [runsTotal, poolTotal],
  );

  return (
    <AdminShell>
      <div
        className={
          running
            ? "rounded-xl ring-2 ring-emerald-400/70 shadow-[0_0_48px_rgba(16,185,129,0.35)] transition-shadow"
            : "transition-shadow"
        }
      >
        <PageHeader
          title="注册"
          description="启动流水线 · 日志 / 结果 / 号池"
          actions={
            running ? (
              <Badge variant="primary">运行中</Badge>
            ) : (
              <Badge variant="secondary">{status?.status || "stopped"}</Badge>
            )
          }
        />

        <LayerCard className="mb-4">
          <LayerCard.Secondary>控制台</LayerCard.Secondary>
          <LayerCard.Primary>
            <div className="flex flex-col gap-4">
              <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
                <Input
                  label="目标数量"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                />
                <Button
                  size="lg"
                  loading={busy}
                  disabled={running}
                  onClick={() => void start()}
                  className="!h-12 !min-w-[140px] !px-6 !text-base !font-semibold"
                >
                  启动注册
                </Button>
                <Button
                  size="lg"
                  variant="secondary"
                  loading={busy}
                  disabled={!running && !busy}
                  onClick={() => void stop()}
                  className="!h-12 !min-w-[120px] !px-6 !text-base !font-semibold"
                >
                  停止
                </Button>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-lg bg-kumo-contrast/5 px-3 py-2">
                  <Text size="xs" variant="secondary">
                    状态
                  </Text>
                  <div className={running ? "text-emerald-500 font-semibold" : undefined}>
                    <Text>{status?.status || "—"}</Text>
                  </div>
                  <Text size="xs" variant="secondary">
                    {status?.phase_detail || status?.phase || ""}
                  </Text>
                </div>
                <div className="rounded-lg bg-kumo-contrast/5 px-3 py-2">
                  <Text size="xs" variant="secondary">
                    进度
                  </Text>
                  <Text>
                    {status?.success ?? 0} / {status?.target ?? "—"}
                  </Text>
                  <Text size="xs" variant="secondary">
                    fail {status?.fail ?? 0}
                  </Text>
                </div>
                <div className="rounded-lg bg-kumo-contrast/5 px-3 py-2">
                  <Text size="xs" variant="secondary">
                    号池筛选
                  </Text>
                  <Text>
                    {poolSource === "local"
                      ? `本地 ${poolTotal}`
                      : poolSource === "cloud"
                        ? `云端 ${poolTotal}`
                        : `联邦 ${poolTotal}`}
                  </Text>
                  <Text size="xs" variant="secondary">
                    run {status?.run_id || "—"}
                  </Text>
                </div>
              </div>

              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                <Switch
                  label="注册完成后自动加入本地号池"
                  checked={autoImport}
                  onCheckedChange={(v) => void savePoolFlags(!!v, autoSync)}
                />
                <Switch
                  label="本地号池自动同步到 CPA 云端"
                  checked={autoSync}
                  onCheckedChange={(v) => void savePoolFlags(autoImport, !!v)}
                />
              </div>
            </div>
          </LayerCard.Primary>
        </LayerCard>

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
            onValueChange={(v) => setTab(v as TabKey)}
          />
        </div>

        {tab === "logs" ? (
          <LayerCard>
            <LayerCard.Secondary>
              <span className="text-base font-semibold">实时日志</span>{" "}
              <a
                className="underline"
                href={`/api/logs${tokenQuery()}`}
                target="_blank"
                rel="noreferrer"
              >
                原始
              </a>
            </LayerCard.Secondary>
            <LayerCard.Primary>
              <pre
                className={
                  running
                    ? "max-h-[520px] overflow-auto whitespace-pre-wrap rounded-lg border border-emerald-400/40 bg-black/90 p-4 font-mono text-sm leading-relaxed text-emerald-100 shadow-[inset_0_0_24px_rgba(16,185,129,0.15)]"
                    : "max-h-[520px] overflow-auto whitespace-pre-wrap rounded-lg border border-kumo-hairline bg-black/80 p-4 font-mono text-sm leading-relaxed text-zinc-100"
                }
              >
                {log || "（暂无日志 — 启动注册后会出现）"}
              </pre>
            </LayerCard.Primary>
          </LayerCard>
        ) : null}

        {tab === "results" ? (
          <LayerCard>
            <LayerCard.Secondary>
              注册结果{" "}
              <Button
                size="sm"
                variant="secondary"
                loading={busy}
                onClick={() => void importPool()}
              >
                入库最新结果
              </Button>
            </LayerCard.Secondary>
            <LayerCard.Primary>
              {runs.length === 0 ? (
                <Text variant="secondary">暂无 run 产物（成功后会出现在 outputs/）</Text>
              ) : (
                <div className="flex flex-col gap-3">
                  {runs.map((r) => (
                    <div
                      key={r.id}
                      className="flex flex-wrap items-center justify-between gap-2 border-b border-kumo-hairline pb-3 last:border-0"
                    >
                      <div className="min-w-0">
                        <Text size="sm">
                          <code>{r.id}</code>{" "}
                          <Badge variant={r.cpa_count > 0 ? "primary" : "secondary"}>
                            CPA {r.cpa_count}
                          </Badge>{" "}
                          <Badge variant="secondary">SSO {r.sso_files}</Badge>
                        </Text>
                        <Text size="xs" variant="secondary">
                          {r.mod_time || ""}
                        </Text>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            const q = tokenQuery();
                            const t = q.startsWith("?") ? q.slice(1) : q;
                            window.open(
                              t
                                ? `/api/runs/${r.id}/download?kind=cpa&${t}`
                                : `/api/runs/${r.id}/download?kind=cpa`,
                              "_blank",
                            );
                          }}
                        >
                          下载 CPA
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={busy}
                          onClick={() => void importPool(r.id)}
                        >
                          加入本地号池
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <Pager
                page={runsPage}
                totalPages={runsTotalPages}
                total={runsTotal}
                label="注册结果"
                onChange={setRunsPage}
              />
            </LayerCard.Primary>
          </LayerCard>
        ) : null}

        {tab === "pool" ? (
          <LayerCard>
            <LayerCard.Secondary>
              号池{" "}
              {poolSource === "local" ? (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy}
                  onClick={() => void syncPool()}
                >
                  同步未上传到云端
                </Button>
              ) : null}
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
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void refreshPool(poolPage, poolSource, masterURL)}
                >
                  刷新
                </Button>
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

              {poolError ? (
                <Text variant="secondary">{poolError}</Text>
              ) : poolSource === "local" ? (
                localItems.length === 0 ? (
                  <Text variant="secondary">
                    本地号池为空 — 从「结果」入库，或开启自动入库
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

              {poolSource === "local" && poolUnsynced > 0 ? (
                <div className="mt-2"><Text size="xs" variant="secondary">未同步到云端：{poolUnsynced}</Text></div>
              ) : null}

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
        ) : null}
      </div>
    </AdminShell>
  );
}
