package cluster

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/grok-free-register/grok-reg/internal/config"
)

func (s *Service) slaveLoop(ctx context.Context) {
	client := &http.Client{Timeout: 20 * time.Second}
	for {
		cfg := s.cfgFn()
		sec := clamp(cfg.ClusterHeartbeatSec, 5, 300)
		if normalizeRole(cfg.ClusterRole) != RoleSlave || strings.TrimSpace(cfg.ClusterMasterURL) == "" {
			s.setSlaveMeta(false, "未启用从节点或未配置主地址", nil)
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Duration(sec) * time.Second):
				continue
			}
		}

		if err := s.slaveTick(client, cfg); err != nil {
			s.setSlaveMeta(false, err.Error(), nil)
		}

		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Duration(sec) * time.Second):
		}
	}
}

func (s *Service) setSlaveMeta(ok bool, errMsg string, t *time.Time) {
	s.slaveMu.Lock()
	defer s.slaveMu.Unlock()
	s.slaveConnected = ok
	s.slaveLastErr = errMsg
	if t != nil {
		s.slaveLastOK = t
	}
}

func (s *Service) slaveTick(client *http.Client, cfg config.Config) error {
	busy := false
	runningTarget := 0
	if s.runningFn != nil && s.runningFn() {
		busy = true
	}

	reqBody := HeartbeatRequest{
		NodeID:        s.nodeID,
		Name:          firstNonEmpty(cfg.ClusterNodeName, s.nodeID[:min(8, len(s.nodeID))]),
		Capacity:      clamp(cfg.ClusterAssignMax, 1, 10),
		Busy:          busy,
		RunningTarget: runningTarget,
		Token:         cfg.ClusterPublicToken,
		Version:       "0.2.0-panel",
	}
	raw, _ := json.Marshal(reqBody)
	url := strings.TrimRight(cfg.ClusterMasterURL, "/") + "/api/federation/heartbeat"
	httpReq, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if tok := strings.TrimSpace(cfg.ClusterPublicToken); tok != "" {
		httpReq.Header.Set("X-Cluster-Token", tok)
	}
	resp, err := client.Do(httpReq)
	if err != nil {
		return fmt.Errorf("heartbeat: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("heartbeat status=%d body=%s", resp.StatusCode, truncate(string(body), 200))
	}
	var hb HeartbeatResponse
	if err := json.Unmarshal(body, &hb); err != nil {
		return fmt.Errorf("heartbeat decode: %w", err)
	}
	now := time.Now()
	s.slaveMu.Lock()
	s.slaveConnected = true
	s.slaveLastErr = ""
	s.slaveLastOK = &now
	s.lastAssign = hb.Assign
	s.slaveMu.Unlock()

	if hb.Assign <= 0 || !cfg.ClusterAutoRegister {
		return nil
	}
	if s.runningFn != nil && s.runningFn() {
		return nil
	}
	if s.startFn == nil {
		return fmt.Errorf("start fn not wired")
	}
	target := clamp(hb.Assign, 1, 10)
	if err := s.startFn(target); err != nil {
		return fmt.Errorf("auto start target=%d: %w", target, err)
	}

	// Wait for pipeline to finish (bounded), then optional upload + report.
	go s.afterAssign(client, cfg, target)
	return nil
}

func (s *Service) afterAssign(client *http.Client, cfg config.Config, target int) {
	// Poll until not running (max ~6h)
	deadline := time.Now().Add(6 * time.Hour)
	for time.Now().Before(deadline) {
		time.Sleep(5 * time.Second)
		if s.runningFn == nil || !s.runningFn() {
			break
		}
	}
	uploaded, failed := 0, 0
	if cfg.ClusterAutoUpload && s.uploadFn != nil {
		u, f, err := s.uploadFn()
		uploaded, failed = u, f
		if err != nil {
			s.slaveMu.Lock()
			s.slaveLastErr = "upload: " + err.Error()
			s.slaveMu.Unlock()
		}
	}
	// best-effort report
	rep := ReportRequest{
		NodeID:    s.nodeID,
		Name:      firstNonEmpty(cfg.ClusterNodeName, s.nodeID),
		Completed: target,
		Uploaded:  uploaded,
		Failed:    failed,
		Token:     cfg.ClusterPublicToken,
		Message:   fmt.Sprintf("batch target=%d uploaded=%d failed=%d", target, uploaded, failed),
	}
	raw, _ := json.Marshal(rep)
	url := strings.TrimRight(cfg.ClusterMasterURL, "/") + "/api/federation/report"
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if tok := strings.TrimSpace(cfg.ClusterPublicToken); tok != "" {
		req.Header.Set("X-Cluster-Token", tok)
	}
	resp, err := client.Do(req)
	if err != nil {
		return
	}
	_ = resp.Body.Close()
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
