package api

import (
	"archive/zip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/grok-free-register/grok-reg/internal/cluster"
	"github.com/grok-free-register/grok-reg/internal/config"
	"github.com/grok-free-register/grok-reg/internal/cpa"
	"github.com/grok-free-register/grok-reg/internal/daemon"
	"github.com/grok-free-register/grok-reg/internal/home"
	"github.com/grok-free-register/grok-reg/internal/patrol"
	"github.com/grok-free-register/grok-reg/internal/state"
	"github.com/grok-free-register/grok-reg/internal/transfer"
)

// Options configures the panel HTTP server.
type Options struct {
	Paths home.Paths
	Addr  string // e.g. :8787
	Token string // empty = no auth (dev only)
	WebFS fs.FS  // static panel assets (index.html at root)
}

type Server struct {
	opt      Options
	mux      *http.ServeMux
	transfer *transfer.Service
	patrol   *patrol.Service
	cluster  *cluster.Service
}

func New(opt Options) *Server {
	s := &Server{opt: opt, mux: http.NewServeMux()}
	s.transfer = transfer.NewService(opt.Paths.ExportsDir, opt.Paths.TmpDir, opt.Paths.UploadCache,
		func() (string, string, transfer.Defaults) {
			cfg, _ := config.Load(opt.Paths.Config)
			return cfg.CPAManagementBase, cfg.CPAManagementKey, transfer.Defaults{
				UploadConcurrency: cfg.UploadConcurrency,
				UploadBatchSize:   cfg.UploadBatchSize,
				ExportBatchSize:   cfg.ExportBatchSize,
				ExportConcurrency: cfg.ExportConcurrency,
				TimeoutMs:         cfg.CPAUploadTimeoutSec * 1000,
				RetryLimit:        cfg.CPAUploadRetries,
			}
		})
	s.patrol = patrol.New(opt.Paths.PatrolState,
		func() config.Config {
			cfg, _ := config.Load(opt.Paths.Config)
			return cfg
		},
		func(cfg config.Config) patrol.ManagementAPI {
			return cpa.NewClient(cfg.CPAManagementBase, cfg.CPAManagementKey, max(cfg.CPAUploadTimeoutSec, 30))
		},
		func(target int) error {
			_, _, _, err := s.ensurePipelineStart(target)
			return err
		})
	s.patrol.SetPipelineChecker(s.pipelineRunning)
	s.cluster = cluster.New(opt.Paths.ClusterState, func() config.Config {
		cfg, _ := config.Load(opt.Paths.Config)
		return cfg
	})
	s.cluster.SetPoolProvider(func() cluster.PoolSnapshot {
		o := s.patrol.Overview()
		return cluster.PoolSnapshot{
			Healthy:       o.Healthy,
			RateLimited:   o.RateLimited,
			Dead:          o.Dead,
			Disabled:      o.Disabled,
			Total:         o.Total,
			QuotaEstimate: o.QuotaEstimate,
		}
	})
	s.cluster.SetStartFn(func(target int) error {
		_, _, _, err := s.ensurePipelineStart(target)
		return err
	})
	s.cluster.SetRunningFn(s.pipelineRunning)
	s.cluster.SetUploadFn(func() (int, int, error) {
		// Best-effort: slaves still use panel CPA auto-upload when enabled;
		// report zeros here — full batch upload is via grok upload / transfer.
		return 0, 0, nil
	})
	s.routes()
	return s
}

func (s *Server) Handler() http.Handler {
	return s.withAuth(s.withCORS(s.mux))
}

func (s *Server) ListenAndServe() error {
	if err := s.opt.Paths.EnsureBase(); err != nil {
		return err
	}
	// ensure default config exists for first boot
	if _, err := os.Stat(s.opt.Paths.Config); os.IsNotExist(err) {
		cfg := config.Defaults()
		// Docker-friendly defaults when env hints present
		if v := os.Getenv("REGISTER_PROXY"); v != "" {
			cfg.RegisterProxy = v
			cfg.HTTPProxy = v
			cfg.HTTPSProxy = v
		}
		if v := os.Getenv("FLARESOLVERR_URL"); v != "" {
			cfg.FlareSolverrURL = v
		}
		if v := os.Getenv("CLEARANCE_PROXY"); v != "" {
			cfg.ClearanceProxy = v
		}
		if v := os.Getenv("CLEARANCE_ENABLED"); v != "" {
			cfg.ClearanceEnabled = v == "1" || strings.EqualFold(v, "true")
		}
		_ = config.Save(s.opt.Paths.Config, cfg)
	}
	srv := &http.Server{
		Addr:              s.opt.Addr,
		Handler:           s.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	// Background job pruning (upload 2h / export 7d TTL) + pool patrol loop.
	bgCtx, stopBg := context.WithCancel(context.Background())
	defer stopBg()
	s.transfer.UploadJobs.StartPruner(bgCtx, 15*time.Minute)
	s.transfer.ExportJobs.StartPruner(bgCtx, 15*time.Minute)
	s.patrol.Start(bgCtx)
	s.cluster.Start(bgCtx)

	// Graceful shutdown: cancel running jobs, flush the upload cache.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(sigCh)
	errCh := make(chan error, 1)
	go func() { errCh <- srv.ListenAndServe() }()
	select {
	case err := <-errCh:
		return err
	case <-sigCh:
		s.transfer.UploadJobs.CancelAll()
		s.transfer.ExportJobs.CancelAll()
		s.transfer.Cache.Flush()
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
		return nil
	}
}

func (s *Server) routes() {
	s.mux.HandleFunc("GET /api/health", s.handleHealth)
	s.mux.HandleFunc("GET /api/status", s.handleStatus)
	s.mux.HandleFunc("POST /api/start", s.handleStart)
	s.mux.HandleFunc("POST /api/stop", s.handleStop)
	s.mux.HandleFunc("GET /api/logs", s.handleLogs)
	s.mux.HandleFunc("GET /api/runs", s.handleRuns)
	s.mux.HandleFunc("GET /api/runs/{id}/files", s.handleRunFiles)
	s.mux.HandleFunc("GET /api/runs/{id}/download", s.handleDownload)
	s.mux.HandleFunc("GET /api/runs/{id}/file", s.handleFile)
	s.mux.HandleFunc("GET /api/config", s.handleGetConfig)
	s.mux.HandleFunc("PUT /api/config", s.handlePutConfig)

	// transfer: batch upload
	s.mux.HandleFunc("POST /api/transfer/prepare", s.handleTransferPrepare)
	s.mux.HandleFunc("GET /api/transfer/jobs", s.handleTransferJobs)
	s.mux.HandleFunc("GET /api/transfer/jobs/{id}", s.handleTransferJobGet)
	s.mux.HandleFunc("POST /api/transfer/jobs/{id}/start", s.handleTransferJobStart)
	s.mux.HandleFunc("POST /api/transfer/jobs/{id}/retry-failed", s.handleTransferJobRetryFailed)
	s.mux.HandleFunc("POST /api/transfer/jobs/{id}/cancel", s.handleTransferJobCancel)
	s.mux.HandleFunc("GET /api/transfer/jobs/{id}/events", s.handleTransferJobEvents)
	s.mux.HandleFunc("GET /api/transfer/cache", s.handleTransferCacheGet)
	s.mux.HandleFunc("DELETE /api/transfer/cache", s.handleTransferCacheDelete)

	// transfer: batch export
	s.mux.HandleFunc("POST /api/export/preview", s.handleExportPreview)
	s.mux.HandleFunc("POST /api/export/start", s.handleExportStart)
	s.mux.HandleFunc("GET /api/export/jobs", s.handleExportJobs)
	s.mux.HandleFunc("GET /api/export/jobs/{id}", s.handleExportJobGet)
	s.mux.HandleFunc("GET /api/export/jobs/{id}/events", s.handleExportJobEvents)
	s.mux.HandleFunc("POST /api/export/jobs/{id}/cancel", s.handleExportJobCancel)
	s.mux.HandleFunc("POST /api/export/jobs/{id}/retry-failed", s.handleExportJobRetryFailed)
	s.mux.HandleFunc("GET /api/export/jobs/{id}/parts/{filename}", s.handleExportPart)
	s.mux.HandleFunc("GET /api/export/jobs/{id}/download-all", s.handleExportDownloadAll)

	// pool: remote list + connectivity + patrol
	s.mux.HandleFunc("POST /api/pool/test-connection", s.handlePoolTestConnection)
	s.mux.HandleFunc("GET /api/pool/files", s.handlePoolFiles)
	s.mux.HandleFunc("GET /api/pool/overview", s.handlePoolOverview)
	s.mux.HandleFunc("POST /api/pool/patrol", s.handlePoolPatrol)
	s.mux.HandleFunc("GET /api/pool/patrol/history", s.handlePoolPatrolHistory)
	s.mux.HandleFunc("GET /api/pool/logs", s.handlePoolLogs)
	s.mux.HandleFunc("POST /api/pool/cleanup", s.handlePoolCleanup)

	// cluster / federation (master–slave)
	// Public federation endpoints: auth via CLUSTER_PUBLIC_TOKEN (optional), not PANEL_TOKEN.
	s.mux.HandleFunc("GET /api/federation/info", s.handleFederationInfo)
	s.mux.HandleFunc("POST /api/federation/heartbeat", s.handleFederationHeartbeat)
	s.mux.HandleFunc("POST /api/federation/report", s.handleFederationReport)
	s.mux.HandleFunc("GET /api/public/status", s.handlePublicStatus)
	s.mux.HandleFunc("POST /api/public/status", s.handlePublicStatus)
	// Admin (panel token)
	s.mux.HandleFunc("GET /api/cluster/status", s.handleClusterStatus)
	s.mux.HandleFunc("POST /api/cluster/kick", s.handleClusterKick)

	if s.opt.WebFS != nil {
		// Next export lives under out/ inside embed.FS
		staticRoot := s.opt.WebFS
		if sub, err := fs.Sub(s.opt.WebFS, "out"); err == nil {
			staticRoot = sub
		}
		s.mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
			path := strings.TrimPrefix(r.URL.Path, "/")
			if path == "" || path == "/" {
				path = "index.html"
			}
			// Prefer explicit files over FileServer redirects (Next uses trailingSlash).
			candidates := []string{path}
			if strings.HasSuffix(path, "/") {
				candidates = append(candidates, path+"index.html")
			} else {
				candidates = append(candidates, path+"/index.html", path+".html")
			}
			// _next static assets keep exact path
			for _, candidate := range candidates {
				candidate = strings.TrimPrefix(candidate, "/")
				data, err := fs.ReadFile(staticRoot, candidate)
				if err != nil {
					continue
				}
				ctype := contentTypeFor(candidate)
				w.Header().Set("Content-Type", ctype)
				_, _ = w.Write(data)
				return
			}
			// SPA fallback
			data, err := fs.ReadFile(staticRoot, "index.html")
			if err != nil {
				http.Error(w, "panel missing", 500)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write(data)
		})
	} else {
		s.mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			_, _ = w.Write([]byte("grok-panel API up. Mount web assets or open /api/health\n"))
		})
	}
}

func (s *Server) withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Panel-Token")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) withAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// health + static panel assets always open so the login form can load.
		// Federation endpoints use optional CLUSTER_PUBLIC_TOKEN instead of PANEL_TOKEN.
		if r.URL.Path == "/api/health" ||
			strings.HasPrefix(r.URL.Path, "/api/federation/") ||
			r.URL.Path == "/api/public/status" ||
			!strings.HasPrefix(r.URL.Path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}
		if s.opt.Token == "" {
			next.ServeHTTP(w, r)
			return
		}
		tok := extractToken(r)
		if tok == "" || tok != s.opt.Token {
			writeJSON(w, http.StatusUnauthorized, map[string]any{
				"ok":    false,
				"error": "unauthorized",
			})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func extractToken(r *http.Request) string {
	if h := r.Header.Get("X-Panel-Token"); h != "" {
		return strings.TrimSpace(h)
	}
	if h := r.Header.Get("Authorization"); h != "" {
		h = strings.TrimSpace(h)
		if strings.HasPrefix(strings.ToLower(h), "bearer ") {
			return strings.TrimSpace(h[7:])
		}
		return h
	}
	return strings.TrimSpace(r.URL.Query().Get("token"))
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	upTotal, upRunning := s.transfer.UploadJobs.Counts()
	exTotal, exRunning := s.transfer.ExportJobs.Counts()
	writeJSON(w, 200, map[string]any{
		"ok":      true,
		"service": "grok-panel",
		"time":    time.Now().UTC().Format(time.RFC3339),
		"auth":    s.opt.Token != "",
		"jobs": map[string]any{
			"upload": map[string]int{"total": upTotal, "running": upRunning},
			"export": map[string]int{"total": exTotal, "running": exRunning},
		},
	})
}

// decodeJSONBody decodes a bounded JSON request body; empty bodies are OK.
func decodeJSONBody(r *http.Request, v any) error {
	if r.Body == nil {
		return nil
	}
	return json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(v)
}

func (s *Server) reconcile(snap state.Snapshot) state.Snapshot {
	if snap.Status == state.StatusRunning {
		pid := snap.PID
		if pid == 0 {
			if p, err := daemon.ReadPID(s.opt.Paths.PID); err == nil {
				pid = p
				snap.PID = p
			}
		}
		if pid != 0 && !daemon.PIDAlive(pid) {
			snap.Status = state.StatusStopped
			if snap.PhaseDetail == "" || snap.PhaseDetail == "运行中" {
				snap.PhaseDetail = "进程已结束"
			}
			snap.PID = 0
		}
	}
	return snap
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	st := state.NewStore(s.opt.Paths.State)
	snap, err := st.Load()
	if err != nil && !os.IsNotExist(err) {
		writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	if os.IsNotExist(err) {
		snap = state.Snapshot{Status: state.StatusStopped}
	}
	snap = s.reconcile(snap)
	writeJSON(w, 200, map[string]any{"ok": true, "status": snap})
}

type startReq struct {
	Target int `json:"target"`
}

func (s *Server) handleStart(w http.ResponseWriter, r *http.Request) {
	var req startReq
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil && err != io.EOF {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "invalid json"})
		return
	}
	if req.Target <= 0 {
		req.Target = 10
	}
	target, err := config.ClampTarget(req.Target)
	if err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": err.Error()})
		return
	}

	runID, pid, logPath, err := s.ensurePipelineStart(target)
	if err != nil {
		code := 500
		if strings.Contains(err.Error(), "already running") {
			code = 409
		}
		writeJSON(w, code, map[string]any{"ok": false, "error": err.Error()})
		return
	}

	writeJSON(w, 200, map[string]any{
		"ok":     true,
		"run_id": runID,
		"pid":    pid,
		"target": target,
		"log":    logPath,
		"output": filepath.Join(s.opt.Paths.Outputs, runID),
	})
}

// ensurePipelineStart starts the detached registration worker. Shared by the
// manual /api/start endpoint and the auto-refill controller.
func (s *Server) ensurePipelineStart(target int) (runID string, pid int, logPath string, err error) {
	if p, err := daemon.ReadPID(s.opt.Paths.PID); err == nil && daemon.PIDAlive(p) {
		return "", 0, "", fmt.Errorf("already running (pid %d)", p)
	}

	if _, err := os.Stat(s.opt.Paths.Config); os.IsNotExist(err) {
		_ = config.Save(s.opt.Paths.Config, config.Defaults())
	}

	runID = home.NewRunID()
	_ = os.MkdirAll(s.opt.Paths.LogsDir, 0o700)
	logPath = filepath.Join(s.opt.Paths.LogsDir, fmt.Sprintf("run-%s.log", runID))

	st := state.NewStore(s.opt.Paths.State)
	_ = st.Set(func(snap *state.Snapshot) {
		snap.Status = state.StatusRunning
		snap.RunID = runID
		snap.Target = target
		snap.Done = 0
		snap.SSOCount = 0
		snap.OAuthCount = 0
		snap.FailCount = 0
		snap.Phase = state.PhaseIdle
		snap.PhaseDetail = "启动中"
		snap.LogPath = logPath
		snap.OutputDir = filepath.Join(s.opt.Paths.Outputs, runID)
		snap.Error = ""
		snap.PID = 0
	})

	pid, err = daemon.StartBackground(target, runID)
	if err != nil {
		_ = st.Set(func(snap *state.Snapshot) {
			snap.Status = state.StatusError
			snap.Error = err.Error()
			snap.PhaseDetail = "启动失败"
		})
		return "", 0, "", err
	}
	_ = daemon.WritePID(s.opt.Paths.PID, pid)
	_ = st.Set(func(snap *state.Snapshot) { snap.PID = pid })
	return runID, pid, logPath, nil
}

// pipelineRunning reports whether the registration worker is alive.
func (s *Server) pipelineRunning() bool {
	if p, err := daemon.ReadPID(s.opt.Paths.PID); err == nil && daemon.PIDAlive(p) {
		return true
	}
	return false
}

func (s *Server) handleStop(w http.ResponseWriter, r *http.Request) {
	if err := daemon.Stop(s.opt.Paths); err != nil {
		// still mark stopped if process gone
		if !strings.Contains(err.Error(), "未在运行") {
			writeJSON(w, 400, map[string]any{"ok": false, "error": err.Error()})
			return
		}
	}
	st := state.NewStore(s.opt.Paths.State)
	_ = st.Set(func(snap *state.Snapshot) {
		snap.Status = state.StatusStopped
		snap.Phase = state.PhaseIdle
		snap.PhaseDetail = "已手动停止"
		snap.PID = 0
	})
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) handleLogs(w http.ResponseWriter, r *http.Request) {
	follow := r.URL.Query().Get("follow") == "1" || r.URL.Query().Get("follow") == "true"
	tailN := 200
	if v := r.URL.Query().Get("tail"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			tailN = n
		}
	}

	st := state.NewStore(s.opt.Paths.State)
	snap, _ := st.Load()
	path := snap.LogPath
	if path == "" {
		path = latestLog(s.opt.Paths.LogsDir)
	}
	if path == "" {
		writeJSON(w, 404, map[string]any{"ok": false, "error": "no log file"})
		return
	}

	if !follow {
		data, err := os.ReadFile(path)
		if err != nil {
			writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		text := string(data)
		if lines := strings.Split(text, "\n"); len(lines) > tailN {
			text = strings.Join(lines[len(lines)-tailN:], "\n")
		}
		writeJSON(w, 200, map[string]any{"ok": true, "path": path, "log": text})
		return
	}

	// SSE stream
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "stream unsupported", 500)
		return
	}

	var offset int64
	if fi, err := os.Stat(path); err == nil {
		// start near end
		offset = fi.Size() - 8192
		if offset < 0 {
			offset = 0
		}
	}

	ctx := r.Context()
	ticker := time.NewTicker(400 * time.Millisecond)
	defer ticker.Stop()

	// initial comment
	_, _ = fmt.Fprintf(w, ": connected path=%s\n\n", path)
	flusher.Flush()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			f, err := os.Open(path)
			if err != nil {
				continue
			}
			if _, err := f.Seek(offset, io.SeekStart); err != nil {
				_ = f.Close()
				continue
			}
			buf, err := io.ReadAll(f)
			_ = f.Close()
			if len(buf) == 0 {
				// heartbeat
				_, _ = fmt.Fprintf(w, ": ping\n\n")
				flusher.Flush()
				continue
			}
			offset += int64(len(buf))
			// SSE data lines
			for _, line := range strings.Split(string(buf), "\n") {
				_, _ = fmt.Fprintf(w, "data: %s\n", line)
			}
			_, _ = fmt.Fprintf(w, "\n")
			flusher.Flush()
			_ = err
		}
	}
}

func (s *Server) handleRuns(w http.ResponseWriter, r *http.Request) {
	limit := 20
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	dirs, err := cpa.ListRunDirs(s.opt.Paths.Outputs, limit)
	if err != nil {
		writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	type runInfo struct {
		ID       string `json:"id"`
		Path     string `json:"path"`
		CPACount int    `json:"cpa_count"`
		SSOFiles int    `json:"sso_files"`
		ModTime  string `json:"mod_time"`
	}
	var out []runInfo
	for _, dir := range dirs {
		files, _ := cpa.CollectCPAJSON(dir)
		ssoN := 0
		if entries, err := os.ReadDir(filepath.Join(dir, "SSO")); err == nil {
			ssoN = len(entries)
		}
		mt := ""
		if fi, err := os.Stat(dir); err == nil {
			mt = fi.ModTime().UTC().Format(time.RFC3339)
		}
		out = append(out, runInfo{
			ID:       filepath.Base(dir),
			Path:     dir,
			CPACount: len(files),
			SSOFiles: ssoN,
			ModTime:  mt,
		})
	}
	if out == nil {
		out = []runInfo{}
	}
	writeJSON(w, 200, map[string]any{"ok": true, "runs": out})
}

func (s *Server) handleRunFiles(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	dir, err := s.resolveRun(id)
	if err != nil {
		writeJSON(w, 404, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	var files []map[string]any
	_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		rel, _ := filepath.Rel(dir, path)
		info, _ := d.Info()
		size := int64(0)
		if info != nil {
			size = info.Size()
		}
		files = append(files, map[string]any{
			"path": rel,
			"size": size,
		})
		return nil
	})
	if files == nil {
		files = []map[string]any{}
	}
	writeJSON(w, 200, map[string]any{"ok": true, "run_id": id, "files": files})
}

func (s *Server) handleDownload(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	dir, err := s.resolveRun(id)
	if err != nil {
		writeJSON(w, 404, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	kind := r.URL.Query().Get("kind") // all | cpa | sso
	if kind == "" {
		kind = "cpa"
	}

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="grok-%s-%s.zip"`, id, kind))
	zw := zip.NewWriter(w)
	defer zw.Close()

	addTree := func(sub string) error {
		root := filepath.Join(dir, sub)
		return filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			rel, _ := filepath.Rel(dir, path)
			rel = filepath.ToSlash(rel)
			fw, err := zw.Create(rel)
			if err != nil {
				return err
			}
			f, err := os.Open(path)
			if err != nil {
				return err
			}
			_, copyErr := io.Copy(fw, f)
			_ = f.Close()
			return copyErr
		})
	}

	switch kind {
	case "cpa":
		_ = addTree("CPA")
	case "sso":
		_ = addTree("SSO")
	default:
		_ = addTree("CPA")
		_ = addTree("SSO")
	}
}

func (s *Server) handleFile(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	rel := r.URL.Query().Get("path")
	if rel == "" {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "path required"})
		return
	}
	dir, err := s.resolveRun(id)
	if err != nil {
		writeJSON(w, 404, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	// prevent path traversal
	clean := filepath.Clean("/" + rel)
	clean = strings.TrimPrefix(clean, "/")
	full := filepath.Join(dir, clean)
	if !strings.HasPrefix(full, dir+string(os.PathSeparator)) && full != dir {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "invalid path"})
		return
	}
	http.ServeFile(w, r, full)
}

func (s *Server) handleGetConfig(w http.ResponseWriter, r *http.Request) {
	cfg, err := config.Load(s.opt.Paths.Config)
	if err != nil {
		writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	// redact secrets
	view := map[string]any{
		"email_mode":                   string(cfg.EmailMode),
		"email_domain":                 cfg.EmailDomain,
		"email_api":                    cfg.EmailAPI,
		"clearance_enabled":            cfg.ClearanceEnabled,
		"register_proxy":               cfg.RegisterProxy,
		"flaresolverr_url":             cfg.FlareSolverrURL,
		"clearance_proxy":              cfg.ClearanceProxy,
		"clearance_urls":               cfg.ClearanceURLs,
		"turnstile_provider":           cfg.TurnstileProvider,
		"protocol_http":                cfg.ProtocolHTTP,
		"http_pool_size":               cfg.HTTPPoolSize,
		"tempmail_lol_retries":         cfg.TempmailLOLRetries,
		"tempmail_lol_min_interval_ms": cfg.TempmailLOLIntervalMS,
		"http_proxy":                   cfg.HTTPProxy,
		"https_proxy":                  cfg.HTTPSProxy,
		"no_proxy":                     cfg.NoProxy,
		"probe_enabled":                cfg.ProbeEnabled,
		"physical_cap":                 cfg.PhysicalCap,
		"cpa_upload_enabled":           cfg.CPAUploadEnabled,
		"cpa_management_base":          cfg.CPAManagementBase,
		"cpa_management_key_set":       strings.TrimSpace(cfg.CPAManagementKey) != "",
		"cpa_management_key_masked":    transfer.MaskKey(cfg.CPAManagementKey),
		"cpa_upload_name_template":     cfg.CPAUploadNameTemplate,
		"upload_concurrency":           cfg.UploadConcurrency,
		"upload_batch_size":            cfg.UploadBatchSize,
		"export_batch_size":            cfg.ExportBatchSize,
		"export_concurrency":           cfg.ExportConcurrency,
		"patrol_enabled":               cfg.PatrolEnabled,
		"patrol_interval_min":          cfg.PatrolIntervalMin,
		"patrol_deep_probe":            cfg.PatrolDeepProbe,
		"patrol_concurrency":           cfg.PatrolConcurrency,
		"quota_per_account":            cfg.QuotaPerAccount,
		"refill_enabled":               cfg.RefillEnabled,
		"refill_min_healthy":           cfg.RefillMinHealthy,
		"refill_batch":                 cfg.RefillBatch,
		"refill_cooldown_min":          cfg.RefillCooldownMin,
		"refill_daily_cap":             cfg.RefillDailyCap,
		"cleanup_quota_enabled":        cfg.CleanupQuotaEnabled,
		"cleanup_on_patrol":            cfg.CleanupOnPatrol,
		"cleanup_backup":               cfg.CleanupBackup,
		"cleanup_dry_run":              cfg.CleanupDryRun,
		"cluster_role":                 cfg.ClusterRole,
		"cluster_node_name":            cfg.ClusterNodeName,
		"cluster_public_token_set":     strings.TrimSpace(cfg.ClusterPublicToken) != "",
		"cluster_master_url":           cfg.ClusterMasterURL,
		"cluster_master_urls":          cfg.ClusterMasterURLs,
		"cluster_status_password_set":  strings.TrimSpace(cfg.ClusterStatusPassword) != "",
		"cluster_heartbeat_sec":        cfg.ClusterHeartbeatSec,
		"cluster_pool_target":          cfg.ClusterPoolTarget,
		"cluster_assign_min":           cfg.ClusterAssignMin,
		"cluster_assign_max":           cfg.ClusterAssignMax,
		"cluster_auto_register":        cfg.ClusterAutoRegister,
		"cluster_auto_upload":          cfg.ClusterAutoUpload,
	}
	writeJSON(w, 200, map[string]any{"ok": true, "config": view})
}

type configUpdate struct {
	EmailMode         *string `json:"email_mode"`
	EmailDomain       *string `json:"email_domain"`
	EmailAPI          *string `json:"email_api"`
	ClearanceEnabled  *bool   `json:"clearance_enabled"`
	RegisterProxy     *string `json:"register_proxy"`
	FlareSolverrURL   *string `json:"flaresolverr_url"`
	ClearanceProxy    *string `json:"clearance_proxy"`
	TurnstileProvider *string `json:"turnstile_provider"`
	HTTPPoolSize      *int    `json:"http_pool_size"`
	ProbeEnabled      *bool   `json:"probe_enabled"`
	PhysicalCap       *int    `json:"physical_cap"`
	CPAUploadEnabled  *bool   `json:"cpa_upload_enabled"`
	CPAManagementBase *string `json:"cpa_management_base"`
	CPAManagementKey  *string `json:"cpa_management_key"`
	HTTPProxy         *string `json:"http_proxy"`
	HTTPSProxy        *string `json:"https_proxy"`

	UploadConcurrency *int `json:"upload_concurrency"`
	UploadBatchSize   *int `json:"upload_batch_size"`
	ExportBatchSize   *int `json:"export_batch_size"`
	ExportConcurrency *int `json:"export_concurrency"`

	PatrolEnabled     *bool `json:"patrol_enabled"`
	PatrolIntervalMin *int  `json:"patrol_interval_min"`
	PatrolDeepProbe   *bool `json:"patrol_deep_probe"`
	PatrolConcurrency *int  `json:"patrol_concurrency"`
	QuotaPerAccount   *int  `json:"quota_per_account"`

	RefillEnabled     *bool `json:"refill_enabled"`
	RefillMinHealthy  *int  `json:"refill_min_healthy"`
	RefillBatch       *int  `json:"refill_batch"`
	RefillCooldownMin *int  `json:"refill_cooldown_min"`
	RefillDailyCap    *int  `json:"refill_daily_cap"`

	CleanupQuotaEnabled *bool `json:"cleanup_quota_enabled"`
	CleanupOnPatrol     *bool `json:"cleanup_on_patrol"`
	CleanupBackup       *bool `json:"cleanup_backup"`
	CleanupDryRun       *bool `json:"cleanup_dry_run"`

	ClusterRole           *string `json:"cluster_role"`
	ClusterNodeName       *string `json:"cluster_node_name"`
	ClusterPublicToken    *string `json:"cluster_public_token"`
	ClusterMasterURL      *string `json:"cluster_master_url"`
	ClusterMasterURLs     *string `json:"cluster_master_urls"`
	ClusterStatusPassword *string `json:"cluster_status_password"`
	ClusterHeartbeatSec   *int    `json:"cluster_heartbeat_sec"`
	ClusterPoolTarget     *int    `json:"cluster_pool_target"`
	ClusterAssignMin      *int    `json:"cluster_assign_min"`
	ClusterAssignMax      *int    `json:"cluster_assign_max"`
	ClusterAutoRegister   *bool   `json:"cluster_auto_register"`
	ClusterAutoUpload     *bool   `json:"cluster_auto_upload"`
}

func (s *Server) handlePutConfig(w http.ResponseWriter, r *http.Request) {
	cfg, err := config.Load(s.opt.Paths.Config)
	if err != nil {
		writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	var u configUpdate
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&u); err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "invalid json"})
		return
	}
	if u.EmailMode != nil {
		cfg.EmailMode = config.EmailMode(strings.ToLower(*u.EmailMode))
	}
	if u.EmailDomain != nil {
		cfg.EmailDomain = *u.EmailDomain
	}
	if u.EmailAPI != nil {
		cfg.EmailAPI = *u.EmailAPI
	}
	if u.ClearanceEnabled != nil {
		cfg.ClearanceEnabled = *u.ClearanceEnabled
	}
	if u.RegisterProxy != nil {
		cfg.RegisterProxy = *u.RegisterProxy
		// keep process proxies in sync when user sets register proxy
		if cfg.HTTPProxy == "" || cfg.HTTPProxy == "http://127.0.0.1:40080" {
			cfg.HTTPProxy = *u.RegisterProxy
		}
		if cfg.HTTPSProxy == "" || cfg.HTTPSProxy == "http://127.0.0.1:40080" {
			cfg.HTTPSProxy = *u.RegisterProxy
		}
	}
	if u.FlareSolverrURL != nil {
		cfg.FlareSolverrURL = *u.FlareSolverrURL
	}
	if u.ClearanceProxy != nil {
		cfg.ClearanceProxy = *u.ClearanceProxy
	}
	if u.TurnstileProvider != nil {
		cfg.TurnstileProvider = *u.TurnstileProvider
	}
	if u.HTTPPoolSize != nil {
		cfg.HTTPPoolSize = *u.HTTPPoolSize
	}
	if u.ProbeEnabled != nil {
		cfg.ProbeEnabled = *u.ProbeEnabled
	}
	if u.PhysicalCap != nil {
		cfg.PhysicalCap = *u.PhysicalCap
	}
	if u.CPAUploadEnabled != nil {
		cfg.CPAUploadEnabled = *u.CPAUploadEnabled
	}
	if u.CPAManagementBase != nil {
		cfg.CPAManagementBase = *u.CPAManagementBase
	}
	if u.CPAManagementKey != nil && *u.CPAManagementKey != "" {
		cfg.CPAManagementKey = *u.CPAManagementKey
	}
	if u.HTTPProxy != nil {
		cfg.HTTPProxy = *u.HTTPProxy
	}
	if u.HTTPSProxy != nil {
		cfg.HTTPSProxy = *u.HTTPSProxy
	}
	if u.UploadConcurrency != nil {
		cfg.UploadConcurrency = *u.UploadConcurrency
	}
	if u.UploadBatchSize != nil {
		cfg.UploadBatchSize = *u.UploadBatchSize
	}
	if u.ExportBatchSize != nil {
		cfg.ExportBatchSize = *u.ExportBatchSize
	}
	if u.ExportConcurrency != nil {
		cfg.ExportConcurrency = *u.ExportConcurrency
	}
	if u.PatrolEnabled != nil {
		cfg.PatrolEnabled = *u.PatrolEnabled
	}
	if u.PatrolIntervalMin != nil {
		cfg.PatrolIntervalMin = *u.PatrolIntervalMin
	}
	if u.PatrolDeepProbe != nil {
		cfg.PatrolDeepProbe = *u.PatrolDeepProbe
	}
	if u.PatrolConcurrency != nil {
		cfg.PatrolConcurrency = *u.PatrolConcurrency
	}
	if u.QuotaPerAccount != nil {
		cfg.QuotaPerAccount = *u.QuotaPerAccount
	}
	if u.RefillEnabled != nil {
		cfg.RefillEnabled = *u.RefillEnabled
	}
	if u.RefillMinHealthy != nil {
		cfg.RefillMinHealthy = *u.RefillMinHealthy
	}
	if u.RefillBatch != nil {
		cfg.RefillBatch = *u.RefillBatch
	}
	if u.RefillCooldownMin != nil {
		cfg.RefillCooldownMin = *u.RefillCooldownMin
	}
	if u.RefillDailyCap != nil {
		cfg.RefillDailyCap = *u.RefillDailyCap
	}
	if u.CleanupQuotaEnabled != nil {
		cfg.CleanupQuotaEnabled = *u.CleanupQuotaEnabled
	}
	if u.CleanupOnPatrol != nil {
		cfg.CleanupOnPatrol = *u.CleanupOnPatrol
	}
	if u.CleanupBackup != nil {
		cfg.CleanupBackup = *u.CleanupBackup
	}
	if u.CleanupDryRun != nil {
		cfg.CleanupDryRun = *u.CleanupDryRun
	}
	if u.ClusterRole != nil {
		cfg.ClusterRole = strings.ToLower(strings.TrimSpace(*u.ClusterRole))
	}
	if u.ClusterNodeName != nil {
		cfg.ClusterNodeName = strings.TrimSpace(*u.ClusterNodeName)
	}
	if u.ClusterPublicToken != nil {
		cfg.ClusterPublicToken = strings.TrimSpace(*u.ClusterPublicToken)
	}
	if u.ClusterMasterURL != nil {
		cfg.ClusterMasterURL = strings.TrimRight(strings.TrimSpace(*u.ClusterMasterURL), "/")
	}
	if u.ClusterMasterURLs != nil {
		cfg.ClusterMasterURLs = *u.ClusterMasterURLs
		// normalize to comma-separated single-line for config.env safety
		ms := cfg.ClusterMasters()
		cfg.ClusterMasterURLs = strings.Join(ms, ",")
		if len(ms) > 0 {
			cfg.ClusterMasterURL = ms[0]
		}
	}
	if u.ClusterHeartbeatSec != nil {
		cfg.ClusterHeartbeatSec = *u.ClusterHeartbeatSec
	}
	if u.ClusterPoolTarget != nil {
		cfg.ClusterPoolTarget = *u.ClusterPoolTarget
	}
	if u.ClusterAssignMin != nil {
		cfg.ClusterAssignMin = *u.ClusterAssignMin
	}
	if u.ClusterAssignMax != nil {
		cfg.ClusterAssignMax = *u.ClusterAssignMax
	}
	if u.ClusterAutoRegister != nil {
		cfg.ClusterAutoRegister = *u.ClusterAutoRegister
	}
	if u.ClusterAutoUpload != nil {
		cfg.ClusterAutoUpload = *u.ClusterAutoUpload
	}
	if u.ClusterStatusPassword != nil {
		cfg.ClusterStatusPassword = *u.ClusterStatusPassword
	}
	if err := config.Save(s.opt.Paths.Config, cfg); err != nil {
		writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	// Secrets intentionally omitted by config.Save — re-append from merged cfg every time.
	if strings.TrimSpace(cfg.CPAManagementKey) != "" {
		_ = appendEnvKey(s.opt.Paths.Config, "CPA_MANAGEMENT_KEY", cfg.CPAManagementKey)
	}
	if strings.TrimSpace(cfg.ClusterPublicToken) != "" {
		_ = appendEnvKey(s.opt.Paths.Config, "CLUSTER_PUBLIC_TOKEN", cfg.ClusterPublicToken)
	}
	// status password may be intentionally empty (open board); only rewrite when set in memory
	if u.ClusterStatusPassword != nil || strings.TrimSpace(cfg.ClusterStatusPassword) != "" {
		_ = appendEnvKey(s.opt.Paths.Config, "CLUSTER_STATUS_PASSWORD", cfg.ClusterStatusPassword)
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func appendEnvKey(path, key, val string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	lines := strings.Split(string(data), "\n")
	found := false
	prefix := key + "="
	for i, line := range lines {
		if strings.HasPrefix(strings.TrimSpace(line), prefix) {
			lines[i] = prefix + val
			found = true
			break
		}
	}
	if !found {
		if len(lines) > 0 && lines[len(lines)-1] != "" {
			lines = append(lines, prefix+val)
		} else {
			lines = append(lines, prefix+val)
		}
	}
	return os.WriteFile(path, []byte(strings.Join(lines, "\n")), 0o600)
}

func (s *Server) resolveRun(id string) (string, error) {
	id = filepath.Base(strings.TrimSpace(id))
	if id == "" || id == "." || id == ".." {
		return "", fmt.Errorf("invalid run id")
	}
	dir := filepath.Join(s.opt.Paths.Outputs, id)
	fi, err := os.Stat(dir)
	if err != nil || !fi.IsDir() {
		return "", fmt.Errorf("run not found")
	}
	return dir, nil
}

func latestLog(dir string) string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	var best string
	var bestT time.Time
	for _, e := range entries {
		if e.IsDir() || !strings.HasPrefix(e.Name(), "run-") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.ModTime().After(bestT) {
			bestT = info.ModTime()
			best = filepath.Join(dir, e.Name())
		}
	}
	return best
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

// Shutdown helper for tests.
func IdleContext() context.Context { return context.Background() }


func contentTypeFor(path string) string {
	switch {
	case strings.HasSuffix(path, ".html"):
		return "text/html; charset=utf-8"
	case strings.HasSuffix(path, ".js"):
		return "application/javascript; charset=utf-8"
	case strings.HasSuffix(path, ".css"):
		return "text/css; charset=utf-8"
	case strings.HasSuffix(path, ".json"):
		return "application/json; charset=utf-8"
	case strings.HasSuffix(path, ".svg"):
		return "image/svg+xml"
	case strings.HasSuffix(path, ".png"):
		return "image/png"
	case strings.HasSuffix(path, ".woff2"):
		return "font/woff2"
	case strings.HasSuffix(path, ".txt"):
		return "text/plain; charset=utf-8"
	default:
		return "application/octet-stream"
	}
}
