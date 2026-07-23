"use client";

import { useState } from "react";
import { Button, LayerCard, Text } from "@cloudflare/kumo";
import { AdminShell } from "@/components/admin-shell";
import { PageHeader } from "@/components/page-header";
import { api, getToken } from "@/lib/api";

export default function UploadPage() {
  const [files, setFiles] = useState<FileList | null>(null);
  const [jobId, setJobId] = useState("");
  const [log, setLog] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function prepareAndStart() {
    if (!files || files.length === 0) {
      setMsg("请选择 .json / .zip");
      return;
    }
    setBusy(true);
    setMsg("");
    try {
      const fd = new FormData();
      Array.from(files).forEach((f) => fd.append("files", f));
      const tok = getToken();
      const res = await fetch("/api/transfer/prepare", {
        method: "POST",
        headers: tok ? { "X-Panel-Token": tok } : undefined,
        body: fd,
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        job_id?: string;
        id?: string;
      };
      if (!res.ok) throw new Error(data.error || "prepare failed");
      const id = data.job_id || data.id || "";
      if (!id) throw new Error("no job id");
      setJobId(id);
      await api(`/api/transfer/jobs/${id}/start`, { method: "POST", body: "{}" });
      setMsg(`上传任务已启动：${id}`);
      poll(id);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "上传失败");
    } finally {
      setBusy(false);
    }
  }

  function poll(id: string) {
    const t = setInterval(() => {
      void (async () => {
        try {
          const j = await api<Record<string, unknown>>(`/api/transfer/jobs/${id}`);
          const job =
            j.job && typeof j.job === "object"
              ? (j.job as Record<string, unknown>)
              : j;
          const logs = Array.isArray(job.logs)
            ? job.logs.filter((x): x is string => typeof x === "string")
            : [];
          setLog(logs.join("\n"));
          const st = typeof job.status === "string" ? job.status : "";
          if (st === "completed" || st === "failed" || st === "cancelled") {
            clearInterval(t);
          }
        } catch {
          clearInterval(t);
        }
      })();
    }, 1500);
  }

  return (
    <AdminShell>
      <PageHeader title="凭证上传" description="多文件 / zip 批量上传到 CPA Management" />
      <LayerCard className="mb-4">
        <LayerCard.Secondary>选择文件</LayerCard.Secondary>
        <LayerCard.Primary>
          <div className="flex flex-col gap-3">
            <input
              type="file"
              multiple
              accept=".json,.zip,application/json,application/zip"
              onChange={(e) => setFiles(e.target.files)}
            />
            <Button loading={busy} onClick={() => void prepareAndStart()}>
              准备并上传
            </Button>
            {jobId ? (
              <Text size="sm" variant="secondary">
                job: {jobId}
              </Text>
            ) : null}
            {msg ? <Text size="sm">{msg}</Text> : null}
          </div>
        </LayerCard.Primary>
      </LayerCard>
      <LayerCard>
        <LayerCard.Secondary>任务日志</LayerCard.Secondary>
        <LayerCard.Primary>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap text-xs">
            {log || "（等待任务）"}
          </pre>
        </LayerCard.Primary>
      </LayerCard>
    </AdminShell>
  );
}
