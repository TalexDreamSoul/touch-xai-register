package api

import (
	"context"
	"net/http"
	"time"
)

// handlePoolOverview returns the pool picture: last patrol counts, quota
// estimate, patrol loop status, and refill controller status.
func (s *Server) handlePoolOverview(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{
		"ok":       true,
		"overview": s.patrol.Overview(),
		"patrol":   s.patrol.Status(),
		"refill":   s.patrol.RefillStatus(),
	})
}

// handlePoolPatrol triggers a manual patrol (light|deep), running async.
func (s *Server) handlePoolPatrol(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Mode string `json:"mode"`
	}
	_ = decodeJSONBody(r, &body)
	mode := body.Mode
	if mode != "deep" {
		mode = "light"
	}
	// Run synchronously for light (fast), async for deep (can take minutes).
	if mode == "light" {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
		defer cancel()
		rec, err := s.patrol.Run(ctx, mode)
		if err != nil && rec == nil {
			writeJSON(w, 409, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "record": rec})
		return
	}
	go func() {
		_, _ = s.patrol.Run(context.Background(), mode)
	}()
	writeJSON(w, 200, map[string]any{"ok": true, "started": true, "mode": mode})
}

// handlePoolPatrolHistory returns recent patrol records (newest first).
func (s *Server) handlePoolPatrolHistory(w http.ResponseWriter, r *http.Request) {
	h := s.patrol.History()
	// newest first for the UI
	for i, j := 0, len(h)-1; i < j; i, j = i+1, j-1 {
		h[i], h[j] = h[j], h[i]
	}
	writeJSON(w, 200, map[string]any{"ok": true, "history": h})
}
