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

// MasterLink is the live view of one configured master from a slave.
type MasterLink struct {
	URL        string     `json:"url"`
	OK         bool       `json:"ok"`
	LastError  string     `json:"last_error,omitempty"`
	LastOK     *time.Time `json:"last_ok,omitempty"`
	LastAssign int        `json:"last_assign"`
	Need       int        `json:"need"`
	MasterName string     `json:"master_name,omitempty"`
}

func (s *Service) slaveLoop(ctx context.Context) {
	client := &http.Client{Timeout: 20 * time.Second}
	for {
		cfg := s.cfgFn()
		sec := clamp(cfg.ClusterHeartbeatSec, 5, 300)
		masters := cfg.ClusterMasterEndpoints()
		if normalizeRole(cfg.ClusterRole) != RoleSlave || len(masters) == 0 {
			s.setSlaveMeta(false, "未启用从节点或未配置主地址", nil)
			s.setMasterLinks(nil)
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Duration(sec) * time.Second):
				continue
			}
		}

		if err := s.slaveTickMulti(client, cfg, masters); err != nil {
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

func (s *Service) setMasterLinks(links []MasterLink) {
	s.slaveMu.Lock()
	defer s.slaveMu.Unlock()
	s.masterLinks = links
}

func masterToken(cfg config.Config, ep config.MasterEndpoint) string {
	if t := strings.TrimSpace(ep.Token); t != "" {
		return t
	}
	return strings.TrimSpace(cfg.ClusterPublicToken)
}

func (s *Service) slaveTickMulti(client *http.Client, cfg config.Config, masters []config.MasterEndpoint) error {
	busy := s.runningFn != nil && s.runningFn()

	links := make([]MasterLink, 0, len(masters))
	var (
		bestAssign int
		bestURL    string
		anyOK      bool
		errs       []string
	)

	for _, ep := range masters {
		base := ep.URL
		tok := masterToken(cfg, ep)
		reqBody := HeartbeatRequest{
			NodeID:   s.nodeID,
			Name:     firstNonEmpty(cfg.ClusterNodeName, s.nodeID[:min(8, len(s.nodeID))]),
			Capacity: clamp(cfg.ClusterAssignMax, 1, 10),
			Busy:     busy,
			Token:    tok,
			Version:  "0.2.0-panel",
		}
		raw, _ := json.Marshal(reqBody)
		link := MasterLink{URL: base}
		url := base + "/api/federation/heartbeat"
		httpReq, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(raw))
		if err != nil {
			link.LastError = err.Error()
			links = append(links, link)
			errs = append(errs, base+": "+err.Error())
			continue
		}
		httpReq.Header.Set("Content-Type", "application/json")
		if tok != "" {
			httpReq.Header.Set("X-Cluster-Token", tok)
		}
		resp, err := client.Do(httpReq)
		if err != nil {
			link.LastError = err.Error()
			links = append(links, link)
			errs = append(errs, base+": "+err.Error())
			continue
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		_ = resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			msg := fmt.Sprintf("status=%d body=%s", resp.StatusCode, truncate(string(body), 120))
			link.LastError = msg
			links = append(links, link)
			errs = append(errs, base+": "+msg)
			continue
		}
		var hb HeartbeatResponse
		if err := json.Unmarshal(body, &hb); err != nil {
			link.LastError = err.Error()
			links = append(links, link)
			errs = append(errs, base+": "+err.Error())
			continue
		}
		now := time.Now()
		link.OK = true
		link.LastOK = &now
		link.LastAssign = hb.Assign
		link.Need = hb.Need
		link.MasterName = hb.MasterName
		links = append(links, link)
		anyOK = true
		// Prefer the master with the largest assign (most urgent need).
		if hb.Assign > bestAssign {
			bestAssign = hb.Assign
			bestURL = base
		}
	}

	s.setMasterLinks(links)
	now := time.Now()
	if anyOK {
		s.setSlaveMeta(true, "", &now)
		s.slaveMu.Lock()
		s.lastAssign = bestAssign
		s.slaveMu.Unlock()
	} else {
		msg := "all masters unreachable"
		if len(errs) > 0 {
			msg = strings.Join(errs, " | ")
		}
		s.setSlaveMeta(false, msg, nil)
		return fmt.Errorf("%s", msg)
	}

	if bestAssign <= 0 || !cfg.ClusterAutoRegister {
		return nil
	}
	if s.runningFn != nil && s.runningFn() {
		return nil
	}
	if s.startFn == nil {
		return fmt.Errorf("start fn not wired")
	}
	target := clamp(bestAssign, 1, 10)
	if err := s.startFn(target); err != nil {
		return fmt.Errorf("auto start target=%d: %w", target, err)
	}
	// Report completion back to the master that assigned work (and others best-effort).
	go s.afterAssignMulti(client, cfg, masters, bestURL, target)
	return nil
}

func (s *Service) afterAssignMulti(client *http.Client, cfg config.Config, masters []config.MasterEndpoint, preferred string, target int) {
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
	// preferred first, then the rest
	order := make([]config.MasterEndpoint, 0, len(masters))
	var prefEP *config.MasterEndpoint
	for i := range masters {
		if masters[i].URL == preferred {
			ep := masters[i]
			prefEP = &ep
			break
		}
	}
	if prefEP != nil {
		order = append(order, *prefEP)
	}
	for _, m := range masters {
		if m.URL != preferred {
			order = append(order, m)
		}
	}
	for _, ep := range order {
		tok := masterToken(cfg, ep)
		rep := ReportRequest{
			NodeID:    s.nodeID,
			Name:      firstNonEmpty(cfg.ClusterNodeName, s.nodeID),
			Completed: target,
			Uploaded:  uploaded,
			Failed:    failed,
			Token:     tok,
			Message:   fmt.Sprintf("batch target=%d uploaded=%d failed=%d", target, uploaded, failed),
		}
		raw, _ := json.Marshal(rep)
		url := ep.URL + "/api/federation/report"
		req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(raw))
		if err != nil {
			continue
		}
		req.Header.Set("Content-Type", "application/json")
		if tok != "" {
			req.Header.Set("X-Cluster-Token", tok)
		}
		resp, err := client.Do(req)
		if err != nil {
			continue
		}
		_ = resp.Body.Close()
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
