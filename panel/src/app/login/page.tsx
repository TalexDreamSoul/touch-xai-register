"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, LayerCard, Surface, Text } from "@cloudflare/kumo";
import { useAuth } from "@/lib/auth";

export default function LoginPage() {
  const { login, authRequired } = useAuth();
  const router = useRouter();
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await login(token);
      router.replace("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Surface className="flex min-h-screen items-center justify-center p-6">
      <LayerCard className="w-full max-w-md">
        <LayerCard.Secondary>Grok Panel</LayerCard.Secondary>
        <LayerCard.Primary>
          <form className="flex flex-col gap-4" onSubmit={onSubmit}>
            <Text variant="heading3" as="h3">面板登录</Text>
            <Text variant="secondary" size="sm">
              {authRequired
                ? "输入 PANEL_TOKEN（或 Docker .env 中的 token）"
                : "当前未启用鉴权，任意提交即可进入"}
            </Text>
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="local-dev-token"
              autoComplete="current-password"
            />
            {error ? <Text variant="error">{error}</Text> : null}
            <Button type="submit" loading={busy} disabled={busy}>
              进入面板
            </Button>
          </form>
        </LayerCard.Primary>
      </LayerCard>
    </Surface>
  );
}
