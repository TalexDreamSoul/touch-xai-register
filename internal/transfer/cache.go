package transfer

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

// cacheMaxEntries caps the on-disk upload cache; oldest entries are evicted.
const cacheMaxEntries = 20000

// CacheEntry records one successful upload for dedup.
type CacheEntry struct {
	Name       string    `json:"name"`
	Hash       string    `json:"hash"`
	BaseURL    string    `json:"baseUrl"`
	Email      string    `json:"email,omitempty"`
	Type       string    `json:"type,omitempty"`
	Size       int64     `json:"size"`
	UploadedAt time.Time `json:"uploadedAt"`
}

// UploadCache is a disk-backed content-hash dedup store.
// Key format (compatible with the Node cpa-uploader):
//
//	normalizeBaseURL(baseUrl) + "::" + lower(name) + "::" + sha256hex(content)
type UploadCache struct {
	mu      sync.Mutex
	path    string
	entries map[string]CacheEntry
	timer   *time.Timer
}

// LoadUploadCache reads the cache file (missing/corrupt → empty cache).
func LoadUploadCache(path string) *UploadCache {
	c := &UploadCache{path: path, entries: map[string]CacheEntry{}}
	b, err := os.ReadFile(path)
	if err != nil {
		return c
	}
	var m map[string]CacheEntry
	if json.Unmarshal(b, &m) == nil && m != nil {
		c.entries = m
	}
	return c
}

// NormalizeBaseURL strips trailing slashes (mirrors Node normalizeBaseUrl).
func NormalizeBaseURL(u string) string {
	return strings.TrimRight(strings.TrimSpace(u), "/")
}

// CacheKey builds the dedup key for a piece of content.
func CacheKey(baseURL, name string, content []byte) string {
	sum := sha256.Sum256(content)
	return NormalizeBaseURL(baseURL) + "::" + strings.ToLower(name) + "::" + hex.EncodeToString(sum[:])
}

// Has reports whether the key was successfully uploaded before.
func (c *UploadCache) Has(key string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	_, ok := c.entries[key]
	return ok
}

// Remember records a successful upload and schedules a debounced save.
func (c *UploadCache) Remember(key string, e CacheEntry) {
	c.mu.Lock()
	c.entries[key] = e
	if len(c.entries) > cacheMaxEntries {
		c.evictOldestLocked(len(c.entries) - cacheMaxEntries)
	}
	if c.timer != nil {
		c.timer.Stop()
	}
	c.timer = time.AfterFunc(400*time.Millisecond, c.save)
	c.mu.Unlock()
}

// Flush forces an immediate save (used on shutdown).
func (c *UploadCache) Flush() {
	c.mu.Lock()
	if c.timer != nil {
		c.timer.Stop()
		c.timer = nil
	}
	c.mu.Unlock()
	c.save()
}

func (c *UploadCache) evictOldestLocked(n int) {
	type kv struct {
		k string
		t time.Time
	}
	all := make([]kv, 0, len(c.entries))
	for k, e := range c.entries {
		all = append(all, kv{k, e.UploadedAt})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].t.Before(all[j].t) })
	for i := 0; i < n && i < len(all); i++ {
		delete(c.entries, all[i].k)
	}
}

func (c *UploadCache) save() {
	c.mu.Lock()
	defer c.mu.Unlock()
	b, err := json.MarshalIndent(c.entries, "", "  ")
	if err != nil {
		return
	}
	tmp := c.path + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, c.path)
	}
}

// Summary returns the total count and a sample of the newest entries.
func (c *UploadCache) Summary(sample int) (int, []CacheEntry) {
	c.mu.Lock()
	defer c.mu.Unlock()
	all := make([]CacheEntry, 0, len(c.entries))
	for _, e := range c.entries {
		all = append(all, e)
	}
	sort.Slice(all, func(i, j int) bool { return all[i].UploadedAt.After(all[j].UploadedAt) })
	if sample > 0 && len(all) > sample {
		all = all[:sample]
	}
	return len(c.entries), all
}

// Delete removes entries by exact item name or key substring; empty name clears all.
func (c *UploadCache) Delete(name string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	if name == "" {
		n := len(c.entries)
		c.entries = map[string]CacheEntry{}
		return n
	}
	needle := "::" + strings.ToLower(name) + "::"
	removed := 0
	for k, e := range c.entries {
		if e.Name == name || strings.Contains(k, needle) {
			delete(c.entries, k)
			removed++
		}
	}
	return removed
}
