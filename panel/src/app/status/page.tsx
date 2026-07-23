"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Input,
  LayerCard,
  Surface,
  Text,
} from "@cloudflare/kumo";

type Layout = {
  title?: string;
  subtitle?: string;
  show_pool?: boolean;
  show_models?: boolean;
  show_cluster?: boolean;
  show_need?: boolean;
  show_slaves?: boolean;
  show_json_link?: boolean;
  footer?: string;
  models?: string[];
  probe_enabled?: boolean;
  probe_interval_sec?: number;
  probe_max_tokens?: number;
};

type ModelStatus = {
  id: string;
  available: boolean;
  latency_ms?: number;
  last_check?: string;
  last_error?: string;
  http_code?: number;
};

type Board = {
  ok?: boolean;
  error?: string;
  auth_required?: boolean;
  service?: string;
  time?: string;
  layout?: Layout;
  node?: { name?: string; role?: string };
  pool?: {
    total?: number;
    active?: number;
    disabled?: number;
    error?: number;
    healthy?: number;
    rate_limited?: number;
    dead?: number;
    candidate?: number;
    pool_target?: number;
    need?: number;
  };
  models?: ModelStatus[];
  model_available?: Record<string, boolean>;
  cluster?: {
    role?: string;
    need?: number;
    pool_target?: number;
    slaves_online?: number;
    slaves_total?: number;
    nodes?: Array<{
      id: string;
      name: string;
      online: boolean;
      busy: boolean;
      assigned: number;
      completed_total: number;
    }>;
  };
};

const PW_KEY = "grok_status_password";

export default function PublicStatusPage() {
  const [password, setPassword] = useState("");
  const [data, setData] = useState<Board | null>(null);
  const [needPw, setNeedPw] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (pw?: string) => {
      setBusy(true);
      setError("");
      try {
        const headers: Record<string, string> = {};
        const p = (pw ?? password).trim();
        if (p) headers["X-Status-Password"] = p;
        const res = await fetch("/api/public/status", { headers });
        const json = (await res.json()) as Board;
        if (res.status === 401 || json.auth_required) {
          setNeedPw(true);
          setData(json);
          if (res.status === 401) setError(json.error || "需要状态页密码");
          return;
        }
        if (!res.ok) throw new Error(json.error || res.statusText);
        setNeedPw(!!json.auth_required && !json.ok);
        setData(json);
        if (p) localStorage.setItem(PW_KEY, p);
      } catch (e) {
        setError(e instanceof Error ? e.message : "加载失败");
      } finally {
        setBusy(false);
      }
    },
    [password],
  );

  useEffect(() => {
    const saved = localStorage.getItem(PW_KEY) || "";
    if (saved) setPassword(saved);
    void load(saved);
    const t = setInterval(() => {
      void load(localStorage.getItem(PW_KEY) || "");
    }, 8000);
    return () => clearInterval(t);
  }, [load]);

  const layout = data?.layout || {};
  const pool = data?.pool;
  const title = layout.title || "节点状态";
  const subtitle = layout.subtitle || "号池 · 模型 · 联邦";

  return (
    <Surface className="min-h-screen p-6">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <Text variant="heading2" as="h1">
              {title}
            </Text>
            <Text variant="secondary" size="sm">
              {subtitle}
            </Text>
          </div>
          <div className="flex flex-wrap gap-2">
            {layout.show_json_link !== false ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => window.open("/api/public/status.json", "_blank")}
              >
                JSON
              </Button>
            ) : null}
            <Button size="sm" variant="secondary" loading={busy} onClick={() => void load()}>
              刷新
            </Button>
          </div>
        </div>

        {needPw || data?.auth_required ? (
          <LayerCard>
            <LayerCard.Secondary>状态页密码</LayerCard.Secondary>
            <LayerCard.Primary>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <div className="min-w-0 flex-1">
                  <Input
                    type="password"
                    label="与主从联邦密钥独立"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="留空表示公开"
                  />
                </div>
                <Button
                  loading={busy}
                  onClick={() => {
                    localStorage.setItem(PW_KEY, password);
                    void load(password);
                  }}
                >
                  解锁
                </Button>
              </div>
            </LayerCard.Primary>
          </LayerCard>
        ) : null}

        {error ? (
          <div>
            <Text variant="error">{error}</Text>
          </div>
        ) : null}

        {data?.ok ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="节点" value={data.node?.name || "—"} />
              <Stat label="角色" value={data.node?.role || "—"} />
              {layout.show_need !== false ? (
                <Stat
                  label="缺口 / 目标"
                  value={`${pool?.need ?? 0} / ${pool?.pool_target ?? 0}`}
                />
              ) : null}
              {layout.show_cluster !== false ? (
                <Stat
                  label="从节点在线"
                  value={`${data.cluster?.slaves_online ?? 0}/${data.cluster?.slaves_total ?? 0}`}
                />
              ) : null}
            </div>

            {layout.show_pool !== false ? (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Stat label="正式池总量" value={String(pool?.total ?? "—")} />
                <Stat label="活跃 / 健康" value={`${pool?.active ?? "—"} / ${pool?.healthy ?? "—"}`} />
                <Stat label="候选池" value={String(pool?.candidate ?? "—")} />
                <Stat
                  label="限流 / 死号 / 禁用"
                  value={`${pool?.rate_limited ?? 0} / ${pool?.dead ?? 0} / ${pool?.disabled ?? 0}`}
                />
              </div>
            ) : null}

            {layout.show_models !== false ? (
              <LayerCard>
                <LayerCard.Secondary>
                  模型可用性{" "}
                  {layout.probe_enabled === false ? (
                    <Badge variant="secondary">监测关闭</Badge>
                  ) : (
                    <Badge variant="primary">
                      ~{layout.probe_interval_sec || 30}s 随机探活 · max_tokens{" "}
                      {layout.probe_max_tokens || 20}
                    </Badge>
                  )}
                </LayerCard.Secondary>
                <LayerCard.Primary>
                  {(data.models || []).length === 0 ? (
                    <Text variant="secondary">暂无模型数据（等待探活）</Text>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {data.models?.map((m) => (
                        <div
                          key={m.id}
                          className="flex flex-wrap items-center justify-between gap-2 border-b border-kumo-hairline pb-2 last:border-0"
                        >
                          <Text size="sm">
                            <code>{m.id}</code>{" "}
                            <Badge variant={m.available ? "primary" : "secondary"}>
                              {m.available ? "available" : "down"}
                            </Badge>
                          </Text>
                          <Text size="xs" variant="secondary">
                            {m.latency_ms != null ? `${m.latency_ms}ms` : "—"}
                            {m.http_code ? ` · http ${m.http_code}` : ""}
                            {m.last_error ? ` · ${m.last_error}` : ""}
                          </Text>
                        </div>
                      ))}
                    </div>
                  )}
                </LayerCard.Primary>
              </LayerCard>
            ) : null}

            {layout.show_slaves !== false && layout.show_cluster !== false ? (
              <LayerCard>
                <LayerCard.Secondary>
                  从节点{" "}
                  {(pool?.need ?? 0) > 0 ? (
                    <Badge variant="primary">需要补号</Badge>
                  ) : (
                    <Badge variant="secondary">充足</Badge>
                  )}
                </LayerCard.Secondary>
                <LayerCard.Primary>
                  {(data.cluster?.nodes || []).length === 0 ? (
                    <Text variant="secondary">暂无从节点</Text>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {data.cluster?.nodes?.map((n) => (
                        <div
                          key={n.id}
                          className="flex flex-wrap items-center justify-between gap-2 border-b border-kumo-hairline pb-2 last:border-0"
                        >
                          <Text size="sm">
                            {n.name}{" "}
                            <Badge variant={n.online ? "primary" : "secondary"}>
                              {n.online ? "online" : "offline"}
                            </Badge>{" "}
                            {n.busy ? <Badge variant="secondary">busy</Badge> : null}
                          </Text>
                          <Text size="xs" variant="secondary">
                            分配 {n.assigned} · 完成 {n.completed_total}
                          </Text>
                        </div>
                      ))}
                    </div>
                  )}
                </LayerCard.Primary>
              </LayerCard>
            ) : null}

            <Text size="xs" variant="secondary">
              更新于 {data.time || "—"}
              {layout.footer ? ` · ${layout.footer}` : ""}
              {layout.show_json_link !== false
                ? " · /api/public/status.json"
                : ""}
            </Text>
          </>
        ) : null}
      </div>
    </Surface>
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
