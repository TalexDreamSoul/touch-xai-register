package transfer

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"net/http"

	"github.com/grok-free-register/grok-reg/internal/jobs"
)

// newUploadJobForTest registers an upload job with explicit options,
// bypassing HTTP prepare (unit-level shortcut).
func newUploadJobForTest(s *Service, items []*jobs.Item, opts UploadOptions) *jobs.Job {
	if opts.Concurrency <= 0 {
		opts.Concurrency = 3
	}
	if opts.BatchSize <= 0 {
		opts.BatchSize = 20
	}
	job := jobs.NewJob("upload", items)
	// prepare-time cache check
	if opts.SkipCached {
		job.WithItems(func(items []*jobs.Item) {
			for _, it := range items {
				if s.Cache.Has(CacheKey(opts.BaseURL, it.Name, it.Content)) {
					it.Status = jobs.ItemSkipped
					it.FromCache = true
					it.Content = nil
				}
			}
		})
	}
	s.uploadOpts.Store(job.ID, opts)
	s.UploadJobs.Add(job)
	return job
}

func waitDone(t *testing.T, job *jobs.Job) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if job.Done() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("job %s did not finish in time (status=%s)", job.ID, job.GetStatus())
}

func mustExportReq(t *testing.T, body string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/export/start", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return req
}
