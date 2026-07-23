package config

import "testing"

func TestClusterMasterEndpointsJSON(t *testing.T) {
	cfg := Defaults()
	cfg.ClusterMasterURLs = `[{"url":"https://a.example","token":"ta"},{"url":"https://b.example"}]`
	eps := cfg.ClusterMasterEndpoints()
	if len(eps) != 2 || eps[0].Token != "ta" || eps[1].Token != "" {
		t.Fatalf("%+v", eps)
	}
	cfg2 := Defaults()
	cfg2.ClusterMasterURLs = "https://c.example|tc\nhttps://d.example"
	eps2 := cfg2.ClusterMasterEndpoints()
	if len(eps2) != 2 || eps2[0].Token != "tc" || eps2[1].Token != "" {
		t.Fatalf("%+v", eps2)
	}
	s := FormatMasterEndpoints(eps)
	if s == "" || s[0] != '[' {
		t.Fatalf("format %q", s)
	}
}
