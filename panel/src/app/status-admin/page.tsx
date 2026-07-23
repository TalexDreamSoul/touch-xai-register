"use client";

import { useEffect, useState } from "react";
import { Button, Input, LayerCard, Switch, Text } from "@cloudflare/kumo";
import { AdminShell } from "@/components/admin-shell";
import { PageHeader } from "@/components/page-header";
import { api } from "@/lib/api";

type Layout = {
  title: string;
  subtitle: string;
  show_pool: boolean;
  show_models: boolean;
  show_cluster: boolean;
  show_need: boolean;
  show_slaves: boolean;
  show_json_link: boolean;
  footer: string;
  models: string[];
  probe_enabled: boolean;
  probe_interval_sec: number;
  probe_max_tokens: number;
  api_base: string;
};

const empty: Layout = {
  title: "节点状态",
  subtitle: "号池 · 模型可用性 · 联邦",
  show_pool: true,
  show_models: true,
  show_cluster: true,
  show_need: true,
  show_slaves: true,
  show_json_link: true,
  footer: "JSON: /api/public/status.json",
  models: ["grok-4.5", "grok-4", "grok-3"],
  probe_enabled: true,
  probe_interval_sec: 30,
  probe_max_tokens: 20,
  api_base: "",
};

export default function StatusAdminPage() {
  const [layout, setLayout] = useState<Layout>(empty);
  const [modelsText, setModelsText] = useState(empty.models.join("\n"));
  const [statusPassword, setStatusPassword] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [pwSet, setPwSet] = useState(false);

  async function load() {
    const [l, cfg] = await Promise.all([
      api<{ layout: Partial<Layout> }>("/api/status/layout"),
      api<{ config: Record<string, unknown> }>("/api/config"),
    ]);
    const next: Layout = { ...empty, ...(l.layout || {}) };
    if (!Array.isArray(next.models) || next.models.length === 0) {
      next.models = empty.models;
    }
    setLayout(next);
    setModelsText(next.models.join("\n"));
    setPwSet(!!cfg.config.cluster_status_password_set);
  }

  useEffect(() => {
    void load().catch((e: unknown) =>
      setMsg(e instanceof Error ? e.message : "加载失败"),
    );
  }, []);

  async function save() {
    setBusy(true);
    setMsg("");
    try {
      const models = modelsText
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const body: Layout = {
        ...layout,
        models: models.length ? models : empty.models,
        probe_interval_sec: Number(layout.probe_interval_sec) || 30,
        probe_max_tokens: Number(layout.probe_max_tokens) || 20,
      };
      await api("/api/status/layout", {
        method: "PUT",
        body: JSON.stringify(body),
      });
      if (statusPassword.length > 0) {
        await api("/api/config", {
          method: "PUT",
          body: JSON.stringify({ cluster_status_password: statusPassword }),
        });
        setStatusPassword("");
      }
      setMsg("已保存看板配置");
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function probeNow() {
    setBusy(true);
    try {
      await api("/api/status/probe-now", { method: "POST", body: "{}" });
      setMsg("已触发一次模型探活（随机选模型）");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "触发失败");
    } finally {
      setBusy(false);
    }
  }

  function setFlag<K extends keyof Layout>(key: K, value: Layout[K]) {
    setLayout((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <AdminShell>
      <PageHeader
        title="状态页配置"
        description="独立分组 · 自定义公开看板 · 模型监测（约 30s / max_tokens=20 / 随机）"
        actions={
          <>
            <Button size="sm" variant="secondary" loading={busy} onClick={() => void probeNow()}>
              立即探活
            </Button>
            <Button size="sm" loading={busy} onClick={() => void save()}>
              保存
            </Button>
          </>
        }
      />
      {msg ? (
        <div className="mb-3">
          <Text>{msg}</Text>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <LayerCard>
          <LayerCard.Secondary>文案</LayerCard.Secondary>
          <LayerCard.Primary>
            <div className="flex flex-col gap-3">
              <Input
                label="标题"
                value={layout.title}
                onChange={(e) => setFlag("title", e.target.value)}
              />
              <Input
                label="副标题"
                value={layout.subtitle}
                onChange={(e) => setFlag("subtitle", e.target.value)}
              />
              <Input
                label="页脚"
                value={layout.footer}
                onChange={(e) => setFlag("footer", e.target.value)}
              />
              <Input
                label="状态页密码（与联邦密钥独立；留空不改）"
                type="password"
                value={statusPassword}
                onChange={(e) => setStatusPassword(e.target.value)}
                placeholder={pwSet ? "已设置 · 留空不改" : "空=公开"}
              />
              <Text size="xs" variant="secondary">
                公开地址 <code>/status/</code> · JSON{" "}
                <code>/api/public/status.json</code>
              </Text>
            </div>
          </LayerCard.Primary>
        </LayerCard>

        <LayerCard>
          <LayerCard.Secondary>展示区块</LayerCard.Secondary>
          <LayerCard.Primary>
            <div className="flex flex-col gap-3">
              <Switch
                label="号池（正式池 / 候选池）"
                checked={layout.show_pool}
                onCheckedChange={(v) => setFlag("show_pool", !!v)}
              />
              <Switch
                label="缺口 / 目标"
                checked={layout.show_need}
                onCheckedChange={(v) => setFlag("show_need", !!v)}
              />
              <Switch
                label="模型可用性"
                checked={layout.show_models}
                onCheckedChange={(v) => setFlag("show_models", !!v)}
              />
              <Switch
                label="联邦 / 主从信息"
                checked={layout.show_cluster}
                onCheckedChange={(v) => setFlag("show_cluster", !!v)}
              />
              <Switch
                label="从节点列表"
                checked={layout.show_slaves}
                onCheckedChange={(v) => setFlag("show_slaves", !!v)}
              />
              <Switch
                label="显示 JSON 链接"
                checked={layout.show_json_link}
                onCheckedChange={(v) => setFlag("show_json_link", !!v)}
              />
            </div>
          </LayerCard.Primary>
        </LayerCard>

        <LayerCard>
          <LayerCard.Secondary>模型监测</LayerCard.Secondary>
          <LayerCard.Primary>
            <div className="flex flex-col gap-3">
              <Switch
                label="启用后台探活"
                checked={layout.probe_enabled}
                onCheckedChange={(v) => setFlag("probe_enabled", !!v)}
              />
              <Input
                label="间隔秒（默认 30，带随机抖动）"
                value={String(layout.probe_interval_sec)}
                onChange={(e) =>
                  setFlag("probe_interval_sec", parseInt(e.target.value, 10) || 30)
                }
              />
              <Input
                label="max_tokens（默认 20）"
                value={String(layout.probe_max_tokens)}
                onChange={(e) =>
                  setFlag("probe_max_tokens", parseInt(e.target.value, 10) || 20)
                }
              />
              <Input
                label="API Base（OpenAI 兼容，空=从 CPA base 推 /v1）"
                value={layout.api_base}
                onChange={(e) => setFlag("api_base", e.target.value)}
                placeholder="http://127.0.0.1:8317/v1"
              />
              <Input
                label="模型列表（每行一个，每次随机抽一个探）"
                value={modelsText}
                onChange={(e) => setModelsText(e.target.value)}
                placeholder={"grok-4.5\ngrok-4\ngrok-3"}
              />
            </div>
          </LayerCard.Primary>
        </LayerCard>

        <LayerCard>
          <LayerCard.Secondary>说明</LayerCard.Secondary>
          <LayerCard.Primary>
            <div className="flex flex-col gap-2">
              <Text size="sm" variant="secondary">
                · 状态页独立于「联邦」导航；看板配置在此页完成。
              </Text>
              <Text size="sm" variant="secondary">
                · 正式池来自 CPA Management auth-files；候选池统计本机 outputs/*/CPA
                本地 JSON。
              </Text>
              <Text size="sm" variant="secondary">
                · 探活：约每 30s 随机选一个模型，POST /chat/completions，max_tokens=20，
                随机 prompt 防缓存。
              </Text>
              <Text size="sm" variant="secondary">
                · JSON 暴露 model_available 与 models[] 明细，便于外部监控。
              </Text>
            </div>
          </LayerCard.Primary>
        </LayerCard>
      </div>
    </AdminShell>
  );
}
