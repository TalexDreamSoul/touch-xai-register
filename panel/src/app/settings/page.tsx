"use client";

import { useEffect, useState } from "react";
import { Button, Input, LayerCard, Switch, Text } from "@cloudflare/kumo";
import { AdminShell } from "@/components/admin-shell";
import { PageHeader } from "@/components/page-header";
import { api, type PanelConfig } from "@/lib/api";

export default function SettingsPage() {
  const [cfg, setCfg] = useState<PanelConfig>({});
  const [cpaKey, setCpaKey] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const d = await api<{ config: PanelConfig }>("/api/config");
    setCfg(d.config || {});
  }

  useEffect(() => {
    void load().catch((e: unknown) =>
      setMsg(e instanceof Error ? e.message : "加载失败"),
    );
  }, []);

  function setField(key: string, value: string | number | boolean) {
    setCfg((prev) => ({ ...prev, [key]: value }));
  }

  async function save() {
    setBusy(true);
    setMsg("");
    try {
      const body: Record<string, string | number | boolean> = {
        cpa_management_base: String(cfg.cpa_management_base || ""),
        cpa_upload_enabled: !!cfg.cpa_upload_enabled,
        register_proxy: String(cfg.register_proxy || ""),
        flaresolverr_url: String(cfg.flaresolverr_url || ""),
        email_mode: String(cfg.email_mode || "tempmail"),
        patrol_enabled: !!cfg.patrol_enabled,
        patrol_interval_min: Number(cfg.patrol_interval_min || 30),
        refill_enabled: !!cfg.refill_enabled,
        refill_min_healthy: Number(cfg.refill_min_healthy || 5),
        refill_batch: Number(cfg.refill_batch || 10),
        cleanup_quota_enabled: !!cfg.cleanup_quota_enabled,
        cleanup_on_patrol: cfg.cleanup_on_patrol !== false,
        cleanup_backup: cfg.cleanup_backup !== false,
        cleanup_dry_run: !!cfg.cleanup_dry_run,
      };
      if (cpaKey.trim()) body.cpa_management_key = cpaKey.trim();
      await api("/api/config", { method: "PUT", body: JSON.stringify(body) });
      setCpaKey("");
      setMsg("已保存");
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function testConn() {
    setBusy(true);
    try {
      await api("/api/pool/test-connection", { method: "POST", body: "{}" });
      setMsg("CPA 连接正常");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "连接失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AdminShell>
      <PageHeader
        title="设置"
        description="CPA · 代理 · 巡检 / 补号 / 清理"
        actions={
          <>
            <Button
              size="sm"
              variant="secondary"
              loading={busy}
              onClick={() => void testConn()}
            >
              测试 CPA
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
          <LayerCard.Secondary>CPA Management</LayerCard.Secondary>
          <LayerCard.Primary>
            <div className="flex flex-col gap-3">
              <Input
                label="Base URL"
                value={String(cfg.cpa_management_base || "")}
                onChange={(e) => setField("cpa_management_base", e.target.value)}
                placeholder="http://127.0.0.1:8317/v0/management"
              />
              <Input
                label="Management Key"
                type="password"
                value={cpaKey}
                onChange={(e) => setCpaKey(e.target.value)}
                placeholder={
                  cfg.cpa_management_key_set
                    ? "已设置 · 留空不改"
                    : "Management Key"
                }
              />
              <Switch
                label="注册成功自动上传"
                checked={!!cfg.cpa_upload_enabled}
                onCheckedChange={(v) => setField("cpa_upload_enabled", !!v)}
              />
            </div>
          </LayerCard.Primary>
        </LayerCard>

        <LayerCard>
          <LayerCard.Secondary>代理 / 清障</LayerCard.Secondary>
          <LayerCard.Primary>
            <div className="flex flex-col gap-3">
              <Input
                label="REGISTER_PROXY"
                value={String(cfg.register_proxy || "")}
                onChange={(e) => setField("register_proxy", e.target.value)}
              />
              <Input
                label="FLARESOLVERR_URL"
                value={String(cfg.flaresolverr_url || "")}
                onChange={(e) => setField("flaresolverr_url", e.target.value)}
              />
              <Input
                label="EMAIL_MODE"
                value={String(cfg.email_mode || "tempmail")}
                onChange={(e) => setField("email_mode", e.target.value)}
              />
            </div>
          </LayerCard.Primary>
        </LayerCard>

        <LayerCard>
          <LayerCard.Secondary>巡检 / 补号</LayerCard.Secondary>
          <LayerCard.Primary>
            <div className="flex flex-col gap-3">
              <Switch
                label="启用定时巡检"
                checked={!!cfg.patrol_enabled}
                onCheckedChange={(v) => setField("patrol_enabled", !!v)}
              />
              <Input
                label="巡检间隔（分钟）"
                value={String(cfg.patrol_interval_min ?? 30)}
                onChange={(e) =>
                  setField(
                    "patrol_interval_min",
                    parseInt(e.target.value, 10) || 30,
                  )
                }
              />
              <Switch
                label="健康不足自动补号"
                checked={!!cfg.refill_enabled}
                onCheckedChange={(v) => setField("refill_enabled", !!v)}
              />
              <Input
                label="最低健康数"
                value={String(cfg.refill_min_healthy ?? 5)}
                onChange={(e) =>
                  setField(
                    "refill_min_healthy",
                    parseInt(e.target.value, 10) || 5,
                  )
                }
              />
            </div>
          </LayerCard.Primary>
        </LayerCard>

        <LayerCard>
          <LayerCard.Secondary>清理耗尽号</LayerCard.Secondary>
          <LayerCard.Primary>
            <div className="flex flex-col gap-3">
              <Switch
                label="允许定时清理"
                checked={!!cfg.cleanup_quota_enabled}
                onCheckedChange={(v) => setField("cleanup_quota_enabled", !!v)}
              />
              <Switch
                label="巡检后自动清理"
                checked={cfg.cleanup_on_patrol !== false}
                onCheckedChange={(v) => setField("cleanup_on_patrol", !!v)}
              />
              <Switch
                label="删除前备份"
                checked={cfg.cleanup_backup !== false}
                onCheckedChange={(v) => setField("cleanup_backup", !!v)}
              />
              <Switch
                label="演练模式（不真删）"
                checked={!!cfg.cleanup_dry_run}
                onCheckedChange={(v) => setField("cleanup_dry_run", !!v)}
              />
            </div>
          </LayerCard.Primary>
        </LayerCard>
      </div>
    </AdminShell>
  );
}
