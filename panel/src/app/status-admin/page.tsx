"use client";

import { useEffect, useMemo, useState } from "react";
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

type TabKey = "copy" | "blocks" | "groups" | "probe";

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

function snapshotOf(layout: Layout, drafts: GroupDraft[], pw: string): string {
  return JSON.stringify({
    layout: {
      ...layout,
      model_groups: drafts.map((d, i) => ({
        id: d.id,
        name: d.name,
        models: parseModels(d.modelsText),
      })),
      models: drafts.flatMap((d) => parseModels(d.modelsText)),
    },
    pw,
  });
}

function CardSaveBar({
  dirty,
  busy,
  onSave,
  label = "保存此区块",
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
          <Badge variant="primary">有未保存更改</Badge>
        ) : (
          <Badge variant="secondary">已与服务器一致</Badge>
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

export default function StatusAdminPage() {
  const [tab, setTab] = useState<TabKey>("copy");
  const [layout, setLayout] = useState<Layout>(empty);
  const [drafts, setDrafts] = useState<GroupDraft[]>(defaultDrafts);
  const [statusPassword, setStatusPassword] = useState("");
  const [savedSnap, setSavedSnap] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [pwSet, setPwSet] = useState(false);

  const dirty = useMemo(() => {
    if (!savedSnap) return false;
    return snapshotOf(layout, drafts, statusPassword) !== savedSnap;
  }, [layout, drafts, statusPassword, savedSnap]);

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
    setStatusPassword("");
    setPwSet(!!cfg.config.cluster_status_password_set);
    setSavedSnap(snapshotOf(next, nextDrafts, ""));
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

  const tabItems = useMemo(
    () => [
      { value: "copy", label: dirty ? "文案 ·" : "文案" },
      { value: "blocks", label: "展示区块" },
      { value: "groups", label: `模型组别 (${drafts.length})` },
      { value: "probe", label: "探活" },
    ],
    [drafts.length, dirty],
  );

  return (
    <AdminShell>
      <PageHeader
        title="状态页配置"
        description="Tabs 分区 · 主节点模型组别 · 大按钮保存"
        actions={
          <>
            {dirty ? <Badge variant="primary">未保存</Badge> : null}
            <Button
              size="sm"
              variant="secondary"
              loading={busy}
              onClick={() => void probeNow()}
            >
              立即探活
            </Button>
            <Button
              size="lg"
              loading={busy}
              onClick={() => void save()}
              className="!h-11 !min-w-[128px] !px-5 !text-base !font-semibold"
            >
              {dirty ? "保存更改" : "已保存"}
            </Button>
          </>
        }
      />

      {dirty ? (
        <div className="mb-3 rounded-md border border-amber-400/50 bg-amber-500/10 px-3 py-2">
          <Text size="sm">有未保存的更改 — 切换标签不会自动保存，请点「保存更改」</Text>
        </div>
      ) : null}
      {msg ? (
        <div className="mb-3 rounded-md bg-kumo-contrast/5 px-3 py-2">
          <Text>{msg}</Text>
        </div>
      ) : null}

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

      {tab === "copy" ? (
        <LayerCard>
          <LayerCard.Secondary>文案 / 访问</LayerCard.Secondary>
          <LayerCard.Primary>
            <div className="flex flex-col gap-3 sm:max-w-xl">
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
            <CardSaveBar dirty={dirty} busy={busy} onSave={() => void save()} />
          </LayerCard.Primary>
        </LayerCard>
      ) : null}

      {tab === "blocks" ? (
        <LayerCard>
          <LayerCard.Secondary>展示区块</LayerCard.Secondary>
          <LayerCard.Primary>
            <div className="flex flex-col gap-3 sm:max-w-md">
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
            <CardSaveBar dirty={dirty} busy={busy} onSave={() => void save()} />
          </LayerCard.Primary>
        </LayerCard>
      ) : null}

      {tab === "groups" ? (
        <LayerCard>
          <LayerCard.Secondary>
            模型组别{" "}
            <Button size="sm" variant="secondary" onClick={addGroup}>
              添加组别
            </Button>
          </LayerCard.Secondary>
          <LayerCard.Primary>
            <div className="flex flex-col gap-4">
              <Text size="xs" variant="secondary">
                如 Grok / GPT 系列；公开看板按组别分区。空组别可预留。
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
            <CardSaveBar dirty={dirty} busy={busy} onSave={() => void save()} />
          </LayerCard.Primary>
        </LayerCard>
      ) : null}

      {tab === "probe" ? (
        <LayerCard>
          <LayerCard.Secondary>探活参数</LayerCard.Secondary>
          <LayerCard.Primary>
            <div className="flex flex-col gap-3 sm:max-w-xl">
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
              <Text size="xs" variant="secondary">
                探活对所有组别模型合并后随机轮询。
              </Text>
            </div>
            <CardSaveBar dirty={dirty} busy={busy} onSave={() => void save()} />
          </LayerCard.Primary>
        </LayerCard>
      ) : null}
    </AdminShell>
  );
}
