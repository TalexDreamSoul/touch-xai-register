package api

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/grok-free-register/grok-reg/internal/config"
	"github.com/grok-free-register/grok-reg/internal/cpa"
)

// handleFederationPoolList exposes the master's formal CPA pool metadata
// when ClusterSharePoolList is enabled. Auth: federation token.
func (s *Server) handleFederationPoolList(w http.ResponseWriter, r *http.Request) {
	tok := federationToken(r)
	cfg, err := config.Load(s.opt.Paths.Config)
	if err != nil {
		writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	if code, msg := s.clusterAuthorize(cfg, tok); code != 0 {
		writeJSON(w, code, map[string]any{"ok": false, "error": msg})
		return
	}
	if !cfg.ClusterSharePoolList {
		writeJSON(w, 403, map[string]any{
			"ok":    false,
			"error": "主节点未开启号池列表分享（CLUSTER_SHARE_POOL_LIST）",
		})
		return
	}
	page, pageSize := parsePage(r, 1, 10, 100)
	list, total, err := s.transfer.ListRemotePage("", "", true, page, pageSize)
	if err != nil {
		writeJSON(w, 502, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	// strip nothing extra — AuthMeta is already slim
	writeJSON(w, 200, map[string]any{
		"ok":             true,
		"source":         "federation",
		"share_pool_list": true,
		"share_pool_pull": cfg.ClusterSharePoolPull,
		"total":          total,
		"page":           page,
		"page_size":      pageSize,
		"total_pages":    pageCount(total, pageSize),
		"files":          list,
		"master_name":    firstNonEmpty(cfg.ClusterNodeName, "master"),
	})
}

// handleFederationPoolPull downloads one credential when ClusterSharePoolPull is on.
func (s *Server) handleFederationPoolPull(w http.ResponseWriter, r *http.Request) {
	tok := federationToken(r)
	cfg, err := config.Load(s.opt.Paths.Config)
	if err != nil {
		writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	if code, msg := s.clusterAuthorize(cfg, tok); code != 0 {
		writeJSON(w, code, map[string]any{"ok": false, "error": msg})
		return
	}
	if !cfg.ClusterSharePoolPull {
		writeJSON(w, 403, map[string]any{
			"ok":    false,
			"error": "主节点未开启号池凭证拉取（CLUSTER_SHARE_POOL_PULL）",
		})
		return
	}
	name := strings.TrimSpace(r.URL.Query().Get("name"))
	if name == "" {
		name = strings.TrimSpace(r.PathValue("name"))
	}
	if name == "" || strings.Contains(name, "..") || strings.ContainsAny(name, "/\\") {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "invalid name"})
		return
	}
	client := cpa.NewClient(cfg.CPAManagementBase, cfg.CPAManagementKey, max(cfg.CPAUploadTimeoutSec, 30))
	raw, err := client.Download(name)
	if err != nil {
		writeJSON(w, 502, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, name))
	w.WriteHeader(200)
	_, _ = w.Write(raw)
}

// handleUnifiedPoolList is the panel-side multi-source list:
//   source=local|cloud|federation
//   master=<base url> when source=federation
func (s *Server) handleUnifiedPoolList(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	source := strings.ToLower(strings.TrimSpace(q.Get("source")))
	if source == "" {
		source = "local"
	}
	page, pageSize := parsePage(r, 1, 10, 100)

	switch source {
	case "local":
		all := s.localPool.List()
		total, unsynced := s.localPool.Stats()
		start := (page - 1) * pageSize
		if start > len(all) {
			start = len(all)
		}
		end := start + pageSize
		if end > len(all) {
			end = len(all)
		}
		items := all[start:end]
		writeJSON(w, 200, map[string]any{
			"ok":          true,
			"source":      "local",
			"total":       total,
			"unsynced":    unsynced,
			"page":        page,
			"page_size":   pageSize,
			"total_pages": pageCount(len(all), pageSize),
			"items":       items,
		})
	case "cloud":
		list, total, err := s.transfer.ListRemotePage("", "", true, page, pageSize)
		if err != nil {
			writeJSON(w, 502, map[string]any{"ok": false, "error": err.Error(), "source": "cloud"})
			return
		}
		writeJSON(w, 200, map[string]any{
			"ok":          true,
			"source":      "cloud",
			"total":       total,
			"page":        page,
			"page_size":   pageSize,
			"total_pages": pageCount(total, pageSize),
			"files":       list,
			"can_pull":    true, // local panel has CPA key
		})
	case "federation", "master", "fed":
		master := strings.TrimRight(strings.TrimSpace(q.Get("master")), "/")
		if master == "" {
			writeJSON(w, 400, map[string]any{"ok": false, "error": "缺少 master 参数"})
			return
		}
		cfg, err := config.Load(s.opt.Paths.Config)
		if err != nil {
			writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		body, status, err := federationGET(master, "/api/federation/pool", cfg.ClusterPublicToken, map[string]string{
			"page":  strconv.Itoa(page),
			"limit": strconv.Itoa(pageSize),
		})
		if err != nil {
			writeJSON(w, 502, map[string]any{"ok": false, "error": err.Error(), "source": "federation", "master": master})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write(body)
	default:
		writeJSON(w, 400, map[string]any{"ok": false, "error": "source 须为 local|cloud|federation"})
	}
}

// handleUnifiedPoolPull downloads from cloud (local CPA) or federation master.
func (s *Server) handleUnifiedPoolPull(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	source := strings.ToLower(strings.TrimSpace(q.Get("source")))
	name := strings.TrimSpace(q.Get("name"))
	if name == "" || strings.Contains(name, "..") || strings.ContainsAny(name, "/\\") {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "invalid name"})
		return
	}
	switch source {
	case "", "cloud", "local-cpa":
		cfg, err := config.Load(s.opt.Paths.Config)
		if err != nil {
			writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		client := cpa.NewClient(cfg.CPAManagementBase, cfg.CPAManagementKey, max(cfg.CPAUploadTimeoutSec, 30))
		raw, err := client.Download(name)
		if err != nil {
			writeJSON(w, 502, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, name))
		w.WriteHeader(200)
		_, _ = w.Write(raw)
	case "federation", "master", "fed":
		master := strings.TrimRight(strings.TrimSpace(q.Get("master")), "/")
		if master == "" {
			writeJSON(w, 400, map[string]any{"ok": false, "error": "缺少 master 参数"})
			return
		}
		cfg, err := config.Load(s.opt.Paths.Config)
		if err != nil {
			writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		body, status, err := federationGET(master, "/api/federation/pool/pull", cfg.ClusterPublicToken, map[string]string{
			"name": name,
		})
		if err != nil {
			writeJSON(w, 502, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		if status >= 400 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			_, _ = w.Write(body)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, name))
		w.WriteHeader(200)
		_, _ = w.Write(body)
	default:
		writeJSON(w, 400, map[string]any{"ok": false, "error": "source 须为 cloud|federation"})
	}
}

func (s *Server) clusterAuthorize(cfg config.Config, token string) (int, string) {
	// reuse cluster service's constant-time check via PublicInfo path
	_, code, msg := s.cluster.PublicInfo(token)
	if code != 0 {
		return code, msg
	}
	return 0, ""
}

func federationGET(masterBase, path, token string, query map[string]string) ([]byte, int, error) {
	u, err := url.Parse(strings.TrimRight(masterBase, "/") + path)
	if err != nil {
		return nil, 0, err
	}
	q := u.Query()
	for k, v := range query {
		q.Set(k, v)
	}
	u.RawQuery = q.Encode()
	req, err := http.NewRequest(http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, 0, err
	}
	if strings.TrimSpace(token) != "" {
		req.Header.Set("X-Cluster-Token", token)
	}
	client := &http.Client{Timeout: 45 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if err != nil {
		return nil, res.StatusCode, err
	}
	return b, res.StatusCode, nil
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
