package transfer

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/grok-free-register/grok-reg/internal/jobs"
)

// Limits mirrored from the Node cpa-uploader.
const (
	maxPrepareFiles   = 200
	maxPrepareFileSz  = 80 << 20 // 80 MB per file
	maxPrepareTotalSz = 512 << 20
)

// candidate is one parsed credential ready to become a job item.
type candidate struct {
	Name    string
	Content []byte // canonical re-stringified JSON
	Preview map[string]string
}

// credentialHintKeys mark a JSON object as looking like an auth file.
var credentialHintKeys = []string{
	"access_token", "refresh_token", "id_token", "api_key",
	"email", "account", "type", "provider", "token",
}

// isCredentialJSONName reports whether a zip entry / filename is acceptable.
func isCredentialJSONName(name string) bool {
	base := filepath.Base(name)
	if strings.HasPrefix(base, ".") || strings.Contains(name, "__MACOSX") {
		return false
	}
	return strings.HasSuffix(strings.ToLower(base), ".json")
}

// safeBasename keeps basename and maps exotic chars to '_'.
func safeBasename(name string) string {
	base := filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			return r
		case r == '.', r == '-', r == '_', r == '@', r == '+':
			return r
		}
		return '_'
	}, base)
}

// parseCredential validates and canonicalizes one credential buffer.
// Non-JSON or empty payloads are rejected; JSON objects missing hint keys
// are still allowed (mirrors the Node heuristic).
func parseCredential(raw []byte, fallbackName string) (candidate, error) {
	raw = bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf")) // strip BOM
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil {
		return candidate{}, fmt.Errorf("不是有效 JSON: %v", err)
	}
	name := safeBasename(fallbackName)
	if v, ok := obj["email"].(string); ok && v != "" && fallbackName == "" {
		name = safeBasename(v)
	}
	if !strings.HasSuffix(strings.ToLower(name), ".json") {
		name += ".json"
	}
	canon, err := json.Marshal(obj)
	if err != nil {
		return candidate{}, err
	}
	preview := map[string]string{}
	for _, k := range []string{"email", "account"} {
		if v, ok := obj[k].(string); ok && v != "" {
			preview["email"] = v
			break
		}
	}
	for _, k := range []string{"type", "provider", "account_type"} {
		if v, ok := obj[k].(string); ok && v != "" {
			preview["type"] = v
			break
		}
	}
	return candidate{Name: name, Content: canon, Preview: preview}, nil
}

// looksLikeCredential reports whether obj carries any hint key.
func looksLikeCredential(obj map[string]any) bool {
	for _, k := range credentialHintKeys {
		if _, ok := obj[k]; ok {
			return true
		}
	}
	return false
}

// fromZip extracts credential candidates from a zip archive,
// flattening entry paths to basenames (zip-slip safe).
func fromZip(data []byte) ([]candidate, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("zip 解析失败: %v", err)
	}
	var out []candidate
	var errs []string
	for _, f := range zr.File {
		if f.FileInfo().IsDir() || !isCredentialJSONName(f.Name) {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", f.Name, err))
			continue
		}
		b, err := io.ReadAll(io.LimitReader(rc, maxPrepareFileSz))
		rc.Close()
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", f.Name, err))
			continue
		}
		c, err := parseCredential(b, filepath.Base(f.Name))
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", filepath.Base(f.Name), err))
			continue
		}
		out = append(out, c)
	}
	if len(out) == 0 && len(errs) > 0 {
		return nil, fmt.Errorf("zip 内无可用凭证: %s", strings.Join(errs, "; "))
	}
	return out, nil
}

// fromFolder walks a server-local directory for *.json credentials.
func fromFolder(dir string) ([]candidate, error) {
	dir = filepath.Clean(dir)
	st, err := os.Stat(dir)
	if err != nil || !st.IsDir() {
		return nil, fmt.Errorf("目录不存在或不可读: %s", dir)
	}
	var out []candidate
	var errs []string
	err = filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil // skip unreadable entries
		}
		if d.IsDir() {
			switch d.Name() {
			case "node_modules", ".git", "__MACOSX":
				return filepath.SkipDir
			}
			return nil
		}
		if !isCredentialJSONName(d.Name()) {
			return nil
		}
		b, err := os.ReadFile(path)
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", d.Name(), err))
			return nil
		}
		c, err := parseCredential(b, d.Name())
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", d.Name(), err))
			return nil
		}
		out = append(out, c)
		return nil
	})
	if err != nil {
		return nil, err
	}
	if len(out) == 0 {
		if len(errs) > 0 {
			return nil, fmt.Errorf("目录内无可用凭证: %s", strings.Join(errs[:min(3, len(errs))], "; "))
		}
		return nil, fmt.Errorf("目录内没有 .json 凭证文件: %s", dir)
	}
	return out, nil
}

// fromRawJSON parses pasted JSON (single object or array of objects).
func fromRawJSON(text string) ([]candidate, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, nil
	}
	raw := []byte(strings.TrimPrefix(text, "\xef\xbb\xbf"))
	var arr []map[string]any
	if err := json.Unmarshal(raw, &arr); err == nil {
		var out []candidate
		for i, obj := range arr {
			b, _ := json.Marshal(obj)
			c, err := parseCredential(b, fmt.Sprintf("pasted-%d.json", i+1))
			if err != nil {
				return nil, fmt.Errorf("第 %d 项: %v", i+1, err)
			}
			out = append(out, c)
		}
		return out, nil
	}
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil {
		return nil, fmt.Errorf("粘贴内容不是有效 JSON: %v", err)
	}
	name := "pasted-1.json"
	if v, ok := obj["email"].(string); ok && v != "" {
		name = v
	}
	c, err := parseCredential(raw, name)
	if err != nil {
		return nil, err
	}
	return []candidate{c}, nil
}

// dedupeCandidates merges sources, last one wins per lowercase name.
func dedupeCandidates(in []candidate) []candidate {
	idx := map[string]int{}
	var out []candidate
	for _, c := range in {
		k := strings.ToLower(c.Name)
		if i, ok := idx[k]; ok {
			out[i] = c
			continue
		}
		idx[k] = len(out)
		out = append(out, c)
	}
	return out
}

// toItems converts candidates to job items.
func toItems(cands []candidate) []*jobs.Item {
	items := make([]*jobs.Item, 0, len(cands))
	for i, c := range cands {
		items = append(items, &jobs.Item{
			ID:      i + 1,
			Name:    c.Name,
			Size:    int64(len(c.Content)),
			Status:  jobs.ItemPending,
			Preview: c.Preview,
			Content: c.Content,
		})
	}
	return items
}
