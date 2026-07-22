package api

import (
	"fmt"
	"net/http"
	"strconv"

	"github.com/grok-free-register/grok-reg/internal/jobs"
	"github.com/grok-free-register/grok-reg/internal/transfer"
)

// transferSvc lazily builds the transfer service bound to this server.
// Constructed in New() via initTransfer.

func (s *Server) handleTransferPrepare(w http.ResponseWriter, r *http.Request) {
	job, err := s.transfer.PrepareUpload(r)
	if err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "job": s.transfer.UploadSummary(job)})
}

func (s *Server) handleTransferJobs(w http.ResponseWriter, r *http.Request) {
	list := s.transfer.UploadJobs.List(30)
	out := make([]transfer.UploadSummary, 0, len(list))
	for _, j := range list {
		out = append(out, s.transfer.UploadSummary(j))
	}
	writeJSON(w, 200, map[string]any{"ok": true, "jobs": out})
}

func (s *Server) getUploadJob(w http.ResponseWriter, r *http.Request) (*jobs.Job, bool) {
	job, ok := s.transfer.UploadJobs.Get(r.PathValue("id"))
	if !ok {
		writeJSON(w, 404, map[string]any{"ok": false, "error": "任务不存在"})
	}
	return job, ok
}

func (s *Server) handleTransferJobGet(w http.ResponseWriter, r *http.Request) {
	job, ok := s.getUploadJob(w, r)
	if !ok {
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "job": s.transfer.UploadSummary(job)})
}

func (s *Server) handleTransferJobStart(w http.ResponseWriter, r *http.Request) {
	job, ok := s.getUploadJob(w, r)
	if !ok {
		return
	}
	if !s.transfer.StartUploadJob(job, false) {
		writeJSON(w, 409, map[string]any{"ok": false, "error": "任务已在运行或已完成"})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) handleTransferJobRetryFailed(w http.ResponseWriter, r *http.Request) {
	job, ok := s.getUploadJob(w, r)
	if !ok {
		return
	}
	if !s.transfer.StartUploadJob(job, true) {
		writeJSON(w, 409, map[string]any{"ok": false, "error": "任务正在运行或没有失败项"})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) handleTransferJobCancel(w http.ResponseWriter, r *http.Request) {
	job, ok := s.getUploadJob(w, r)
	if !ok {
		return
	}
	job.Cancel()
	job.Broadcast(s.transfer.UploadSummary(job))
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) handleTransferJobEvents(w http.ResponseWriter, r *http.Request) {
	job, ok := s.getUploadJob(w, r)
	if !ok {
		return
	}
	jobs.ServeSSE(w, r, job, func() any { return s.transfer.UploadSummary(job) })
}

func (s *Server) handleTransferCacheGet(w http.ResponseWriter, r *http.Request) {
	total, sample := s.transfer.Cache.Summary(20)
	writeJSON(w, 200, map[string]any{"ok": true, "total": total, "sample": sample})
}

func (s *Server) handleTransferCacheDelete(w http.ResponseWriter, r *http.Request) {
	removed := s.transfer.Cache.Delete(r.URL.Query().Get("name"))
	s.transfer.Cache.Flush()
	writeJSON(w, 200, map[string]any{"ok": true, "removed": removed})
}

// ---------- export ----------

func (s *Server) handleExportPreview(w http.ResponseWriter, r *http.Request) {
	res, err := s.transfer.PreviewExport(r)
	if err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "preview": res})
}

func (s *Server) handleExportStart(w http.ResponseWriter, r *http.Request) {
	job, running, err := s.transfer.StartExport(r)
	if err != nil {
		code := 400
		body := map[string]any{"ok": false, "error": err.Error()}
		if running != nil {
			code = 409
			body["running"] = s.transfer.ExportSummary(running)
		}
		writeJSON(w, code, body)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "job": s.transfer.ExportSummary(job)})
}

func (s *Server) getExportJob(w http.ResponseWriter, r *http.Request) (*jobs.Job, bool) {
	job, ok := s.transfer.ExportJobs.Get(r.PathValue("id"))
	if !ok {
		writeJSON(w, 404, map[string]any{"ok": false, "error": "导出任务不存在"})
	}
	return job, ok
}

func (s *Server) handleExportJobs(w http.ResponseWriter, r *http.Request) {
	list := s.transfer.ExportJobs.List(30)
	out := make([]transfer.ExportSummary, 0, len(list))
	for _, j := range list {
		out = append(out, s.transfer.ExportSummary(j))
	}
	writeJSON(w, 200, map[string]any{"ok": true, "jobs": out})
}

func (s *Server) handleExportJobGet(w http.ResponseWriter, r *http.Request) {
	job, ok := s.getExportJob(w, r)
	if !ok {
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "job": s.transfer.ExportSummary(job)})
}

func (s *Server) handleExportJobEvents(w http.ResponseWriter, r *http.Request) {
	job, ok := s.getExportJob(w, r)
	if !ok {
		return
	}
	jobs.ServeSSE(w, r, job, func() any { return s.transfer.ExportSummary(job) })
}

func (s *Server) handleExportJobCancel(w http.ResponseWriter, r *http.Request) {
	job, ok := s.getExportJob(w, r)
	if !ok {
		return
	}
	job.Cancel()
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) handleExportJobRetryFailed(w http.ResponseWriter, r *http.Request) {
	job, ok := s.getExportJob(w, r)
	if !ok {
		return
	}
	if !s.transfer.RetryExportFailed(job) {
		writeJSON(w, 409, map[string]any{"ok": false, "error": "任务正在运行或没有失败项"})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) handleExportPart(w http.ResponseWriter, r *http.Request) {
	abs, err := s.transfer.PartPath(r.PathValue("id"), r.PathValue("filename"))
	if err != nil {
		writeJSON(w, 404, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", r.PathValue("filename")))
	http.ServeFile(w, r, abs)
}

func (s *Server) handleExportDownloadAll(w http.ResponseWriter, r *http.Request) {
	abs, err := s.transfer.DownloadAllParts(r.PathValue("id"))
	if err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", r.PathValue("id")+"-all-parts.zip"))
	http.ServeFile(w, r, abs)
}

// ---------- pool (remote list + connectivity) ----------

func (s *Server) handlePoolTestConnection(w http.ResponseWriter, r *http.Request) {
	var body struct {
		BaseURL       string `json:"baseUrl"`
		ManagementKey string `json:"managementKey"`
	}
	_ = decodeJSONBody(r, &body)
	status, _, err := s.transfer.TestConnection(body.BaseURL, body.ManagementKey)
	if err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	if status < 200 || status >= 300 {
		writeJSON(w, 200, map[string]any{"ok": false, "error": fmt.Sprintf("HTTP %d", status)})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) handlePoolFiles(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	force := q.Get("force") == "1" || q.Get("force") == "true"
	limit, _ := strconv.Atoi(q.Get("limit"))
	list, total, err := s.transfer.ListRemote("", "", force, limit)
	if err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	if !force {
		writeJSON(w, 200, map[string]any{
			"ok": true, "total": total, "disabled": true,
			"message": "全量列表默认禁用，使用 ?force=1&limit=50 获取样本",
		})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "total": total, "files": list})
}
