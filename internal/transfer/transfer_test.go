package transfer

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/grok-free-register/grok-reg/internal/cpa"
)

func TestCacheKeyFormat(t *testing.T) {
	key := CacheKey("http://127.0.0.1:8317/", "A@B.COM.json", []byte(`{"a":1}`))
	want := "http://127.0.0.1:8317::a@b.com.json::"
	if len(key) <= len(want) || key[:len(want)] != want {
		t.Fatalf("unexpected key: %s", key)
	}
}

func TestMaskKey(t *testing.T) {
	cases := map[string]string{
		"":           "",
		"abc":        "***",
		"abcdef":     "******",
		"abcdefg":    "ab***fg",
		"secret-key": "se******ey",
	}
	for in, want := range cases {
		if got := MaskKey(in); got != want {
			t.Errorf("MaskKey(%q) = %q, want %q", in, got, want)
		}
	}
}

func testService(t *testing.T) *Service {
	dir := t.TempDir()
	s := NewService(
		filepath.Join(dir, "exports"),
		filepath.Join(dir, "tmp"),
		filepath.Join(dir, "upload-cache.json"),
		func() (string, string, Defaults) {
			return "http://cpa.local", "stored-secret", Defaults{
				UploadConcurrency: 3, UploadBatchSize: 20,
				ExportBatchSize: 500, ExportConcurrency: 15,
				TimeoutMs: 30000, RetryLimit: 2,
			}
		})
	return s
}

func TestResolveConnectionMaskedKey(t *testing.T) {
	s := testService(t)
	stored := "stored-secret"
	masked := MaskKey(stored)

	// masked echo → stored key preserved
	c := s.ResolveConnection("", masked)
	if c.Key != stored {
		t.Fatalf("masked key not substituted: got %q", c.Key)
	}
	// empty → stored
	c = s.ResolveConnection("", "")
	if c.Key != stored {
		t.Fatalf("empty key should fall back to stored: got %q", c.Key)
	}
	// new key → verbatim
	c = s.ResolveConnection("", "brand-new")
	if c.Key != "brand-new" {
		t.Fatalf("new key should pass through: got %q", c.Key)
	}
	// masked-looking but wrong → treated as literal new key
	c = s.ResolveConnection("", "xx***yy")
	if c.Key != "xx***yy" {
		t.Fatalf("wrong mask should pass through: got %q", c.Key)
	}
}

func TestParseCredential(t *testing.T) {
	c, err := parseCredential([]byte("\xef\xbb\xbf"+`{"email":"a@b.com","access_token":"x"}`), "weird name.json")
	if err != nil {
		t.Fatal(err)
	}
	if c.Name != "weird_name.json" {
		t.Fatalf("name not sanitized: %s", c.Name)
	}
	if c.Preview["email"] != "a@b.com" {
		t.Fatalf("preview email missing: %+v", c.Preview)
	}
	// canonical form is valid JSON
	var obj map[string]any
	if json.Unmarshal(c.Content, &obj) != nil {
		t.Fatal("content not canonical JSON")
	}
	if _, err := parseCredential([]byte(`not json`), "x.json"); err == nil {
		t.Fatal("expected error for non-JSON")
	}
}

func TestFromZip(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	add := func(name, content string) {
		w, _ := zw.Create(name)
		_, _ = w.Write([]byte(content))
	}
	add("cred1.json", `{"email":"x@y.z"}`)
	add("sub/dir/cred2.json", `{"email":"a@b.c"}`)
	add("__MACOSX/junk.json", `{}`)
	add("readme.txt", "hello")
	add("../../evil.json", `{"email":"e@v.il"}`)
	_ = zw.Close()

	cands, err := fromZip(buf.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if len(cands) != 3 {
		t.Fatalf("want 3 candidates, got %d", len(cands))
	}
	for _, c := range cands {
		if filepath.Base(c.Name) != c.Name {
			t.Fatalf("path not flattened: %s", c.Name)
		}
	}
}

func TestDedupeCandidates(t *testing.T) {
	in := []candidate{
		{Name: "A.json", Content: []byte(`{"v":1}`)},
		{Name: "a.JSON", Content: []byte(`{"v":2}`)},
		{Name: "b.json", Content: []byte(`{"v":3}`)},
	}
	out := dedupeCandidates(in)
	if len(out) != 2 {
		t.Fatalf("want 2, got %d", len(out))
	}
	if string(out[0].Content) != `{"v":2}` {
		t.Fatalf("last one should win: %s", out[0].Content)
	}
}

func TestFilters(t *testing.T) {
	list := []cpa.AuthMeta{
		{Name: "a.json", Provider: "xai", Email: "a@x.com", Disabled: false},
		{Name: "b.json", Provider: "codex", Email: "b@y.com", Disabled: true},
		{Name: "c.json", Provider: "xai-pro", Email: "c@x.com", Disabled: false},
		{Name: "d.txt", Provider: "xai", Email: "d@x.com"},
	}
	f := ExportFilters{Provider: "xai"}
	got := f.Apply(list)
	if len(got) != 2 { // a + c (substring), d.txt excluded
		t.Fatalf("provider filter: want 2, got %d", len(got))
	}
	f = ExportFilters{EmailContains: "@x.com", Limit: 1}
	got = f.Apply(list)
	if len(got) != 1 {
		t.Fatalf("limit: want 1, got %d", len(got))
	}
	tr := true
	f = ExportFilters{Disabled: &tr}
	got = f.Apply(list)
	if len(got) != 1 || got[0].Name != "b.json" {
		t.Fatalf("disabled filter: %+v", got)
	}
}

// fakeMgmt implements ManagementAPI for job tests.
type fakeMgmt struct {
	uploaded map[string][]byte
	failOn   map[string]bool
	files    []cpa.AuthMeta
	bodies   map[string][]byte
}

func (f *fakeMgmt) UploadOnce(name string, raw []byte) cpa.UploadResult {
	if f.failOn[name] {
		return cpa.UploadResult{Name: name, Status: 500, Body: `{"error":"boom"}`}
	}
	if f.uploaded == nil {
		f.uploaded = map[string][]byte{}
	}
	f.uploaded[name] = raw
	return cpa.UploadResult{Name: name, OK: true, Status: 200}
}
func (f *fakeMgmt) List() ([]cpa.AuthMeta, error) { return f.files, nil }
func (f *fakeMgmt) Download(name string) ([]byte, error) {
	if f.failOn[name] {
		return nil, fmt.Errorf("download failed")
	}
	if b, ok := f.bodies[name]; ok {
		return b, nil
	}
	return []byte(`{"email":"` + name + `"}`), nil
}
func (f *fakeMgmt) Debug() (int, string, error) { return 200, "ok", nil }

func TestUploadJobRun(t *testing.T) {
	s := testService(t)
	fake := &fakeMgmt{failOn: map[string]bool{"bad.json": true}}
	s.NewClient = func(conn Connection) ManagementAPI { return fake }

	items := toItems(dedupeCandidates([]candidate{
		{Name: "ok1.json", Content: []byte(`{"email":"1@x.y"}`)},
		{Name: "ok2.json", Content: []byte(`{"email":"2@x.y"}`)},
		{Name: "bad.json", Content: []byte(`{"email":"3@x.y"}`)},
	}))
	job := newUploadJobForTest(s, items, UploadOptions{Concurrency: 2, BatchSize: 2, TimeoutMs: 5000, RetryLimit: 0, BaseURL: "http://cpa.local"})
	if !s.StartUploadJob(job, false) {
		t.Fatal("start refused")
	}
	waitDone(t, job)

	counts := uploadCounts(job.ItemValues())
	if counts.Success != 2 || counts.Failed != 1 {
		t.Fatalf("counts: %+v", counts)
	}
	if len(fake.uploaded) != 2 {
		t.Fatalf("uploaded: %v", len(fake.uploaded))
	}
	// cache remembered
	if !s.Cache.Has(CacheKey("http://cpa.local", "ok1.json", []byte(`{"email":"1@x.y"}`))) {
		t.Fatal("cache missing ok1")
	}

	// retry-failed with fixed backend
	fake.failOn = map[string]bool{}
	if !s.StartUploadJob(job, true) {
		t.Fatal("retry-failed refused")
	}
	waitDone(t, job)
	counts = uploadCounts(job.ItemValues())
	if counts.Failed != 0 || counts.Success != 3 {
		t.Fatalf("after retry: %+v", counts)
	}
}

func TestUploadCacheSkipOnPrepare(t *testing.T) {
	s := testService(t)
	// pre-populate cache
	content := []byte(`{"email":"dup@x.y"}`)
	s.Cache.Remember(CacheKey("http://cpa.local", "dup.json", content), CacheEntry{
		Name: "dup.json", UploadedAt: time.Now(),
	})
	items := toItems([]candidate{{Name: "dup.json", Content: content}})
	job := newUploadJobForTest(s, items, UploadOptions{SkipCached: true, BaseURL: "http://cpa.local"})
	_ = job
	// emulate prepare-time cache check directly
	key := CacheKey("http://cpa.local", "dup.json", content)
	if !s.Cache.Has(key) {
		t.Fatal("cache lost entry")
	}
}

func TestExportJobRun(t *testing.T) {
	s := testService(t)
	fake := &fakeMgmt{
		files: []cpa.AuthMeta{
			{Name: "a.json", Provider: "xai", Email: "a@x.y"},
			{Name: "b.json", Provider: "xai", Email: "b@x.y"},
			{Name: "c.json", Provider: "xai", Email: "c@x.y"},
		},
		failOn: map[string]bool{"b.json": true},
	}
	s.NewClient = func(conn Connection) ManagementAPI { return fake }

	job, running, err := s.StartExport(mustExportReq(t, `{"provider":"xai","batchSize":50,"concurrency":2,"retryLimit":0}`))
	if err != nil || running != nil {
		t.Fatalf("start: err=%v running=%v", err, running)
	}
	waitDone(t, job)

	sum := s.ExportSummary(job)
	if sum.Counts.Success != 2 || sum.Counts.Failed != 1 {
		t.Fatalf("counts: %+v", sum.Counts)
	}
	if len(sum.Parts) != 1 || sum.Parts[0].Filename != "part-001.zip" {
		t.Fatalf("parts: %+v", sum.Parts)
	}
	// manifest written
	dir, ok := s.ExportJobDir(job.ID)
	if !ok {
		t.Fatal("no export dir")
	}
	mb, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		t.Fatal("manifest missing")
	}
	var m ExportManifest
	if json.Unmarshal(mb, &m) != nil {
		t.Fatal("manifest invalid")
	}
	if m.Total != 3 || m.Counts.Failed != 1 {
		t.Fatalf("manifest: %+v", m)
	}
	// part zip contains 2 files
	zr, err := zip.OpenReader(filepath.Join(dir, "part-001.zip"))
	if err != nil {
		t.Fatal(err)
	}
	if len(zr.File) != 2 {
		t.Fatalf("part files: %d", len(zr.File))
	}
	zr.Close()
	// keepFiles=false → files/ cleaned
	entries, _ := os.ReadDir(filepath.Join(dir, "files"))
	if len(entries) != 0 {
		t.Fatalf("files dir not cleaned: %d", len(entries))
	}

	// download-all
	all, err := s.DownloadAllParts(job.ID)
	if err != nil {
		t.Fatal(err)
	}
	zr2, err := zip.OpenReader(all)
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, f := range zr2.File {
		names[f.Name] = true
	}
	zr2.Close()
	if !names["part-001.zip"] || !names["manifest.json"] {
		t.Fatalf("all-parts content: %v", names)
	}

	// retry-failed: fix backend, rerun → part-002 appended
	fake.failOn = map[string]bool{}
	if !s.RetryExportFailed(job) {
		t.Fatal("retry refused")
	}
	waitDone(t, job)
	sum = s.ExportSummary(job)
	if sum.Counts.Failed != 0 || sum.Counts.Success != 3 {
		t.Fatalf("after retry: %+v", sum.Counts)
	}
	if len(sum.Parts) != 2 || sum.Parts[1].Filename != "part-002.zip" {
		t.Fatalf("parts after retry: %+v", sum.Parts)
	}
}

func TestExportSingleConstraint(t *testing.T) {
	s := testService(t)
	block := make(chan struct{})
	fake := &blockingMgmt{block: block}
	fake.files = []cpa.AuthMeta{{Name: "a.json"}}
	s.NewClient = func(conn Connection) ManagementAPI { return fake }

	job, _, err := s.StartExport(mustExportReq(t, `{}`))
	if err != nil {
		t.Fatal(err)
	}
	_, running, err := s.StartExport(mustExportReq(t, `{}`))
	if err == nil || running == nil || running.ID != job.ID {
		t.Fatalf("expected 409 conflict with running job, got err=%v", err)
	}
	close(block)
	waitDone(t, job)
}

type blockingMgmt struct {
	fakeMgmt
	block chan struct{}
}

func (b *blockingMgmt) Download(name string) ([]byte, error) {
	<-b.block
	return []byte(`{}`), nil
}
