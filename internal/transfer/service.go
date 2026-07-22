// Package transfer ports the cpa-uploader feature set (batch upload /
// batch export of CPA auth-files) into the grok panel.
package transfer

import (
	"strings"
	"sync"
	"time"

	"github.com/grok-free-register/grok-reg/internal/cpa"
	"github.com/grok-free-register/grok-reg/internal/jobs"
)

// Connection describes how to reach the CPA Management API for one operation.
type Connection struct {
	BaseURL    string
	Key        string
	TimeoutMs  int
	RetryLimit int
}

// Defaults are the per-kind tuning knobs sourced from config.env.
type Defaults struct {
	UploadConcurrency int
	UploadBatchSize   int
	ExportBatchSize   int
	ExportConcurrency int
	TimeoutMs         int
	RetryLimit        int
}

// ConfigProvider returns the current connection + defaults (from config.env).
type ConfigProvider func() (baseURL, key string, defs Defaults)

// Service owns upload/export job managers, the upload cache, and paths.
type Service struct {
	UploadJobs *jobs.Manager
	ExportJobs *jobs.Manager
	Cache      *UploadCache

	ExportsDir string
	TmpDir     string

	cfgFn ConfigProvider

	// uploadOpts stores per-job options (incl. the resolved key) outside
	// the job struct so summaries never leak the management key.
	uploadOpts sync.Map

	// exportStates holds per-job export bookkeeping (parts, failures, dirs).
	exportStates sync.Map

	// NewClient is injectable for tests.
	NewClient func(conn Connection) ManagementAPI
}

// ManagementAPI abstracts the CPA Management calls used by jobs.
type ManagementAPI interface {
	UploadOnce(name string, raw []byte) cpa.UploadResult
	List() ([]cpa.AuthMeta, error)
	Download(name string) ([]byte, error)
	Debug() (int, string, error)
}

// realClient adapts cpa.Client + cpa.Uploader to ManagementAPI.
type realClient struct {
	cl *cpa.Client
	up *cpa.Uploader
}

func (r *realClient) UploadOnce(name string, raw []byte) cpa.UploadResult {
	return r.up.UploadOnce(name, raw)
}
func (r *realClient) List() ([]cpa.AuthMeta, error)        { return r.cl.List() }
func (r *realClient) Download(name string) ([]byte, error) { return r.cl.Download(name) }
func (r *realClient) Debug() (int, string, error)          { return r.cl.Debug() }

// NewService builds the transfer service.
func NewService(exportsDir, tmpDir, cachePath string, cfgFn ConfigProvider) *Service {
	s := &Service{
		UploadJobs: jobs.NewManager("upload", 2*time.Hour),
		ExportJobs: jobs.NewManager("export", 7*24*time.Hour),
		Cache:      LoadUploadCache(cachePath),
		ExportsDir: exportsDir,
		TmpDir:     tmpDir,
		cfgFn:      cfgFn,
	}
	s.NewClient = func(conn Connection) ManagementAPI {
		timeoutSec := conn.TimeoutMs / 1000
		if timeoutSec < 3 {
			timeoutSec = 3
		}
		cl := cpa.NewClient(conn.BaseURL, conn.Key, timeoutSec)
		ucfg := cpa.DefaultUploadConfig()
		ucfg.Enabled = true
		ucfg.BaseURL = conn.BaseURL
		ucfg.Key = conn.Key
		ucfg.Mode = "json"
		ucfg.Verify = false
		ucfg.Retries = 0
		ucfg.TimeoutSec = timeoutSec
		up := cpa.NewUploader(ucfg, nil)
		return &realClient{cl: cl, up: up}
	}
	return s
}

// ResolveConnection merges per-request overrides with config defaults and
// substitutes a masked management key back to the stored one.
//
// Masked-key rule (ported from the Node tool): if the incoming key contains
// '*' and exactly equals the masked form of the stored key, keep the stored
// key; if empty, fall back to the stored key; otherwise use it verbatim.
func (s *Service) ResolveConnection(overrideBase, overrideKey string) Connection {
	base, storedKey, defs := s.cfgFn()
	if strings.TrimSpace(overrideBase) != "" {
		base = overrideBase
	}
	key := storedKey
	if k := strings.TrimSpace(overrideKey); k != "" {
		if strings.Contains(k, "*") && k == MaskKey(storedKey) {
			key = storedKey
		} else {
			key = k
		}
	}
	return Connection{
		BaseURL:    NormalizeBaseURL(base),
		Key:        key,
		TimeoutMs:  defs.TimeoutMs,
		RetryLimit: defs.RetryLimit,
	}
}

// MaskKey redacts a secret: len<=6 → all '*'; else first2 + stars + last2.
func MaskKey(k string) string {
	if k == "" {
		return ""
	}
	r := []rune(k)
	if len(r) <= 6 {
		return strings.Repeat("*", len(r))
	}
	return string(r[:2]) + strings.Repeat("*", len(r)-4) + string(r[len(r)-2:])
}

// clampInt bounds v into [lo, hi], falling back to def when v <= 0.
func clampInt(v, def, lo, hi int) int {
	if v <= 0 {
		v = def
	}
	if v < lo {
		v = lo
	}
	if v > hi {
		v = hi
	}
	return v
}
