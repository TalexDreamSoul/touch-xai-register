// Package jobs provides a generic in-memory background job framework:
// job state machine, worker pools, SSE fan-out, and TTL-based pruning.
// It backs the transfer (upload/export) features of the panel.
package jobs

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

// Status is the lifecycle state of a Job.
type Status string

const (
	StatusQueued    Status = "queued"
	StatusRunning   Status = "running"
	StatusCompleted Status = "completed"
	StatusCancelled Status = "cancelled"
)

// ItemStatus is the per-file state within a job.
type ItemStatus string

const (
	ItemPending ItemStatus = "pending"
	ItemRunning ItemStatus = "running"
	ItemSuccess ItemStatus = "success"
	ItemFailed  ItemStatus = "failed"
	ItemSkipped ItemStatus = "skipped"
)

// Item is one unit of work (usually one credential file).
// Content is deliberately excluded from JSON summaries.
type Item struct {
	ID         int               `json:"id"`
	Name       string            `json:"name"`
	Size       int64             `json:"size"`
	Status     ItemStatus        `json:"status"`
	Attempts   int               `json:"attempts"`
	Error      string            `json:"error,omitempty"`
	StartedAt  *time.Time        `json:"startedAt,omitempty"`
	FinishedAt *time.Time        `json:"finishedAt,omitempty"`
	Preview    map[string]string `json:"preview,omitempty"`
	FromCache  bool              `json:"fromCache,omitempty"`

	Content []byte `json:"-"`
}

// Job is a background task with items, a log ring, and SSE listeners.
type Job struct {
	ID         string     `json:"id"`
	Kind       string     `json:"kind"` // upload | export
	Status     Status     `json:"status"`
	CreatedAt  time.Time  `json:"createdAt"`
	StartedAt  *time.Time `json:"startedAt,omitempty"`
	FinishedAt *time.Time `json:"finishedAt,omitempty"`

	mu        sync.Mutex
	items     []*Item
	logs      []string
	logCap    int
	listeners map[chan []byte]struct{}
	cancel    context.CancelFunc
	ctx       context.Context
}

// NewJob creates a queued job with its own cancellable context.
func NewJob(kind string, items []*Item) *Job {
	ctx, cancel := context.WithCancel(context.Background())
	return &Job{
		ID:        newID(kind),
		Kind:      kind,
		Status:    StatusQueued,
		CreatedAt: time.Now(),
		items:     items,
		logCap:    300,
		listeners: map[chan []byte]struct{}{},
		cancel:    cancel,
		ctx:       ctx,
	}
}

func newID(prefix string) string {
	var b [4]byte
	_, _ = rand.Read(b[:])
	return fmt.Sprintf("%s_%x_%s", prefix, time.Now().UnixMilli(), hex.EncodeToString(b[:]))
}

// Context returns the job's context (cancelled on Cancel).
func (j *Job) Context() context.Context { return j.ctx }

// Cancel marks the job cancelled and aborts in-flight work.
func (j *Job) Cancel() {
	j.mu.Lock()
	if j.Status == StatusQueued || j.Status == StatusRunning {
		j.Status = StatusCancelled
		now := time.Now()
		j.FinishedAt = &now
	}
	j.mu.Unlock()
	j.cancel()
}

// Done reports whether the job reached a terminal state.
func (j *Job) Done() bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.Status == StatusCompleted || j.Status == StatusCancelled
}

// SetStatus transitions the job state, stamping timestamps.
func (j *Job) SetStatus(s Status) {
	j.mu.Lock()
	defer j.mu.Unlock()
	now := time.Now()
	switch s {
	case StatusRunning:
		if j.StartedAt == nil {
			j.StartedAt = &now
		}
	case StatusCompleted, StatusCancelled:
		j.FinishedAt = &now
	}
	j.Status = s
}

// GetStatus returns the current status.
func (j *Job) GetStatus() Status {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.Status
}

// Items returns a snapshot slice of item pointers (callers must treat the
// pointed-to items as read-only unless holding the job lock via WithItems).
func (j *Job) Items() []*Item {
	j.mu.Lock()
	defer j.mu.Unlock()
	out := make([]*Item, len(j.items))
	copy(out, j.items)
	return out
}

// WithItems runs fn while holding the job lock, allowing safe item mutation.
func (j *Job) WithItems(fn func(items []*Item)) {
	j.mu.Lock()
	defer j.mu.Unlock()
	fn(j.items)
}

// MutateItem applies fn to item i under the job lock.
func (j *Job) MutateItem(i int, fn func(*Item)) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if i >= 0 && i < len(j.items) {
		fn(j.items[i])
	}
}

// ItemValues returns a deep-enough copy of all items (value semantics) safe
// to marshal without holding the lock. Content is stripped.
func (j *Job) ItemValues() []Item {
	j.mu.Lock()
	defer j.mu.Unlock()
	out := make([]Item, len(j.items))
	for i, it := range j.items {
		v := *it
		v.Content = nil
		out[i] = v
	}
	return out
}

// Logs returns a copy of the log ring.
func (j *Job) Logs() []string {
	j.mu.Lock()
	defer j.mu.Unlock()
	out := make([]string, len(j.logs))
	copy(out, j.logs)
	return out
}

// AddLog appends a line to the log ring (capped at logCap).
func (j *Job) AddLog(format string, args ...any) {
	line := fmt.Sprintf(format, args...)
	j.mu.Lock()
	j.logs = append(j.logs, line)
	if len(j.logs) > j.logCap {
		j.logs = j.logs[len(j.logs)-j.logCap:]
	}
	j.mu.Unlock()
}

// SetLogCap changes the ring capacity (export jobs use 400).
func (j *Job) SetLogCap(n int) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.logCap = n
}

// Broadcast marshals v and pushes it to all SSE listeners.
// Slow listeners (buffer full) are skipped — they will catch up on the next
// frame; SSE clients always receive the latest full summary anyway.
func (j *Job) Broadcast(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	for ch := range j.listeners {
		select {
		case ch <- b:
		default:
		}
	}
}

// Subscribe registers an SSE listener; the returned channel first receives
// nothing — the caller should send an initial snapshot itself.
func (j *Job) Subscribe() chan []byte {
	ch := make(chan []byte, 16)
	j.mu.Lock()
	j.listeners[ch] = struct{}{}
	j.mu.Unlock()
	return ch
}

// Unsubscribe removes a listener.
func (j *Job) Unsubscribe(ch chan []byte) {
	j.mu.Lock()
	delete(j.listeners, ch)
	j.mu.Unlock()
}

// Manager tracks jobs of one kind with insertion order and TTL pruning.
type Manager struct {
	kind  string
	ttl   time.Duration
	mu    sync.RWMutex
	jobs  map[string]*Job
	order []string // oldest → newest
}

// NewManager creates a manager; ttl controls when finished jobs are pruned.
func NewManager(kind string, ttl time.Duration) *Manager {
	return &Manager{kind: kind, ttl: ttl, jobs: map[string]*Job{}}
}

// Add registers a job.
func (m *Manager) Add(j *Job) {
	m.mu.Lock()
	m.jobs[j.ID] = j
	m.order = append(m.order, j.ID)
	m.mu.Unlock()
}

// Get returns a job by ID.
func (m *Manager) Get(id string) (*Job, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	j, ok := m.jobs[id]
	return j, ok
}

// List returns up to limit newest jobs (newest first).
func (m *Manager) List(limit int) []*Job {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var out []*Job
	for i := len(m.order) - 1; i >= 0 && (limit <= 0 || len(out) < limit); i-- {
		out = append(out, m.jobs[m.order[i]])
	}
	return out
}

// Running returns the first running job, if any.
func (m *Manager) Running() *Job {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, id := range m.order {
		if m.jobs[id].GetStatus() == StatusRunning {
			return m.jobs[id]
		}
	}
	return nil
}

// Counts returns (total, running) job counts for health reporting.
func (m *Manager) Counts() (int, int) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	running := 0
	for _, j := range m.jobs {
		if j.GetStatus() == StatusRunning {
			running++
		}
	}
	return len(m.jobs), running
}

// CancelAll cancels every running/queued job (graceful shutdown).
func (m *Manager) CancelAll() {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, j := range m.jobs {
		if !j.Done() {
			j.Cancel()
		}
	}
}

// Prune removes finished jobs older than the manager TTL.
// In-memory index only — on-disk artifacts (zips, manifests) are kept.
func (m *Manager) Prune() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	cutoff := time.Now().Add(-m.ttl)
	removed := 0
	kept := m.order[:0]
	for _, id := range m.order {
		j := m.jobs[id]
		if j.Done() && j.FinishedAt != nil && j.FinishedAt.Before(cutoff) {
			delete(m.jobs, id)
			removed++
			continue
		}
		kept = append(kept, id)
	}
	m.order = kept
	return removed
}

// StartPruner runs Prune on an interval until ctx is done.
func (m *Manager) StartPruner(ctx context.Context, interval time.Duration) {
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				m.Prune()
			}
		}
	}()
}

// RunPool executes fn(i) for i in [0,total) with at most workers goroutines,
// using a shared atomic cursor. It returns early when ctx is cancelled.
func RunPool(ctx context.Context, total, workers int, fn func(i int)) {
	if workers < 1 {
		workers = 1
	}
	if workers > total {
		workers = total
	}
	var cursor atomic.Int64
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				if ctx.Err() != nil {
					return
				}
				i := int(cursor.Add(1) - 1)
				if i >= total {
					return
				}
				fn(i)
			}
		}()
	}
	wg.Wait()
}
