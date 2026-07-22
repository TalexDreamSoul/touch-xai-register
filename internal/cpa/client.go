package cpa

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// AuthMeta is the slimmed metadata of one remote auth-file, mirroring the
// fields exposed by CLIProxyAPI's GET /v0/management/auth-files listing.
type AuthMeta struct {
	Name          string `json:"name"`
	Provider      string `json:"provider"`
	Type          string `json:"type,omitempty"`
	Status        string `json:"status,omitempty"`
	StatusMessage string `json:"status_message,omitempty"`
	Email         string `json:"email,omitempty"`
	Disabled      bool   `json:"disabled"`
	Size          int64  `json:"size,omitempty"`
	Success       int64  `json:"success,omitempty"`
	Failed        int64  `json:"failed,omitempty"`
}

// Client is a general-purpose CPA Management API client (list / download /
// delete / debug), complementing Uploader which is upload-focused.
type Client struct {
	up *Uploader
}

// NewClient builds a Client for the given Management base URL and key.
// baseURL may omit /v0/management — it is normalized like uploads.
func NewClient(baseURL, key string, timeoutSec int) *Client {
	cfg := DefaultUploadConfig()
	cfg.Enabled = true
	cfg.BaseURL = baseURL
	cfg.Key = key
	if timeoutSec > 0 {
		cfg.TimeoutSec = timeoutSec
	}
	return &Client{up: NewUploader(cfg, nil)}
}

// Debug probes GET /debug with a short timeout; returns the HTTP status.
func (c *Client) Debug() (int, string, error) {
	ep := strings.TrimRight(c.up.cfg.BaseURL, "/") + "/debug"
	req, err := http.NewRequest(http.MethodGet, ep, nil)
	if err != nil {
		return 0, "", err
	}
	c.up.authHeaders(req)
	resp, err := c.up.client.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return resp.StatusCode, string(b), nil
}

// List fetches and parses the remote auth-files metadata list.
// Tolerates both {"files":[...]} and bare-array responses, and entries that
// are plain strings (names only).
func (c *Client) List() ([]AuthMeta, error) {
	req, err := http.NewRequest(http.MethodGet, c.up.endpoint(), nil)
	if err != nil {
		return nil, err
	}
	c.up.authHeaders(req)
	resp, err := c.up.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 256<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("list status=%d body=%s", resp.StatusCode, truncate(string(b), 200))
	}
	return parseAuthList(b), nil
}

func parseAuthList(b []byte) []AuthMeta {
	var raw []json.RawMessage
	var wrapped struct {
		Files []json.RawMessage `json:"files"`
	}
	if err := json.Unmarshal(b, &wrapped); err == nil && wrapped.Files != nil {
		raw = wrapped.Files
	} else if err := json.Unmarshal(b, &raw); err != nil {
		return nil
	}
	out := make([]AuthMeta, 0, len(raw))
	for _, r := range raw {
		// entry may be a plain name string
		var name string
		if err := json.Unmarshal(r, &name); err == nil {
			if meta := slimName(name); meta.Name != "" {
				out = append(out, meta)
			}
			continue
		}
		var m map[string]any
		if err := json.Unmarshal(r, &m); err != nil {
			continue
		}
		out = append(out, slimMeta(m))
	}
	return out
}

func strField(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

func numField(m map[string]any, keys ...string) int64 {
	for _, k := range keys {
		switch v := m[k].(type) {
		case float64:
			return int64(v)
		case int64:
			return v
		}
	}
	return 0
}

func slimMeta(m map[string]any) AuthMeta {
	meta := AuthMeta{
		Name:     strField(m, "name", "id"),
		Provider: strField(m, "provider", "type"),
		Type:     strField(m, "type"),
		Status:   strField(m, "status"),
		Email:    strField(m, "email", "account"),
		Size:     numField(m, "size"),
		Success:  numField(m, "success"),
		Failed:   numField(m, "failed"),
	}
	// status_message may be a string or a structured object from CPA.
	if v, ok := m["status_message"].(string); ok {
		meta.StatusMessage = v
	} else if raw, ok := m["status_message"]; ok && raw != nil {
		if b, err := json.Marshal(raw); err == nil {
			meta.StatusMessage = string(b)
		}
	}
	if meta.StatusMessage == "" {
		meta.StatusMessage = strField(m, "error", "message", "detail")
	}
	if v, ok := m["disabled"].(bool); ok {
		meta.Disabled = v
	}
	return meta
}

// IsQuotaExhausted reports free-usage / quota exhaustion (not transient 429 alone).
func IsQuotaExhausted(status, statusMessage string) bool {
	blob := strings.ToLower(status + " " + statusMessage)
	if blob == "" {
		return false
	}
	markers := []string{
		"free-usage-exhausted",
		"usage-exhausted",
		"subscription:free-usage-exhausted",
		"used all the included free usage",
		"you've used all the included free usage",
		"quota exhausted",
		"quota_exceeded",
		"insufficient_quota",
	}
	for _, m := range markers {
		if strings.Contains(blob, m) {
			return true
		}
	}
	return false
}

// IsTransientRateLimit reports temporary rate limiting that may recover.
func IsTransientRateLimit(status, statusMessage string) bool {
	if IsQuotaExhausted(status, statusMessage) {
		return false
	}
	blob := strings.ToLower(status + " " + statusMessage)
	return strings.Contains(blob, "429") ||
		strings.Contains(blob, "rate limit") ||
		strings.Contains(blob, "rate_limited") ||
		strings.Contains(blob, "too many requests")
}

func slimName(name string) AuthMeta {
	name = strings.TrimSpace(name)
	if name == "" || !strings.HasSuffix(strings.ToLower(name), ".json") {
		return AuthMeta{}
	}
	return AuthMeta{Name: name}
}

// Download fetches one auth-file's raw JSON bytes.
func (c *Client) Download(name string) ([]byte, error) {
	if !strings.HasSuffix(strings.ToLower(name), ".json") {
		return nil, fmt.Errorf("invalid auth-file name %q", name)
	}
	ep := c.up.endpoint() + "/download?name=" + url.QueryEscape(name)
	req, err := http.NewRequest(http.MethodGet, ep, nil)
	if err != nil {
		return nil, err
	}
	c.up.authHeaders(req)
	resp, err := c.up.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("download %s status=%d body=%s", name, resp.StatusCode, truncate(string(b), 200))
	}
	return b, nil
}

// Delete removes one remote auth-file.
func (c *Client) Delete(name string) error {
	ep := c.up.endpoint() + "?name=" + url.QueryEscape(name)
	req, err := http.NewRequest(http.MethodDelete, ep, nil)
	if err != nil {
		return err
	}
	c.up.authHeaders(req)
	resp, err := c.up.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return fmt.Errorf("delete %s status=%d body=%s", name, resp.StatusCode, truncate(string(b), 200))
	}
	return nil
}
