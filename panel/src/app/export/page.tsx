"use client";

import { useState } from "react";
import { Button, Input, LayerCard, Text } from "@cloudflare/kumo";
import { AdminShell } from "@/components/admin-shell";
import { PageHeader } from "@/components/page-header";
import { api, tokenQuery } from "@/lib/api";

export default function ExportPage() {
  const [provider, setProvider] = useState("");
  const [email, setEmail] = useState("");
  const [preview, setPreview] = useState("");
  const [jobId, setJobId] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function doPreview() {
    setBusy(true);
    try {
      const d = await api<{ total?: number; matched?: number; ok?: boolean }>(
        "/api/export/preview",
        {
          method: "POST",
          body: JSON.stringify({ provider, email }),
        },
      );
      setPreview(JSON.stringify(d, null, 2));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "预览失败");
    } finally {
      setBusy(false);
    }
  }

  async function doStart() {
    setBusy(true);
    try {
      const d = await api<{ job_id?: string; id?: string }>("/api/export/start", {
        method: "POST",
        body: JSON.stringify({ provider, email }),
      });
      const id = d.job_id || d.id || "";
      setJobId(id);
      setMsg(id ? `导出已启动 ${id}` : "已启动");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "导出失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AdminShell>
      <PageHeader title="批量导出" description="按条件筛选远端号池，分卷 zip 下载" />
      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <LayerCard>
          <LayerCard.Secondary>筛选</LayerCard.Secondary>
          <LayerCard.Primary>
            <div className="flex flex-col gap-3">
              <Input
                placeholder="provider（可选）"
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
              />
              <Input
                placeholder="email 包含（可选）"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <div className="flex gap-2">
                <Button variant="secondary" loading={busy} onClick={() => void doPreview()}>
                  预览
                </Button>
                <Button loading={busy} onClick={() => void doStart()}>
                  开始导出
                </Button>
              </div>
              {msg ? <Text size="sm">{msg}</Text> : null}
              {jobId ? (
                <a
                  className="text-sm underline"
                  href={`/api/export/jobs/${jobId}/download-all${tokenQuery()}`}
                >
                  下载全部 zip
                </a>
              ) : null}
            </div>
          </LayerCard.Primary>
        </LayerCard>
        <LayerCard>
          <LayerCard.Secondary>预览结果</LayerCard.Secondary>
          <LayerCard.Primary>
            <pre className="max-h-80 overflow-auto text-xs">{preview || "—"}</pre>
          </LayerCard.Primary>
        </LayerCard>
      </div>
    </AdminShell>
  );
}
