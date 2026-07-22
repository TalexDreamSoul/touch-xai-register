/* Grok Panel — 注册 / 上传 / 导出 / 号池 / 设置 */
'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  token: localStorage.getItem('grok_panel_token') || '',
  es: null,               // register log SSE
  followPaused: false,
  pollTimer: null,
  upload: { files: [], job: null, es: null, filter: 'all', page: 1, pageSize: 20 },
  export: { job: null, es: null },
};

/* ================= shared ================= */

function toast(msg, isErr) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3200);
}

function headers(json) {
  const h = {};
  if (json) h['Content-Type'] = 'application/json';
  if (state.token) h['X-Panel-Token'] = state.token;
  return h;
}

async function api(path, opts = {}) {
  const isForm = opts.body instanceof FormData;
  const res = await fetch(path, {
    ...opts,
    headers: { ...headers(!isForm && !!opts.body), ...(opts.headers || {}) },
  });
  const ct = res.headers.get('content-type') || '';
  let body = null;
  if (ct.includes('application/json')) body = await res.json();
  else body = await res.text();
  if (!res.ok) {
    const err = (body && body.error) || res.statusText || 'request failed';
    const e = new Error(err);
    e.status = res.status;
    e.body = body;
    throw e;
  }
  return body;
}

function tokQuery() {
  return state.token ? 'token=' + encodeURIComponent(state.token) : '';
}

function fmtBytes(n) {
  if (!n && n !== 0) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function esc(s) {
  return String(s == null ? '' : s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/* ================= tabs ================= */

document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab-page').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + btn.dataset.tab));
    const t = btn.dataset.tab;
    if (t === 'pool') loadPool();
    if (t === 'settings') loadSettings();
  };
});

/* ================= auth gate ================= */

function showAuth(err) {
  $('app').classList.add('hidden');
  $('authGate').classList.remove('hidden');
  if (err) $('authErr').textContent = err;
  if (state.pollTimer) clearInterval(state.pollTimer);
  if (state.es) { state.es.close(); state.es = null; }
  closeUploadSSE();
  closeExportSSE();
}

async function enterApp() {
  $('authErr').textContent = '';
  try {
    await api('/api/status');
  } catch (e) {
    if (e.status === 401) {
      $('authErr').textContent = 'Token 无效';
      return;
    }
  }
  localStorage.setItem('grok_panel_token', state.token);
  $('authGate').classList.add('hidden');
  $('app').classList.remove('hidden');
  await refreshStatus();
  await loadConfig();
  await loadSnapshotLog();
  connectLogs();
  await loadRuns();
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(refreshStatus, 2500);
}

$('authBtn').onclick = () => { state.token = $('tokenInput').value.trim(); enterApp(); };
$('skipAuthBtn').onclick = () => { state.token = ''; enterApp(); };
$('logoutBtn').onclick = () => {
  state.token = '';
  localStorage.removeItem('grok_panel_token');
  showAuth('');
};
$('tokenInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('authBtn').click(); });

(async () => {
  try {
    const h = await fetch('/api/health').then((r) => r.json());
    if (!h.auth) { state.token = ''; enterApp(); return; }
    if (state.token) { $('tokenInput').value = state.token; enterApp(); }
  } catch (_) { /* stay on auth gate */ }
})();

/* ================= 注册流水线 ================= */

function setRunningUI(running) {
  $('startBtn').disabled = running;
  $('stopBtn').disabled = !running;
}

function renderStatus(snap) {
  if (!snap) snap = { status: 'stopped' };
  const running = snap.status === 'running';
  const err = snap.status === 'error';
  const dot = $('statusDot');
  dot.className = 'dot' + (running ? ' run' : err ? ' err' : '');
  $('statusLabel').textContent = running ? '运行中' : err ? '错误' : '空闲';
  $('statProgress').textContent = `${snap.done || 0}/${snap.target || 0}`;
  $('statSSO').textContent = snap.sso_count || 0;
  $('statOAuth').textContent = snap.oauth_count || 0;
  $('statFail').textContent = snap.fail_count || 0;
  $('phaseText').textContent = snap.phase_detail || snap.phase || '—';
  const bits = [];
  if (snap.run_id) bits.push('Run ' + snap.run_id);
  if (snap.pid) bits.push('PID ' + snap.pid);
  if (snap.rate_per_min) bits.push(snap.rate_per_min.toFixed(1) + '/分');
  if (snap.error) bits.push('错误: ' + snap.error);
  $('runMeta').textContent = bits.join(' · ');
  setRunningUI(running);
}

async function refreshStatus() {
  try {
    const data = await api('/api/status');
    renderStatus(data.status);
  } catch (e) {
    if (e.status === 401) { showAuth('Token 无效，请重新输入'); return; }
    $('statusLabel').textContent = '无法连接';
  }
}

async function loadConfig() {
  try {
    const data = await api('/api/config');
    const c = data.config || {};
    $('emailMode').value = c.email_mode || 'tempmail';
    $('registerProxy').value = c.register_proxy || '';
    $('flareURL').value = c.flaresolverr_url || '';
  } catch (e) { /* ignore on first paint */ }
}

async function saveConfig() {
  try {
    await api('/api/config', {
      method: 'PUT',
      body: JSON.stringify({
        email_mode: $('emailMode').value,
        register_proxy: $('registerProxy').value,
        flaresolverr_url: $('flareURL').value,
      }),
    });
    toast('配置已保存');
  } catch (e) { toast(e.message, true); }
}

async function startRun() {
  const target = parseInt($('targetInput').value, 10) || 10;
  try {
    const data = await api('/api/start', { method: 'POST', body: JSON.stringify({ target }) });
    toast('已启动 run ' + data.run_id);
    connectLogs();
    refreshStatus();
    loadRuns();
  } catch (e) { toast(e.message, true); }
}

async function stopRun() {
  try {
    await api('/api/stop', { method: 'POST', body: '{}' });
    toast('已发送停止');
    refreshStatus();
  } catch (e) { toast(e.message, true); }
}

function appendLog(text) {
  const el = $('logView');
  el.textContent += text;
  if (!state.followPaused) el.scrollTop = el.scrollHeight;
  if (el.textContent.length > 400000) el.textContent = el.textContent.slice(-300000);
}

function connectLogs() {
  if (state.es) { state.es.close(); state.es = null; }
  const q = new URLSearchParams({ follow: '1' });
  if (state.token) q.set('token', state.token);
  const es = new EventSource('/api/logs?' + q.toString());
  state.es = es;
  es.onmessage = (ev) => appendLog(ev.data + '\n');
  es.onerror = () => {};
}

async function loadSnapshotLog() {
  try {
    const data = await api('/api/logs?tail=200');
    $('logView').textContent = data.log || '';
    if (!state.followPaused) $('logView').scrollTop = $('logView').scrollHeight;
  } catch (_) {}
}

async function loadRuns() {
  try {
    const data = await api('/api/runs?limit=30');
    const body = $('runsBody');
    const runs = data.runs || [];
    if (!runs.length) {
      body.innerHTML = '<tr><td colspan="5" class="muted">暂无产物</td></tr>';
      return;
    }
    body.innerHTML = runs.map((r) => {
      const tok = state.token ? ('&token=' + encodeURIComponent(state.token)) : '';
      const cpa = `/api/runs/${encodeURIComponent(r.id)}/download?kind=cpa${tok}`;
      const all = `/api/runs/${encodeURIComponent(r.id)}/download?kind=all${tok}`;
      return `<tr>
        <td><code>${esc(r.id)}</code></td>
        <td>${r.cpa_count}</td>
        <td>${r.sso_files}</td>
        <td class="muted">${(r.mod_time || '').replace('T', ' ').replace('Z', ' UTC')}</td>
        <td><a href="${cpa}">CPA.zip</a> &nbsp;·&nbsp; <a href="${all}">全部</a></td>
      </tr>`;
    }).join('');
  } catch (e) {
    $('runsBody').innerHTML = `<tr><td colspan="5" class="muted">${esc(e.message)}</td></tr>`;
  }
}

$('startBtn').onclick = startRun;
$('stopBtn').onclick = stopRun;
$('refreshBtn').onclick = () => { refreshStatus(); loadRuns(); };
$('saveCfgBtn').onclick = saveConfig;
$('reloadCfgBtn').onclick = loadConfig;
$('reloadRunsBtn').onclick = loadRuns;
$('clearLogBtn').onclick = () => { $('logView').textContent = ''; };
$('pauseLogBtn').onclick = () => {
  state.followPaused = !state.followPaused;
  $('pauseLogBtn').textContent = state.followPaused ? '继续跟随' : '暂停跟随';
};

/* ================= 凭证上传 ================= */

const dz = $('dropzone');
const fi = $('fileInput');

dz.onclick = () => fi.click();
dz.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') fi.click(); };
dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('drag'); };
dz.ondragleave = () => dz.classList.remove('drag');
dz.ondrop = (e) => {
  e.preventDefault();
  dz.classList.remove('drag');
  addUploadFiles(e.dataTransfer.files);
};
fi.onchange = () => { addUploadFiles(fi.files); fi.value = ''; };

function addUploadFiles(fileList) {
  const seen = new Set(state.upload.files.map((f) => f.name + ':' + f.size));
  for (const f of fileList) {
    const lower = f.name.toLowerCase();
    if (!lower.endsWith('.json') && !lower.endsWith('.zip')) continue;
    const key = f.name + ':' + f.size;
    if (seen.has(key)) continue;
    seen.add(key);
    state.upload.files.push(f);
  }
  renderSelectedFiles();
}

function renderSelectedFiles() {
  const el = $('selectedFiles');
  const files = state.upload.files;
  if (!files.length) { el.textContent = ''; return; }
  const total = files.reduce((s, f) => s + f.size, 0);
  el.innerHTML = `已选 <b>${files.length}</b> 个文件（${fmtBytes(total)}） ` +
    files.slice(0, 8).map((f) => esc(f.name)).join('、') +
    (files.length > 8 ? ` 等 ${files.length} 个` : '') +
    ` · <a href="#" id="clearSelected">清空</a>`;
  $('clearSelected').onclick = (e) => { e.preventDefault(); state.upload.files = []; renderSelectedFiles(); };
}

async function refreshCacheInfo() {
  try {
    const d = await api('/api/transfer/cache');
    $('cacheInfo').textContent = `本地缓存 ${d.total} 条`;
  } catch (_) {}
}

$('clearCacheBtn').onclick = async () => {
  if (!confirm('清空本地上传缓存？下次将重新上传所有文件。')) return;
  try {
    await api('/api/transfer/cache', { method: 'DELETE' });
    toast('缓存已清空');
    refreshCacheInfo();
  } catch (e) { toast(e.message, true); }
};

$('prepareBtn').onclick = async () => {
  const fd = new FormData();
  for (const f of state.upload.files) fd.append('files', f, f.name);
  if ($('folderPath').value.trim()) fd.append('folderPath', $('folderPath').value.trim());
  if ($('rawJson').value.trim()) fd.append('rawJson', $('rawJson').value);
  fd.append('concurrency', $('upConcurrency').value);
  fd.append('batchSize', $('upBatchSize').value);
  fd.append('timeoutMs', $('upTimeoutMs').value);
  fd.append('retryLimit', $('upRetryLimit').value);
  fd.append('skipCached', $('upSkipCached').checked ? 'true' : 'false');
  $('prepareBtn').disabled = true;
  try {
    const d = await api('/api/transfer/prepare', { method: 'POST', body: fd });
    state.upload.job = d.job;
    state.upload.page = 1;
    $('uploadJobCard').style.display = '';
    renderUploadJob(d.job);
    connectUploadSSE(d.job.id);
    toast(`任务已创建：${d.job.total} 项`);
  } catch (e) {
    toast(e.message, true);
  } finally {
    $('prepareBtn').disabled = false;
  }
};

function connectUploadSSE(jobID) {
  closeUploadSSE();
  const q = tokQuery();
  const es = new EventSource(`/api/transfer/jobs/${encodeURIComponent(jobID)}/events?${q}`);
  state.upload.es = es;
  es.onmessage = (ev) => {
    try {
      const job = JSON.parse(ev.data);
      state.upload.job = job;
      renderUploadJob(job);
    } catch (_) {}
  };
  es.onerror = () => {};
}

function closeUploadSSE() {
  if (state.upload.es) { state.upload.es.close(); state.upload.es = null; }
}

function renderUploadJob(job) {
  if (!job) return;
  const c = job.counts || {};
  $('upStatus').textContent = job.status;
  $('upStatus').className = 'pill ' + job.status;
  $('upTotal').textContent = job.total || 0;
  $('upPending').textContent = c.pending || 0;
  $('upRunning').textContent = c.uploading || 0;
  $('upSuccess').textContent = c.success || 0;
  $('upFailed').textContent = c.failed || 0;
  $('upSkipped').textContent = c.skipped || 0;
  $('upProgressBar').style.width = (job.progress || 0) + '%';

  const running = job.status === 'running';
  $('upStartBtn').disabled = running || job.status === 'completed';
  $('upRetryBtn').disabled = running || !(c.failed > 0);
  $('upCancelBtn').disabled = !running;

  renderUploadItems(job);
  $('upLog').textContent = (job.logs || []).join('\n');
  $('upLog').scrollTop = $('upLog').scrollHeight;
}

function renderUploadItems(job) {
  const u = state.upload;
  let items = job.items || [];
  if (u.filter !== 'all') {
    items = items.filter((it) => it.status === u.filter || (u.filter === 'running' && it.status === 'uploading'));
  }
  const totalPages = Math.max(1, Math.ceil(items.length / u.pageSize));
  if (u.page > totalPages) u.page = totalPages;
  const slice = items.slice((u.page - 1) * u.pageSize, u.page * u.pageSize);
  $('upItemsBody').innerHTML = slice.length ? slice.map((it) => `<tr>
    <td><code>${esc(it.name)}</code>${it.fromCache ? ' <span class="pill skipped">缓存</span>' : ''}</td>
    <td class="muted">${fmtBytes(it.size)}</td>
    <td><span class="pill ${esc(it.status)}">${esc(it.status)}</span></td>
    <td class="muted">${it.attempts || 0}</td>
    <td class="muted small">${esc(it.error || (it.preview && it.preview.email) || '')}</td>
  </tr>`).join('') : '<tr><td colspan="5" class="muted">无匹配项</td></tr>';
  $('upPageInfo').textContent = `${u.page}/${totalPages}（${items.length} 项）`;
}

$('upFilter').onchange = (e) => { state.upload.filter = e.target.value; state.upload.page = 1; renderUploadItems(state.upload.job || {}); };
$('upPageSize').onchange = (e) => { state.upload.pageSize = parseInt(e.target.value, 10); state.upload.page = 1; renderUploadItems(state.upload.job || {}); };
$('upPrevPage').onclick = () => { if (state.upload.page > 1) { state.upload.page--; renderUploadItems(state.upload.job || {}); } };
$('upNextPage').onclick = () => { state.upload.page++; renderUploadItems(state.upload.job || {}); };

$('upStartBtn').onclick = async () => {
  if (!state.upload.job) return;
  try {
    await api(`/api/transfer/jobs/${state.upload.job.id}/start`, { method: 'POST', body: '{}' });
  } catch (e) { toast(e.message, true); }
};
$('upRetryBtn').onclick = async () => {
  if (!state.upload.job) return;
  try {
    await api(`/api/transfer/jobs/${state.upload.job.id}/retry-failed`, { method: 'POST', body: '{}' });
    state.upload.filter = 'failed';
    $('upFilter').value = 'failed';
  } catch (e) { toast(e.message, true); }
};
$('upCancelBtn').onclick = async () => {
  if (!state.upload.job) return;
  try {
    await api(`/api/transfer/jobs/${state.upload.job.id}/cancel`, { method: 'POST', body: '{}' });
  } catch (e) { toast(e.message, true); }
};

/* ================= 批量导出 ================= */

function exportPayload() {
  const p = {
    provider: $('exProvider').value.trim(),
    emailContains: $('exEmail').value.trim(),
    nameContains: $('exName').value.trim(),
    batchSize: parseInt($('exBatchSize').value, 10) || 500,
    concurrency: parseInt($('exConcurrency').value, 10) || 15,
    timeoutMs: parseInt($('exTimeoutMs').value, 10) || 120000,
    retryLimit: parseInt($('exRetryLimit').value, 10) || 0,
    keepFiles: $('exKeepFiles').checked,
  };
  if ($('exLimit').value) p.limit = parseInt($('exLimit').value, 10);
  if ($('exDisabled').value !== '') p.disabled = $('exDisabled').value === 'true';
  if (!p.retryLimit) p.retryLimit = parseInt($('exRetryLimit').value, 10) || 0;
  return p;
}

$('exPreviewBtn').onclick = async () => {
  $('exPreviewInfo').textContent = '拉取中…';
  try {
    const d = await api('/api/export/preview', { method: 'POST', body: JSON.stringify(exportPayload()) });
    const p = d.preview;
    const prov = (p.matchedProviders || []).slice(0, 5).map((x) => `${x.provider}:${x.count}`).join(' ');
    $('exPreviewInfo').textContent =
      `远端 ${p.totalRemote}，匹配 ${p.matched}，预计 ${p.estimatedBatches} 卷 ${prov ? '｜' + prov : ''}${p.hint ? '｜' + p.hint : ''}`;
  } catch (e) {
    $('exPreviewInfo').textContent = e.message;
  }
};

$('exStartBtn').onclick = async () => {
  if (!confirm('开始导出？大池可能需要数分钟。')) return;
  try {
    const d = await api('/api/export/start', { method: 'POST', body: JSON.stringify(exportPayload()) });
    state.export.job = d.job;
    $('exportJobCard').style.display = '';
    renderExportJob(d.job);
    connectExportSSE(d.job.id);
    toast('导出已启动');
  } catch (e) {
    if (e.status === 409 && e.body && e.body.running) {
      state.export.job = e.body.running;
      $('exportJobCard').style.display = '';
      renderExportJob(e.body.running);
      connectExportSSE(e.body.running.id);
      toast('已有导出任务进行中，已为你接上进度', true);
    } else {
      toast(e.message, true);
    }
  }
};

function connectExportSSE(jobID) {
  closeExportSSE();
  const es = new EventSource(`/api/export/jobs/${encodeURIComponent(jobID)}/events?${tokQuery()}`);
  state.export.es = es;
  es.onmessage = (ev) => {
    try {
      const job = JSON.parse(ev.data);
      state.export.job = job;
      renderExportJob(job);
    } catch (_) {}
  };
  es.onerror = () => {};
}

function closeExportSSE() {
  if (state.export.es) { state.export.es.close(); state.export.es = null; }
}

function renderExportJob(job) {
  if (!job) return;
  const c = job.counts || {};
  $('exStatus').textContent = job.status;
  $('exStatus').className = 'pill ' + job.status;
  $('exTotal').textContent = job.total || 0;
  $('exBatch').textContent = `${job.currentBatch || 0}/${job.totalBatches || 0}`;
  $('exSuccess').textContent = c.success || 0;
  $('exFailed').textContent = c.failed || 0;
  $('exParts').textContent = (job.parts || []).length;
  $('exTotalRemote').textContent = job.totalRemote || 0;
  $('exProgressBar').style.width = (job.progress || 0) + '%';

  const running = job.status === 'running';
  $('exRetryBtn').disabled = running || !(c.failed > 0);
  $('exCancelBtn').disabled = !running;

  const tok = tokQuery();
  const parts = job.parts || [];
  $('exPartsBody').innerHTML = parts.length ? parts.map((p) => `<tr>
    <td><code>${esc(p.filename)}</code></td>
    <td>${p.files}</td>
    <td class="muted">${fmtBytes(p.bytes)}</td>
    <td><a href="/api/export/jobs/${encodeURIComponent(job.id)}/parts/${encodeURIComponent(p.filename)}?${tok}">下载</a></td>
  </tr>`).join('') : '<tr><td colspan="4" class="muted">尚无分卷</td></tr>';

  const allLink = $('exDownloadAll');
  const manLink = $('exManifest');
  if (parts.length) {
    allLink.classList.remove('hidden');
    allLink.href = `/api/export/jobs/${encodeURIComponent(job.id)}/download-all?${tok}`;
  } else {
    allLink.classList.add('hidden');
  }
  if (job.manifest) {
    manLink.classList.remove('hidden');
    manLink.href = `/api/export/jobs/${encodeURIComponent(job.id)}/parts/manifest.json?${tok}`;
  } else {
    manLink.classList.add('hidden');
  }

  $('exLog').textContent = (job.logs || []).join('\n');
  $('exLog').scrollTop = $('exLog').scrollHeight;
}

$('exCancelBtn').onclick = async () => {
  if (!state.export.job) return;
  try {
    await api(`/api/export/jobs/${state.export.job.id}/cancel`, { method: 'POST', body: '{}' });
  } catch (e) { toast(e.message, true); }
};
$('exRetryBtn').onclick = async () => {
  if (!state.export.job) return;
  try {
    await api(`/api/export/jobs/${state.export.job.id}/retry-failed`, { method: 'POST', body: '{}' });
  } catch (e) { toast(e.message, true); }
};

/* ================= 号池 / 巡检 ================= */

async function loadPool() {
  loadPoolOverview();
  loadPoolHistory();
  loadPoolLogs();
}

async function loadPoolLogs() {
  try {
    const d = await api('/api/pool/logs?tail=300');
    const text = d.text || (d.lines || []).join('\n') || '（暂无巡检日志，点「立即轻检/深检」或「清理限额耗尽」后会出现）';
    const el = $('poolLogView');
    if (!el) return;
    el.textContent = text;
    el.scrollTop = el.scrollHeight;
  } catch (e) {
    const el = $('poolLogView');
    if (el) el.textContent = e.message || String(e);
  }
}

if ($('poolLogReload')) $('poolLogReload').onclick = loadPoolLogs;
if ($('poolLogClear')) $('poolLogClear').onclick = () => { const el = $('poolLogView'); if (el) el.textContent = ''; };

async function loadPoolOverview() {
  try {
    const d = await api('/api/pool/overview');
    const o = d.overview || {};
    $('poolHealthy').textContent = o.healthy ?? '—';
    $('poolRateLimited').textContent = o.rate_limited ?? '—';
    $('poolDead').textContent = o.dead ?? '—';
    $('poolDisabled').textContent = o.disabled ?? '—';
    $('poolTotal').textContent = o.total ?? '—';
    $('poolQuota').textContent = o.quota_estimate != null ? `≈ ${o.quota_estimate}` : '—';
    const p = d.patrol || {};
    const bits = [];
    if (p.running) bits.push('巡检进行中…');
    if (p.last_run) bits.push('上次巡检 ' + String(p.last_run).replace('T', ' ').slice(0, 19));
    if (p.mode) bits.push('模式 ' + p.mode);
    if (p.next_run) bits.push('下次 ' + String(p.next_run).replace('T', ' ').slice(0, 19));
    if (p.enabled === false) bits.push('定时巡检未启用（可在设置中开启）');
    $('poolPatrolStatus').textContent = bits.join(' · ') || '暂无巡检数据';
    const r = d.refill || {};
    const rb = [];
    if (r.enabled) {
      rb.push(`自动补号开启：健康 < ${r.min_healthy} 时补 ${r.batch} 个`);
      if (r.last_refill) rb.push('上次补号 ' + String(r.last_refill).replace('T', ' ').slice(0, 19));
      if (r.today_count != null) rb.push(`今日已补 ${r.today_count}/${r.daily_cap}`);
    } else {
      rb.push('自动补号未启用');
    }
    $('poolRefillStatus').textContent = rb.join(' · ');
    const c = d.cleanup || {};
    const cb = [];
    if (c.enabled) {
      cb.push('清理限额耗尽：已启用');
      if (c.on_patrol) cb.push('随巡检自动跑');
      if (c.dry_run) cb.push('演练模式');
      if (c.backup) cb.push('删前备份');
    } else {
      cb.push('清理限额耗尽：未启用定时（仍可手动点按钮）');
    }
    if (c.last_run) cb.push('上次 ' + String(c.last_run).replace('T', ' ').slice(0, 19));
    if (c.last_reason) cb.push(c.last_reason);
    if (c.last) {
      const L = c.last;
      cb.push(`扫 ${L.scanned ?? 0} / 命中 ${L.quota_hits ?? 0} / 删 ${L.deleted ?? 0}`);
    }
    $('poolCleanupStatus').textContent = cb.join(' · ');
  } catch (e) {
    $('poolPatrolStatus').textContent = e.message;
  }
}

async function loadPoolHistory() {
  try {
    const d = await api('/api/pool/patrol/history');
    const rows = d.history || [];
    $('poolHistoryBody').innerHTML = rows.length ? rows.map((h) => `<tr>
      <td class="muted">${String(h.time || '').replace('T', ' ').slice(0, 19)}</td>
      <td>${esc(h.mode)}</td>
      <td class="good">${h.healthy ?? 0}</td>
      <td class="warn">${h.rate_limited ?? 0}</td>
      <td class="bad">${h.dead ?? 0}</td>
      <td>${h.disabled ?? 0}</td>
      <td>${h.total ?? 0}</td>
      <td class="muted">${h.duration_ms ? (h.duration_ms / 1000).toFixed(1) + 's' : '—'}</td>
    </tr>`).join('') : '<tr><td colspan="8" class="muted">暂无巡检记录</td></tr>';
  } catch (e) {
    $('poolHistoryBody').innerHTML = `<tr><td colspan="8" class="muted">${esc(e.message)}</td></tr>`;
  }
}

$('poolHistoryReload').onclick = loadPoolHistory;

$('poolTestBtn').onclick = async () => {
  $('poolTestBtn').disabled = true;
  try {
    await api('/api/pool/test-connection', { method: 'POST', body: '{}' });
    toast('CPA 连接正常');
  } catch (e) { toast(e.message, true); }
  finally { $('poolTestBtn').disabled = false; }
};

async function triggerPatrol(mode) {
  try {
    await api('/api/pool/patrol', { method: 'POST', body: JSON.stringify({ mode }) });
    toast(mode === 'deep' ? '深检已启动' : '轻检已启动');
    setTimeout(() => { loadPool(); loadPoolLogs(); }, 1200);
    setTimeout(() => { loadPool(); loadPoolLogs(); }, 4000);
  } catch (e) { toast(e.message, true); }
}
$('poolPatrolLightBtn').onclick = () => triggerPatrol('light');
$('poolPatrolDeepBtn').onclick = () => triggerPatrol('deep');

$('poolCleanupBtn').onclick = async () => {
  if (!confirm('将清理 CPA 正式池中 free-usage/quota 耗尽号（不删纯 429）。\n若设置了演练模式则只报告不删除。继续？')) return;
  $('poolCleanupBtn').disabled = true;
  try {
    const d = await api('/api/pool/cleanup', { method: 'POST', body: JSON.stringify({ force: true }) });
    const r = d.result || {};
    toast(r.reason || (d.ok ? '清理完成' : (d.error || '清理结束')));
    loadPoolOverview();
    loadPoolLogs();
  } catch (e) { toast(e.message, true); }
  finally { $('poolCleanupBtn').disabled = false; }
};

$('poolFilesBtn').onclick = async () => {
  $('poolFilesBtn').disabled = true;
  $('poolFilesBody').innerHTML = '<tr><td colspan="5" class="muted">拉取中…</td></tr>';
  try {
    const d = await api('/api/pool/files?force=1&limit=50');
    const files = d.files || [];
    $('poolFilesBody').innerHTML = files.length ? files.map((f) => `<tr>
      <td><code>${esc(f.name)}</code></td>
      <td>${esc(f.provider || f.type || '')}</td>
      <td class="muted">${esc(f.email || '')}</td>
      <td class="muted">${esc(f.status || '')}</td>
      <td>${f.disabled ? '<span class="pill failed">禁用</span>' : '<span class="pill success">可用</span>'}</td>
    </tr>`).join('') : `<tr><td colspan="5" class="muted">远端为空（总数 ${d.total}）</td></tr>`;
    if (files.length) toast(`远端总数 ${d.total}，显示前 ${files.length} 条`);
  } catch (e) {
    $('poolFilesBody').innerHTML = `<tr><td colspan="5" class="muted">${esc(e.message)}</td></tr>`;
  } finally {
    $('poolFilesBtn').disabled = false;
  }
};

/* ================= 设置 ================= */

async function loadSettings() {
  try {
    const d = await api('/api/config');
    const c = d.config || {};
    $('cfgCpaBase').value = c.cpa_management_base || '';
    $('cfgCpaKey').value = c.cpa_management_key_masked || '';
    $('cfgCpaKey').placeholder = c.cpa_management_key_set ? '已设置（脱敏显示）' : '未设置';
    $('cfgCpaUploadEnabled').checked = !!c.cpa_upload_enabled;
    $('cfgUpConc').value = c.upload_concurrency ?? 3;
    $('cfgUpBatch').value = c.upload_batch_size ?? 20;
    $('cfgExBatch').value = c.export_batch_size ?? 500;
    $('cfgExConc').value = c.export_concurrency ?? 15;
    $('cfgPatrolEnabled').checked = !!c.patrol_enabled;
    $('cfgPatrolInterval').value = c.patrol_interval_min ?? 30;
    $('cfgPatrolConc').value = c.patrol_concurrency ?? 10;
    $('cfgPatrolDeep').checked = !!c.patrol_deep_probe;
    $('cfgQuotaPer').value = c.quota_per_account ?? 60;
    $('cfgRefillEnabled').checked = !!c.refill_enabled;
    $('cfgRefillMin').value = c.refill_min_healthy ?? 5;
    $('cfgRefillBatch').value = c.refill_batch ?? 10;
    $('cfgRefillCooldown').value = c.refill_cooldown_min ?? 60;
    $('cfgRefillCap').value = c.refill_daily_cap ?? 50;
    $('cfgCleanupEnabled').checked = !!c.cleanup_quota_enabled;
    $('cfgCleanupOnPatrol').checked = c.cleanup_on_patrol !== false;
    $('cfgCleanupBackup').checked = c.cleanup_backup !== false;
    $('cfgCleanupDryRun').checked = !!c.cleanup_dry_run;
    $('settingsMsg').textContent = '';
  } catch (e) {
    $('settingsMsg').textContent = e.message;
  }
}

$('settingsSaveBtn').onclick = async () => {
  const body = {
    cpa_management_base: $('cfgCpaBase').value.trim(),
    cpa_upload_enabled: $('cfgCpaUploadEnabled').checked,
    upload_concurrency: parseInt($('cfgUpConc').value, 10),
    upload_batch_size: parseInt($('cfgUpBatch').value, 10),
    export_batch_size: parseInt($('cfgExBatch').value, 10),
    export_concurrency: parseInt($('cfgExConc').value, 10),
    patrol_enabled: $('cfgPatrolEnabled').checked,
    patrol_interval_min: parseInt($('cfgPatrolInterval').value, 10),
    patrol_concurrency: parseInt($('cfgPatrolConc').value, 10),
    patrol_deep_probe: $('cfgPatrolDeep').checked,
    quota_per_account: parseInt($('cfgQuotaPer').value, 10),
    refill_enabled: $('cfgRefillEnabled').checked,
    refill_min_healthy: parseInt($('cfgRefillMin').value, 10),
    refill_batch: parseInt($('cfgRefillBatch').value, 10),
    refill_cooldown_min: parseInt($('cfgRefillCooldown').value, 10),
    refill_daily_cap: parseInt($('cfgRefillCap').value, 10),
    cleanup_quota_enabled: $('cfgCleanupEnabled').checked,
    cleanup_on_patrol: $('cfgCleanupOnPatrol').checked,
    cleanup_backup: $('cfgCleanupBackup').checked,
    cleanup_dry_run: $('cfgCleanupDryRun').checked,
  };
  const key = $('cfgCpaKey').value.trim();
  if (key && !key.includes('*')) body.cpa_management_key = key;
  try {
    await api('/api/config', { method: 'PUT', body: JSON.stringify(body) });
    toast('设置已保存');
    loadSettings();
  } catch (e) { toast(e.message, true); }
};
$('settingsReloadBtn').onclick = loadSettings;

/* ================= init ================= */
refreshCacheInfo();
