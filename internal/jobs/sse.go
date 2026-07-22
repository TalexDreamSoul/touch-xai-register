package jobs

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// ServeSSE streams job summaries as Server-Sent Events until the client
// disconnects or the request context ends.
//
// Protocol (mirrors the Node cpa-uploader):
//   - one initial frame with the full current summary
//   - subsequent frames each time the job broadcasts
//   - ": ping" comment heartbeat every 15s
//   - all frames are default-message frames: "data: <json>\n\n"
func ServeSSE(w http.ResponseWriter, r *http.Request, j *Job, snapshot func() any) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache, no-transform")
	h.Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	writeFrame := func(b []byte) bool {
		if _, err := fmt.Fprintf(w, "data: %s\n\n", b); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}

	// Initial full snapshot.
	if snap, err := json.Marshal(snapshot()); err == nil {
		if !writeFrame(snap) {
			return
		}
	}

	ch := j.Subscribe()
	defer j.Unsubscribe(ch)

	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case b := <-ch:
			if !writeFrame(b) {
				return
			}
		case <-heartbeat.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}
