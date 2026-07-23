"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Input,
  LayerCard,
  Switch,
  Tabs,
  Text,
} from "@cloudflare/kumo";
import { AdminShell } from "@/components/admin-shell";
import { PageHeader } from "@/components/page-header";
import { api, tokenQuery, type RunStatus } from "@/lib/api";

type RunInfo = {
  id: string;
  cpa_count: number;
  sso_files: number;
  mod_time?: string;
};

type TabKey = "logs" | "results";

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
  const [poolTotal, setPoolTotal] = useState(0);
  const [poolUnsynced, setPoolUnsynced] = useState(0);
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
      const [st, lg, cfg, lp] = await Promise.all([
        api<{ status: RunStatus }>("/api/status"),
        api<{ log?: string }>("/api/logs?tail=300"),
        api<{ config?: Record<string, unknown> }>("/api/config").catch(() => ({
          config: {} as Record<string, unknown>,
        })),
        api<{ total?: number; unsynced?: number }>(
          "/api/pool/list?source=local&page=1&limit=1",
        ).catch(() => ({ total: 0, unsynced: 0 })),
      ]);
      setStatus(st.status);
      setLog(lg.log || "");
      setPoolTotal(lp.total || 0);
      setPoolUnsynced(lp.unsynced || 0);
      const conf = cfg.config || {};
      if (typeof conf.local_pool_auto_import === "boolean") {
        setAutoImport(conf.local_pool_auto_import);
      }
      if (typeof conf.local_pool_auto_sync === "boolean") {
        setAutoSync(conf.local_pool_auto_sync);
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "刷新失败");
    }
  }, []);

  const refreshRuns = useCallback(async (page: number) => {
    try {
      const rs = await api<{
        runs?: RunInfo[];
        total?: number;
        total_pages?: number;
      }>(`/api/runs?page=${page}&limit=${PAGE_SIZE}`);
      setRuns(rs.runs || []);
      setRunsTotal(rs.total || 0);
      setRunsTotalPages(rs.total_pages || 0);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "加载注册结果失败");
    }
  }, []);

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
    if (!running || tab !== "results") return;
    const t = setInterval(() => void refreshRuns(runsPage), 5000);
    return () => clearInterval(t);
  }, [running, tab, runsPage, refreshRuns]);

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
      if (tab === "results") await refreshRuns(runsPage);
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
      setMsg(
        `已入库 ${d.added ?? 0} 个（run ${d.run_id || "latest"}）· 去左侧「号池」查看`,
      );
      await refreshCore();
      await refreshRuns(runsPage);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "入库失败");
    } finally {
      setBusy(false);
    }
  }

  const tabItems = useMemo(
    () => [
      { value: "logs", label: "日志" },
      { value: "results", label: `结果${runsTotal ? ` (${runsTotal})` : ""}` },
    ],
    [runsTotal],
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
          description="启动流水线 · 日志 / 结果 · 号池见左侧导航"
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
                    本地号池
                  </Text>
                  <Text>
                    {poolTotal} 个 · 未同步 {poolUnsynced}
                  </Text>
                  <Text size="xs" variant="secondary">
                    <a className="underline" href="/pool/">
                      打开号池
                    </a>
                    {" · "}
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
            onValueChange={(v) => {
              if (!v) return;
              setTab(v as TabKey);
            }}
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
        ) : (
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
              <a className="ml-2 text-sm underline" href="/pool/">
                查看号池
              </a>
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
        )}
      </div>
    </AdminShell>
  );
}
