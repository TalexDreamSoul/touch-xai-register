package transfer

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/grok-free-register/grok-reg/internal/cpa"
	"github.com/grok-free-register/grok-reg/internal/jobs"
)

// ExportOptions tunes one export job. Key is never serialized.
type ExportOptions struct {
	BatchSize   int    `json:"batchSize"`
	Concurrency int    `json:"concurrency"`
	TimeoutMs   int    `json:"timeoutMs"`
	RetryLimit  int    `json:"retryLimit"`
	KeepFiles   bool   `json:"keepFiles"`
	BaseURL     string `json:"baseUrl"`

	Key string `json:"-"`
}

// ExportPart describes one written zip volume.
type ExportPart struct {
	Index    int    `json:"index"`
	Filename string `json:"filename"`
	Files    int    `json:"files"`
	Success  int    `json:"success"`
	Failed   int    `json:"failed"`
	Bytes    int64  `json:"bytes"`

	absPath string
}

// ExportFailure records one failed download.
type ExportFailure struct {
	Name  string `json:"name"`
	Error string `json:"error"`
}

// ExportManifest is written to manifest.json at the end of every export.
type ExportManifest struct {
	ID          string          `json:"id"`
	CreatedAt   time.Time       `json:"createdAt"`
	FinishedAt  time.Time       `json:"finishedAt"`
	Filters     ExportFilters   `json:"filters"`
	TotalRemote int             `json:"totalRemote"`
	Total       int             `json:"total"`
	Counts      itemCounts      `json:"counts"`
	Parts       []ExportPart    `json:"parts"`
	Failures    []ExportFailure `json:"failures"`
	BaseURL     string          `json:"baseUrl"`
}

// exportState holds the mutable per-job export bookkeeping.
type exportState struct {
	mu           sync.Mutex
	opts         ExportOptions
	filters      ExportFilters
	totalRemote  int
	dir          string
	filesDir     string
	parts        []ExportPart
	failures     []ExportFailure
	currentBatch int
	totalBatches int
	successes    int
	manifest     *ExportManifest
}

// PreviewResult is returned by /api/export/preview.
type PreviewResult struct {
	TotalRemote      int            `json:"totalRemote"`
	Matched          int            `json:"matched"`
	Filters          ExportFilters  `json:"filters"`
	Providers        []ProviderStat `json:"providers"`
	MatchedProviders []ProviderStat `json:"matchedProviders"`
	Sample           []cpa.AuthMeta `json:"sample"`
	EstimatedBatches int            `json:"estimatedBatches"`
	BatchSize        int            `json:"batchSize"`
	Concurrency      int            `json:"concurrency"`
	Hint             string         `json:"hint,omitempty"`
}

// PreviewExport lists the remote pool and applies filters without downloading.
func (s *Service) PreviewExport(r *http.Request) (PreviewResult, error) {
	req, err := parseExportRequest(r)
	if err != nil {
		return PreviewResult{}, err
	}
	_, _, defs := s.cfgFn()
	batchSize := clampInt(req.BatchSize, defs.ExportBatchSize, 50, 2000)
	concurrency := clampInt(req.Concurrency, defs.ExportConcurrency, 1, 50)
	conn := s.ResolveConnection(req.BaseURL, req.ManagementKey)
	if conn.Key == "" {
		return PreviewResult{}, fmt.Errorf("未配置 Management Key")
	}
	client := s.NewClient(conn)
	list, err := client.List()
	if err != nil {
		return PreviewResult{}, fmt.Errorf("拉取远端列表失败: %v", err)
	}
	matched := req.ExportFilters.Apply(list)
	res := PreviewResult{
		TotalRemote:      len(list),
		Matched:          len(matched),
		Filters:          req.ExportFilters,
		Providers:        providerStats(list),
		MatchedProviders: providerStats(matched),
		EstimatedBatches: (len(matched) + batchSize - 1) / batchSize,
		BatchSize:        batchSize,
		Concurrency:      concurrency,
	}
	if len(matched) > 20 {
		res.Sample = matched[:20]
	} else {
		res.Sample = matched
	}
	if len(matched) > 2000 {
		res.Hint = "号池较大，建议分批导出（每批 500）并预留充足时间"
	}
	return res, nil
}

// StartExport validates, creates and launches an export job.
// Returns the job and, on conflict, the currently running job.
func (s *Service) StartExport(r *http.Request) (*jobs.Job, *jobs.Job, error) {
	req, err := parseExportRequest(r)
	if err != nil {
		return nil, nil, err
	}
	if running := s.ExportJobs.Running(); running != nil {
		return nil, running, fmt.Errorf("已有导出任务进行中")
	}
	conn := s.ResolveConnection(req.BaseURL, req.ManagementKey)
	if conn.Key == "" {
		return nil, nil, fmt.Errorf("未配置 Management Key")
	}
	_, _, defs := s.cfgFn()
	opts := ExportOptions{
		BatchSize:   clampInt(req.BatchSize, defs.ExportBatchSize, 50, 2000),
		Concurrency: clampInt(req.Concurrency, defs.ExportConcurrency, 1, 50),
		TimeoutMs:   clampInt(req.TimeoutMs, defs.TimeoutMs, 3000, 300000),
		RetryLimit:  clampInt(req.RetryLimit, defs.RetryLimit, 0, 10),
		KeepFiles:   req.KeepFiles,
		BaseURL:     conn.BaseURL,
		Key:         conn.Key,
	}
	client := s.NewClient(Connection{BaseURL: opts.BaseURL, Key: opts.Key, TimeoutMs: max(opts.TimeoutMs, 120000), RetryLimit: opts.RetryLimit})
	list, err := client.List()
	if err != nil {
		return nil, nil, fmt.Errorf("拉取远端列表失败: %v", err)
	}
	matched := req.ExportFilters.Apply(list)
	if len(matched) == 0 {
		return nil, nil, fmt.Errorf("没有匹配的远端凭证")
	}

	items := make([]*jobs.Item, 0, len(matched))
	for i, m := range matched {
		items = append(items, &jobs.Item{
			ID: i + 1, Name: m.Name, Size: m.Size, Status: jobs.ItemPending,
			Preview: map[string]string{"email": m.Email, "type": m.Provider},
		})
	}
	job := jobs.NewJob("export", items)
	job.SetLogCap(400)

	dir := filepath.Join(s.ExportsDir, job.ID)
	st := &exportState{
		opts: opts, filters: req.ExportFilters, totalRemote: len(list),
		dir: dir, filesDir: filepath.Join(dir, "files"),
	}
	if err := os.MkdirAll(st.filesDir, 0o700); err != nil {
		return nil, nil, err
	}
	s.exportStates.Store(job.ID, st)
	s.ExportJobs.Add(job)
	job.AddLog("导出任务已创建：远端 %d，匹配 %d，每批 %d，并发 %d", len(list), len(matched), opts.BatchSize, opts.Concurrency)
	job.SetStatus(jobs.StatusRunning)
	go s.runExportJob(job, st, false)
	return job, nil, nil
}

// RetryExportFailed re-runs only the failed downloads of a finished export.
func (s *Service) RetryExportFailed(job *jobs.Job) bool {
	if job.GetStatus() == jobs.StatusRunning {
		return false
	}
	v, ok := s.exportStates.Load(job.ID)
	if !ok {
		return false
	}
	st := v.(*exportState)
	hasFailed := false
	for _, it := range job.ItemValues() {
		if it.Status == jobs.ItemFailed {
			hasFailed = true
			break
		}
	}
	if !hasFailed {
		return false
	}
	job.SetStatus(jobs.StatusRunning)
	go s.runExportJob(job, st, true)
	return true
}

func (s *Service) runExportJob(job *jobs.Job, st *exportState, onlyFailed bool) {
	if onlyFailed {
		job.AddLog("重试失败项（已有分卷保留，新分卷续编号）")
	}
	// Re-queue items: retry mode only failed ones; fresh run everything unfinished.
	job.WithItems(func(items []*jobs.Item) {
		for _, it := range items {
			switch {
			case onlyFailed && it.Status == jobs.ItemFailed:
				it.Status = jobs.ItemPending
				it.Error = ""
			case !onlyFailed && (it.Status == jobs.ItemPending || it.Status == jobs.ItemFailed):
				it.Status = jobs.ItemPending
				it.Error = ""
			}
		}
	})
	if onlyFailed {
		st.mu.Lock()
		st.failures = nil
		st.mu.Unlock()
	}

	opts := st.opts
	client := s.NewClient(Connection{BaseURL: opts.BaseURL, Key: opts.Key, TimeoutMs: opts.TimeoutMs, RetryLimit: opts.RetryLimit})

	items := job.Items()
	waveSize := max(50, opts.BatchSize)

	// Build the queue of pending item indexes.
	var queue []int
	for i, it := range job.ItemValues() {
		if it.Status == jobs.ItemPending {
			queue = append(queue, i)
		}
	}
	st.mu.Lock()
	st.totalBatches = (len(queue) + waveSize - 1) / waveSize
	st.currentBatch = 0
	st.mu.Unlock()

	emit := func(force bool) {
		st.mu.Lock()
		succ := st.successes
		st.mu.Unlock()
		if force || succ%10 == 0 {
			job.Broadcast(s.ExportSummary(job))
		}
	}
	job.Broadcast(s.ExportSummary(job))

	for bs := 0; bs < len(queue); bs += waveSize {
		if job.Context().Err() != nil {
			break
		}
		be := min(bs+waveSize, len(queue))
		batchIdx := queue[bs:be]

		st.mu.Lock()
		st.currentBatch++
		batchNo := st.currentBatch
		st.mu.Unlock()
		job.AddLog("第 %d/%d 批：下载 %d 个文件", batchNo, st.totalBatches, len(batchIdx))

		batchOK := make(map[int]bool, len(batchIdx))
		var batchMu sync.Mutex

		jobs.RunPool(job.Context(), len(batchIdx), min(opts.Concurrency, len(batchIdx)), func(i int) {
			idx := batchIdx[i]
			name := items[idx].Name
			job.MutateItem(idx, func(cur *jobs.Item) {
				cur.Status = jobs.ItemRunning
				now := time.Now()
				cur.StartedAt = &now
			})

			var lastErr string
			var data []byte
			attempts := 1 + opts.RetryLimit
			for a := 1; a <= attempts; a++ {
				if job.Context().Err() != nil {
					break
				}
				if a > 1 {
					timer := time.NewTimer(time.Duration(250*a) * time.Millisecond)
					select {
					case <-job.Context().Done():
						timer.Stop()
					case <-timer.C:
					}
					if job.Context().Err() != nil {
						break
					}
				}
				job.MutateItem(idx, func(cur *jobs.Item) { cur.Attempts = a })
				b, err := client.Download(name)
				if err == nil {
					data = b
					lastErr = ""
					break
				}
				lastErr = err.Error()
			}

			if lastErr == "" && data != nil {
				// Write to files/ then count toward the batch zip.
				out := filepath.Join(st.filesDir, safeBasename(name))
				if err := os.WriteFile(out, data, 0o600); err != nil {
					lastErr = err.Error()
				} else {
					batchMu.Lock()
					batchOK[idx] = true
					batchMu.Unlock()
					job.MutateItem(idx, func(cur *jobs.Item) {
						cur.Status = jobs.ItemSuccess
						cur.Size = int64(len(data))
						now := time.Now()
						cur.FinishedAt = &now
					})
					st.mu.Lock()
					st.successes++
					st.mu.Unlock()
					emit(false)
					return
				}
			}
			job.MutateItem(idx, func(cur *jobs.Item) {
				cur.Status = jobs.ItemFailed
				cur.Error = lastErr
				now := time.Now()
				cur.FinishedAt = &now
			})
			st.mu.Lock()
			if len(st.failures) < 500 {
				st.failures = append(st.failures, ExportFailure{Name: name, Error: lastErr})
			}
			st.mu.Unlock()
			job.AddLog("✗ %s: %s", name, lastErr)
			emit(true)
		})

		// Zip this batch's successes into the next part volume.
		if len(batchOK) > 0 {
			part, err := s.writePartZip(st, batchOK, items)
			if err != nil {
				job.AddLog("⚠ 分卷打包失败: %v", err)
			} else {
				st.mu.Lock()
				st.parts = append(st.parts, part)
				st.mu.Unlock()
				job.AddLog("✓ %s（%d 个文件，%.1f KB）", part.Filename, part.Files, float64(part.Bytes)/1024)
			}
			if !opts.KeepFiles {
				for idx := range batchOK {
					_ = os.Remove(filepath.Join(st.filesDir, safeBasename(items[idx].Name)))
				}
			}
		}
		job.Broadcast(s.ExportSummary(job))

		select {
		case <-job.Context().Done():
		case <-time.After(50 * time.Millisecond):
		}
	}

	// Final status + manifest (written even on cancel).
	cancelled := job.Context().Err() != nil
	if cancelled {
		job.SetStatus(jobs.StatusCancelled)
		job.AddLog("导出已取消")
	} else {
		job.SetStatus(jobs.StatusCompleted)
	}
	manifest := s.writeManifest(job, st)
	st.mu.Lock()
	st.manifest = manifest
	st.mu.Unlock()
	if !cancelled {
		c := manifest.Counts
		job.AddLog("导出完成：成功 %d，失败 %d，分卷 %d", c.Success, c.Failed, len(manifest.Parts))
	}
	job.Broadcast(s.ExportSummary(job))
}

// writePartZip packs the given successful item indexes into part-%03d.zip.
func (s *Service) writePartZip(st *exportState, batchOK map[int]bool, items []*jobs.Item) (ExportPart, error) {
	st.mu.Lock()
	idx := len(st.parts) + 1
	st.mu.Unlock()
	filename := fmt.Sprintf("part-%03d.zip", idx)
	abs := filepath.Join(st.dir, filename)

	f, err := os.Create(abs)
	if err != nil {
		return ExportPart{}, err
	}
	zw := zip.NewWriter(f)
	count := 0
	for i := range batchOK {
		name := safeBasename(items[i].Name)
		src := filepath.Join(st.filesDir, name)
		data, err := os.ReadFile(src)
		if err != nil {
			continue
		}
		w, err := zw.Create(name)
		if err != nil {
			continue
		}
		if _, err := w.Write(data); err != nil {
			continue
		}
		count++
	}
	if err := zw.Close(); err != nil {
		f.Close()
		return ExportPart{}, err
	}
	if err := f.Close(); err != nil {
		return ExportPart{}, err
	}
	fi, _ := os.Stat(abs)
	var size int64
	if fi != nil {
		size = fi.Size()
	}
	return ExportPart{
		Index: idx, Filename: filename, Files: count, Success: count,
		Failed: len(batchOK) - count, Bytes: size, absPath: abs,
	}, nil
}

// writeManifest persists manifest.json and returns it.
func (s *Service) writeManifest(job *jobs.Job, st *exportState) *ExportManifest {
	st.mu.Lock()
	parts := append([]ExportPart(nil), st.parts...)
	failures := append([]ExportFailure(nil), st.failures...)
	st.mu.Unlock()
	pub := make([]ExportPart, len(parts))
	for i, p := range parts {
		p.absPath = ""
		pub[i] = p
	}
	m := &ExportManifest{
		ID: job.ID, CreatedAt: job.CreatedAt, FinishedAt: time.Now(),
		Filters: st.filters, TotalRemote: st.totalRemote, Total: len(job.Items()),
		Counts: uploadCounts(job.ItemValues()),
		Parts:  pub, Failures: failures, BaseURL: st.opts.BaseURL,
	}
	b, err := json.MarshalIndent(m, "", "  ")
	if err == nil {
		_ = os.WriteFile(filepath.Join(st.dir, "manifest.json"), b, 0o600)
	}
	return m
}

// ExportSummary is the SSE/snapshot payload for an export job.
type ExportSummary struct {
	ID           string          `json:"id"`
	Kind         string          `json:"kind"`
	Status       jobs.Status     `json:"status"`
	CreatedAt    time.Time       `json:"createdAt"`
	StartedAt    *time.Time      `json:"startedAt,omitempty"`
	FinishedAt   *time.Time      `json:"finishedAt,omitempty"`
	Filters      ExportFilters   `json:"filters"`
	Options      ExportOptions   `json:"options"`
	TotalRemote  int             `json:"totalRemote"`
	Total        int             `json:"total"`
	Done         int             `json:"done"`
	Progress     int             `json:"progress"`
	Counts       itemCounts      `json:"counts"`
	CurrentBatch int             `json:"currentBatch"`
	TotalBatches int             `json:"totalBatches"`
	Parts        []ExportPart    `json:"parts"`
	Failures     []ExportFailure `json:"failures"`
	Logs         []string        `json:"logs"`
	OutputDir    string          `json:"outputDir"`
	Manifest     *ExportManifest `json:"manifest,omitempty"`
}

// ExportSummary builds the public summary for an export job.
func (s *Service) ExportSummary(job *jobs.Job) ExportSummary {
	items := job.ItemValues()
	counts := uploadCounts(items)
	done := counts.Success + counts.Failed + counts.Skipped
	progress := 0
	if len(items) > 0 {
		progress = done * 100 / len(items)
	}
	sum := ExportSummary{
		ID: job.ID, Kind: "export", Status: job.GetStatus(),
		CreatedAt: job.CreatedAt, StartedAt: job.StartedAt, FinishedAt: job.FinishedAt,
		Total: len(items), Done: done, Progress: progress, Counts: counts,
	}
	logs := job.Logs()
	if len(logs) > 100 {
		logs = logs[len(logs)-100:]
	}
	sum.Logs = logs

	if v, ok := s.exportStates.Load(job.ID); ok {
		st := v.(*exportState)
		st.mu.Lock()
		sum.Filters = st.filters
		pub := st.opts
		pub.Key = ""
		sum.Options = pub
		sum.TotalRemote = st.totalRemote
		sum.CurrentBatch = st.currentBatch
		sum.TotalBatches = st.totalBatches
		sum.Parts = append([]ExportPart(nil), st.parts...)
		for i := range sum.Parts {
			sum.Parts[i].absPath = ""
		}
		if len(st.failures) > 100 {
			sum.Failures = append([]ExportFailure(nil), st.failures[len(st.failures)-100:]...)
		} else {
			sum.Failures = append([]ExportFailure(nil), st.failures...)
		}
		sum.OutputDir = filepath.Base(st.dir)
		sum.Manifest = st.manifest
		st.mu.Unlock()
	}
	return sum
}

// ExportJobDir returns the on-disk directory of an export job.
func (s *Service) ExportJobDir(jobID string) (string, bool) {
	v, ok := s.exportStates.Load(jobID)
	if !ok {
		return "", false
	}
	return v.(*exportState).dir, true
}

// PartPath resolves a part/manifest filename inside a job dir safely.
// Allowed: part-\d{3}.zip, manifest.json, <jobID>-all-parts.zip.
func (s *Service) PartPath(jobID, filename string) (string, error) {
	dir, ok := s.ExportJobDir(jobID)
	if !ok {
		return "", fmt.Errorf("导出任务不存在")
	}
	base := filepath.Base(filename)
	valid := base == "manifest.json" ||
		base == jobID+"-all-parts.zip" ||
		(strings.HasPrefix(base, "part-") && strings.HasSuffix(base, ".zip") && len(base) == len("part-000.zip"))
	if !valid {
		return "", fmt.Errorf("非法文件名")
	}
	abs := filepath.Join(dir, base)
	cleanDir := filepath.Clean(dir) + string(os.PathSeparator)
	if !strings.HasPrefix(filepath.Clean(abs)+string(os.PathSeparator), cleanDir) && filepath.Clean(abs) != filepath.Clean(dir) {
		return "", fmt.Errorf("路径越界")
	}
	if _, err := os.Stat(abs); err != nil {
		return "", fmt.Errorf("文件不存在")
	}
	return abs, nil
}

// DownloadAllParts repackages all part zips + manifest into one zip and
// returns its path (regenerated per request).
func (s *Service) DownloadAllParts(jobID string) (string, error) {
	dir, ok := s.ExportJobDir(jobID)
	if !ok {
		return "", fmt.Errorf("导出任务不存在")
	}
	out := filepath.Join(dir, jobID+"-all-parts.zip")
	f, err := os.Create(out)
	if err != nil {
		return "", err
	}
	defer f.Close()
	zw := zip.NewWriter(f)
	add := func(path, name string) error {
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		w, err := zw.Create(name)
		if err != nil {
			return err
		}
		_, err = w.Write(data)
		return err
	}
	added := 0
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		n := e.Name()
		if strings.HasPrefix(n, "part-") && strings.HasSuffix(n, ".zip") {
			if add(filepath.Join(dir, n), n) == nil {
				added++
			}
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "manifest.json")); err == nil {
		_ = add(filepath.Join(dir, "manifest.json"), "manifest.json")
	}
	if err := zw.Close(); err != nil {
		return "", err
	}
	if added == 0 {
		return "", fmt.Errorf("还没有可下载的分卷")
	}
	return out, nil
}

// TestConnection probes GET /debug on the CPA Management API.
func (s *Service) TestConnection(baseURL, key string) (int, string, error) {
	conn := s.ResolveConnection(baseURL, key)
	if conn.Key == "" {
		return 0, "", fmt.Errorf("未配置 Management Key")
	}
	conn.TimeoutMs = 20000
	client := s.NewClient(conn)
	return client.Debug()
}

// ListRemote fetches the slim remote list; limited unless force.
// page is 1-based when force; pageSize defaults/caps at 50 (legacy) or 100 when page>0.
func (s *Service) ListRemote(baseURL, key string, force bool, limit int) ([]cpa.AuthMeta, int, error) {
	return s.ListRemotePage(baseURL, key, force, 1, limit)
}

// ListRemotePage pages the remote auth-files list (1-based page).
func (s *Service) ListRemotePage(baseURL, key string, force bool, page, pageSize int) ([]cpa.AuthMeta, int, error) {
	conn := s.ResolveConnection(baseURL, key)
	if conn.Key == "" {
		return nil, 0, fmt.Errorf("未配置 Management Key")
	}
	conn.TimeoutMs = max(conn.TimeoutMs, 120000)
	client := s.NewClient(conn)
	list, err := client.List()
	if err != nil {
		return nil, 0, err
	}
	total := len(list)
	if !force {
		return nil, total, nil
	}
	if page < 1 {
		page = 1
	}
	if pageSize <= 0 {
		pageSize = 50
	}
	if pageSize > 100 {
		pageSize = 100
	}
	start := (page - 1) * pageSize
	if start >= total {
		return []cpa.AuthMeta{}, total, nil
	}
	end := start + pageSize
	if end > total {
		end = total
	}
	return list[start:end], total, nil
}
