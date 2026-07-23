package statuspage

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/grok-free-register/grok-reg/internal/config"
	"github.com/grok-free-register/grok-reg/internal/cpa"
)

// Layout is the admin-customizable public board layout (stored as JSON).
type Layout struct {
	Title       string `json:"title"`
	Subtitle    string `json:"subtitle"`
	ShowPool    bool   `json:"show_pool"`
	ShowModels  bool   `json:"show_models"`
	ShowCluster bool   `json:"show_cluster"`
	ShowNeed    bool   `json:"show_need"`
	ShowSlaves  bool   `json:"show_slaves"`
	ShowJSONLink bool  `json:"show_json_link"`
	Footer      string `json:"footer"`
	// Models to monitor (empty → defaults)
	Models []string `json:"models"`
	// Probe settings
	ProbeEnabled     bool   `json:"probe_enabled"`
	ProbeIntervalSec int    `json:"probe_interval_sec"`
	ProbeMaxTokens   int    `json:"probe_max_tokens"`
	APIBase          string `json:"api_base"` // OpenAI-compatible base, e.g. http://127.0.0.1:8317/v1
}

func DefaultLayout() Layout {
	return Layout{
		Title:            "节点状态",
		Subtitle:         "号池 · 模型可用性 · 联邦",
		ShowPool:         true,
		ShowModels:       true,
		ShowCluster:      true,
		ShowNeed:         true,
		ShowSlaves:       true,
		ShowJSONLink:     true,
		Footer:           "JSON: /api/public/status.json",
		Models:           []string{"grok-4.5", "grok-4", "grok-3"},
		ProbeEnabled:     true,
		ProbeIntervalSec: 30,
		ProbeMaxTokens:   20,
	}
}

// PoolStats is live CPA formal pool + local candidate estimate.
type PoolStats struct {
	// Formal pool (CPA management auth-files)
	Total     int `json:"total"`
	Active    int `json:"active"`
	Disabled  int `json:"disabled"`
	Error     int `json:"error"`
	Healthy   int `json:"healthy"`    // from last patrol if available
	RateLimited int `json:"rate_limited"`
	Dead      int `json:"dead"`
	// Candidate pool: local CPA json waiting / not in formal pool
	Candidate int `json:"candidate"`
	// Targets
	PoolTarget int `json:"pool_target"`
	Need       int `json:"need"`
}

// ModelStatus is one model probe result.
type ModelStatus struct {
	ID        string     `json:"id"`
	Available bool       `json:"available"`
	LatencyMS int64      `json:"latency_ms,omitempty"`
	LastCheck *time.Time `json:"last_check,omitempty"`
	LastError string     `json:"last_error,omitempty"`
	HTTPCode  int        `json:"http_code,omitempty"`
}

// PublicBoard is the full public status payload (HTML board + JSON API).
type PublicBoard struct {
	OK           bool                   `json:"ok"`
	Service      string                 `json:"service"`
	AuthRequired bool                   `json:"auth_required"`
	Time         string                 `json:"time"`
	Layout       Layout                 `json:"layout"`
	Node         map[string]any         `json:"node"`
	Pool         PoolStats              `json:"pool"`
	Models       []ModelStatus          `json:"models"`
	ModelAvailable map[string]bool      `json:"model_available"`
	Cluster      map[string]any         `json:"cluster,omitempty"`
	Extra        map[string]any         `json:"extra,omitempty"`
}

type poolLister func() ([]cpa.AuthMeta, error)
type patrolSnap func() (healthy, rateLimited, dead, disabled, total int)
type clusterSnap func() map[string]any
type candidateCount func() int

// Service runs model probes and serves the public board.
type Service struct {
	layoutPath string
	cfgFn      func() config.Config
	listFn     poolLister
	patrolFn   patrolSnap
	clusterFn  clusterSnap
	candFn     candidateCount
	outputsDir string

	mu     sync.RWMutex
	layout Layout
	models map[string]ModelStatus
}

func New(layoutPath string, cfgFn func() config.Config, outputsDir string) *Service {
	s := &Service{
		layoutPath: layoutPath,
		cfgFn:      cfgFn,
		outputsDir: outputsDir,
		layout:     loadLayout(layoutPath),
		models:     map[string]ModelStatus{},
	}
	return s
}

func (s *Service) SetPoolLister(fn poolLister)       { s.listFn = fn }
func (s *Service) SetPatrolSnap(fn patrolSnap)       { s.patrolFn = fn }
func (s *Service) SetClusterSnap(fn clusterSnap)     { s.clusterFn = fn }
func (s *Service) SetCandidateCounter(fn candidateCount) { s.candFn = fn }

func (s *Service) Start(ctx context.Context) {
	go s.probeLoop(ctx)
}

func (s *Service) Layout() Layout {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.layout
}

func (s *Service) SaveLayout(l Layout) error {
	if l.ProbeIntervalSec <= 0 {
		l.ProbeIntervalSec = 30
	}
	if l.ProbeMaxTokens <= 0 {
		l.ProbeMaxTokens = 20
	}
	if len(l.Models) == 0 {
		l.Models = DefaultLayout().Models
	}
	if err := saveLayout(s.layoutPath, l); err != nil {
		return err
	}
	s.mu.Lock()
	s.layout = l
	s.mu.Unlock()
	return nil
}

func (s *Service) Board(password string) (PublicBoard, int, string) {
	cfg := s.cfgFn()
	want := strings.TrimSpace(cfg.ClusterStatusPassword)
	if want != "" {
		if subtle.ConstantTimeCompare([]byte(strings.TrimSpace(password)), []byte(want)) != 1 {
			return PublicBoard{OK: false, Service: "grok-panel-status", AuthRequired: true}, 401, "invalid status password"
		}
	}
	layout := s.Layout()
	pool := s.collectPool(cfg)
	models := s.modelList(layout)
	avail := map[string]bool{}
	for _, m := range models {
		avail[m.ID] = m.Available
	}
	nodeName := cfg.ClusterNodeName
	if nodeName == "" {
		nodeName = "node"
	}
	board := PublicBoard{
		OK:           true,
		Service:      "grok-panel-status",
		AuthRequired: want != "",
		Time:         time.Now().UTC().Format(time.RFC3339),
		Layout:       layout,
		Node: map[string]any{
			"name": nodeName,
			"role": strings.ToLower(strings.TrimSpace(cfg.ClusterRole)),
		},
		Pool:           pool,
		Models:         models,
		ModelAvailable: avail,
	}
	if layout.ShowCluster && s.clusterFn != nil {
		board.Cluster = s.clusterFn()
	}
	return board, 0, ""
}

func (s *Service) collectPool(cfg config.Config) PoolStats {
	st := PoolStats{PoolTarget: cfg.ClusterPoolTarget}
	if s.listFn != nil {
		if files, err := s.listFn(); err == nil {
			st.Total = len(files)
			for _, f := range files {
				if f.Disabled {
					st.Disabled++
					continue
				}
				low := strings.ToLower(f.Status + " " + f.StatusMessage)
				if strings.Contains(low, "error") || strings.Contains(low, "fail") || strings.Contains(low, "exhaust") {
					st.Error++
				} else {
					st.Active++
				}
			}
		}
	}
	if s.patrolFn != nil {
		h, r, d, dis, tot := s.patrolFn()
		st.Healthy = h
		st.RateLimited = r
		st.Dead = d
		if st.Disabled == 0 {
			st.Disabled = dis
		}
		if st.Total == 0 {
			st.Total = tot
		}
	}
	if s.candFn != nil {
		st.Candidate = s.candFn()
	} else {
		st.Candidate = countLocalCandidates(s.outputsDir)
	}
	// need based on healthy if known else active
	have := st.Healthy
	if have == 0 {
		have = st.Active
	}
	if st.PoolTarget > 0 && have < st.PoolTarget {
		st.Need = st.PoolTarget - have
	}
	return st
}

func (s *Service) modelList(layout Layout) []ModelStatus {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]ModelStatus, 0, len(layout.Models))
	for _, id := range layout.Models {
		if m, ok := s.models[id]; ok {
			out = append(out, m)
			continue
		}
		out = append(out, ModelStatus{ID: id, Available: false})
	}
	return out
}

func (s *Service) probeLoop(ctx context.Context) {
	// stagger first run slightly
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			s.probeOnce()
			layout := s.Layout()
			sec := layout.ProbeIntervalSec
			if sec <= 0 {
				sec = 30
			}
			// jitter ±20% so multiple panels don't sync
			j := sec * 20 / 100
			if j < 1 {
				j = 1
			}
			delta := randIntn(j*2+1) - j
			next := sec + delta
			if next < 5 {
				next = 5
			}
			timer.Reset(time.Duration(next) * time.Second)
		}
	}
}

func (s *Service) ProbeNow() { s.probeOnce() }

func (s *Service) probeOnce() {
	layout := s.Layout()
	if !layout.ProbeEnabled || len(layout.Models) == 0 {
		return
	}
	cfg := s.cfgFn()
	// pick random model each tick
	model := layout.Models[randIntn(len(layout.Models))]
	maxTok := layout.ProbeMaxTokens
	if maxTok <= 0 {
		maxTok = 20
	}
	apiBase := strings.TrimSpace(layout.APIBase)
	if apiBase == "" {
		apiBase = deriveAPIBase(cfg.CPAManagementBase)
	}
	key := strings.TrimSpace(cfg.CPAManagementKey)
	start := time.Now()
	code, err := probeModel(apiBase, key, model, maxTok)
	lat := time.Since(start).Milliseconds()
	now := time.Now()
	st := ModelStatus{
		ID:        model,
		Available: err == nil && code >= 200 && code < 300,
		LatencyMS: lat,
		LastCheck: &now,
		HTTPCode:  code,
	}
	if err != nil {
		st.LastError = err.Error()
		st.Available = false
	}
	s.mu.Lock()
	s.models[model] = st
	s.mu.Unlock()
}

func probeModel(apiBase, key, model string, maxTokens int) (int, error) {
	apiBase = strings.TrimRight(strings.TrimSpace(apiBase), "/")
	if apiBase == "" {
		return 0, fmt.Errorf("api base empty")
	}
	// Prefer OpenAI chat completions; also try responses-style path fallback by caller config.
	ep := apiBase + "/chat/completions"
	// random short prompt so caches don't hide failures
	prompt := fmt.Sprintf("ping %d", randIntn(1_000_000))
	body := map[string]any{
		"model":      model,
		"stream":     false,
		"max_tokens": maxTokens,
		"messages": []map[string]string{
			{"role": "user", "content": prompt},
		},
	}
	raw, _ := json.Marshal(body)
	req, err := http.NewRequest(http.MethodPost, ep, bytes.NewReader(raw))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	client := &http.Client{Timeout: 25 * time.Second, Transport: &http.Transport{Proxy: nil}}
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return resp.StatusCode, nil
	}
	return resp.StatusCode, fmt.Errorf("http=%d body=%s", resp.StatusCode, truncate(string(b), 160))
}

func deriveAPIBase(managementBase string) string {
	managementBase = strings.TrimSpace(managementBase)
	if managementBase == "" {
		return "http://127.0.0.1:8317/v1"
	}
	u, err := url.Parse(cpa.NormalizeManagementBase(managementBase))
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "http://127.0.0.1:8317/v1"
	}
	u.Path = "/v1"
	u.RawQuery = ""
	u.Fragment = ""
	return u.String()
}

func countLocalCandidates(outputsDir string) int {
	if strings.TrimSpace(outputsDir) == "" {
		return 0
	}
	n := 0
	_ = filepath.Walk(outputsDir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info == nil || info.IsDir() {
			return nil
		}
		name := strings.ToLower(info.Name())
		if strings.HasSuffix(name, ".json") && (strings.Contains(path, string(filepath.Separator)+"CPA"+string(filepath.Separator)) || strings.Contains(strings.ToLower(path), "/cpa/")) {
			n++
		}
		return nil
	})
	return n
}

func loadLayout(path string) Layout {
	def := DefaultLayout()
	b, err := os.ReadFile(path)
	if err != nil {
		return def
	}
	var l Layout
	if json.Unmarshal(b, &l) != nil {
		return def
	}
	// fill zeros
	if l.Title == "" {
		l.Title = def.Title
	}
	if l.ProbeIntervalSec <= 0 {
		l.ProbeIntervalSec = def.ProbeIntervalSec
	}
	if l.ProbeMaxTokens <= 0 {
		l.ProbeMaxTokens = def.ProbeMaxTokens
	}
	if len(l.Models) == 0 {
		l.Models = def.Models
	}
	// if file existed but all show flags false and empty models — keep as-is (user choice)
	// first boot defaults already applied when file missing
	if !l.ShowPool && !l.ShowModels && !l.ShowCluster && !l.ShowNeed && !l.ShowSlaves {
		// treat empty customization as defaults for flags
		l.ShowPool, l.ShowModels, l.ShowCluster, l.ShowNeed, l.ShowSlaves, l.ShowJSONLink = true, true, true, true, true, true
	}
	return l
}

func saveLayout(path string, l Layout) error {
	_ = os.MkdirAll(filepath.Dir(path), 0o700)
	b, err := json.MarshalIndent(l, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o600)
}

func randIntn(n int) int {
	if n <= 0 {
		return 0
	}
	var b [8]byte
	_, _ = rand.Read(b[:])
	return int(binary.BigEndian.Uint64(b[:]) % uint64(n))
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
