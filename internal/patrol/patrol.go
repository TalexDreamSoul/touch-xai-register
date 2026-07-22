// Package patrol implements pool health patrol (巡检), quota estimation,
// and auto-refill (自动补号) for the merged grok panel.
package patrol

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/grok-free-register/grok-reg/internal/config"
	"github.com/grok-free-register/grok-reg/internal/cpa"
)

// Record is one patrol run's outcome.
type Record struct {
	Time        time.Time `json:"time"`
	Mode        string    `json:"mode"` // light | deep
	Healthy     int       `json:"healthy"`
	RateLimited int       `json:"rate_limited"`
	Dead        int       `json:"dead"`
	Disabled    int       `json:"disabled"`
	Total       int       `json:"total"`
	DurationMS  int64     `json:"duration_ms"`
	Error       string    `json:"error,omitempty"`
}

// Overview is the current pool picture + quota estimate.
type Overview struct {
	Healthy       int `json:"healthy"`
	RateLimited   int `json:"rate_limited"`
	Dead          int `json:"dead"`
	Disabled      int `json:"disabled"`
	Total         int `json:"total"`
	QuotaEstimate int `json:"quota_estimate"`
}

// Status describes the patrol loop for the panel.
type Status struct {
	Enabled bool       `json:"enabled"`
	Running bool       `json:"running"`
	Mode    string     `json:"mode,omitempty"`
	LastRun *time.Time `json:"last_run,omitempty"`
	NextRun *time.Time `json:"next_run,omitempty"`
}

// RefillStatus describes the auto-refill controller for the panel.
type RefillStatus struct {
	Enabled    bool       `json:"enabled"`
	MinHealthy int        `json:"min_healthy"`
	Batch      int        `json:"batch"`
	DailyCap   int        `json:"daily_cap"`
	TodayCount int        `json:"today_count"`
	LastRefill *time.Time `json:"last_refill,omitempty"`
	LastReason string     `json:"last_reason,omitempty"`
}

// ManagementAPI is the subset of the CPA client patrol needs.
type ManagementAPI interface {
	List() ([]cpa.AuthMeta, error)
	Download(name string) ([]byte, error)
}

// StartPipelineFunc starts the registration pipeline with a target count.
type StartPipelineFunc func(target int) error

// Service runs patrols and refill evaluation.
type Service struct {
	cfgFn         func() config.Config
	newClient     func(cfg config.Config) ManagementAPI
	startPipeline StartPipelineFunc
	statePath     string
	probeFn       func(doc cpa.Document, proxy string) error // injectable for tests

	mu              sync.Mutex
	running         bool
	lastMode        string
	lastRun         *time.Time
	nextRun         *time.Time
	last            *Record
	history         []Record
	refill          refillState
	pipelineRunning PipelineRunningFunc
}

type refillState struct {
	lastRefill *time.Time
	today      string // yyyy-mm-dd of todayCount
	todayCount int
	lastReason string
}

const historyCap = 50

// New builds the patrol service and restores persisted state.
func New(statePath string, cfgFn func() config.Config, newClient func(config.Config) ManagementAPI, startPipeline StartPipelineFunc) *Service {
	s := &Service{
		cfgFn:         cfgFn,
		newClient:     newClient,
		startPipeline: startPipeline,
		statePath:     statePath,
		probeFn:       cpa.Probe,
	}
	s.load()
	return s
}

type persisted struct {
	Last    *Record     `json:"last,omitempty"`
	History []Record    `json:"history,omitempty"`
	Refill  refillState `json:"refill"`
}

func (s *Service) load() {
	b, err := os.ReadFile(s.statePath)
	if err != nil {
		return
	}
	var p persisted
	if json.Unmarshal(b, &p) != nil {
		return
	}
	s.last = p.Last
	s.history = p.History
	s.refill = p.Refill
	if s.last != nil {
		t := s.last.Time
		s.lastRun = &t
		s.lastMode = s.last.Mode
	}
}

func (s *Service) saveLocked() {
	p := persisted{Last: s.last, History: s.history, Refill: s.refill}
	b, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return
	}
	tmp := s.statePath + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, s.statePath)
	}
}

// Start launches the background patrol loop (1-minute granularity; the
// configured interval is re-read every tick so config edits apply live).
func (s *Service) Start(ctx context.Context) {
	go func() {
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				s.maybeRunScheduled()
			}
		}
	}()
}

func (s *Service) maybeRunScheduled() {
	cfg := s.cfgFn()
	if !cfg.PatrolEnabled {
		s.mu.Lock()
		s.nextRun = nil
		s.mu.Unlock()
		return
	}
	interval := time.Duration(max(cfg.PatrolIntervalMin, 5)) * time.Minute
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		return
	}
	if s.lastRun != nil && time.Since(*s.lastRun) < interval {
		nt := s.lastRun.Add(interval)
		s.nextRun = &nt
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	mode := "light"
	if cfg.PatrolDeepProbe {
		mode = "deep"
	}
	_, _ = s.Run(context.Background(), mode)
}

// Run executes one patrol. Returns an error if one is already running.
func (s *Service) Run(ctx context.Context, mode string) (*Record, error) {
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		return nil, fmt.Errorf("巡检正在进行中")
	}
	s.running = true
	s.lastMode = mode
	s.mu.Unlock()

	started := time.Now()
	rec := &Record{Time: started, Mode: mode}
	err := s.runOnce(ctx, mode, rec)
	rec.DurationMS = time.Since(started).Milliseconds()
	if err != nil {
		rec.Error = err.Error()
	}

	s.mu.Lock()
	s.running = false
	now := time.Now()
	s.lastRun = &now
	s.last = rec
	s.history = append(s.history, *rec)
	if len(s.history) > historyCap {
		s.history = s.history[len(s.history)-historyCap:]
	}
	s.saveLocked()
	s.mu.Unlock()

	// Auto-refill evaluation happens after every successful patrol.
	if err == nil {
		s.evaluateRefill(rec)
	}
	return rec, nil
}

func (s *Service) runOnce(ctx context.Context, mode string, rec *Record) error {
	cfg := s.cfgFn()
	if strings.TrimSpace(cfg.CPAManagementKey) == "" {
		return fmt.Errorf("未配置 CPA_MANAGEMENT_KEY")
	}
	client := s.newClient(cfg)
	list, err := client.List()
	if err != nil {
		return fmt.Errorf("拉取远端列表失败: %v", err)
	}
	rec.Total = len(list)

	if mode != "deep" {
		// Light: classify from list metadata only.
		for _, m := range list {
			switch {
			case m.Disabled:
				rec.Disabled++
			case isErrorStatus(m.Status):
				rec.Dead++
			default:
				rec.Healthy++
			}
		}
		return nil
	}

	// Deep: download + real probe per non-disabled file.
	conc := max(cfg.PatrolConcurrency, 1)
	if conc > 50 {
		conc = 50
	}
	var active []cpa.AuthMeta
	for _, m := range list {
		if m.Disabled {
			rec.Disabled++
			continue
		}
		active = append(active, m)
	}
	var mu sync.Mutex
	var cursor int
	var wg sync.WaitGroup
	for w := 0; w < conc && w < len(active); w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				if ctx.Err() != nil {
					return
				}
				mu.Lock()
				if cursor >= len(active) {
					mu.Unlock()
					return
				}
				m := active[cursor]
				cursor++
				mu.Unlock()

				class := s.deepClassify(client, m, cfg.RegisterProxy)
				mu.Lock()
				switch class {
				case "healthy":
					rec.Healthy++
				case "rate_limited":
					rec.RateLimited++
				default:
					rec.Dead++
				}
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	return nil
}

func (s *Service) deepClassify(client ManagementAPI, m cpa.AuthMeta, proxy string) string {
	raw, err := client.Download(m.Name)
	if err != nil {
		return "dead"
	}
	var doc cpa.Document
	if json.Unmarshal(raw, &doc) != nil || doc.AccessToken == "" {
		return "dead"
	}
	err = s.probeFn(doc, proxy)
	if err == nil {
		return "healthy"
	}
	low := strings.ToLower(err.Error())
	if strings.Contains(low, "rate/exhausted") || strings.Contains(low, "429") ||
		strings.Contains(low, "free-usage-exhausted") || strings.Contains(low, "rate limit") {
		return "rate_limited"
	}
	return "dead"
}

func isErrorStatus(status string) bool {
	s := strings.ToLower(status)
	return strings.Contains(s, "error") || strings.Contains(s, "fail") ||
		strings.Contains(s, "invalid") || strings.Contains(s, "expired")
}

// Overview returns the last patrol result + quota estimate.
func (s *Service) Overview() Overview {
	cfg := s.cfgFn()
	s.mu.Lock()
	defer s.mu.Unlock()
	var o Overview
	if s.last != nil {
		o.Healthy = s.last.Healthy
		o.RateLimited = s.last.RateLimited
		o.Dead = s.last.Dead
		o.Disabled = s.last.Disabled
		o.Total = s.last.Total
	}
	o.QuotaEstimate = o.Healthy * max(cfg.QuotaPerAccount, 0)
	return o
}

// Status returns the patrol loop status.
func (s *Service) Status() Status {
	cfg := s.cfgFn()
	s.mu.Lock()
	defer s.mu.Unlock()
	st := Status{Enabled: cfg.PatrolEnabled, Running: s.running, Mode: s.lastMode}
	if s.lastRun != nil {
		t := *s.lastRun
		st.LastRun = &t
	}
	if s.nextRun != nil {
		t := *s.nextRun
		st.NextRun = &t
	}
	return st
}

// History returns recent patrol records (newest last).
func (s *Service) History() []Record {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Record, len(s.history))
	copy(out, s.history)
	return out
}

// RefillStatus returns the refill controller status.
func (s *Service) RefillStatus() RefillStatus {
	cfg := s.cfgFn()
	s.mu.Lock()
	defer s.mu.Unlock()
	rs := RefillStatus{
		Enabled:    cfg.RefillEnabled,
		MinHealthy: cfg.RefillMinHealthy,
		Batch:      cfg.RefillBatch,
		DailyCap:   cfg.RefillDailyCap,
		LastReason: s.refill.lastReason,
	}
	if s.refill.lastRefill != nil {
		t := *s.refill.lastRefill
		rs.LastRefill = &t
	}
	if s.refill.today == time.Now().Format("2006-01-02") {
		rs.TodayCount = s.refill.todayCount
	}
	return rs
}

// PipelineRunningFunc reports whether the registration pipeline is alive.
type PipelineRunningFunc func() bool

// SetPipelineChecker wires the running-pipeline guard for refill.
func (s *Service) SetPipelineChecker(fn PipelineRunningFunc) {
	s.pipelineRunning = fn
}
