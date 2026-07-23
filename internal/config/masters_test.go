package config

import "testing"

func TestClusterMastersSplit(t *testing.T) {
	cfg := Defaults()
	cfg.ClusterMasterURLs = "http://a.example.com\nhttp://b.example.com, http://c.example.com"
	m := cfg.ClusterMasters()
	if len(m) != 3 {
		t.Fatalf("got %v", m)
	}
	cfg.ClusterMasterURLs = "http://a\\nhttp://b"
	// two-char backslash-n should also split
	m = cfg.ClusterMasters()
	if len(m) != 2 {
		t.Fatalf("escaped got %v", m)
	}
}
