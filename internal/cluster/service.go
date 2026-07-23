package cluster

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/grok-free-register/grok-reg/internal/config"
)

const (
	RoleStandalone = "standalone"
	RoleMaster     = "master"
	RoleSlave      = "slave"

	nodeStaleAfter = 90 * time.Second
)

// PoolSnapshot is the master's live CPA pool picture for federation.
type PoolSnapshot struct {
	Healthy      int `json:"healthy"`
	RateLimited  int `json:"rate_limited"`
	Dead         int `json:"dead"`
	Disabled     int `json:"disabled"`
	Total        int `json:"total"`
	QuotaEstimate int `json:"quota_estimate"`
}

// Node is a connected slave as seen by the master.
type Node struct {
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	LastSeen      time.Time `json:"last_seen"`
	Online        bool      `json:"online"`
	Busy          bool      `json:"busy"`
	Capacity      int       `json:"capacity"` // max concurrent target it accepts (1-10)
	RunningTarget int       `json:"running_target"`
	Assigned      int       `json:"assigned"`
	Completed     int       `json:"completed_total"`
	LastError     string    `json:"last_error,omitempty"`
	RemoteAddr    string    `json:"remote_addr,omitempty"`
	Version       string    `json:"version,omitempty"`
}

// HeartbeatRequest is what a slave posts to the master.
type HeartbeatRequest struct {
	NodeID        string `json:"node_id"`
	Name          string `json:"name"`
	Capacity      int   `json:"capacity"`
	Busy          bool  `json:"busy"`
	RunningTarget int   `json:"running_target"`
	Completed     int   `json:"completed_total"`
	LastError     string `json:"last_error,omitempty"`
	Version       string `json:"version,omitempty"`
	Token         string `json:"token,omitempty"`
}

// HeartbeatResponse is the master's assignment reply.
type HeartbeatResponse struct {
	OK            bool         `json:"ok"`
	MasterName    string       `json:"master_name"`
	Role          string       `json:"role"`
	Need          int          `json:"need"`
	Assign        int          `json:"assign"` // 0 or 1..10
	PoolTarget    int          `json:"pool_target"`
	Pool          PoolSnapshot `json:"pool"`
	AssignMin     int          `json:"assign_min"`
	AssignMax     int          `json:"assign_max"`
	Message       string       `json:"message,omitempty"`
	ServerTime    string       `json:"server_time"`
}

// PublicInfo is federation advertisement (slave↔master), gated by ClusterPublicToken.
type PublicInfo struct {
	OK           bool         `json:"ok"`
	Service      string       `json:"service"`
	Role         string       `json:"role"`
	Name         string       `json:"name"`
	AuthRequired bool         `json:"auth_required"`
	PoolTarget   int          `json:"pool_target"`
	Need         int          `json:"need"`
	NeedAccounts bool         `json:"need_accounts"`
	Pool         PoolSnapshot `json:"pool"`
	AssignMin    int          `json:"assign_min"`
	AssignMax    int          `json:"assign_max"`
	SlavesOnline   int          `json:"slaves_online"`
	SlavesTotal    int          `json:"slaves_total"`
	SharePoolList  bool         `json:"share_pool_list"`
	SharePoolPull  bool         `json:"share_pool_pull"`
	Time           string       `json:"time"`
}

// StatusPage is the human-facing public status board (gated by ClusterStatusPassword).
type StatusPage struct {
	OK              bool         `json:"ok"`
	Service         string       `json:"service"`
	Role            string       `json:"role"`
	Name            string       `json:"name"`
	AuthRequired    bool         `json:"auth_required"`
	PoolTarget      int          `json:"pool_target"`
	Need            int          `json:"need"`
	NeedAccounts    bool         `json:"need_accounts"`
	Pool            PoolSnapshot `json:"pool"`
	SlavesOnline    int          `json:"slaves_online"`
	SlavesTotal     int          `json:"slaves_total"`
	Slaves          []Node       `json:"slaves,omitempty"`
	Time            string       `json:"time"`
}

// ReportRequest is optional progress from a slave after finishing a batch.
type ReportRequest struct {
	NodeID    string `json:"node_id"`
	Name      string `json:"name"`
	Completed int    `json:"completed"` // this batch
	Uploaded  int    `json:"uploaded"`
	Failed    int    `json:"failed"`
	Token     string `json:"token,omitempty"`
	Message   string `json:"message,omitempty"`
}

// Status is the admin panel snapshot.
type Status struct {
	Role              string       `json:"role"`
	NodeID            string       `json:"node_id"`
	NodeName          string       `json:"node_name"`
	PublicTokenSet    bool         `json:"public_token_set"`
	StatusPasswordSet bool         `json:"status_password_set"`
	MasterURL         string       `json:"master_url"`
	MasterURLs        string       `json:"master_urls"`
	Masters           []string     `json:"masters"`
	MasterLinks       []MasterLink `json:"master_links,omitempty"`
	HeartbeatSec      int          `json:"heartbeat_sec"`
	PoolTarget        int          `json:"pool_target"`
	AssignMin         int          `json:"assign_min"`
	AssignMax         int          `json:"assign_max"`
	AutoRegister      bool         `json:"auto_register"`
	AutoUpload        bool         `json:"auto_upload"`
	SharePoolList     bool         `json:"share_pool_list"`
	SharePoolPull     bool         `json:"share_pool_pull"`
	SlaveConnected    bool         `json:"slave_connected"`
	SlaveLastError    string       `json:"slave_last_error,omitempty"`
	SlaveLastOK       *time.Time   `json:"slave_last_ok,omitempty"`
	LastAssign        int          `json:"last_assign"`
	Need              int          `json:"need"`
	Pool              PoolSnapshot `json:"pool"`
	Nodes             []Node       `json:"nodes"`
}

type poolProvider func() PoolSnapshot
type startFn func(target int) error
type runningFn func() bool
type uploadFn func() (uploaded, failed int, err error)

// Service owns master registry + slave loop.
type Service struct {
	statePath string
	cfgFn     func() config.Config
	poolFn    poolProvider
	startFn   startFn
	runningFn runningFn
	uploadFn  uploadFn

	mu     sync.Mutex
	nodes  map[string]*Node
	nodeID string

	slaveMu        sync.Mutex
	slaveConnected bool
	slaveLastErr   string
	slaveLastOK    *time.Time
	lastAssign     int
	masterLinks    []MasterLink
}

func New(statePath string, cfgFn func() config.Config) *Service {
	s := &Service{
		statePath: statePath,
		cfgFn:     cfgFn,
		nodes:     map[string]*Node{},
		nodeID:    loadOrCreateNodeID(statePath),
	}
	return s
}

func (s *Service) SetPoolProvider(fn poolProvider) { s.poolFn = fn }
func (s *Service) SetStartFn(fn startFn)           { s.startFn = fn }
func (s *Service) SetRunningFn(fn runningFn)       { s.runningFn = fn }
func (s *Service) SetUploadFn(fn uploadFn)         { s.uploadFn = fn }

func (s *Service) NodeID() string { return s.nodeID }

func (s *Service) Start(ctx context.Context) {
	go s.slaveLoop(ctx)
	go s.gcLoop(ctx)
}

func (s *Service) gcLoop(ctx context.Context) {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.markStale()
		}
	}
}

func (s *Service) markStale() {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	for _, n := range s.nodes {
		n.Online = now.Sub(n.LastSeen) <= nodeStaleAfter
	}
}

func (s *Service) pool() PoolSnapshot {
	if s.poolFn != nil {
		return s.poolFn()
	}
	return PoolSnapshot{}
}

func (s *Service) need(cfg config.Config, pool PoolSnapshot) int {
	target := cfg.ClusterPoolTarget
	if target <= 0 {
		return 0
	}
	// Prefer healthy; if never patrolled (all zero) fall back to total.
	have := pool.Healthy
	if have == 0 && pool.Total > 0 && pool.Healthy == 0 && pool.Dead == 0 {
		have = pool.Total
	}
	if have >= target {
		return 0
	}
	return target - have
}

func (s *Service) PublicInfo(token string) (PublicInfo, int, string) {
	cfg := s.cfgFn()
	if code, msg := s.authorizeFederation(cfg, token); code != 0 {
		return PublicInfo{}, code, msg
	}
	pool := s.pool()
	need := 0
	if cfg.ClusterRole == RoleMaster {
		need = s.need(cfg, pool)
	}
	online, total := s.nodeCounts()
	return PublicInfo{
		OK:           true,
		Service:      "grok-panel-federation",
		Role:         normalizeRole(cfg.ClusterRole),
		Name:         firstNonEmpty(cfg.ClusterNodeName, "master"),
		AuthRequired: strings.TrimSpace(cfg.ClusterPublicToken) != "",
		PoolTarget:   cfg.ClusterPoolTarget,
		Need:         need,
		NeedAccounts: need > 0,
		Pool:         pool,
		AssignMin:    clamp(cfg.ClusterAssignMin, 1, 10),
		AssignMax:    clamp(cfg.ClusterAssignMax, 1, 10),
		SlavesOnline:  online,
		SlavesTotal:   total,
		SharePoolList: cfg.ClusterSharePoolList,
		SharePoolPull: cfg.ClusterSharePoolPull,
		Time:          time.Now().UTC().Format(time.RFC3339),
	}, 0, ""
}

// StatusPage returns the human-facing board. Password is independent of federation token.
func (s *Service) StatusPage(password string) (StatusPage, int, string) {
	cfg := s.cfgFn()
	want := strings.TrimSpace(cfg.ClusterStatusPassword)
	if want != "" {
		got := strings.TrimSpace(password)
		if subtle.ConstantTimeCompare([]byte(got), []byte(want)) != 1 {
			return StatusPage{OK: false, AuthRequired: true, Service: "grok-panel-status"}, 401, "invalid status password"
		}
	}
	pool := s.pool()
	need := 0
	role := normalizeRole(cfg.ClusterRole)
	if role == RoleMaster {
		need = s.need(cfg, pool)
	}
	online, total := s.nodeCounts()
	nodes := s.listNodes()
	// Only expose a slim public slave list (no remote addr noise optional — keep name/online/busy)
	slaves := make([]Node, 0, len(nodes))
	for _, n := range nodes {
		slaves = append(slaves, Node{
			ID:            n.ID,
			Name:          n.Name,
			LastSeen:      n.LastSeen,
			Online:        n.Online,
			Busy:          n.Busy,
			Capacity:      n.Capacity,
			Assigned:      n.Assigned,
			Completed:     n.Completed,
			RunningTarget: n.RunningTarget,
		})
	}
	return StatusPage{
		OK:           true,
		Service:      "grok-panel-status",
		Role:         role,
		Name:         firstNonEmpty(cfg.ClusterNodeName, "node"),
		AuthRequired: want != "",
		PoolTarget:   cfg.ClusterPoolTarget,
		Need:         need,
		NeedAccounts: need > 0,
		Pool:         pool,
		SlavesOnline: online,
		SlavesTotal:  total,
		Slaves:       slaves,
		Time:         time.Now().UTC().Format(time.RFC3339),
	}, 0, ""
}


func (s *Service) Heartbeat(req HeartbeatRequest, remote string) (HeartbeatResponse, int, string) {
	cfg := s.cfgFn()
	if code, msg := s.authorizeFederation(cfg, req.Token); code != 0 {
		return HeartbeatResponse{}, code, msg
	}
	if cfg.ClusterRole != RoleMaster {
		return HeartbeatResponse{}, 400, "this node is not a master"
	}
	id := strings.TrimSpace(req.NodeID)
	if id == "" {
		return HeartbeatResponse{}, 400, "node_id required"
	}
	cap := clamp(req.Capacity, 1, 10)
	if req.Capacity <= 0 {
		cap = clamp(cfg.ClusterAssignMax, 1, 10)
	}
	pool := s.pool()
	need := s.need(cfg, pool)
	minA := clamp(cfg.ClusterAssignMin, 1, 10)
	maxA := clamp(cfg.ClusterAssignMax, 1, 10)
	if maxA < minA {
		maxA = minA
	}

	assign := 0
	msg := "no demand"
	if need > 0 && !req.Busy {
		assign = need
		if assign < minA {
			assign = minA
		}
		if assign > maxA {
			assign = maxA
		}
		if assign > cap {
			assign = cap
		}
		if assign > need {
			assign = need
		}
		msg = fmt.Sprintf("assigned %d (need %d)", assign, need)
	} else if req.Busy {
		msg = "slave busy — no new assignment"
	}

	s.mu.Lock()
	n, ok := s.nodes[id]
	if !ok {
		n = &Node{ID: id}
		s.nodes[id] = n
	}
	n.Name = firstNonEmpty(strings.TrimSpace(req.Name), id[:min(8, len(id))])
	n.LastSeen = time.Now()
	n.Online = true
	n.Busy = req.Busy
	n.Capacity = cap
	n.RunningTarget = req.RunningTarget
	n.Assigned = assign
	if req.Completed > n.Completed {
		n.Completed = req.Completed
	}
	n.LastError = req.LastError
	n.RemoteAddr = remote
	n.Version = req.Version
	s.mu.Unlock()

	return HeartbeatResponse{
		OK:         true,
		MasterName: firstNonEmpty(cfg.ClusterNodeName, "master"),
		Role:       RoleMaster,
		Need:       need,
		Assign:     assign,
		PoolTarget: cfg.ClusterPoolTarget,
		Pool:       pool,
		AssignMin:  minA,
		AssignMax:  maxA,
		Message:    msg,
		ServerTime: time.Now().UTC().Format(time.RFC3339),
	}, 0, ""
}

func (s *Service) Report(req ReportRequest) (map[string]any, int, string) {
	cfg := s.cfgFn()
	if code, msg := s.authorizeFederation(cfg, req.Token); code != 0 {
		return nil, code, msg
	}
	if cfg.ClusterRole != RoleMaster {
		return nil, 400, "this node is not a master"
	}
	id := strings.TrimSpace(req.NodeID)
	if id == "" {
		return nil, 400, "node_id required"
	}
	s.mu.Lock()
	n, ok := s.nodes[id]
	if !ok {
		n = &Node{ID: id, Name: req.Name}
		s.nodes[id] = n
	}
	n.LastSeen = time.Now()
	n.Online = true
	n.Completed += max(0, req.Completed)
	if req.Message != "" {
		n.LastError = ""
	}
	s.mu.Unlock()
	return map[string]any{"ok": true}, 0, ""
}

func (s *Service) Status() Status {
	cfg := s.cfgFn()
	pool := s.pool()
	need := 0
	if normalizeRole(cfg.ClusterRole) == RoleMaster {
		need = s.need(cfg, pool)
	}
	nodes := s.listNodes()
	masters := cfg.ClusterMasters()
	s.slaveMu.Lock()
	st := Status{
		Role:              normalizeRole(cfg.ClusterRole),
		NodeID:            s.nodeID,
		NodeName:          firstNonEmpty(cfg.ClusterNodeName, s.nodeID[:min(8, len(s.nodeID))]),
		PublicTokenSet:    strings.TrimSpace(cfg.ClusterPublicToken) != "",
		StatusPasswordSet: strings.TrimSpace(cfg.ClusterStatusPassword) != "",
		MasterURL:         cfg.ClusterMasterURL,
		MasterURLs:        cfg.ClusterMasterURLs,
		Masters:           masters,
		MasterLinks:       append([]MasterLink(nil), s.masterLinks...),
		HeartbeatSec:      clamp(cfg.ClusterHeartbeatSec, 5, 300),
		PoolTarget:        cfg.ClusterPoolTarget,
		AssignMin:         clamp(cfg.ClusterAssignMin, 1, 10),
		AssignMax:         clamp(cfg.ClusterAssignMax, 1, 10),
		AutoRegister:      cfg.ClusterAutoRegister,
		AutoUpload:        cfg.ClusterAutoUpload,
		SharePoolList:     cfg.ClusterSharePoolList,
		SharePoolPull:     cfg.ClusterSharePoolPull,
		SlaveConnected:    s.slaveConnected,
		SlaveLastError:    s.slaveLastErr,
		LastAssign:        s.lastAssign,
		Need:              need,
		Pool:              pool,
		Nodes:             nodes,
	}
	if s.slaveLastOK != nil {
		t := *s.slaveLastOK
		st.SlaveLastOK = &t
	}
	s.slaveMu.Unlock()
	return st
}

func (s *Service) Kick(nodeID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.nodes[nodeID]; !ok {
		return false
	}
	delete(s.nodes, nodeID)
	return true
}

func (s *Service) listNodes() []Node {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	out := make([]Node, 0, len(s.nodes))
	for _, n := range s.nodes {
		cp := *n
		cp.Online = now.Sub(n.LastSeen) <= nodeStaleAfter
		out = append(out, cp)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Online != out[j].Online {
			return out[i].Online
		}
		return out[i].Name < out[j].Name
	})
	return out
}

func (s *Service) nodeCounts() (online, total int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	total = len(s.nodes)
	for _, n := range s.nodes {
		if now.Sub(n.LastSeen) <= nodeStaleAfter {
			online++
		}
	}
	return online, total
}

func (s *Service) authorizeFederation(cfg config.Config, token string) (int, string) {
	want := strings.TrimSpace(cfg.ClusterPublicToken)
	if want == "" {
		return 0, ""
	}
	got := strings.TrimSpace(token)
	if subtle.ConstantTimeCompare([]byte(got), []byte(want)) != 1 {
		return 401, "invalid federation token"
	}
	return 0, ""
}

func normalizeRole(r string) string {
	switch strings.ToLower(strings.TrimSpace(r)) {
	case RoleMaster:
		return RoleMaster
	case RoleSlave:
		return RoleSlave
	default:
		return RoleStandalone
	}
}

func loadOrCreateNodeID(statePath string) string {
	dir := filepath.Dir(statePath)
	_ = os.MkdirAll(dir, 0o700)
	p := filepath.Join(dir, "cluster-node-id")
	if b, err := os.ReadFile(p); err == nil {
		id := strings.TrimSpace(string(b))
		if id != "" {
			return id
		}
	}
	var buf [16]byte
	_, _ = rand.Read(buf[:])
	id := hex.EncodeToString(buf[:])
	_ = os.WriteFile(p, []byte(id+"\n"), 0o600)
	// also touch state file shell
	_ = os.WriteFile(statePath, []byte(`{"version":1}`+"\n"), 0o600)
	return id
}

func firstNonEmpty(a, b string) string {
	if strings.TrimSpace(a) != "" {
		return a
	}
	return b
}

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// DumpNodesJSON is a helper for tests/debug.
func (s *Service) DumpNodesJSON() []byte {
	b, _ := json.Marshal(s.listNodes())
	return b
}
