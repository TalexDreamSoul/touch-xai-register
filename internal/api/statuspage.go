package api

import (
	"net/http"

	"github.com/grok-free-register/grok-reg/internal/cluster"
	"github.com/grok-free-register/grok-reg/internal/statuspage"
)

func (s *Server) handlePublicStatus(w http.ResponseWriter, r *http.Request) {
	pw := statusPassword(r)
	board, code, msg := s.status.Board(pw)
	if code != 0 {
		writeJSON(w, code, map[string]any{
			"ok":            false,
			"error":         msg,
			"auth_required": true,
			"service":       "grok-panel-status",
		})
		return
	}
	writeJSON(w, 200, board)
}

func (s *Server) handlePublicStatusJSON(w http.ResponseWriter, r *http.Request) {
	// same as handlePublicStatus — explicit .json alias for scrapers
	s.handlePublicStatus(w, r)
}

func (s *Server) handleStatusLayoutGet(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"ok": true, "layout": s.status.Layout()})
}

func (s *Server) handleStatusLayoutPut(w http.ResponseWriter, r *http.Request) {
	var body statuspage.Layout
	if err := decodeJSONBody(r, &body); err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "invalid json"})
		return
	}
	if err := s.status.SaveLayout(body); err != nil {
		writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "layout": s.status.Layout()})
}

func (s *Server) handleStatusProbeNow(w http.ResponseWriter, r *http.Request) {
	// trigger one probe asynchronously
	go s.status.ProbeNow()
	writeJSON(w, 200, map[string]any{"ok": true, "started": true})
}

func filterOnline(nodes []cluster.Node) []cluster.Node {
	var out []cluster.Node
	for _, n := range nodes {
		if n.Online {
			out = append(out, n)
		}
	}
	return out
}
