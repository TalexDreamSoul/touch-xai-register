package api

import (
	"net/http"
	"strings"

	"github.com/grok-free-register/grok-reg/internal/cluster"
)

func federationToken(r *http.Request) string {
	if h := strings.TrimSpace(r.Header.Get("X-Cluster-Token")); h != "" {
		return h
	}
	if h := strings.TrimSpace(r.Header.Get("Authorization")); h != "" {
		if strings.HasPrefix(strings.ToLower(h), "bearer ") {
			return strings.TrimSpace(h[7:])
		}
	}
	if q := strings.TrimSpace(r.URL.Query().Get("cluster_token")); q != "" {
		return q
	}
	return ""
}

func (s *Server) handleFederationInfo(w http.ResponseWriter, r *http.Request) {
	tok := federationToken(r)
	info, code, msg := s.cluster.PublicInfo(tok)
	if code != 0 {
		writeJSON(w, code, map[string]any{"ok": false, "error": msg})
		return
	}
	writeJSON(w, 200, info)
}

func (s *Server) handleFederationHeartbeat(w http.ResponseWriter, r *http.Request) {
	var req cluster.HeartbeatRequest
	_ = decodeJSONBody(r, &req)
	if strings.TrimSpace(req.Token) == "" {
		req.Token = federationToken(r)
	}
	remote := r.RemoteAddr
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		remote = strings.TrimSpace(strings.Split(xff, ",")[0])
	}
	res, code, msg := s.cluster.Heartbeat(req, remote)
	if code != 0 {
		writeJSON(w, code, map[string]any{"ok": false, "error": msg})
		return
	}
	writeJSON(w, 200, res)
}

func (s *Server) handleFederationReport(w http.ResponseWriter, r *http.Request) {
	var req cluster.ReportRequest
	_ = decodeJSONBody(r, &req)
	if strings.TrimSpace(req.Token) == "" {
		req.Token = federationToken(r)
	}
	res, code, msg := s.cluster.Report(req)
	if code != 0 {
		writeJSON(w, code, map[string]any{"ok": false, "error": msg})
		return
	}
	writeJSON(w, 200, res)
}

func (s *Server) handleClusterStatus(w http.ResponseWriter, r *http.Request) {
	st := s.cluster.Status()
	writeJSON(w, 200, map[string]any{"ok": true, "cluster": st})
}

func (s *Server) handleClusterKick(w http.ResponseWriter, r *http.Request) {
	var body struct {
		NodeID string `json:"node_id"`
	}
	_ = decodeJSONBody(r, &body)
	id := strings.TrimSpace(body.NodeID)
	if id == "" {
		id = strings.TrimSpace(r.URL.Query().Get("node_id"))
	}
	if id == "" {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "node_id required"})
		return
	}
	if !s.cluster.Kick(id) {
		writeJSON(w, 404, map[string]any{"ok": false, "error": "node not found"})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}
