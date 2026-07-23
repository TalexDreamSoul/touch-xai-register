package localpool

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/grok-free-register/grok-reg/internal/cpa"
)

// Entry is one credential in the local pool index.
type Entry struct {
	Name       string    `json:"name"`
	Email      string    `json:"email,omitempty"`
	SourceRun  string    `json:"source_run,omitempty"`
	Hash       string    `json:"hash"`
	Size       int64     `json:"size"`
	AddedAt    time.Time `json:"added_at"`
	SyncedAt   *time.Time `json:"synced_at,omitempty"`
	SyncError  string    `json:"sync_error,omitempty"`
	SyncTarget string    `json:"sync_target,omitempty"` // cpa base or master url
}

// Index is persisted next to credential files.
type Index struct {
	Version int               `json:"version"`
	Items   map[string]*Entry `json:"items"` // key = name
}

// Service manages GROK_HOME/local-pool credentials.
type Service struct {
	dir   string
	mu    sync.Mutex
	index Index
}

func New(dir string) *Service {
	s := &Service{dir: dir, index: Index{Version: 1, Items: map[string]*Entry{}}}
	s.load()
	return s
}

func (s *Service) Dir() string { return s.dir }

func (s *Service) load() {
	_ = os.MkdirAll(s.dir, 0o700)
	b, err := os.ReadFile(s.indexPath())
	if err != nil {
		return
	}
	var idx Index
	if json.Unmarshal(b, &idx) == nil && idx.Items != nil {
		s.index = idx
	}
	if s.index.Items == nil {
		s.index.Items = map[string]*Entry{}
	}
}

func (s *Service) saveLocked() error {
	_ = os.MkdirAll(s.dir, 0o700)
	b, err := json.MarshalIndent(s.index, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.indexPath(), append(b, '\n'), 0o600)
}

func (s *Service) indexPath() string {
	return filepath.Join(s.dir, "index.json")
}

// List returns newest-first entries.
func (s *Service) List() []Entry {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Entry, 0, len(s.index.Items))
	for _, e := range s.index.Items {
		if e != nil {
			out = append(out, *e)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].AddedAt.After(out[j].AddedAt)
	})
	return out
}

// Stats returns counts.
func (s *Service) Stats() (total, unsynced int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, e := range s.index.Items {
		if e == nil {
			continue
		}
		total++
		if e.SyncedAt == nil {
			unsynced++
		}
	}
	return total, unsynced
}

// ImportRun copies CPA json from a run directory into the local pool.
// Returns number added (new or updated).
func (s *Service) ImportRun(runDir string) (added int, entries []Entry, err error) {
	files, err := cpa.CollectCPAJSON(runDir)
	if err != nil {
		// empty CPA dir is fine
		if os.IsNotExist(err) {
			return 0, nil, nil
		}
		return 0, nil, err
	}
	runID := filepath.Base(runDir)
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = os.MkdirAll(s.dir, 0o700)
	for _, src := range files {
		raw, err := os.ReadFile(src)
		if err != nil {
			continue
		}
		name := filepath.Base(src)
		sum := sha256.Sum256(raw)
		hash := hex.EncodeToString(sum[:])
		email := ""
		var doc map[string]any
		if json.Unmarshal(raw, &doc) == nil {
			if v, ok := doc["email"].(string); ok {
				email = v
			}
		}
		dest := filepath.Join(s.dir, name)
		// skip identical content
		if prev, ok := s.index.Items[name]; ok && prev != nil && prev.Hash == hash {
			// still refresh source run
			prev.SourceRun = runID
			continue
		}
		tmp := dest + ".tmp"
		if err := os.WriteFile(tmp, raw, 0o600); err != nil {
			continue
		}
		if err := os.Rename(tmp, dest); err != nil {
			_ = os.Remove(tmp)
			continue
		}
		e := &Entry{
			Name:      name,
			Email:     email,
			SourceRun: runID,
			Hash:      hash,
			Size:      int64(len(raw)),
			AddedAt:   time.Now().UTC(),
		}
		// keep previous sync state if same name but re-imported content changed → mark unsynced
		s.index.Items[name] = e
		added++
		entries = append(entries, *e)
	}
	if err := s.saveLocked(); err != nil {
		return added, entries, err
	}
	return added, entries, nil
}

// ImportLatest scans newest run dirs until it finds CPA files (or limit).
func (s *Service) ImportLatest(outputsDir string, lookback int) (runID string, added int, entries []Entry, err error) {
	dirs, err := cpa.ListRunDirs(outputsDir, lookback)
	if err != nil {
		return "", 0, nil, err
	}
	for _, d := range dirs {
		n, ents, err := s.ImportRun(d)
		if err != nil {
			return filepath.Base(d), 0, nil, err
		}
		if n > 0 || len(ents) > 0 {
			return filepath.Base(d), n, ents, nil
		}
		// also return if run has files already in pool
		files, _ := cpa.CollectCPAJSON(d)
		if len(files) > 0 {
			return filepath.Base(d), n, ents, nil
		}
	}
	return "", 0, nil, nil
}

// PathFor returns absolute path for a pool entry name.
func (s *Service) PathFor(name string) (string, error) {
	name = filepath.Base(strings.TrimSpace(name))
	if name == "" || strings.Contains(name, "..") {
		return "", fmt.Errorf("invalid name")
	}
	p := filepath.Join(s.dir, name)
	if _, err := os.Stat(p); err != nil {
		return "", err
	}
	return p, nil
}

// MarkSynced updates sync metadata for names.
func (s *Service) MarkSynced(names []string, target string, syncErr error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UTC()
	for _, name := range names {
		e := s.index.Items[filepath.Base(name)]
		if e == nil {
			continue
		}
		if syncErr != nil {
			e.SyncError = syncErr.Error()
			continue
		}
		e.SyncedAt = &now
		e.SyncError = ""
		e.SyncTarget = target
	}
	return s.saveLocked()
}

// UnsyncedPaths returns file paths not yet synced (or failed).
func (s *Service) UnsyncedPaths() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for name, e := range s.index.Items {
		if e == nil {
			continue
		}
		if e.SyncedAt == nil {
			out = append(out, filepath.Join(s.dir, name))
		}
	}
	sort.Strings(out)
	return out
}

// AllPaths returns all credential paths.
func (s *Service) AllPaths() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for name := range s.index.Items {
		out = append(out, filepath.Join(s.dir, name))
	}
	sort.Strings(out)
	return out
}
