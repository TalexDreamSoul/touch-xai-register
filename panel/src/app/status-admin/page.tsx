"use client";

import { useEffect, useState } from "react";
import { Button, Input, LayerCard, Switch, Text } from "@cloudflare/kumo";
import { AdminShell } from "@/components/admin-shell";
import { PageHeader } from "@/components/page-header";
import { api } from "@/lib/api";

type ModelGroup = {
  id: string;
  name: string;
  models: string[];
};

type GroupDraft = {
  id: string;
  name: string;
  modelsText: string;
};

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
  model_groups: ModelGroup[];
  probe_enabled: boolean;
  probe_interval_sec: number;
  probe_max_tokens: number;
  api_base: string;
};

const defaultDrafts: GroupDraft[] = [
  { id: "grok", name: "Grok", modelsText: "grok-4.5\ngrok-4\ngrok-3" },
  { id: "gpt", name: "GPT", modelsText: "" },
];

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
  model_groups: [
    { id: "grok", name: "Grok", models: ["grok-4.5", "grok-4", "grok-3"] },
    { id: "gpt", name: "GPT", models: [] },
  ],
  probe_enabled: true,
  probe_interval_sec: 30,
  probe_max_tokens: 20,
  api_base: "",
};

function slugify(name: string, i: number): string {
  const s = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return s || `group-${i + 1}`;
}

function parseModels(text: string): string[] {
  return text
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function StatusAdminPage() {
  const [layout, setLayout] = useState<Layout>(empty);
  const [drafts, setDrafts] = useState<GroupDraft[]>(defaultDrafts);
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
    let groups = Array.isArray(next.model_groups) ? next.model_groups : [];
    if (groups.length === 0) {
      if (Array.isArray(next.models) && next.models.length > 0) {
        groups = [{ id: "default", name: "模型", models: next.models }];
      } else {
        groups = empty.model_groups.map((g) => ({
          ...g,
          models: [...g.models],
        }));
      }
    }
    const nextDrafts: GroupDraft[] = groups.map((g, i) => ({
      id: g.id || slugify(g.name || "", i),
      name: g.name || g.id || `组别 ${i + 1}`,
      modelsText: (g.models || []).join("\n"),
    }));
    next.model_groups = groups;
    setLayout(next);
    setDrafts(nextDrafts);
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
      const bodyGroups: ModelGroup[] = drafts.map((d, i) => {
        const name = d.name.trim() || `组别 ${i + 1}`;
        return {
          id: d.id.trim() || slugify(name, i),
          name,
          models: parseModels(d.modelsText),
        };
      });
      const body: Layout = {
        ...layout,
        model_groups: bodyGroups,
        models: bodyGroups.flatMap((g) => g.models),
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
      setMsg("已保存看板配置（含模型组别）");
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

  function updateDraft(i: number, patch: Partial<GroupDraft>) {
    setDrafts((prev) =>
      prev.map((d, idx) => (idx === i ? { ...d, ...patch } : d)),
    );
  }

  function addGroup() {
    setDrafts((prev) => [
      ...prev,
      {
        id: `group-${prev.length + 1}`,
        name: "新组别",
        modelsText: "",
      },
    ]);
  }

  function removeGroup(i: number) {
    setDrafts((prev) => prev.filter((_, idx) => idx !== i));
  }

  return (
    <AdminShell>
      <PageHeader
        title="状态页配置"
        description="主节点看板 · 模型组别（Grok / GPT…）· 探活"
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
                label="模型可用性（按组别）"
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

        <LayerCard className="lg:col-span-2">
          <LayerCard.Secondary>
            模型组别{" "}
            <Button size="sm" variant="secondary" onClick={addGroup}>
              添加组别
            </Button>
          </LayerCard.Secondary>
          <LayerCard.Primary>
            <div className="flex flex-col gap-4">
              <Text size="xs" variant="secondary">
                主节点可配置多个系列（如 Grok、GPT）。公开看板按组别分区展示；探活对所有组别模型合并随机探测。
              </Text>
              {drafts.length === 0 ? (
                <Text variant="secondary">暂无组别，点「添加组别」</Text>
              ) : (
                drafts.map((g, i) => (
                  <div
                    key={`${g.id}-${i}`}
                    className="rounded-lg border border-kumo-hairline p-3"
                  >
                    <div className="mb-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
                      <Input
                        label="组别名称"
                        value={g.name}
                        onChange={(e) => updateDraft(i, { name: e.target.value })}
                        placeholder="Grok / GPT / Claude…"
                      />
                      <Input
                        label="组别 ID（可选）"
                        value={g.id}
                        onChange={(e) => updateDraft(i, { id: e.target.value })}
                        placeholder="grok"
                      />
                      <div className="flex items-end">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => removeGroup(i)}
                        >
                          删除
                        </Button>
                      </div>
                    </div>
                    <Input
                      label="模型列表（每行一个）"
                      value={g.modelsText}
                      onChange={(e) =>
                        updateDraft(i, { modelsText: e.target.value })
                      }
                      placeholder={
                        g.name.toLowerCase().includes("gpt")
                          ? "gpt-4o\ngpt-4.1"
                          : "grok-4.5\ngrok-4"
                      }
                    />
                  </div>
                ))
              )}
            </div>
          </LayerCard.Primary>
        </LayerCard>

        <LayerCard>
          <LayerCard.Secondary>探活参数</LayerCard.Secondary>
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
            </div>
          </LayerCard.Primary>
        </LayerCard>

        <LayerCard>
          <LayerCard.Secondary>说明</LayerCard.Secondary>
          <LayerCard.Primary>
            <div className="flex flex-col gap-2">
              <Text size="sm" variant="secondary">
                · 组别只影响看板分区；探活仍对全部模型随机轮询。
              </Text>
              <Text size="sm" variant="secondary">
                · 空组别（如预留 GPT）可保留名称，等有模型再填。
              </Text>
              <Text size="sm" variant="secondary">
                · JSON 同时返回 models[] 与 model_groups[]，便于外部监控。
              </Text>
            </div>
          </LayerCard.Primary>
        </LayerCard>
      </div>
    </AdminShell>
  );
}
