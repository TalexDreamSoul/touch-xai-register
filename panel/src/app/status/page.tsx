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

type StatusPayload = {
  ok?: boolean;
  error?: string;
  auth_required?: boolean;
  service?: string;
  role?: string;
  name?: string;
  pool_target?: number;
  need?: number;
  need_accounts?: boolean;
  pool?: {
    healthy?: number;
    rate_limited?: number;
    dead?: number;
    disabled?: number;
    total?: number;
    quota_estimate?: number;
  };
  slaves_online?: number;
  slaves_total?: number;
  slaves?: Array<{
    id: string;
    name: string;
    online: boolean;
    busy: boolean;
    assigned: number;
    completed_total: number;
  }>;
  time?: string;
};

const PW_KEY = "grok_status_password";

export default function PublicStatusPage() {
  const [password, setPassword] = useState("");
  const [data, setData] = useState<StatusPayload | null>(null);
  const [needPw, setNeedPw] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (pw?: string) => {
    setBusy(true);
    setError("");
    try {
      const headers: Record<string, string> = {};
      const p = (pw ?? password).trim();
      if (p) headers["X-Status-Password"] = p;
      const res = await fetch("/api/public/status", { headers });
      const json = (await res.json()) as StatusPayload;
      if (res.status === 401 || json.auth_required) {
        setNeedPw(true);
        setData(json);
        if (res.status === 401) {
          setError(json.error || "需要状态页密码");
        }
        return;
      }
      if (!res.ok) {
        throw new Error(json.error || res.statusText);
      }
      setNeedPw(!!json.auth_required && !json.ok);
      setData(json);
      if (p) localStorage.setItem(PW_KEY, p);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setBusy(false);
    }
  }, [password]);

  useEffect(() => {
    const saved = localStorage.getItem(PW_KEY) || "";
    if (saved) setPassword(saved);
    void load(saved);
    const t = setInterval(() => {
      const pw = localStorage.getItem(PW_KEY) || "";
      void load(pw);
    }, 8000);
    return () => clearInterval(t);
  }, [load]);

  const pool = data?.pool;

  return (
    <Surface className="min-h-screen p-6">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <Text variant="heading2" as="h1">
              节点状态
            </Text>
            <Text variant="secondary" size="sm">
              公网状态板 · 与主从联邦密钥独立
            </Text>
          </div>
          <Button size="sm" variant="secondary" loading={busy} onClick={() => void load()}>
            刷新
          </Button>
        </div>

        {needPw || data?.auth_required ? (
          <LayerCard>
            <LayerCard.Secondary>状态页密码</LayerCard.Secondary>
            <LayerCard.Primary>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <div className="min-w-0 flex-1">
                  <Input
                    type="password"
                    label="密码（主从配置里的状态页密码，非联邦密钥）"
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
          <div className="mb-1">
            <Text variant="error">{error}</Text>
          </div>
        ) : null}

        {data?.ok ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="节点" value={data.name || "—"} />
              <Stat label="角色" value={data.role || "—"} />
              <Stat
                label="缺口 / 目标"
                value={`${data.need ?? 0} / ${data.pool_target ?? 0}`}
              />
              <Stat
                label="从节点在线"
                value={`${data.slaves_online ?? 0}/${data.slaves_total ?? 0}`}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <Stat label="健康" value={String(pool?.healthy ?? "—")} />
              <Stat label="限流" value={String(pool?.rate_limited ?? "—")} />
              <Stat label="死号" value={String(pool?.dead ?? "—")} />
              <Stat label="总量" value={String(pool?.total ?? "—")} />
              <Stat label="额度估算" value={String(pool?.quota_estimate ?? "—")} />
            </div>

            <LayerCard>
              <LayerCard.Secondary>
                从节点{" "}
                {data.need_accounts ? (
                  <Badge variant="primary">需要补号</Badge>
                ) : (
                  <Badge variant="secondary">充足</Badge>
                )}
              </LayerCard.Secondary>
              <LayerCard.Primary>
                {(data.slaves || []).length === 0 ? (
                  <Text variant="secondary">暂无从节点</Text>
                ) : (
                  <div className="flex flex-col gap-3">
                    {data.slaves?.map((n) => (
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

            <Text size="xs" variant="secondary">
              更新于 {data.time || "—"} · API <code>/api/public/status</code>
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
