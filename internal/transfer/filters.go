package transfer

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"

	"github.com/grok-free-register/grok-reg/internal/cpa"
)

// ExportFilters selects which remote auth-files to export.
type ExportFilters struct {
	Provider      string `json:"provider,omitempty"`
	EmailContains string `json:"emailContains,omitempty"`
	NameContains  string `json:"nameContains,omitempty"`
	Disabled      *bool  `json:"disabled,omitempty"`
	Limit         int    `json:"limit,omitempty"`
}

// exportRequest is the JSON body for preview/start.
type exportRequest struct {
	ExportFilters
	// accept Node-style aliases
	Email string `json:"email,omitempty"`
	Name  string `json:"name,omitempty"`

	BaseURL       string `json:"baseUrl,omitempty"`
	ManagementKey string `json:"managementKey,omitempty"`

	BatchSize   int  `json:"batchSize,omitempty"`
	Concurrency int  `json:"concurrency,omitempty"`
	TimeoutMs   int  `json:"timeoutMs,omitempty"`
	RetryLimit  int  `json:"retryLimit,omitempty"`
	KeepFiles   bool `json:"keepFiles,omitempty"`
}

// parseExportRequest decodes and normalizes the body, including the
// tri-state disabled flag which may arrive as bool or string.
func parseExportRequest(r *http.Request) (exportRequest, error) {
	var raw map[string]json.RawMessage
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&raw); err != nil {
		return exportRequest{}, fmt.Errorf("JSON 解析失败: %v", err)
	}
	var req exportRequest
	b, _ := json.Marshal(raw)
	// best-effort straight decode for the simple fields
	var straight exportRequest
	_ = json.Unmarshal(b, &straight)
	req = straight

	getStr := func(keys ...string) string {
		for _, k := range keys {
			if rm, ok := raw[k]; ok {
				var s string
				if json.Unmarshal(rm, &s) == nil {
					return s
				}
			}
		}
		return ""
	}
	req.Provider = getStr("provider")
	req.EmailContains = getStr("emailContains", "email")
	req.NameContains = getStr("nameContains", "name")
	req.BaseURL = getStr("baseUrl")
	req.ManagementKey = getStr("managementKey")

	// disabled tri-state: true/false/'true'/'false'/'1'/'0'
	if rm, ok := raw["disabled"]; ok {
		var b bool
		if json.Unmarshal(rm, &b) == nil {
			req.Disabled = &b
		} else {
			var s string
			if json.Unmarshal(rm, &s) == nil {
				switch strings.ToLower(strings.TrimSpace(s)) {
				case "true", "1":
					t := true
					req.Disabled = &t
				case "false", "0":
					f := false
					req.Disabled = &f
				}
			}
		}
	}
	if req.Limit < 0 {
		req.Limit = 0
	}
	if req.Limit > 200000 {
		req.Limit = 200000
	}
	return req, nil
}

// Match reports whether a remote auth-file passes the filters.
// Provider matches exact-or-substring against provider||type, lowercased.
func (f ExportFilters) Match(m cpa.AuthMeta) bool {
	if f.Provider != "" {
		p := strings.ToLower(m.Provider)
		if p == "" {
			p = strings.ToLower(m.Type)
		}
		needle := strings.ToLower(f.Provider)
		if p != needle && !strings.Contains(p, needle) {
			return false
		}
	}
	if f.EmailContains != "" && !strings.Contains(strings.ToLower(m.Email), strings.ToLower(f.EmailContains)) {
		return false
	}
	if f.NameContains != "" && !strings.Contains(strings.ToLower(m.Name), strings.ToLower(f.NameContains)) {
		return false
	}
	if f.Disabled != nil && m.Disabled != *f.Disabled {
		return false
	}
	return true
}

// Apply filters the list and applies the limit (after filtering).
func (f ExportFilters) Apply(list []cpa.AuthMeta) []cpa.AuthMeta {
	var out []cpa.AuthMeta
	for _, m := range list {
		if !strings.HasSuffix(strings.ToLower(m.Name), ".json") {
			continue
		}
		if f.Match(m) {
			out = append(out, m)
		}
	}
	if f.Limit > 0 && len(out) > f.Limit {
		out = out[:f.Limit]
	}
	return out
}

// ProviderStat is one provider's count entry.
type ProviderStat struct {
	Provider string `json:"provider"`
	Count    int    `json:"count"`
}

// providerStats counts per lowercase provider, sorted desc.
func providerStats(list []cpa.AuthMeta) []ProviderStat {
	m := map[string]int{}
	for _, meta := range list {
		p := strings.ToLower(meta.Provider)
		if p == "" {
			p = strings.ToLower(meta.Type)
		}
		if p == "" {
			p = "unknown"
		}
		m[p]++
	}
	out := make([]ProviderStat, 0, len(m))
	for p, c := range m {
		out = append(out, ProviderStat{Provider: p, Count: c})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Count > out[j].Count })
	return out
}
