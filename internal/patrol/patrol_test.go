package patrol

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/grok-free-register/grok-reg/internal/config"
	"github.com/grok-free-register/grok-reg/internal/cpa"
)

type fakeMgmt struct {
	files []cpa.AuthMeta
	err   error
}

func (f *fakeMgmt) List() ([]cpa.AuthMeta, error) { return f.files, f.err }
func (f *fakeMgmt) Download(name string) ([]byte, error) {
	return json.Marshal(cpa.Document{AccessToken: "tok-" + name, Email: name})
}

func testConfig(mut func(*config.Config)) func() config.Config {
	return func() config.Config {
		cfg := config.Defaults()
		cfg.CPAManagementKey = "test-key"
		cfg.RegisterProxy = ""
		if mut != nil {
			mut(&cfg)
		}
		return cfg
	}
}

func newTestService(t *testing.T, mgmt ManagementAPI, cfgFn func() config.Config) *Service {
	t.Helper()
	s := New(filepath.Join(t.TempDir(), "patrol-state.json"), cfgFn,
		func(config.Config) ManagementAPI { return mgmt }, nil)
	// fast deterministic probe: name decides the outcome
	s.probeFn = func(doc cpa.Document, proxy string) error {
		switch doc.Email {
		case "limited.json":
			return fmt.Errorf("probe http=429 rate/exhausted body=free-usage-exhausted")
		case "dead.json":
			return fmt.Errorf("probe http=401 body=unauthorized")
		}
		return nil
	}
	return s
}

func TestLightPatrol(t *testing.T) {
	mgmt := &fakeMgmt{files: []cpa.AuthMeta{
		{Name: "a.json"},                  // healthy
		{Name: "b.json", Disabled: true},  // disabled
		{Name: "c.json", Status: "error"}, // dead
		{Name: "d.json", Status: "ok"},    // healthy
	}}
	s := newTestService(t, mgmt, testConfig(nil))
	rec, err := s.Run(context.Background(), "light")
	if err != nil {
		t.Fatal(err)
	}
	if rec.Healthy != 2 || rec.Disabled != 1 || rec.Dead != 1 || rec.Total != 4 {
		t.Fatalf("record: %+v", rec)
	}
	o := s.Overview()
	if o.Healthy != 2 || o.Total != 4 {
		t.Fatalf("overview: %+v", o)
	}
	// quota estimate = healthy * QuotaPerAccount (default 60)
	if o.QuotaEstimate != 120 {
		t.Fatalf("quota: %d", o.QuotaEstimate)
	}
	// status + history
	if s.Status().LastRun == nil {
		t.Fatal("status missing last run")
	}
	if len(s.History()) != 1 {
		t.Fatal("history missing record")
	}
}

func TestDeepPatrol(t *testing.T) {
	mgmt := &fakeMgmt{files: []cpa.AuthMeta{
		{Name: "ok.json"},
		{Name: "limited.json"},
		{Name: "dead.json"},
		{Name: "off.json", Disabled: true},
	}}
	s := newTestService(t, mgmt, testConfig(func(c *config.Config) { c.PatrolConcurrency = 3 }))
	rec, err := s.Run(context.Background(), "deep")
	if err != nil {
		t.Fatal(err)
	}
	if rec.Healthy != 1 || rec.RateLimited != 1 || rec.Dead != 1 || rec.Disabled != 1 {
		t.Fatalf("record: %+v", rec)
	}
}

func TestPatrolConcurrentRunRejected(t *testing.T) {
	block := make(chan struct{})
	mgmt := &fakeMgmt{files: []cpa.AuthMeta{{Name: "a.json"}}}
	s := newTestService(t, mgmt, testConfig(nil))
	s.probeFn = func(doc cpa.Document, proxy string) error {
		<-block
		return nil
	}
	defer close(block)
	go func() { _, _ = s.Run(context.Background(), "deep") }()
	time.Sleep(50 * time.Millisecond)
	if _, err := s.Run(context.Background(), "light"); err == nil {
		t.Fatal("expected concurrent run rejection")
	}
}

func TestRefillGuards(t *testing.T) {
	mgmt := &fakeMgmt{files: []cpa.AuthMeta{{Name: "a.json"}}} // healthy=1
	var started []int
	cfgFn := testConfig(func(c *config.Config) {
		c.RefillEnabled = true
		c.RefillMinHealthy = 5
		c.RefillBatch = 7
		c.RefillCooldownMin = 60
		c.RefillDailyCap = 2
	})
	s := New(filepath.Join(t.TempDir(), "patrol-state.json"), cfgFn,
		func(config.Config) ManagementAPI { return mgmt },
		func(target int) error { started = append(started, target); return nil })
	s.probeFn = func(doc cpa.Document, proxy string) error { return nil }
	s.SetPipelineChecker(func() bool { return false })

	// 1. healthy < min → refill starts
	if _, err := s.Run(context.Background(), "light"); err != nil {
		t.Fatal(err)
	}
	if len(started) != 1 || started[0] != 7 {
		t.Fatalf("expected refill target 7, got %v", started)
	}

	// 2. cooldown blocks second run
	if _, err := s.Run(context.Background(), "light"); err != nil {
		t.Fatal(err)
	}
	if len(started) != 1 {
		t.Fatalf("cooldown should block, got %v", started)
	}

	// 3. pipeline running blocks
	s.mu.Lock()
	s.refill.lastRefill = nil
	s.mu.Unlock()
	s.SetPipelineChecker(func() bool { return true })
	if _, err := s.Run(context.Background(), "light"); err != nil {
		t.Fatal(err)
	}
	if len(started) != 1 {
		t.Fatalf("running pipeline should block, got %v", started)
	}
}

func TestRefillDailyCap(t *testing.T) {
	mgmt := &fakeMgmt{files: []cpa.AuthMeta{{Name: "a.json"}}}
	starts := 0
	cfgFn := testConfig(func(c *config.Config) {
		c.RefillEnabled = true
		c.RefillMinHealthy = 5
		c.RefillBatch = 3
		c.RefillCooldownMin = 5
		c.RefillDailyCap = 2
	})
	s := New(filepath.Join(t.TempDir(), "patrol-state.json"), cfgFn,
		func(config.Config) ManagementAPI { return mgmt },
		func(target int) error { starts++; return nil })
	s.probeFn = func(doc cpa.Document, proxy string) error { return nil }
	s.SetPipelineChecker(func() bool { return false })

	for i := 0; i < 4; i++ {
		if _, err := s.Run(context.Background(), "light"); err != nil {
			t.Fatal(err)
		}
		// reset cooldown to allow next evaluation
		s.mu.Lock()
		past := time.Now().Add(-10 * time.Minute)
		s.refill.lastRefill = &past
		s.mu.Unlock()
	}
	if starts != 2 {
		t.Fatalf("daily cap 2 expected, got %d", starts)
	}
	rs := s.RefillStatus()
	if rs.TodayCount != 2 {
		t.Fatalf("today count: %+v", rs)
	}
}

func TestStatePersistence(t *testing.T) {
	dir := t.TempDir()
	statePath := filepath.Join(dir, "patrol-state.json")
	mgmt := &fakeMgmt{files: []cpa.AuthMeta{{Name: "a.json"}}}
	cfgFn := testConfig(nil)

	s1 := New(statePath, cfgFn, func(config.Config) ManagementAPI { return mgmt }, nil)
	s1.probeFn = func(doc cpa.Document, proxy string) error { return nil }
	if _, err := s1.Run(context.Background(), "light"); err != nil {
		t.Fatal(err)
	}

	s2 := New(statePath, cfgFn, func(config.Config) ManagementAPI { return mgmt }, nil)
	if len(s2.History()) != 1 || s2.Overview().Total != 1 {
		t.Fatalf("state not restored: history=%d", len(s2.History()))
	}
}
