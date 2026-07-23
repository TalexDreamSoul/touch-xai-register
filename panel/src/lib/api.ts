const TOKEN_KEY = "grok_panel_token";

export function getToken(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(TOKEN_KEY) || "";
}

export function setToken(t: string) {
  localStorage.setItem(TOKEN_KEY, t);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function errorMessage(data: unknown, fallback: string): string {
  if (data && typeof data === "object") {
    const rec = data as Record<string, unknown>;
    if (typeof rec.error === "string" && rec.error) return rec.error;
    if (typeof rec.message === "string" && rec.message) return rec.message;
  }
  return fallback;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers || {});
  if (!headers.has("Content-Type") && init.body && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  const tok = getToken();
  if (tok) headers.set("X-Panel-Token", tok);

  const res = await fetch(path, { ...init, headers });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      data = { raw: text };
    }
  }
  if (!res.ok) {
    throw new ApiError(res.status, errorMessage(data, res.statusText || "request failed"));
  }
  return data as T;
}

export function tokenQuery(): string {
  const t = getToken();
  return t ? `?token=${encodeURIComponent(t)}` : "";
}

export type Health = {
  ok: boolean;
  service: string;
  auth: boolean;
  time: string;
};

export type RunStatus = {
  status?: string;
  run_id?: string;
  target?: number;
  success?: number;
  fail?: number;
  phase?: string;
  phase_detail?: string;
  pid?: number;
  log_path?: string;
};

export type ClusterNode = {
  id: string;
  name: string;
  last_seen: string;
  online: boolean;
  busy: boolean;
  capacity: number;
  running_target: number;
  assigned: number;
  completed_total: number;
  last_error?: string;
  remote_addr?: string;
};

export type ClusterStatus = {
  role: string;
  node_id: string;
  node_name: string;
  public_token_set: boolean;
  master_url: string;
  heartbeat_sec: number;
  pool_target: number;
  assign_min: number;
  assign_max: number;
  auto_register: boolean;
  auto_upload: boolean;
  slave_connected: boolean;
  slave_last_error?: string;
  slave_last_ok?: string;
  last_assign: number;
  need: number;
  pool: {
    healthy: number;
    rate_limited: number;
    dead: number;
    disabled: number;
    total: number;
    quota_estimate: number;
  };
  nodes: ClusterNode[];
};

export type PanelConfig = Record<string, string | number | boolean | null | undefined>;
