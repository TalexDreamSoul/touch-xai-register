package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSaveLoadMasterEndpointsWithToken(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.env")
	cfg := Defaults()
	cfg.ClusterRole = "slave"
	cfg.ClusterMasterURLs = `[{"url":"https://a.example","token":"secret-a"},{"url":"https://b.example"}]`
	if err := Save(path, cfg); err != nil {
		t.Fatal(err)
	}
	// Save should keep token JSON, not strip to bare URLs
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !contains(string(raw), "secret-a") {
		t.Fatalf("token missing in saved file: %s", raw)
	}
	got, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	eps := got.ClusterMasterEndpoints()
	if len(eps) != 2 || eps[0].Token != "secret-a" || eps[1].Token != "" {
		t.Fatalf("%+v", eps)
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(sub) == 0 || (len(s) > 0 && (func() bool {
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	})()))
}
