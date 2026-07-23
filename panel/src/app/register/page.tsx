"use client";

import { useEffect, useState } from "react";
import { Button, Input, LayerCard, Text } from "@cloudflare/kumo";
import { AdminShell } from "@/components/admin-shell";
import { PageHeader } from "@/components/page-header";
import { api, tokenQuery, type RunStatus } from "@/lib/api";

export default function RegisterPage() {
  const [target, setTarget] = useState("10");
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [log, setLog] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const st = await api<{ status: RunStatus }>("/api/status");
      setStatus(st.status);
      const lg = await api<{ log?: string }>("/api/logs?tail=200");
      setLog(lg.log || "");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "刷新失败");
    }
  }

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, []);

  async function start() {
    setBusy(true);
    setMsg("");
    try {
      const n = Math.max(1, Math.min(10000, parseInt(target, 10) || 10));
      await api("/api/start", { method: "POST", body: JSON.stringify({ target: n }) });
      setMsg(`已启动 target=${n}`);
      await refresh();
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
      await refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "停止失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AdminShell>
      <PageHeader
        title="注册"
        description="启动 / 停止注册流水线，查看实时日志"
        actions={
          <>
            <Button size="sm" loading={busy} onClick={() => void start()}>
              启动
            </Button>
            <Button size="sm" variant="secondary" loading={busy} onClick={() => void stop()}>
              停止
            </Button>
          </>
        }
      />

      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <LayerCard>
          <LayerCard.Secondary>目标数量</LayerCard.Secondary>
          <LayerCard.Primary>
            <Input value={target} onChange={(e) => setTarget(e.target.value)} />
          </LayerCard.Primary>
        </LayerCard>
        <LayerCard>
          <LayerCard.Secondary>状态</LayerCard.Secondary>
          <LayerCard.Primary>
            <Text>{status?.status || "—"}</Text>
            <Text variant="secondary" size="sm">
              {status?.phase_detail || status?.phase || ""}
            </Text>
          </LayerCard.Primary>
        </LayerCard>
        <LayerCard>
          <LayerCard.Secondary>进度</LayerCard.Secondary>
          <LayerCard.Primary>
            <Text>
              {status?.success ?? 0} / {status?.target ?? "—"}
            </Text>
            <Text variant="secondary" size="sm">
              fail {status?.fail ?? 0}
            </Text>
          </LayerCard.Primary>
        </LayerCard>
      </div>

      {msg ? <div className="mb-3"><Text>{msg}</Text></div> : null}

      <LayerCard>
        <LayerCard.Secondary>
          日志{" "}
          <a className="underline" href={`/api/logs${tokenQuery()}`} target="_blank" rel="noreferrer">
            原始
          </a>
        </LayerCard.Secondary>
        <LayerCard.Primary>
          <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap text-xs">
            {log || "（暂无日志）"}
          </pre>
        </LayerCard.Primary>
      </LayerCard>
    </AdminShell>
  );
}
