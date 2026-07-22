package patrol

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/grok-free-register/grok-reg/internal/cpa"
)

// CleanupResult is one cleanup run's outcome.
type CleanupResult struct {
	Time          time.Time `json:"time"`
	Enabled       bool      `json:"enabled"`
	DryRun        bool      `json:"dry_run"`
	Scanned       int       `json:"scanned"`
	QuotaHits     int       `json:"quota_hits"`
	Deleted       int       `json:"deleted"`
	BackedUp      int       `json:"backed_up"`
	Skipped       int       `json:"skipped"`
	Errors        int       `json:"errors"`
	DurationMS    int64     `json:"duration_ms"`
	BackupDir     string    `json:"backup_dir,omitempty"`
	SampleDeleted []string  `json:"sample_deleted,omitempty"`
	SampleErrors  []string  `json:"sample_errors,omitempty"`
	SampleWould   []string  `json:"sample_would_delete,omitempty"`
	Reason        string    `json:"reason,omitempty"`
	Error         string    `json:"error,omitempty"`
}

// CleanupStatus is the controller snapshot for the panel.
type CleanupStatus struct {
	Enabled       bool           `json:"enabled"`
	OnPatrol      bool           `json:"on_patrol"`
	Backup        bool           `json:"backup"`
	DryRun        bool           `json:"dry_run"`
	Last          *CleanupResult `json:"last,omitempty"`
	LastRun       *time.Time     `json:"last_run,omitempty"`
	LastReason    string         `json:"last_reason,omitempty"`
}

// Deleter is the Management API surface cleanup needs.
type Deleter interface {
	List() ([]cpa.AuthMeta, error)
	Download(name string) ([]byte, error)
	Delete(name string) error
}

// CleanupStatus returns the cleanup controller status.
func (s *Service) CleanupStatus() CleanupStatus {
	cfg := s.cfgFn()
	s.mu.Lock()
	defer s.mu.Unlock()
	st := CleanupStatus{
		Enabled:    cfg.CleanupQuotaEnabled,
		OnPatrol:   cfg.CleanupOnPatrol,
		Backup:     cfg.CleanupBackup,
		DryRun:     cfg.CleanupDryRun,
		LastReason: s.cleanup.lastReason,
	}
	if s.cleanup.last != nil {
		cp := *s.cleanup.last
		st.Last = &cp
	}
	if s.cleanup.lastRun != nil {
		t := *s.cleanup.lastRun
		st.LastRun = &t
	}
	return st
}

// RunCleanup deletes remote auth-files whose status indicates free-usage /
// quota exhaustion. Transient 429 rate limits are never deleted.
//
// force=true runs even when CLEANUP_QUOTA_ENABLED=0 (manual panel action still
// respects dry-run / backup flags from config).
func (s *Service) RunCleanup(force bool) (*CleanupResult, error) {
	cfg := s.cfgFn()
	started := time.Now()
	res := &CleanupResult{
		Time:    started,
		Enabled: cfg.CleanupQuotaEnabled,
		DryRun:  cfg.CleanupDryRun,
	}

	if !force && !cfg.CleanupQuotaEnabled {
		res.Reason = "CLEANUP_QUOTA_ENABLED=0"
		s.storeCleanup(res, "未启用：设置中打开「清理限额耗尽号」")
		s.appendEvent("清理跳过：未启用 CLEANUP_QUOTA_ENABLED")
		return res, nil
	}
	if strings.TrimSpace(cfg.CPAManagementKey) == "" {
		res.Error = "未配置 CPA_MANAGEMENT_KEY"
		s.storeCleanup(res, res.Error)
		s.appendEvent("清理失败：%s", res.Error)
		return res, fmt.Errorf("%s", res.Error)
	}

	s.appendEvent("清理开始 force=%v dry_run=%v backup=%v", force, cfg.CleanupDryRun, cfg.CleanupBackup)
	del := s.newClient(cfg)

	list, err := del.List()
	if err != nil {
		res.Error = fmt.Sprintf("拉取远端列表失败: %v", err)
		s.storeCleanup(res, res.Error)
		s.appendEvent("清理失败：%s", res.Error)
		return res, fmt.Errorf("%s", res.Error)
	}
	res.Scanned = len(list)
	s.appendEvent("清理扫描远端 %d 条", res.Scanned)

	var targets []cpa.AuthMeta
	metaHits := 0
	for _, m := range list {
		if cpa.IsQuotaExhausted(m.Status, m.StatusMessage) {
			targets = append(targets, m)
			metaHits++
		}
	}
	// Many CPA deployments leave status_message empty on list metadata.
	// Fall back to download + probe so free-usage-exhausted is still found.
	// Pure transient 429 without exhausted markers is never selected.
	if metaHits == 0 {
		s.appendEvent("列表元数据无限额标记，回退 download+probe 识别耗尽号…")
		proxy := cfg.RegisterProxy
		for _, m := range list {
			if m.Disabled || strings.TrimSpace(m.Name) == "" {
				continue
			}
			raw, err := del.Download(m.Name)
			if err != nil {
				continue
			}
			var doc cpa.Document
			if json.Unmarshal(raw, &doc) != nil || doc.AccessToken == "" {
				continue
			}
			err = s.probeFn(doc, proxy)
			if err == nil {
				continue
			}
			low := strings.ToLower(err.Error())
			if cpa.IsQuotaExhausted("", low) {
				targets = append(targets, m)
			}
			// IsTransientRateLimit alone → keep (may recover)
		}
	}
	res.QuotaHits = len(targets)
	s.appendEvent("限额耗尽命中 %d 条（元数据命中 %d）", res.QuotaHits, metaHits)
	if len(targets) == 0 {
		res.Reason = "无限额耗尽号"
		s.storeCleanup(res, "扫描完成：无限额耗尽号可清理")
		s.appendEvent("清理结束：无限额耗尽号")
		return res, nil
	}

	backupDir := ""
	if cfg.CleanupBackup && !cfg.CleanupDryRun {
		backupDir = filepath.Join(s.backupRoot(), time.Now().Format("20060102-150405"))
		if err := os.MkdirAll(backupDir, 0o700); err != nil {
			res.Error = fmt.Sprintf("创建备份目录失败: %v", err)
			s.storeCleanup(res, res.Error)
			return res, fmt.Errorf("%s", res.Error)
		}
		res.BackupDir = backupDir
	}

	for _, m := range targets {
		name := strings.TrimSpace(m.Name)
		if name == "" {
			res.Skipped++
			continue
		}
		if cfg.CleanupDryRun {
			if len(res.SampleWould) < 20 {
				res.SampleWould = append(res.SampleWould, name)
			}
			res.Deleted++ // would-delete count under dry-run
			continue
		}

		if cfg.CleanupBackup {
			raw, err := del.Download(name)
			if err != nil {
				res.Errors++
				if len(res.SampleErrors) < 10 {
					res.SampleErrors = append(res.SampleErrors, fmt.Sprintf("%s: backup %v", name, err))
				}
				// 备份失败则不删
				continue
			}
			bp := filepath.Join(backupDir, filepath.Base(name))
			if err := os.WriteFile(bp, raw, 0o600); err != nil {
				res.Errors++
				if len(res.SampleErrors) < 10 {
					res.SampleErrors = append(res.SampleErrors, fmt.Sprintf("%s: write backup %v", name, err))
				}
				continue
			}
			res.BackedUp++
		}

		if err := del.Delete(name); err != nil { // ManagementAPI includes Delete
			res.Errors++
			if len(res.SampleErrors) < 10 {
				res.SampleErrors = append(res.SampleErrors, fmt.Sprintf("%s: %v", name, err))
			}
			continue
		}
		res.Deleted++
		if len(res.SampleDeleted) < 20 {
			res.SampleDeleted = append(res.SampleDeleted, name)
		}
	}

	res.DurationMS = time.Since(started).Milliseconds()
	if cfg.CleanupDryRun {
		res.Reason = fmt.Sprintf("dry-run：将删除 %d 个限额耗尽号（未实际删除）", res.QuotaHits)
	} else {
		res.Reason = fmt.Sprintf("已删除 %d / 命中 %d（错误 %d）", res.Deleted, res.QuotaHits, res.Errors)
	}
	s.storeCleanup(res, res.Reason)
	s.appendEvent("清理结束：%s 耗时=%dms", res.Reason, res.DurationMS)
	if len(res.SampleWould) > 0 {
		s.appendEvent("将删样本: %s", strings.Join(res.SampleWould, ", "))
	}
	if len(res.SampleDeleted) > 0 {
		s.appendEvent("已删样本: %s", strings.Join(res.SampleDeleted, ", "))
	}
	if len(res.SampleErrors) > 0 {
		s.appendEvent("错误样本: %s", strings.Join(res.SampleErrors, " | "))
	}
	return res, nil
}

func (s *Service) backupRoot() string {
	if s.backupDir != "" {
		return s.backupDir
	}
	// default next to patrol state: <grok-home>/pool-backups
	return filepath.Join(filepath.Dir(s.statePath), "pool-backups")
}

// SetBackupDir overrides the backup root (tests / custom GROK_HOME layout).
func (s *Service) SetBackupDir(dir string) {
	s.backupDir = dir
}

func (s *Service) storeCleanup(res *CleanupResult, reason string) {
	if res.DurationMS == 0 {
		res.DurationMS = time.Since(res.Time).Milliseconds()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := *res
	s.cleanup.last = &cp
	now := time.Now()
	s.cleanup.lastRun = &now
	s.cleanup.lastReason = reason
	s.saveLocked()
}

// maybeCleanupAfterPatrol runs cleanup when enabled + on_patrol.
func (s *Service) maybeCleanupAfterPatrol() {
	cfg := s.cfgFn()
	if !cfg.CleanupQuotaEnabled || !cfg.CleanupOnPatrol {
		s.appendEvent("巡检后清理跳过：enabled=%v on_patrol=%v",
			cfg.CleanupQuotaEnabled, cfg.CleanupOnPatrol)
		return
	}
	s.appendEvent("巡检后自动触发清理…")
	_, _ = s.RunCleanup(false)
}
