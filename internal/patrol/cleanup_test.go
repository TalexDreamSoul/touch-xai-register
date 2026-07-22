package patrol

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/grok-free-register/grok-reg/internal/config"
	"github.com/grok-free-register/grok-reg/internal/cpa"
)

func TestIsQuotaExhaustedHelpers(t *testing.T) {
	if !cpa.IsQuotaExhausted("error", `{"code":"subscription:free-usage-exhausted"}`) {
		t.Fatal("expected exhausted")
	}
	if cpa.IsQuotaExhausted("error", "http 429 rate limit") {
		t.Fatal("429 alone must not count as exhausted")
	}
	if !cpa.IsTransientRateLimit("error", "http 429 rate limit") {
		t.Fatal("expected transient rate limit")
	}
	if cpa.IsTransientRateLimit("error", "free-usage-exhausted") {
		t.Fatal("exhausted must not be classified as transient-only")
	}
}

func TestCleanupDryRunDeletesNothing(t *testing.T) {
	mgmt := &fakeMgmt{files: []cpa.AuthMeta{
		{Name: "ok.json", Status: "active"},
		{Name: "dead.json", Status: "error", StatusMessage: `{"code":"subscription:free-usage-exhausted","error":"used all the included free usage"}`},
		{Name: "rate.json", Status: "error", StatusMessage: "429 rate limit"},
	}}
	s := New(filepath.Join(t.TempDir(), "patrol-state.json"),
		testConfig(func(cfg *config.Config) {
			cfg.CleanupQuotaEnabled = true
			cfg.CleanupDryRun = true
			cfg.CleanupBackup = false
		}),
		func(config.Config) ManagementAPI { return mgmt }, nil)
	s.SetBackupDir(t.TempDir())
	res, err := s.RunCleanup(false)
	if err != nil {
		t.Fatal(err)
	}
	if res.QuotaHits != 1 {
		t.Fatalf("quota hits=%d want 1", res.QuotaHits)
	}
	if res.Deleted != 1 { // dry-run counts would-delete into Deleted
		t.Fatalf("deleted(would)=%d", res.Deleted)
	}
	if len(mgmt.files) != 3 {
		t.Fatalf("dry-run must not mutate remote list, got %d", len(mgmt.files))
	}
}

func TestCleanupDeletesExhaustedOnly(t *testing.T) {
	mgmt := &fakeMgmt{files: []cpa.AuthMeta{
		{Name: "ok.json", Status: "active"},
		{Name: "dead.json", Status: "error", StatusMessage: "You've used all the included free usage for model grok"},
		{Name: "rate.json", Status: "error", StatusMessage: "429 too many requests"},
	}}
	s := New(filepath.Join(t.TempDir(), "patrol-state.json"),
		testConfig(func(cfg *config.Config) {
			cfg.CleanupQuotaEnabled = true
			cfg.CleanupDryRun = false
			cfg.CleanupBackup = true
		}),
		func(config.Config) ManagementAPI { return mgmt }, nil)
	s.SetBackupDir(t.TempDir())
	// Download returns valid JSON for backup
	// fakeMgmt already returns document JSON
	res, err := s.RunCleanup(true)
	if err != nil {
		t.Fatal(err)
	}
	if res.Deleted != 1 {
		t.Fatalf("deleted=%d want 1; sample=%v errors=%v", res.Deleted, res.SampleDeleted, res.SampleErrors)
	}
	// dead.json removed, rate.json kept
	names := map[string]bool{}
	for _, f := range mgmt.files {
		names[f.Name] = true
	}
	if names["dead.json"] {
		t.Fatal("exhausted account should be deleted")
	}
	if !names["rate.json"] || !names["ok.json"] {
		t.Fatalf("should keep non-exhausted: %v", names)
	}
	_ = json.Marshal
}
