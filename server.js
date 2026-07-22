'use strict';

const path = require('path');
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const AdmZip = require('adm-zip');
const { fetch, Agent } = require('undici');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const EXPORT_DIR = path.join(DATA_DIR, 'exports');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const CACHE_PATH = path.join(DATA_DIR, 'upload-cache.json');
const PORT = Number(process.env.PORT || 8788);
const HOST = String(process.env.HOST || '0.0.0.0');
const PKG = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  } catch {
    return { name: 'touch-xai-register', version: '0.0.0' };
  }
})();
const APP_VERSION = String(PKG.version || '0.0.0');
const STARTED_AT = Date.now();
/** 已完成任务在内存中保留多久后清理（默认 2 小时） */
const JOB_TTL_MS = clampEnvMs(process.env.JOB_TTL_MS, 2 * 60 * 60 * 1000);
/** 导出产物目录保留多久（默认 7 天，仅清内存索引；磁盘文件需手动删） */
const EXPORT_TTL_MS = clampEnvMs(process.env.EXPORT_TTL_MS, 7 * 24 * 60 * 60 * 1000);

function clampEnvMs(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 60_000) return fallback;
  return Math.min(n, 30 * 24 * 60 * 60 * 1000);
}

const DEFAULT_CONFIG = {
  baseUrl: 'http://127.0.0.1:8317',
  managementKey: '',
  concurrency: 3,
  batchSize: 20,
  timeoutMs: 30000,
  retryLimit: 2,
  skipCached: true,
  // 导出：每批写盘+打 zip 的文件数；大号池必须分批，避免内存/单 zip 过大
  exportBatchSize: 500,
  exportConcurrency: 15,
};

/** @type {Map<string, Job>} */
const jobs = new Map();

/** @type {Map<string, ExportJob>} */
const exportJobs = new Map();

/** @type {{version:number, updatedAt:number, items: Record<string, any>}|null} */
let uploadCache = null;

function ensureDirs() {
  for (const dir of [DATA_DIR, TMP_DIR, EXPORT_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      concurrency: clampInt(raw.concurrency, 1, 100, DEFAULT_CONFIG.concurrency),
      batchSize: clampInt(raw.batchSize, 1, 500, DEFAULT_CONFIG.batchSize),
      timeoutMs: clampInt(raw.timeoutMs, 3000, 300000, DEFAULT_CONFIG.timeoutMs),
      retryLimit: clampInt(raw.retryLimit, 0, 10, DEFAULT_CONFIG.retryLimit),
      skipCached: raw.skipCached !== false,
      exportBatchSize: clampInt(raw.exportBatchSize, 50, 2000, DEFAULT_CONFIG.exportBatchSize),
      exportConcurrency: clampInt(raw.exportConcurrency, 1, 50, DEFAULT_CONFIG.exportConcurrency),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(next) {
  const cfg = {
    baseUrl: String(next.baseUrl || '').trim().replace(/\/+$/, ''),
    managementKey: String(next.managementKey || ''),
    concurrency: clampInt(next.concurrency, 1, 100, DEFAULT_CONFIG.concurrency),
    batchSize: clampInt(next.batchSize, 1, 500, DEFAULT_CONFIG.batchSize),
    timeoutMs: clampInt(next.timeoutMs, 3000, 300000, DEFAULT_CONFIG.timeoutMs),
    retryLimit: clampInt(next.retryLimit, 0, 10, DEFAULT_CONFIG.retryLimit),
    skipCached: next.skipCached !== false,
    exportBatchSize: clampInt(next.exportBatchSize, 50, 2000, DEFAULT_CONFIG.exportBatchSize),
    exportConcurrency: clampInt(next.exportConcurrency, 1, 50, DEFAULT_CONFIG.exportConcurrency),
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  return cfg;
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function normalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

/** 防止 path traversal：确保 candidate 落在 root 目录内 */
function isPathInside(root, candidate) {
  const rootAbs = path.resolve(root);
  const candAbs = path.resolve(candidate);
  return candAbs === rootAbs || candAbs.startsWith(rootAbs + path.sep);
}

function maskKey(key) {
  const s = String(key || '');
  if (!s) return '';
  if (s.length <= 6) return '*'.repeat(s.length);
  return `${s.slice(0, 2)}${'*'.repeat(Math.max(0, s.length - 4))}${s.slice(-2)}`;
}

function managementHeaders(key, extra = {}) {
  return {
    Authorization: `Bearer ${key}`,
    'X-Management-Key': key,
    ...extra,
  };
}

function contentHash(content) {
  return crypto.createHash('sha256').update(String(content || ''), 'utf8').digest('hex');
}

function cacheKey(baseUrl, name, hash) {
  return `${normalizeBaseUrl(baseUrl)}::${String(name || '').toLowerCase()}::${hash}`;
}

function loadUploadCache() {
  if (uploadCache) return uploadCache;
  try {
    if (!fs.existsSync(CACHE_PATH)) {
      uploadCache = { version: 1, updatedAt: 0, items: {} };
      return uploadCache;
    }
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    uploadCache = {
      version: 1,
      updatedAt: Number(raw.updatedAt || 0),
      items: raw.items && typeof raw.items === 'object' ? raw.items : {},
    };
  } catch {
    uploadCache = { version: 1, updatedAt: 0, items: {} };
  }
  return uploadCache;
}

function saveUploadCache() {
  const cache = loadUploadCache();
  cache.updatedAt = Date.now();
  // 控制体积：最多保留 20000 条，按时间淘汰最旧
  const entries = Object.entries(cache.items);
  if (entries.length > 20000) {
    entries.sort((a, b) => (a[1]?.uploadedAt || 0) - (b[1]?.uploadedAt || 0));
    cache.items = Object.fromEntries(entries.slice(entries.length - 20000));
  }
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache), 'utf8');
}

function rememberUpload(baseUrl, item) {
  const hash = item.hash || contentHash(item.content || '');
  const key = cacheKey(baseUrl, item.name, hash);
  const cache = loadUploadCache();
  cache.items[key] = {
    name: item.name,
    hash,
    baseUrl: normalizeBaseUrl(baseUrl),
    email: item.preview?.email || null,
    type: item.preview?.type || null,
    size: item.size || 0,
    uploadedAt: Date.now(),
  };
  // 批量成功时延迟写盘，避免频繁 fsync；这里简单节流
  if (!rememberUpload._timer) {
    rememberUpload._timer = setTimeout(() => {
      rememberUpload._timer = null;
      try {
        saveUploadCache();
      } catch (e) {
        console.error('save upload cache failed', e.message);
      }
    }, 400);
  }
}

function isCachedUpload(baseUrl, name, hash) {
  const cache = loadUploadCache();
  return Boolean(cache.items[cacheKey(baseUrl, name, hash)]);
}

function isCredentialJsonName(name) {
  return /\.json$/i.test(name) && !/(^|\/)(\.|__MACOSX)/.test(name);
}

function safeBasename(name) {
  return path.basename(String(name || 'credential.json')).replace(/[^\w.\-@+]+/g, '_');
}

function looksLikeCredential(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const keys = Object.keys(obj);
  const hints = [
    'access_token',
    'refresh_token',
    'token',
    'api_key',
    'api-key',
    'type',
    'provider',
    'email',
    'client_id',
    'expires_at',
    'id_token',
    'token_type',
    'private_key',
    'project_id',
    'auth',
  ];
  return hints.some((h) => keys.includes(h) || keys.some((k) => k.toLowerCase().includes(h.replace(/_/g, ''))));
}

function parseCredentialBuffer(buf, preferredName) {
  const text = buf.toString('utf8').replace(/^\uFEFF/, '').trim();
  if (!text) throw new Error('空文件');
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`JSON 解析失败: ${e.message}`);
  }
  if (!looksLikeCredential(data) && !Array.isArray(data)) {
    // still allow upload — CPA 侧会校验；这里只做弱校验提示
  }
  const name = safeBasename(preferredName || data.email || data.name || 'credential.json');
  const finalName = name.toLowerCase().endsWith('.json') ? name : `${name}.json`;
  return {
    name: finalName,
    content: JSON.stringify(data),
    size: Buffer.byteLength(JSON.stringify(data), 'utf8'),
    preview: {
      email: data.email || data.account || null,
      type: data.type || data.provider || data.account_type || null,
    },
  };
}

function extractFromZip(filePath, originalName) {
  const zip = new AdmZip(filePath);
  const entries = zip.getEntries();
  const items = [];
  const errors = [];

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const name = entry.entryName.replace(/\\/g, '/');
    if (!isCredentialJsonName(name)) continue;
    try {
      const buf = entry.getData();
      items.push(parseCredentialBuffer(buf, path.basename(name)));
    } catch (e) {
      errors.push({ name, error: e.message });
    }
  }

  if (!items.length) {
    throw new Error(`压缩包 ${originalName} 内未找到可用的 .json 凭证`);
  }
  return { items, errors };
}

async function collectLocalFolderJson(folderPath) {
  const items = [];
  const errors = [];

  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === '__MACOSX') continue;
        await walk(full);
      } else if (ent.isFile() && isCredentialJsonName(ent.name)) {
        try {
          const buf = await fsp.readFile(full);
          items.push(parseCredentialBuffer(buf, ent.name));
        } catch (e) {
          errors.push({ name: full, error: e.message });
        }
      }
    }
  }

  await walk(folderPath);
  return { items, errors };
}

/**
 * @typedef {Object} JobItem
 * @property {string} id
 * @property {string} name
 * @property {string} content
 * @property {number} size
 * @property {'pending'|'uploading'|'success'|'failed'|'skipped'} status
 * @property {number} attempts
 * @property {string|null} error
 * @property {number|null} startedAt
 * @property {number|null} finishedAt
 * @property {object|null} preview
 * @property {object|null} response
 */

/**
 * @typedef {Object} Job
 * @property {string} id
 * @property {'queued'|'running'|'paused'|'completed'|'cancelled'} status
 * @property {JobItem[]} items
 * @property {object} options
 * @property {number} createdAt
 * @property {number|null} startedAt
 * @property {number|null} finishedAt
 * @property {string[]} logs
 * @property {AbortController|null} controller
 * @property {Set<Function>} listeners
 */

function createJob(items, options = {}) {
  const cfg = loadConfig();
  const baseUrl = normalizeBaseUrl(options.baseUrl || cfg.baseUrl);
  const skipCached = options.skipCached === undefined ? cfg.skipCached !== false : options.skipCached !== false;
  let skipped = 0;

  /** @type {Job} */
  const job = {
    id: uid('job'),
    status: 'queued',
    items: items.map((it) => {
      const hash = it.hash || contentHash(it.content || '');
      const cached = skipCached && baseUrl ? isCachedUpload(baseUrl, it.name, hash) : false;
      if (cached) skipped += 1;
      return {
        id: uid('item'),
        name: it.name,
        content: cached ? null : it.content,
        hash,
        size: it.size || Buffer.byteLength(it.content || '', 'utf8'),
        status: cached ? 'skipped' : 'pending',
        attempts: 0,
        error: cached ? '本地缓存：此前已上传成功' : null,
        startedAt: null,
        finishedAt: cached ? Date.now() : null,
        preview: it.preview || null,
        response: null,
        fromCache: cached,
      };
    }),
    options: {
      concurrency: clampInt(options.concurrency ?? cfg.concurrency, 1, 100, cfg.concurrency),
      batchSize: clampInt(options.batchSize ?? cfg.batchSize, 1, 500, cfg.batchSize),
      timeoutMs: clampInt(options.timeoutMs ?? cfg.timeoutMs, 3000, 300000, cfg.timeoutMs),
      retryLimit: clampInt(options.retryLimit ?? cfg.retryLimit, 0, 10, cfg.retryLimit),
      baseUrl,
      managementKey: options.managementKey || cfg.managementKey,
      skipCached,
    },
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    logs: [],
    controller: null,
    listeners: new Set(),
    skippedOnCreate: skipped,
  };
  jobs.set(job.id, job);
  if (skipped) {
    logJob(job, `本地缓存命中 ${skipped} 个，已自动跳过`);
  }
  return job;
}

function jobSummary(job) {
  const counts = { pending: 0, uploading: 0, success: 0, failed: 0, skipped: 0 };
  for (const it of job.items) counts[it.status] = (counts[it.status] || 0) + 1;
  const total = job.items.length;
  const done = counts.success + counts.failed + counts.skipped;
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    options: {
      concurrency: job.options.concurrency,
      batchSize: job.options.batchSize,
      timeoutMs: job.options.timeoutMs,
      retryLimit: job.options.retryLimit,
      baseUrl: job.options.baseUrl,
      skipCached: job.options.skipCached !== false,
    },
    total,
    done,
    progress: total ? Math.round((done / total) * 100) : 0,
    counts,
    logs: job.logs.slice(-80),
    items: job.items.map((it) => ({
      id: it.id,
      name: it.name,
      size: it.size,
      status: it.status,
      attempts: it.attempts,
      error: it.error,
      startedAt: it.startedAt,
      finishedAt: it.finishedAt,
      preview: it.preview,
      fromCache: Boolean(it.fromCache),
      // 不回传 response/content，避免 SSE 膨胀
    })),
  };
}

function emitJob(job) {
  const payload = jobSummary(job);
  for (const fn of job.listeners) {
    try {
      fn(payload);
    } catch {
      /* ignore */
    }
  }
}

function logJob(job, msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  job.logs.push(line);
  if (job.logs.length > 300) job.logs.splice(0, job.logs.length - 300);
  emitJob(job);
}

async function uploadOne(job, item) {
  const { baseUrl, managementKey, timeoutMs } = job.options;
  if (!baseUrl) throw new Error('未配置 CPA 地址');
  if (!managementKey) throw new Error('未配置 Management Key');

  const url = `${baseUrl}/v0/management/auth-files?name=${encodeURIComponent(item.name)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: managementHeaders(managementKey, {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      }),
      body: item.content,
      signal: controller.signal,
      dispatcher: new Agent({ connectTimeout: timeoutMs, headersTimeout: timeoutMs, bodyTimeout: timeoutMs }),
    });

    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }

    if (!res.ok) {
      const msg =
        (body && (body.error || body.message || body.status)) ||
        `HTTP ${res.status} ${res.statusText}` ||
        text ||
        '上传失败';
      throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }

    item.response = body;
    return body;
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('请求超时/中止');
    const cause = e && e.cause ? String(e.cause.code || e.cause.message || e.cause) : '';
    if (e && e.message === 'fetch failed') {
      throw new Error(cause ? `无法连接 CPA (${cause})` : `无法连接 CPA: ${baseUrl}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function runJob(job, { onlyFailed = false } = {}) {
  if (job.status === 'running') return;
  if (!job.options.baseUrl || !job.options.managementKey) {
    job.status = 'completed';
    logJob(job, '缺少 baseUrl 或 managementKey，已中止');
    return;
  }

  job.status = 'running';
  job.startedAt = job.startedAt || Date.now();
  job.finishedAt = null;
  job.controller = new AbortController();

  const queue = job.items.filter((it) => {
    if (onlyFailed) return it.status === 'failed';
    return it.status === 'pending' || it.status === 'failed';
  });

  for (const it of queue) {
    it.status = 'pending';
    it.error = null;
    it.finishedAt = null;
  }
  emitJob(job);

  const { concurrency, batchSize, retryLimit } = job.options;
  // 每批数量 = 一批处理多少个；批内并行 = min(批大小, max(并发, 批大小))
  // 这样设置 batchSize=100 时会真正 100 路并发，而不是一个一个来
  const waveSize = Math.max(1, batchSize || concurrency || 1);
  const parallel = Math.min(100, Math.max(1, Math.max(concurrency || 1, waveSize)));
  const totalBatches = Math.max(1, Math.ceil(queue.length / waveSize));

  logJob(
    job,
    onlyFailed
      ? `开始重传失败项… 共 ${queue.length} · 每批 ${waveSize} · 并行 ${parallel}`
      : `开始上传，共 ${queue.length} 项 · 每批 ${waveSize} · 并行 ${parallel}`,
  );

  async function uploadItem(item) {
    if (job.controller?.signal.aborted || job.status !== 'running') return;
    item.status = 'uploading';
    item.startedAt = Date.now();
    emitJob(job);

    let lastErr = null;
    const maxAttempts = 1 + retryLimit;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (job.controller?.signal.aborted || job.status !== 'running') break;
      item.attempts = attempt;
      try {
        await uploadOne(job, item);
        item.status = 'success';
        item.error = null;
        item.finishedAt = Date.now();
        item.fromCache = false;
        rememberUpload(job.options.baseUrl, item);
        item.content = null;
        logJob(job, `✓ ${item.name}`);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        item.error = e && e.name === 'AbortError' ? '超时/中止' : e.message || String(e);
        if (attempt < maxAttempts) {
          logJob(job, `↻ ${item.name} 第 ${attempt} 次失败: ${item.error}，重试中…`);
          await sleep(300 * attempt);
        }
      }
    }

    if (lastErr) {
      item.status = 'failed';
      item.finishedAt = Date.now();
      logJob(job, `✗ ${item.name}: ${item.error}`);
    }
    emitJob(job);
  }

  async function runPool(items, limit) {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
      while (job.status === 'running') {
        if (job.controller?.signal.aborted) break;
        const idx = cursor++;
        if (idx >= items.length) break;
        await uploadItem(items[idx]);
      }
    });
    await Promise.all(workers);
  }

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    if (job.status !== 'running' || job.controller?.signal.aborted) break;
    const start = batchIndex * waveSize;
    const batch = queue.slice(start, start + waveSize);
    if (!batch.length) break;

    logJob(job, `批次 ${batchIndex + 1}/${totalBatches} 开始 · ${batch.length} 个 · 并行 ${Math.min(parallel, batch.length)}`);
    await runPool(batch, Math.min(parallel, batch.length));

    if (job.status === 'running' && !job.controller?.signal.aborted) {
      const ok = batch.filter((it) => it.status === 'success').length;
      const fail = batch.filter((it) => it.status === 'failed').length;
      logJob(job, `批次 ${batchIndex + 1}/${totalBatches} 完成 · 成功 ${ok} · 失败 ${fail}`);
    }
  }

  if (job.status === 'cancelled') {
    logJob(job, '任务已取消');
  } else {
    job.status = 'completed';
    job.finishedAt = Date.now();
    const s = jobSummary(job);
    logJob(job, `完成：成功 ${s.counts.success} / 失败 ${s.counts.failed} / 跳过 ${s.counts.skipped}`);
  }
  job.controller = null;
  emitJob(job);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function cpaRequest(cfg, method, apiPath, { body, headers, timeoutMs } = {}) {
  const baseUrl = normalizeBaseUrl(cfg.baseUrl);
  if (!baseUrl) throw new Error('未配置 CPA 地址');
  if (!cfg.managementKey) throw new Error('未配置 Management Key');
  const url = `${baseUrl}${apiPath.startsWith('/') ? apiPath : `/${apiPath}`}`;
  const waitMs = clampInt(timeoutMs ?? cfg.timeoutMs, 3000, 600000, cfg.timeoutMs || 30000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), waitMs);
  try {
    const res = await fetch(url, {
      method,
      headers: managementHeaders(cfg.managementKey, {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      }),
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      dispatcher: new Agent({ connectTimeout: waitMs, headersTimeout: waitMs, bodyTimeout: waitMs }),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    if (e && e.name === 'AbortError') {
      const err = new Error('连接超时');
      err.name = 'AbortError';
      throw err;
    }
    const cause = e && e.cause ? String(e.cause.code || e.cause.message || e.cause) : '';
    if (e && e.message === 'fetch failed') {
      throw new Error(cause ? `无法连接 CPA (${cause})` : `无法连接 CPA: ${baseUrl}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function managementErrorMessage(data, fallback = '请求失败') {
  if (!data) return fallback;
  if (typeof data === 'string') return data;
  const raw = data.error || data.message || data.status || fallback;
  if (typeof raw !== 'string') return JSON.stringify(raw);
  const lower = raw.toLowerCase();
  if (lower.includes('banned') || lower.includes('too many failed')) {
    return `${raw}（连续输错管理密钥会 ban IP 约 30 分钟；可重启 cli-proxy-api 清 ban）`;
  }
  if (lower.includes('invalid management key')) {
    return `${raw}（请确认用的是 CPA secret-key 明文，不是 manager 面板其它 key）`;
  }
  return raw;
}

// ---------- export (batched download) ----------

function normalizeExportFilters(input = {}) {
  const provider = String(input.provider || '')
    .trim()
    .toLowerCase();
  const emailContains = String(input.emailContains || input.email || '')
    .trim()
    .toLowerCase();
  const nameContains = String(input.nameContains || input.name || '')
    .trim()
    .toLowerCase();
  let disabled = null;
  if (input.disabled === true || input.disabled === 'true' || input.disabled === '1') disabled = true;
  if (input.disabled === false || input.disabled === 'false' || input.disabled === '0') disabled = false;
  const limit = input.limit === undefined || input.limit === null || input.limit === ''
    ? null
    : clampInt(input.limit, 1, 200000, null);
  return { provider, emailContains, nameContains, disabled, limit };
}

function slimAuthMeta(f) {
  return {
    name: f.name || f.id || null,
    provider: f.provider || f.type || null,
    type: f.type || null,
    status: f.status || null,
    email: f.email || null,
    disabled: Boolean(f.disabled),
    size: f.size ?? null,
    success: f.success ?? 0,
    failed: f.failed ?? 0,
  };
}

function matchAuthFilter(file, filters) {
  if (!file?.name) return false;
  if (filters.provider) {
    const p = String(file.provider || file.type || '').toLowerCase();
    if (p !== filters.provider && !p.includes(filters.provider)) return false;
  }
  if (filters.emailContains) {
    const email = String(file.email || '').toLowerCase();
    if (!email.includes(filters.emailContains)) return false;
  }
  if (filters.nameContains) {
    const name = String(file.name || '').toLowerCase();
    if (!name.includes(filters.nameContains)) return false;
  }
  if (filters.disabled === true && !file.disabled) return false;
  if (filters.disabled === false && file.disabled) return false;
  return true;
}

function providerStats(files) {
  const map = new Map();
  for (const f of files) {
    const key = String(f.provider || f.type || 'unknown').toLowerCase() || 'unknown';
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([provider, count]) => ({ provider, count }));
}

async function listRemoteAuthMetas(cfg, { timeoutMs } = {}) {
  const waitMs = clampInt(timeoutMs ?? Math.max(cfg.timeoutMs || 30000, 120000), 10000, 600000, 120000);
  const result = await cpaRequest(cfg, 'GET', '/v0/management/auth-files', { timeoutMs: waitMs });
  if (!result.ok) {
    const err = new Error(managementErrorMessage(result.data, `拉取列表失败 HTTP ${result.status}`));
    err.status = result.status;
    err.data = result.data;
    throw err;
  }
  const files = Array.isArray(result.data?.files) ? result.data.files : [];
  return files.map(slimAuthMeta).filter((f) => f.name && /\.json$/i.test(f.name));
}

function filterAuthMetas(files, filters) {
  const f = normalizeExportFilters(filters);
  let matched = files.filter((file) => matchAuthFilter(file, f));
  if (f.limit) matched = matched.slice(0, f.limit);
  return { filters: f, matched, totalRemote: files.length };
}

async function downloadAuthFileRaw(cfg, name, { timeoutMs, signal } = {}) {
  const baseUrl = normalizeBaseUrl(cfg.baseUrl);
  if (!baseUrl) throw new Error('未配置 CPA 地址');
  if (!cfg.managementKey) throw new Error('未配置 Management Key');
  if (!name || !/\.json$/i.test(name)) throw new Error('无效文件名');

  const waitMs = clampInt(timeoutMs ?? cfg.timeoutMs, 3000, 300000, cfg.timeoutMs || 30000);
  const url = `${baseUrl}/v0/management/auth-files/download?name=${encodeURIComponent(name)}`;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), waitMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: managementHeaders(cfg.managementKey, { Accept: 'application/json' }),
      signal: controller.signal,
      dispatcher: new Agent({ connectTimeout: waitMs, headersTimeout: waitMs, bodyTimeout: waitMs }),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = JSON.parse(buf.toString('utf8'));
        msg = managementErrorMessage(j, msg);
      } catch {
        const t = buf.toString('utf8').slice(0, 200);
        if (t) msg = t;
      }
      throw new Error(msg);
    }
    return buf;
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('下载超时/中止');
    const cause = e && e.cause ? String(e.cause.code || e.cause.message || e.cause) : '';
    if (e && e.message === 'fetch failed') {
      throw new Error(cause ? `无法连接 CPA (${cause})` : `无法连接 CPA: ${baseUrl}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

function exportJobSummary(job) {
  const counts = job.counts || { pending: 0, downloading: 0, success: 0, failed: 0, skipped: 0 };
  const total = job.total || 0;
  const done = (counts.success || 0) + (counts.failed || 0) + (counts.skipped || 0);
  return {
    id: job.id,
    kind: 'export',
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    filters: job.filters,
    options: {
      batchSize: job.options.batchSize,
      concurrency: job.options.concurrency,
      timeoutMs: job.options.timeoutMs,
      retryLimit: job.options.retryLimit,
      baseUrl: job.options.baseUrl,
      keepFiles: Boolean(job.options.keepFiles),
    },
    total,
    totalRemote: job.totalRemote || 0,
    done,
    progress: total ? Math.round((done / total) * 100) : 0,
    counts,
    currentBatch: job.currentBatch || 0,
    totalBatches: job.totalBatches || 0,
    parts: (job.parts || []).map((p) => ({
      index: p.index,
      filename: p.filename,
      files: p.files,
      success: p.success,
      failed: p.failed,
      bytes: p.bytes,
      path: p.relPath,
    })),
    failures: (job.failures || []).slice(-100),
    logs: (job.logs || []).slice(-100),
    outputDir: job.relDir || null,
    manifest: job.manifestName || null,
  };
}

function emitExportJob(job) {
  const payload = exportJobSummary(job);
  for (const fn of job.listeners) {
    try {
      fn(payload);
    } catch {
      /* ignore */
    }
  }
}

function logExportJob(job, msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  job.logs.push(line);
  if (job.logs.length > 400) job.logs.splice(0, job.logs.length - 400);
  emitExportJob(job);
}

function createExportJob(metas, options = {}, filters = {}, totalRemote = 0) {
  const cfg = loadConfig();
  const baseUrl = normalizeBaseUrl(options.baseUrl || cfg.baseUrl);
  const batchSize = clampInt(
    options.batchSize ?? options.exportBatchSize ?? cfg.exportBatchSize,
    50,
    2000,
    cfg.exportBatchSize,
  );
  const concurrency = clampInt(
    options.concurrency ?? options.exportConcurrency ?? cfg.exportConcurrency,
    1,
    50,
    cfg.exportConcurrency,
  );
  const timeoutMs = clampInt(options.timeoutMs ?? cfg.timeoutMs, 3000, 300000, cfg.timeoutMs);
  const retryLimit = clampInt(options.retryLimit ?? cfg.retryLimit, 0, 10, cfg.retryLimit);
  const id = uid('export');
  const dirName = id;
  const absDir = path.join(EXPORT_DIR, dirName);
  fs.mkdirSync(absDir, { recursive: true });
  fs.mkdirSync(path.join(absDir, 'files'), { recursive: true });

  /** @type {ExportJob} */
  const job = {
    id,
    status: 'queued',
    items: metas.map((m) => ({
      name: m.name,
      provider: m.provider,
      email: m.email,
      disabled: Boolean(m.disabled),
      status: 'pending',
      attempts: 0,
      error: null,
      size: 0,
    })),
    filters: normalizeExportFilters(filters),
    options: {
      baseUrl,
      managementKey: options.managementKey || cfg.managementKey,
      batchSize,
      concurrency,
      timeoutMs,
      retryLimit,
      keepFiles: options.keepFiles === true || options.keepFiles === 'true' || options.keepFiles === 1,
    },
    total: metas.length,
    totalRemote,
    counts: { pending: metas.length, downloading: 0, success: 0, failed: 0, skipped: 0 },
    currentBatch: 0,
    totalBatches: Math.max(1, Math.ceil(metas.length / batchSize)),
    parts: [],
    failures: [],
    logs: [],
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    controller: null,
    listeners: new Set(),
    absDir,
    relDir: path.posix.join('data', 'exports', dirName),
    filesDir: path.join(absDir, 'files'),
    manifestName: 'manifest.json',
  };
  exportJobs.set(job.id, job);
  return job;
}

function recountExport(job) {
  const counts = { pending: 0, downloading: 0, success: 0, failed: 0, skipped: 0 };
  for (const it of job.items) counts[it.status] = (counts[it.status] || 0) + 1;
  job.counts = counts;
  return counts;
}

async function runExportJob(job, { onlyFailed = false } = {}) {
  if (job.status === 'running') return;
  if (!job.options.baseUrl || !job.options.managementKey) {
    job.status = 'completed';
    logExportJob(job, '缺少 baseUrl 或 managementKey，已中止');
    return;
  }

  job.status = 'running';
  job.startedAt = job.startedAt || Date.now();
  job.finishedAt = null;
  job.controller = new AbortController();
  if (!onlyFailed) job.parts = [];
  job.failures = onlyFailed ? job.failures.filter((f) => f.retried) : [];

  const queue = job.items.filter((it) => {
    if (onlyFailed) return it.status === 'failed';
    return it.status === 'pending' || it.status === 'failed';
  });
  for (const it of queue) {
    it.status = 'pending';
    it.error = null;
  }
  recountExport(job);

  const { batchSize, concurrency, retryLimit, timeoutMs, keepFiles } = job.options;
  const waveSize = Math.max(50, batchSize || 500);
  job.totalBatches = Math.max(1, Math.ceil(queue.length / waveSize));
  logExportJob(
    job,
    onlyFailed
      ? `开始重试失败项… 共 ${queue.length} · 每批 ${waveSize} · 并行 ${concurrency}`
      : `开始导出，共 ${queue.length} 项（远端列表 ${job.totalRemote}）· 每批 ${waveSize} · 并行 ${concurrency}`,
  );
  emitExportJob(job);

  const cfg = {
    baseUrl: job.options.baseUrl,
    managementKey: job.options.managementKey,
    timeoutMs,
  };

  async function downloadItem(item) {
    if (job.controller?.signal.aborted || job.status !== 'running') return;
    item.status = 'downloading';
    recountExport(job);
    emitExportJob(job);

    let lastErr = null;
    const maxAttempts = 1 + retryLimit;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (job.controller?.signal.aborted || job.status !== 'running') break;
      item.attempts = attempt;
      try {
        const buf = await downloadAuthFileRaw(cfg, item.name, {
          timeoutMs,
          signal: job.controller.signal,
        });
        const safeName = safeBasename(item.name);
        const dest = path.join(job.filesDir, safeName);
        await fsp.writeFile(dest, buf);
        item.status = 'success';
        item.error = null;
        item.size = buf.length;
        item.localPath = dest;
        item.localName = safeName;
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        item.error = e && e.name === 'AbortError' ? '超时/中止' : e.message || String(e);
        if (attempt < maxAttempts) {
          logExportJob(job, `↻ ${item.name} 第 ${attempt} 次失败: ${item.error}，重试…`);
          await sleep(250 * attempt);
        }
      }
    }

    if (lastErr) {
      item.status = 'failed';
      job.failures.push({ name: item.name, error: item.error, at: Date.now() });
      if (job.failures.length > 500) job.failures.splice(0, job.failures.length - 500);
      logExportJob(job, `✗ ${item.name}: ${item.error}`);
    }
    recountExport(job);
    // 节流 emit：成功时每 10 个刷一次，失败立即刷
    if (item.status === 'failed' || (job.counts.success + job.counts.failed) % 10 === 0) {
      emitExportJob(job);
    }
  }

  async function runPool(items, limit) {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
      while (job.status === 'running') {
        if (job.controller?.signal.aborted) break;
        const idx = cursor++;
        if (idx >= items.length) break;
        await downloadItem(items[idx]);
      }
    });
    await Promise.all(workers);
  }

  for (let batchIndex = 0; batchIndex < job.totalBatches; batchIndex++) {
    if (job.status !== 'running' || job.controller?.signal.aborted) break;
    const start = batchIndex * waveSize;
    const batch = queue.slice(start, start + waveSize);
    if (!batch.length) break;

    job.currentBatch = batchIndex + 1;
    logExportJob(
      job,
      `批次 ${batchIndex + 1}/${job.totalBatches} 开始 · ${batch.length} 个 · 并行 ${Math.min(concurrency, batch.length)}`,
    );
    emitExportJob(job);

    await runPool(batch, Math.min(concurrency, batch.length));

    if (job.status !== 'running' && job.status !== 'cancelled') break;

    // 本批成功文件打 zip（失败的不进包，避免空壳）
    const okItems = batch.filter((it) => it.status === 'success' && it.localPath);
    if (okItems.length) {
      const partIndex = job.parts.length + 1;
      const partName = `part-${String(partIndex).padStart(3, '0')}.zip`;
      const partAbs = path.join(job.absDir, partName);
      try {
        const zip = new AdmZip();
        for (const it of okItems) {
          zip.addLocalFile(it.localPath, '', it.localName || safeBasename(it.name));
        }
        zip.writeZip(partAbs);
        const st = await fsp.stat(partAbs);
        job.parts.push({
          index: partIndex,
          filename: partName,
          files: okItems.length,
          success: okItems.length,
          failed: batch.filter((it) => it.status === 'failed').length,
          bytes: st.size,
          absPath: partAbs,
          relPath: path.posix.join(job.relDir, partName),
        });
        logExportJob(
          job,
          `批次 ${batchIndex + 1}/${job.totalBatches} 打包 ${partName} · ${okItems.length} 文件 · ${(st.size / 1024 / 1024).toFixed(2)} MB`,
        );

        // 默认删掉已打进 zip 的单文件，省磁盘；keepFiles=true 时保留
        if (!keepFiles) {
          await Promise.all(
            okItems.map(async (it) => {
              try {
                await fsp.unlink(it.localPath);
              } catch {
                /* ignore */
              }
              it.localPath = null;
            }),
          );
        }
      } catch (e) {
        logExportJob(job, `批次 ${batchIndex + 1} 打包失败: ${e.message}`);
      }
    } else {
      logExportJob(job, `批次 ${batchIndex + 1}/${job.totalBatches} 无成功文件，跳过打包`);
    }

    recountExport(job);
    emitExportJob(job);

    // 批次间短暂让出事件循环，避免长时间占满
    await sleep(50);
  }

  // manifest
  try {
    const manifest = {
      id: job.id,
      createdAt: job.createdAt,
      finishedAt: Date.now(),
      filters: job.filters,
      totalRemote: job.totalRemote,
      total: job.total,
      counts: recountExport(job),
      parts: job.parts.map((p) => ({
        index: p.index,
        filename: p.filename,
        files: p.files,
        bytes: p.bytes,
      })),
      failures: job.failures.slice(-500),
      baseUrl: job.options.baseUrl,
    };
    await fsp.writeFile(path.join(job.absDir, job.manifestName), JSON.stringify(manifest, null, 2), 'utf8');
  } catch (e) {
    logExportJob(job, `写 manifest 失败: ${e.message}`);
  }

  if (job.status === 'cancelled') {
    logExportJob(job, '导出任务已取消');
  } else {
    job.status = 'completed';
    job.finishedAt = Date.now();
    const c = recountExport(job);
    logExportJob(
      job,
      `导出完成：成功 ${c.success} / 失败 ${c.failed} · zip 分卷 ${job.parts.length} 个`,
    );
  }
  job.controller = null;
  emitExportJob(job);
}

async function resolveExportCfg(body = {}) {
  const cfg = loadConfig();
  const next = { ...cfg, ...body };
  if (body.managementKey && String(body.managementKey).includes('*')) {
    next.managementKey = cfg.managementKey;
  }
  if (body.baseUrl) next.baseUrl = normalizeBaseUrl(body.baseUrl);
  return next;
}

// ---------- app ----------
ensureDirs();
const app = express();
const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 80 * 1024 * 1024, files: 200 },
});

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(ROOT, 'public')));

// ===== Grok 注册面板反向代理：/panel -> grok panel（默认 127.0.0.1:8787）=====
const PANEL_TARGET = String(process.env.PANEL_TARGET || 'http://127.0.0.1:8787').replace(/\/+$/, '');

app.get('/panel', (req, res, next) => (req.path === '/panel' ? res.redirect('/panel/') : next()));
app.use('/panel', (req, res) => {
  let target;
  try {
    target = new URL(PANEL_TARGET);
  } catch {
    res.status(500).json({ error: `PANEL_TARGET 配置非法: ${PANEL_TARGET}` });
    return;
  }
  const proxyReq = http.request(
    {
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: req.url, // express 挂载后已剥掉 /panel 前缀
      method: req.method,
      headers: { ...req.headers, host: target.host },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );
  proxyReq.on('error', () => {
    if (!res.headersSent) {
      res.status(502).send('Grok 注册面板未启动：请先在 grok-register 下运行 `grok panel`（默认 :8787），或设置 PANEL_TARGET 指向面板地址。');
    } else {
      res.end();
    }
  });
  req.pipe(proxyReq);
});

app.get('/api/health', (_req, res) => {
  const uploadRunning = [...jobs.values()].filter((j) => j.status === 'running').length;
  const exportRunning = [...exportJobs.values()].filter((j) => j.status === 'running').length;
  res.json({
    ok: true,
    service: 'touch-xai-register',
    version: APP_VERSION,
    time: new Date().toISOString(),
    startedAt: new Date(STARTED_AT).toISOString(),
    uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000),
    jobs: { upload: jobs.size, export: exportJobs.size, uploadRunning, exportRunning },
    node: process.version,
  });
});

app.get('/api/version', (_req, res) => {
  res.json({
    name: PKG.name || 'touch-xai-register',
    version: APP_VERSION,
    description: PKG.description || '',
  });
});

app.get('/api/config', (_req, res) => {
  const cfg = loadConfig();
  res.json({
    ...cfg,
    managementKey: maskKey(cfg.managementKey),
    managementKeyMasked: maskKey(cfg.managementKey),
    version: APP_VERSION,
  });
});

app.put('/api/config', (req, res) => {
  try {
    const current = loadConfig();
    const body = req.body || {};
    const next = {
      baseUrl: body.baseUrl ?? current.baseUrl,
      managementKey:
        body.managementKey === undefined || body.managementKey === '' || body.managementKey === current.managementKey
          ? body.managementKey === ''
            ? ''
            : body.managementKey || current.managementKey
          : body.managementKey,
      concurrency: body.concurrency ?? current.concurrency,
      batchSize: body.batchSize ?? current.batchSize,
      timeoutMs: body.timeoutMs ?? current.timeoutMs,
      retryLimit: body.retryLimit ?? current.retryLimit,
      skipCached: body.skipCached === undefined ? current.skipCached : body.skipCached !== false,
      exportBatchSize: body.exportBatchSize ?? current.exportBatchSize,
      exportConcurrency: body.exportConcurrency ?? current.exportConcurrency,
    };
    // 如果前端传了完整 key（非 mask），覆盖；传空字符串清空
    if (typeof body.managementKey === 'string') {
      if (
        body.managementKey.includes('*') &&
        body.managementKey ===
          (current.managementKey
            ? `${current.managementKey.slice(0, 2)}${'*'.repeat(Math.max(0, current.managementKey.length - 4))}${current.managementKey.slice(-2)}`
            : '')
      ) {
        next.managementKey = current.managementKey;
      } else {
        next.managementKey = body.managementKey;
      }
    }
    const saved = saveConfig(next);
    res.json({
      ...saved,
      managementKey: maskKey(saved.managementKey),
      managementKeyMasked: maskKey(saved.managementKey),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/upload-cache', (_req, res) => {
  const cache = loadUploadCache();
  const items = Object.values(cache.items || {});
  res.json({
    total: items.length,
    updatedAt: cache.updatedAt || 0,
    sample: items
      .sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0))
      .slice(0, 20)
      .map((it) => ({
        name: it.name,
        email: it.email,
        type: it.type,
        baseUrl: it.baseUrl,
        uploadedAt: it.uploadedAt,
      })),
  });
});

app.delete('/api/upload-cache', (req, res) => {
  try {
    const name = String(req.query.name || '').trim().toLowerCase();
    const cache = loadUploadCache();
    if (!name) {
      cache.items = {};
      saveUploadCache();
      return res.json({ ok: true, cleared: 'all', total: 0 });
    }
    let removed = 0;
    for (const [k, v] of Object.entries(cache.items)) {
      if (String(v?.name || '').toLowerCase() === name || k.toLowerCase().includes(`::${name}::`)) {
        delete cache.items[k];
        removed += 1;
      }
    }
    saveUploadCache();
    res.json({ ok: true, removed, total: Object.keys(cache.items).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/test-connection', async (req, res) => {
  try {
    const cfg = { ...loadConfig(), ...(req.body || {}) };
    if (req.body?.managementKey && String(req.body.managementKey).includes('*')) {
      cfg.managementKey = loadConfig().managementKey;
    }
    // auth-files 在大号池上很慢（可能数分钟）；连通性探测用轻量接口
    const result = await cpaRequest(cfg, 'GET', '/v0/management/debug', { timeoutMs: 20000 });
    if (!result.ok) {
      return res.status(result.status || 502).json({
        ok: false,
        status: result.status,
        error: managementErrorMessage(result.data, '连接失败'),
        data: result.data,
      });
    }
    res.json({
      ok: true,
      status: result.status,
      endpoint: '/v0/management/debug',
      debug: result.data,
      hint: '密钥有效。远端凭证列表很大时不要用 auth-files 做连通测试。',
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.name === 'AbortError' ? '连接超时' : e.message });
  }
});

app.get('/api/remote-auth-files', async (req, res) => {
  try {
    // 大号池全量 auth-files 可达数百 MB～数 GB，本地 Node 会 OOM。
    // 默认不再拉取全量列表；需要时用 CPA 面板查看。
    const force = String(req.query.force || '') === '1';
    if (!force) {
      return res.json({
        total: null,
        truncated: true,
        disabled: true,
        files: [],
        message:
          '远端凭证池过大，已禁用全量列表以防内存溢出。上传功能不受影响；请到 CPA 管理面板查看完整列表。',
      });
    }

    const cfg = loadConfig();
    const limit = clampInt(req.query.limit, 1, 100, 50);
    const result = await cpaRequest(cfg, 'GET', '/v0/management/auth-files', {
      timeoutMs: Math.min(Math.max(cfg.timeoutMs || 30000, 60000), 120000),
    });
    if (!result.ok) {
      return res.status(result.status || 502).json({
        error: managementErrorMessage(result.data, '拉取失败'),
        data: result.data,
      });
    }
    const files = Array.isArray(result.data?.files) ? result.data.files : [];
    // 立刻丢掉多余字段，只保留摘要，尽快让大数组可 GC
    const slim = files.slice(0, limit).map((f) => ({
      name: f.name || f.id || null,
      provider: f.provider || f.type || null,
      status: f.status || null,
      email: f.email || null,
      success: f.success ?? 0,
      failed: f.failed ?? 0,
      disabled: f.disabled ?? false,
    }));
    res.json({
      total: files.length,
      truncated: files.length > limit,
      files: slim,
    });
  } catch (e) {
    res.status(500).json({
      error: e.name === 'AbortError' ? '拉取超时（凭证太多）' : e.message,
    });
  }
});

app.post('/api/prepare', upload.array('files', 200), async (req, res) => {
  const tempFiles = req.files || [];
  try {
    const items = [];
    const errors = [];

    // 1) 上传的文件 / zip
    for (const f of tempFiles) {
      const original = f.originalname || f.filename;
      const lower = original.toLowerCase();
      try {
        if (lower.endsWith('.zip')) {
          const extracted = extractFromZip(f.path, original);
          items.push(...extracted.items);
          errors.push(...extracted.errors);
        } else if (lower.endsWith('.json')) {
          const buf = await fsp.readFile(f.path);
          items.push(parseCredentialBuffer(buf, original));
        } else {
          errors.push({ name: original, error: '仅支持 .json / .zip' });
        }
      } catch (e) {
        errors.push({ name: original, error: e.message });
      }
    }

    // 2) 可选：本地文件夹路径（服务端可访问）
    const folderPath = (req.body.folderPath || '').trim();
    if (folderPath) {
      const abs = path.resolve(folderPath);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
        errors.push({ name: folderPath, error: '文件夹不存在或不可访问' });
      } else {
        const collected = await collectLocalFolderJson(abs);
        items.push(...collected.items);
        errors.push(...collected.errors);
      }
    }

    // 3) 可选：直接粘贴 JSON 数组/对象
    if (req.body.rawJson) {
      try {
        const parsed = JSON.parse(req.body.rawJson);
        const list = Array.isArray(parsed) ? parsed : [parsed];
        list.forEach((obj, i) => {
          try {
            const buf = Buffer.from(JSON.stringify(obj), 'utf8');
            const name = obj.email || obj.name || `pasted-${i + 1}.json`;
            items.push(parseCredentialBuffer(buf, name));
          } catch (e) {
            errors.push({ name: `raw[${i}]`, error: e.message });
          }
        });
      } catch (e) {
        errors.push({ name: 'rawJson', error: e.message });
      }
    }

    // 去重（同名保留最后一次）
    const map = new Map();
    for (const it of items) map.set(it.name.toLowerCase(), it);
    const unique = [...map.values()];

    if (!unique.length) {
      return res.status(400).json({ error: '没有可上传的凭证文件', errors });
    }

    const options = {
      concurrency: req.body.concurrency,
      batchSize: req.body.batchSize,
      timeoutMs: req.body.timeoutMs,
      retryLimit: req.body.retryLimit,
      baseUrl: req.body.baseUrl,
      managementKey:
        req.body.managementKey && !String(req.body.managementKey).includes('*')
          ? req.body.managementKey
          : undefined,
      skipCached:
        req.body.skipCached === undefined
          ? undefined
          : !(req.body.skipCached === 'false' || req.body.skipCached === false || req.body.skipCached === '0'),
    };

    const job = createJob(unique, options);
    const summary = jobSummary(job);
    res.json({
      jobId: job.id,
      total: summary.total,
      skipped: summary.counts.skipped || 0,
      pending: summary.counts.pending || 0,
      counts: summary.counts,
      errors,
      items: summary.items,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    await Promise.all(
      tempFiles.map(async (f) => {
        try {
          await fsp.unlink(f.path);
        } catch {
          /* ignore */
        }
      }),
    );
  }
});

app.post('/api/jobs/:id/start', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  if (job.status === 'running') return res.json(jobSummary(job));
  // fire and forget
  runJob(job, { onlyFailed: false }).catch((e) => logJob(job, `任务异常: ${e.message}`));
  res.json(jobSummary(job));
});

app.post('/api/jobs/:id/retry-failed', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  if (job.status === 'running') return res.status(409).json({ error: '任务进行中' });
  const failed = job.items.filter((it) => it.status === 'failed');
  if (!failed.length) return res.json({ ...jobSummary(job), message: '没有失败项' });
  runJob(job, { onlyFailed: true }).catch((e) => logJob(job, `重传异常: ${e.message}`));
  res.json(jobSummary(job));
});

app.post('/api/jobs/:id/cancel', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  if (job.status === 'running') {
    job.status = 'cancelled';
    job.controller?.abort();
    logJob(job, '收到取消请求');
  }
  res.json(jobSummary(job));
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  res.json(jobSummary(job));
});

app.get('/api/jobs/:id/events', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  send(jobSummary(job));
  job.listeners.add(send);

  const heartbeat = setInterval(() => {
    res.write(`: ping\n\n`);
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    job.listeners.delete(send);
  });
});

app.get('/api/jobs', (_req, res) => {
  const list = [...jobs.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 30)
    .map((j) => {
      const s = jobSummary(j);
      return {
        id: s.id,
        status: s.status,
        total: s.total,
        done: s.done,
        progress: s.progress,
        counts: s.counts,
        createdAt: s.createdAt,
        finishedAt: s.finishedAt,
      };
    });
  res.json({ jobs: list });
});


// ---------- export APIs ----------
app.post('/api/export/preview', async (req, res) => {
  try {
    const cfg = await resolveExportCfg(req.body || {});
    const filters = normalizeExportFilters(req.body || {});
    const metas = await listRemoteAuthMetas(cfg, {
      timeoutMs: Math.min(Math.max(cfg.timeoutMs || 30000, 120000), 300000),
    });
    const { matched, totalRemote } = filterAuthMetas(metas, filters);
    const batchSize = clampInt(
      req.body?.batchSize ?? req.body?.exportBatchSize ?? cfg.exportBatchSize,
      50,
      2000,
      cfg.exportBatchSize,
    );
    res.json({
      ok: true,
      totalRemote,
      matched: matched.length,
      filters,
      providers: providerStats(metas),
      matchedProviders: providerStats(matched),
      sample: matched.slice(0, 20),
      estimatedBatches: Math.max(1, Math.ceil(matched.length / batchSize)),
      batchSize,
      concurrency: clampInt(
        req.body?.concurrency ?? req.body?.exportConcurrency ?? cfg.exportConcurrency,
        1,
        50,
        cfg.exportConcurrency,
      ),
      hint:
        matched.length > 2000
          ? '匹配数量较大，将按批次下载并打成多个 zip 分卷，请耐心等待。'
          : matched.length
            ? '可以开始导出。'
            : '没有匹配的凭证，请调整筛选条件。',
    });
  } catch (e) {
    res.status(e.status || 500).json({
      ok: false,
      error: e.name === 'AbortError' ? '拉取列表超时（凭证太多）' : e.message,
      data: e.data,
    });
  }
});

app.post('/api/export/start', async (req, res) => {
  try {
    const body = req.body || {};
    const cfg = await resolveExportCfg(body);
    if (!cfg.baseUrl || !cfg.managementKey) {
      return res.status(400).json({ error: '请先配置 Base URL 与 Management Key' });
    }

    // 同时只允许一个导出任务跑，避免把远端/本机打爆
    const running = [...exportJobs.values()].find((j) => j.status === 'running');
    if (running) {
      return res.status(409).json({
        error: `已有导出任务进行中: ${running.id}`,
        jobId: running.id,
        job: exportJobSummary(running),
      });
    }

    const filters = normalizeExportFilters(body);
    const logHint = `筛选 provider=${filters.provider || '*'} email*=${filters.emailContains || '*'} name*=${filters.nameContains || '*'} limit=${filters.limit || 'all'}`;
    const metasAll = await listRemoteAuthMetas(cfg, {
      timeoutMs: Math.min(Math.max(cfg.timeoutMs || 30000, 120000), 300000),
    });
    const { matched, totalRemote } = filterAuthMetas(metasAll, filters);
    if (!matched.length) {
      return res.status(400).json({
        error: '没有匹配的凭证可导出',
        totalRemote,
        filters,
        providers: providerStats(metasAll),
      });
    }

    const job = createExportJob(
      matched,
      {
        baseUrl: cfg.baseUrl,
        managementKey: cfg.managementKey,
        batchSize: body.batchSize ?? body.exportBatchSize ?? cfg.exportBatchSize,
        concurrency: body.concurrency ?? body.exportConcurrency ?? cfg.exportConcurrency,
        timeoutMs: body.timeoutMs ?? cfg.timeoutMs,
        retryLimit: body.retryLimit ?? cfg.retryLimit,
        keepFiles: body.keepFiles,
      },
      filters,
      totalRemote,
    );
    logExportJob(job, `任务创建 · ${logHint} · 匹配 ${matched.length}/${totalRemote}`);
    runExportJob(job, { onlyFailed: false }).catch((e) => logExportJob(job, `导出异常: ${e.message}`));
    res.json(exportJobSummary(job));
  } catch (e) {
    res.status(e.status || 500).json({
      error: e.name === 'AbortError' ? '拉取列表超时（凭证太多）' : e.message,
      data: e.data,
    });
  }
});

app.get('/api/export/jobs', (_req, res) => {
  const list = [...exportJobs.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 30)
    .map((j) => exportJobSummary(j));
  res.json({ jobs: list });
});

app.get('/api/export/jobs/:id', (req, res) => {
  const job = exportJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '导出任务不存在' });
  res.json(exportJobSummary(job));
});

app.get('/api/export/jobs/:id/events', (req, res) => {
  const job = exportJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '导出任务不存在' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  send(exportJobSummary(job));
  job.listeners.add(send);

  const heartbeat = setInterval(() => {
    res.write(`: ping\n\n`);
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    job.listeners.delete(send);
  });
});

app.post('/api/export/jobs/:id/cancel', (req, res) => {
  const job = exportJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '导出任务不存在' });
  if (job.status === 'running') {
    job.status = 'cancelled';
    job.controller?.abort();
    logExportJob(job, '收到取消请求');
  }
  res.json(exportJobSummary(job));
});

app.post('/api/export/jobs/:id/retry-failed', async (req, res) => {
  const job = exportJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '导出任务不存在' });
  if (job.status === 'running') return res.status(409).json({ error: '任务进行中' });
  const failed = job.items.filter((it) => it.status === 'failed');
  if (!failed.length) return res.json({ ...exportJobSummary(job), message: '没有失败项' });
  runExportJob(job, { onlyFailed: true }).catch((e) => logExportJob(job, `重试异常: ${e.message}`));
  res.json(exportJobSummary(job));
});

app.get('/api/export/jobs/:id/parts/:filename', (req, res) => {
  const job = exportJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '导出任务不存在' });
  const filename = path.basename(String(req.params.filename || ''));
  if (!/^part-\d{3}\.zip$/i.test(filename) && filename !== 'manifest.json') {
    return res.status(400).json({ error: '非法文件名' });
  }
  const abs = path.resolve(job.absDir, filename);
  if (!isPathInside(job.absDir, abs) || !fs.existsSync(abs)) {
    return res.status(404).json({ error: '文件不存在（可能批次尚未完成）' });
  }
  res.download(abs, filename);
});

app.get('/api/export/jobs/:id/download-all', async (req, res) => {
  const job = exportJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '导出任务不存在' });
  if (!job.parts.length) {
    return res.status(404).json({ error: '还没有可下载的 zip 分卷' });
  }
  // 把已有 part zip + manifest 再打成一个总包（分卷本身已分批，总包只是索引打包）
  try {
    const zip = new AdmZip();
    for (const p of job.parts) {
      if (p.absPath && fs.existsSync(p.absPath)) zip.addLocalFile(p.absPath, '', p.filename);
    }
    const man = path.join(job.absDir, job.manifestName);
    if (fs.existsSync(man)) zip.addLocalFile(man, '', job.manifestName);
    const outName = `${job.id}-all-parts.zip`;
    const outAbs = path.join(job.absDir, outName);
    zip.writeZip(outAbs);
    res.download(outAbs, outName);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/panel')) return next();
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'server error' });
});

function pruneJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status === 'running') continue;
    const t = job.finishedAt || job.createdAt || 0;
    if (t && now - t > JOB_TTL_MS) {
      job.listeners?.clear?.();
      jobs.delete(id);
    }
  }
  for (const [id, job] of exportJobs) {
    if (job.status === 'running') continue;
    const t = job.finishedAt || job.createdAt || 0;
    if (t && now - t > EXPORT_TTL_MS) {
      job.listeners?.clear?.();
      exportJobs.delete(id);
    }
  }
}

const pruneTimer = setInterval(pruneJobs, 15 * 60 * 1000);
if (typeof pruneTimer.unref === 'function') pruneTimer.unref();

const server = app.listen(PORT, HOST, () => {
  const where = HOST === '0.0.0.0' ? `http://127.0.0.1:${PORT}` : `http://${HOST}:${PORT}`;
  console.log(`touch-xai-register v${APP_VERSION} 已启动: ${where}`);
  console.log(`凭证上传/导出: ${where}/  ·  注册面板: ${where}/panel/ (代理 -> ${PANEL_TARGET})`);
  console.log(`监听: ${HOST}:${PORT}`);
  console.log(`配置文件: ${CONFIG_PATH}`);
  console.log(`导出目录: ${EXPORT_DIR}`);
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用。可设置 PORT=8788 npm start`);
  } else {
    console.error('服务器启动失败:', err);
  }
  process.exit(1);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`收到 ${signal}，正在优雅退出…`);
  for (const job of jobs.values()) {
    if (job.status === 'running') {
      job.status = 'cancelled';
      job.controller?.abort();
    }
  }
  for (const job of exportJobs.values()) {
    if (job.status === 'running') {
      job.status = 'cancelled';
      job.controller?.abort();
    }
  }
  server.close(() => {
    clearInterval(pruneTimer);
    console.log('已停止接受新连接，退出');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 8000).unref?.();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
