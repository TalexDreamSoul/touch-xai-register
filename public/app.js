/* global fetch, EventSource */
(() => {
  const $ = (id) => document.getElementById(id);

  const STATUS_LABEL = {
    pending: '等待',
    uploading: '上传中',
    success: '成功',
    failed: '失败',
    skipped: '已缓存',
  };

  const state = {
    files: [],
    jobId: null,
    es: null,
    configLoaded: false,
    job: null,
    page: 1,
    pageSize: 50,
    filter: 'all',
    exportJobId: null,
    exportEs: null,
    exportJob: null,
  };

  const els = {
    baseUrl: $('baseUrl'),
    managementKey: $('managementKey'),
    concurrency: $('concurrency'),
    batchSize: $('batchSize'),
    timeoutMs: $('timeoutMs'),
    retryLimit: $('retryLimit'),
    folderPath: $('folderPath'),
    rawJson: $('rawJson'),
    fileInput: $('fileInput'),
    fileList: $('fileList'),
    dropzone: $('dropzone'),
    connBadge: $('connBadge'),
    testMsg: $('testMsg'),
    prepareMsg: $('prepareMsg'),
    jobStatus: $('jobStatus'),
    jobCounts: $('jobCounts'),
    progressFill: $('progressFill'),
    cSuccess: $('cSuccess'),
    cFailed: $('cFailed'),
    cUploading: $('cUploading'),
    cPending: $('cPending'),
    cSkipped: $('cSkipped'),
    itemBody: $('itemBody'),
    remoteBody: $('remoteBody'),
    logBox: $('logBox'),
    btnSaveConfig: $('btnSaveConfig'),
    btnTest: $('btnTest'),
    btnPrepare: $('btnPrepare'),
    btnClearFiles: $('btnClearFiles'),
    btnStart: $('btnStart'),
    btnRetry: $('btnRetry'),
    btnCancel: $('btnCancel'),
    btnRefreshRemote: $('btnRefreshRemote'),
    btnTheme: $('btnTheme'),
    skipCached: $('skipCached'),
    itemFilter: $('itemFilter'),
    pageSize: $('pageSize'),
    btnPrevPage: $('btnPrevPage'),
    btnNextPage: $('btnNextPage'),
    pageInfo: $('pageInfo'),
    btnClearCache: $('btnClearCache'),
    cacheMsg: $('cacheMsg'),
    exportProvider: $('exportProvider'),
    exportEmail: $('exportEmail'),
    exportName: $('exportName'),
    exportLimit: $('exportLimit'),
    exportBatchSize: $('exportBatchSize'),
    exportConcurrency: $('exportConcurrency'),
    exportKeepFiles: $('exportKeepFiles'),
    exportMsg: $('exportMsg'),
    exportStatus: $('exportStatus'),
    exportCounts: $('exportCounts'),
    exportProgressFill: $('exportProgressFill'),
    eSuccess: $('eSuccess'),
    eFailed: $('eFailed'),
    eDownloading: $('eDownloading'),
    ePending: $('ePending'),
    eParts: $('eParts'),
    exportPartsBody: $('exportPartsBody'),
    exportLogBox: $('exportLogBox'),
    exportPathHint: $('exportPathHint'),
    btnExportPreview: $('btnExportPreview'),
    btnExportStart: $('btnExportStart'),
    btnExportRetry: $('btnExportRetry'),
    btnExportCancel: $('btnExportCancel'),
    btnExportDownloadAll: $('btnExportDownloadAll'),
  };

  function toast(el, msg, isErr = false) {
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('is-error', Boolean(isErr && msg));
  }

  function getTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  function setTheme(theme) {
    const next = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('cpa-theme', next);
    } catch {
      /* ignore */
    }
  }

  function toggleTheme() {
    setTheme(getTheme() === 'dark' ? 'light' : 'dark');
  }

  function configPayload(includeKey = true) {
    const payload = {
      baseUrl: els.baseUrl.value.trim(),
      concurrency: Number(els.concurrency.value || 3),
      batchSize: Number(els.batchSize.value || 20),
      timeoutMs: Number(els.timeoutMs.value || 30000),
      retryLimit: Number(els.retryLimit.value || 2),
      skipCached: Boolean(els.skipCached?.checked),
      exportBatchSize: Number(els.exportBatchSize?.value || 500),
      exportConcurrency: Number(els.exportConcurrency?.value || 15),
    };
    if (includeKey) payload.managementKey = els.managementKey.value;
    return payload;
  }

  async function loadConfig() {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    els.baseUrl.value = cfg.baseUrl || '';
    els.managementKey.value = cfg.managementKey || cfg.managementKeyMasked || '';
    els.concurrency.value = cfg.concurrency ?? 3;
    els.batchSize.value = cfg.batchSize ?? 20;
    els.timeoutMs.value = cfg.timeoutMs ?? 30000;
    els.retryLimit.value = cfg.retryLimit ?? 2;
    if (els.skipCached) els.skipCached.checked = cfg.skipCached !== false;
    if (els.exportBatchSize) els.exportBatchSize.value = cfg.exportBatchSize ?? 500;
    if (els.exportConcurrency) els.exportConcurrency.value = cfg.exportConcurrency ?? 15;
    state.configLoaded = true;
    refreshCacheInfo().catch(() => {});
  }

  async function saveConfig() {
    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(configPayload(true)),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '保存失败');
    if (data.managementKeyMasked) {
      if (!els.managementKey.value || els.managementKey.value.includes('*')) {
        els.managementKey.value = data.managementKey || data.managementKeyMasked;
      }
    }
    return data;
  }

  async function refreshCacheInfo() {
    const res = await fetch('/api/upload-cache');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '读取缓存失败');
    toast(els.cacheMsg, `本地缓存 ${data.total || 0} 条`);
    return data;
  }

  async function clearCache() {
    if (!window.confirm('确认清空本地上传缓存？下次将重新上传全部文件。')) return;
    const res = await fetch('/api/upload-cache', { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '清空失败');
    toast(els.cacheMsg, '缓存已清空');
  }

  async function testConnection() {
    els.btnTest.disabled = true;
    toast(els.testMsg, '测试中…');
    try {
      await saveConfig().catch(() => {});
      const res = await fetch('/api/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(configPayload(true)),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        els.connBadge.textContent = '连接失败';
        els.connBadge.className = 'badge fail';
        toast(els.testMsg, data.error || `HTTP ${data.status || res.status}`, true);
        return;
      }
      els.connBadge.textContent = '已连接';
      els.connBadge.className = 'badge ok';
      toast(els.testMsg, data.hint || '密钥有效 · 连接成功');
    } catch (e) {
      els.connBadge.textContent = '连接失败';
      els.connBadge.className = 'badge fail';
      toast(els.testMsg, e.message, true);
    } finally {
      els.btnTest.disabled = false;
    }
  }

  function renderFileList() {
    if (!state.files.length) {
      els.fileList.textContent = '尚未选择';
      return;
    }
    const lines = state.files.map((f) => `${f.name} (${formatSize(f.size)})`);
    els.fileList.textContent =
      lines.slice(0, 40).join('\n') + (lines.length > 40 ? `\n… 另有 ${lines.length - 40} 个` : '');
  }

  function formatSize(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }

  function setFiles(fileList) {
    const arr = [...fileList].filter((f) => /\.(json|zip)$/i.test(f.name));
    const map = new Map(state.files.map((f) => [`${f.name}:${f.size}`, f]));
    for (const f of arr) map.set(`${f.name}:${f.size}`, f);
    state.files = [...map.values()];
    renderFileList();
  }

  async function prepareJob() {
    els.btnPrepare.disabled = true;
    toast(els.prepareMsg, '解析中…');
    try {
      await saveConfig().catch(() => {});
      const fd = new FormData();
      for (const f of state.files) fd.append('files', f, f.name);
      const folder = els.folderPath.value.trim();
      if (folder) fd.append('folderPath', folder);
      const raw = els.rawJson.value.trim();
      if (raw) fd.append('rawJson', raw);
      const cfg = configPayload(true);
      fd.append('concurrency', String(cfg.concurrency));
      fd.append('batchSize', String(cfg.batchSize));
      fd.append('timeoutMs', String(cfg.timeoutMs));
      fd.append('retryLimit', String(cfg.retryLimit));
      fd.append('baseUrl', cfg.baseUrl);
      fd.append('skipCached', String(Boolean(cfg.skipCached)));
      if (cfg.managementKey && !cfg.managementKey.includes('*')) {
        fd.append('managementKey', cfg.managementKey);
      }

      const res = await fetch('/api/prepare', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '解析失败');

      state.jobId = data.jobId;
      state.page = 1;
      closeES();
      openES(data.jobId);
      els.btnStart.disabled = false;
      els.btnRetry.disabled = true;
      els.btnCancel.disabled = true;

      const skipped = data.skipped || data.counts?.skipped || 0;
      const pending = data.pending || data.counts?.pending || data.total || 0;
      const errHint = data.errors?.length ? ` · 无效 ${data.errors.length}` : '';
      const skipHint = skipped ? ` · 缓存跳过 ${skipped}` : '';
      toast(els.prepareMsg, `任务已创建 · 共 ${data.total} · 待传 ${pending}${skipHint}${errHint}`);

      renderJob({
        status: 'queued',
        total: data.total,
        done: skipped,
        progress: data.total ? Math.round((skipped / data.total) * 100) : 0,
        counts: data.counts || {
          pending,
          uploading: 0,
          success: 0,
          failed: 0,
          skipped,
        },
        items: data.items || [],
        logs: [],
      });
      refreshCacheInfo().catch(() => {});
    } catch (e) {
      toast(els.prepareMsg, e.message, true);
    } finally {
      els.btnPrepare.disabled = false;
    }
  }

  function closeES() {
    if (state.es) {
      state.es.close();
      state.es = null;
    }
  }

  function openES(jobId) {
    closeES();
    const es = new EventSource(`/api/jobs/${jobId}/events`);
    state.es = es;
    es.onmessage = (ev) => {
      try {
        renderJob(JSON.parse(ev.data));
      } catch {
        /* ignore */
      }
    };
  }

  function statusPill(status) {
    const key = status || 'pending';
    return `<span class="pill ${key}">${STATUS_LABEL[key] || key}</span>`;
  }

  function filteredItems(items) {
    const list = Array.isArray(items) ? items : [];
    if (state.filter === 'all') return list;
    return list.filter((it) => it.status === state.filter);
  }

  function renderTable() {
    const job = state.job;
    const items = filteredItems(job?.items || []);
    const pageSize = state.pageSize || 50;
    const totalPages = Math.max(1, Math.ceil(items.length / pageSize) || 1);
    if (state.page > totalPages) state.page = totalPages;
    if (state.page < 1) state.page = 1;

    const start = (state.page - 1) * pageSize;
    const pageItems = items.slice(start, start + pageSize);

    if (!pageItems.length) {
      els.itemBody.innerHTML = `<tr><td colspan="5" class="empty">${
        job ? '当前筛选无数据' : '创建任务后显示明细'
      }</td></tr>`;
    } else {
      els.itemBody.innerHTML = pageItems
        .map((it) => {
          const preview = it.preview
            ? [it.preview.email, it.preview.type].filter(Boolean).join(' · ')
            : '';
          const note =
            it.error ||
            (it.fromCache || it.status === 'skipped' ? '本地缓存：此前已上传成功' : '');
          return `<tr>
            <td class="col-status">${statusPill(it.status)}</td>
            <td class="cell-name" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</td>
            <td class="cell-preview" title="${escapeHtml(preview || '-')}">${escapeHtml(preview || '-')}</td>
            <td class="cell-try">${it.attempts || 0}</td>
            <td class="err-text" title="${escapeHtml(note || '')}">${escapeHtml(note || '')}</td>
          </tr>`;
        })
        .join('');
    }

    els.pageInfo.textContent = `${state.page} / ${totalPages} · ${items.length} 条`;
    els.btnPrevPage.disabled = state.page <= 1;
    els.btnNextPage.disabled = state.page >= totalPages;
  }

  function renderJob(job) {
    state.job = job;
    const counts = job.counts || {};
    const progress = job.progress || 0;
    els.jobStatus.textContent = `状态 · ${job.status || '-'}`;
    els.jobCounts.textContent = `${job.done || 0} / ${job.total || 0} · ${progress}%`;
    els.progressFill.style.width = `${progress}%`;
    const bar = els.progressFill.parentElement;
    if (bar) bar.setAttribute('aria-valuenow', String(progress));

    els.cSuccess.textContent = counts.success || 0;
    els.cFailed.textContent = counts.failed || 0;
    els.cUploading.textContent = counts.uploading || 0;
    els.cPending.textContent = counts.pending || 0;
    if (els.cSkipped) els.cSkipped.textContent = counts.skipped || 0;

    const running = job.status === 'running';
    const done = job.status === 'completed' || job.status === 'cancelled';
    els.btnStart.disabled = !state.jobId || running;
    els.btnCancel.disabled = !running;
    els.btnRetry.disabled = !(done && (counts.failed || 0) > 0);

    renderTable();

    if (Array.isArray(job.logs)) {
      els.logBox.textContent = job.logs.join('\n');
      els.logBox.scrollTop = els.logBox.scrollHeight;
    }
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function startJob() {
    if (!state.jobId) return;
    els.btnStart.disabled = true;
    const res = await fetch(`/api/jobs/${state.jobId}/start`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      toast(els.prepareMsg, data.error || '启动失败', true);
      els.btnStart.disabled = false;
      return;
    }
    renderJob(data);
    if (!state.es) openES(state.jobId);
  }

  async function retryFailed() {
    if (!state.jobId) return;
    const res = await fetch(`/api/jobs/${state.jobId}/retry-failed`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      toast(els.prepareMsg, data.error || '重传失败', true);
      return;
    }
    state.page = 1;
    if (els.itemFilter) {
      els.itemFilter.value = 'failed';
      state.filter = 'failed';
    }
    renderJob(data);
    if (!state.es) openES(state.jobId);
  }

  async function cancelJob() {
    if (!state.jobId) return;
    const res = await fetch(`/api/jobs/${state.jobId}/cancel`, { method: 'POST' });
    const data = await res.json();
    if (res.ok) renderJob(data);
  }

  async function refreshRemote() {
    els.btnRefreshRemote.disabled = true;
    try {
      const res = await fetch('/api/remote-auth-files?limit=50');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '拉取失败');
      if (data.disabled) {
        els.remoteBody.innerHTML = `<tr><td colspan="5" class="empty">${escapeHtml(
          data.message || '远端列表已禁用（池太大）',
        )}</td></tr>`;
        return;
      }
      const files = data.files || [];
      if (!files.length) {
        els.remoteBody.innerHTML = `<tr><td colspan="5" class="empty">远端暂无凭证</td></tr>`;
      } else {
        const total = data.total ?? files.length;
        const tip = data.truncated
          ? `<tr><td colspan="5" class="empty">共 ${total} 个，仅展示前 ${files.length} 个</td></tr>`
          : '';
        els.remoteBody.innerHTML =
          tip +
          files
            .map(
              (f) => `<tr>
            <td class="cell-name">${escapeHtml(f.name || f.id || '-')}</td>
            <td>${escapeHtml(f.provider || f.type || '-')}</td>
            <td>${statusPill(f.status || (f.disabled ? 'disabled' : 'ready'))}</td>
            <td class="muted">${escapeHtml(f.email || '-')}</td>
            <td>${f.success ?? 0} / ${f.failed ?? 0}</td>
          </tr>`,
            )
            .join('');
      }
    } catch (e) {
      els.remoteBody.innerHTML = `<tr><td colspan="5" class="err-text empty">${escapeHtml(e.message)}</td></tr>`;
    } finally {
      els.btnRefreshRemote.disabled = false;
    }
  }


  function exportPayload() {
    const cfg = configPayload(true);
    const limitRaw = (els.exportLimit?.value || '').trim();
    return {
      baseUrl: cfg.baseUrl,
      managementKey: cfg.managementKey,
      timeoutMs: cfg.timeoutMs,
      retryLimit: cfg.retryLimit,
      provider: (els.exportProvider?.value || '').trim(),
      emailContains: (els.exportEmail?.value || '').trim(),
      nameContains: (els.exportName?.value || '').trim(),
      limit: limitRaw ? Number(limitRaw) : null,
      batchSize: Number(els.exportBatchSize?.value || 500),
      concurrency: Number(els.exportConcurrency?.value || 15),
      keepFiles: Boolean(els.exportKeepFiles?.checked),
    };
  }

  function closeExportES() {
    if (state.exportEs) {
      state.exportEs.close();
      state.exportEs = null;
    }
  }

  function openExportES(jobId) {
    closeExportES();
    const es = new EventSource(`/api/export/jobs/${jobId}/events`);
    state.exportEs = es;
    es.onmessage = (ev) => {
      try {
        renderExportJob(JSON.parse(ev.data));
      } catch {
        /* ignore */
      }
    };
  }

  function renderExportParts(job) {
    const parts = job?.parts || [];
    if (!els.exportPartsBody) return;
    if (!parts.length) {
      els.exportPartsBody.innerHTML = `<tr><td colspan="4" class="empty">${
        job?.status === 'running' ? '批次完成后会出现 zip 分卷…' : '导出完成后显示 zip 分卷'
      }</td></tr>`;
    } else {
      els.exportPartsBody.innerHTML = parts
        .map((p) => {
          const href = `/api/export/jobs/${job.id}/parts/${encodeURIComponent(p.filename)}`;
          return `<tr>
            <td class="cell-name">${escapeHtml(p.filename)}</td>
            <td>${p.files ?? 0}</td>
            <td>${formatSize(p.bytes || 0)}</td>
            <td><a href="${href}" download="${escapeHtml(p.filename)}">下载</a></td>
          </tr>`;
        })
        .join('');
    }

    if (els.btnExportDownloadAll) {
      if (parts.length) {
        els.btnExportDownloadAll.style.display = '';
        els.btnExportDownloadAll.href = `/api/export/jobs/${job.id}/download-all`;
      } else {
        els.btnExportDownloadAll.style.display = 'none';
        els.btnExportDownloadAll.removeAttribute('href');
      }
    }
  }

  function renderExportJob(job) {
    if (!job) return;
    state.exportJob = job;
    state.exportJobId = job.id;
    const counts = job.counts || {};
    const progress = job.progress || 0;
    if (els.exportStatus) {
      const batch =
        job.totalBatches
          ? ` · 批次 ${job.currentBatch || 0}/${job.totalBatches}`
          : '';
      els.exportStatus.textContent = `状态 · ${job.status || '-'}${batch}`;
    }
    if (els.exportCounts) {
      els.exportCounts.textContent = `${job.done || 0} / ${job.total || 0} · ${progress}%`;
    }
    if (els.exportProgressFill) {
      els.exportProgressFill.style.width = `${progress}%`;
      const bar = els.exportProgressFill.parentElement;
      if (bar) bar.setAttribute('aria-valuenow', String(progress));
    }
    if (els.eSuccess) els.eSuccess.textContent = counts.success || 0;
    if (els.eFailed) els.eFailed.textContent = counts.failed || 0;
    if (els.eDownloading) els.eDownloading.textContent = counts.downloading || 0;
    if (els.ePending) els.ePending.textContent = counts.pending || 0;
    if (els.eParts) els.eParts.textContent = (job.parts || []).length;

    const running = job.status === 'running';
    const done = job.status === 'completed' || job.status === 'cancelled';
    if (els.btnExportStart) els.btnExportStart.disabled = running;
    if (els.btnExportCancel) els.btnExportCancel.disabled = !running;
    if (els.btnExportRetry) els.btnExportRetry.disabled = !(done && (counts.failed || 0) > 0);
    if (els.btnExportPreview) els.btnExportPreview.disabled = running;

    if (els.exportPathHint) {
      els.exportPathHint.textContent = job.outputDir
        ? `输出目录: ${job.outputDir}`
        : '';
    }

    renderExportParts(job);

    if (els.exportLogBox && Array.isArray(job.logs)) {
      els.exportLogBox.textContent = job.logs.join('\n');
      els.exportLogBox.scrollTop = els.exportLogBox.scrollHeight;
    }
  }

  async function previewExport() {
    if (!els.btnExportPreview) return;
    els.btnExportPreview.disabled = true;
    toast(els.exportMsg, '正在拉取远端列表并筛选（大号池可能较慢）…');
    try {
      await saveConfig().catch(() => {});
      const res = await fetch('/api/export/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(exportPayload()),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.error || '预览失败');
      const prov = (data.matchedProviders || [])
        .slice(0, 6)
        .map((p) => `${p.provider}:${p.count}`)
        .join(' · ');
      toast(
        els.exportMsg,
        `远端 ${data.totalRemote} · 匹配 ${data.matched} · 预计 ${data.estimatedBatches} 个 zip 分卷（每批 ${data.batchSize}）` +
          (prov ? ` · ${prov}` : '') +
          (data.hint ? ` · ${data.hint}` : ''),
      );
    } catch (e) {
      toast(els.exportMsg, e.message, true);
    } finally {
      els.btnExportPreview.disabled = false;
    }
  }

  async function startExport() {
    if (!els.btnExportStart) return;
    const payload = exportPayload();
    const limitHint = payload.limit ? `前 ${payload.limit} 个` : '全部匹配';
    if (
      !window.confirm(
        `确认开始导出？\n筛选: provider=${payload.provider || '*'} email*=${payload.emailContains || '*'} name*=${payload.nameContains || '*'}\n范围: ${limitHint}\n每批 ${payload.batchSize} · 并发 ${payload.concurrency}`,
      )
    ) {
      return;
    }
    els.btnExportStart.disabled = true;
    toast(els.exportMsg, '创建导出任务… 正在拉取列表');
    try {
      await saveConfig().catch(() => {});
      const res = await fetch('/api/export/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.job) renderExportJob(data.job);
        throw new Error(data.error || '启动失败');
      }
      state.exportJobId = data.id;
      openExportES(data.id);
      renderExportJob(data);
      toast(
        els.exportMsg,
        `导出已开始 · 共 ${data.total} · 远端 ${data.totalRemote} · 分 ${data.totalBatches} 批`,
      );
    } catch (e) {
      toast(els.exportMsg, e.message, true);
      if (els.btnExportStart) els.btnExportStart.disabled = false;
    }
  }

  async function retryExportFailed() {
    if (!state.exportJobId) return;
    const res = await fetch(`/api/export/jobs/${state.exportJobId}/retry-failed`, {
      method: 'POST',
    });
    const data = await res.json();
    if (!res.ok) {
      toast(els.exportMsg, data.error || '重试失败', true);
      return;
    }
    renderExportJob(data);
    if (!state.exportEs) openExportES(state.exportJobId);
  }

  async function cancelExport() {
    if (!state.exportJobId) return;
    const res = await fetch(`/api/export/jobs/${state.exportJobId}/cancel`, { method: 'POST' });
    const data = await res.json();
    if (res.ok) renderExportJob(data);
  }

  // events
  els.dropzone.addEventListener('click', () => els.fileInput.click());
  els.dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      els.fileInput.click();
    }
  });
  els.fileInput.addEventListener('change', () => {
    if (els.fileInput.files?.length) setFiles(els.fileInput.files);
    els.fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach((ev) => {
    els.dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      els.dropzone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach((ev) => {
    els.dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      els.dropzone.classList.remove('dragover');
    });
  });
  els.dropzone.addEventListener('drop', (e) => {
    if (e.dataTransfer?.files?.length) setFiles(e.dataTransfer.files);
  });

  els.btnClearFiles.addEventListener('click', () => {
    state.files = [];
    els.rawJson.value = '';
    els.folderPath.value = '';
    renderFileList();
    toast(els.prepareMsg, '');
  });
  els.btnSaveConfig.addEventListener('click', async () => {
    try {
      await saveConfig();
      toast(els.testMsg, '配置已保存');
    } catch (e) {
      toast(els.testMsg, e.message, true);
    }
  });
  els.btnTest.addEventListener('click', testConnection);
  els.btnPrepare.addEventListener('click', prepareJob);
  els.btnStart.addEventListener('click', startJob);
  els.btnRetry.addEventListener('click', retryFailed);
  els.btnCancel.addEventListener('click', cancelJob);
  els.btnRefreshRemote.addEventListener('click', refreshRemote);
  els.btnTheme.addEventListener('click', toggleTheme);

  if (els.itemFilter) {
    els.itemFilter.addEventListener('change', () => {
      state.filter = els.itemFilter.value || 'all';
      state.page = 1;
      renderTable();
    });
  }
  if (els.pageSize) {
    els.pageSize.addEventListener('change', () => {
      state.pageSize = Number(els.pageSize.value || 50);
      state.page = 1;
      renderTable();
    });
    state.pageSize = Number(els.pageSize.value || 50);
  }
  if (els.btnPrevPage) {
    els.btnPrevPage.addEventListener('click', () => {
      state.page -= 1;
      renderTable();
    });
  }
  if (els.btnNextPage) {
    els.btnNextPage.addEventListener('click', () => {
      state.page += 1;
      renderTable();
    });
  }
  if (els.btnClearCache) {
    els.btnClearCache.addEventListener('click', async () => {
      try {
        await clearCache();
      } catch (e) {
        toast(els.cacheMsg, e.message, true);
      }
    });
  }
  if (els.skipCached) {
    els.skipCached.addEventListener('change', async () => {
      try {
        await saveConfig();
        toast(els.cacheMsg, els.skipCached.checked ? '已开启缓存跳过' : '已关闭缓存跳过');
      } catch (e) {
        toast(els.cacheMsg, e.message, true);
      }
    });
  }

  if (els.btnExportPreview) els.btnExportPreview.addEventListener('click', previewExport);
  if (els.btnExportStart) els.btnExportStart.addEventListener('click', startExport);
  if (els.btnExportRetry) els.btnExportRetry.addEventListener('click', retryExportFailed);
  if (els.btnExportCancel) els.btnExportCancel.addEventListener('click', cancelExport);

  async function loadVersion() {
    try {
      const res = await fetch('/api/health');
      const data = await res.json();
      const el = document.getElementById('appVersion');
      if (el && data.version) el.textContent = `v${data.version}`;
    } catch {
      /* ignore */
    }
  }

  loadVersion();
  loadConfig().catch((e) => toast(els.testMsg, e.message, true));
})();
