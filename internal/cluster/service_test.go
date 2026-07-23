package cluster

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/grok-free-register/grok-reg/internal/config"
)

func testCfg(mut func(*config.Config)) func() config.Config {
	return func() config.Config {
		cfg := config.Defaults()
		cfg.ClusterRole = RoleMaster
		cfg.ClusterPoolTarget = 20
		cfg.ClusterAssignMin = 1
		cfg.ClusterAssignMax = 10
		cfg.ClusterNodeName = "master-a"
		if mut != nil {
			mut(&cfg)
		}
		return cfg
	}
}

func TestHeartbeatAssignsWhenNeed(t *testing.T) {
	s := New(filepath.Join(t.TempDir(), "cluster-state.json"), testCfg(nil))
	s.SetPoolProvider(func() PoolSnapshot {
		return PoolSnapshot{Healthy: 5, Total: 5}
	})
	res, code, msg := s.Heartbeat(HeartbeatRequest{
		NodeID:   "node-1",
		Name:     "slave-1",
		Capacity: 10,
		Busy:     false,
	}, "1.2.3.4")
	if code != 0 {
		t.Fatalf("code=%d msg=%s", code, msg)
	}
	if res.Need != 15 {
		t.Fatalf("need=%d", res.Need)
	}
	if res.Assign != 10 {
		t.Fatalf("assign=%d want 10 (capped)", res.Assign)
	}
	st := s.Status()
	if len(st.Nodes) != 1 || !st.Nodes[0].Online {
		t.Fatalf("nodes=%+v", st.Nodes)
	}
}

func TestHeartbeatNoAssignWhenBusyOrFull(t *testing.T) {
	s := New(filepath.Join(t.TempDir(), "cluster-state.json"), testCfg(nil))
	s.SetPoolProvider(func() PoolSnapshot {
		return PoolSnapshot{Healthy: 20, Total: 20}
	})
	res, code, _ := s.Heartbeat(HeartbeatRequest{NodeID: "n", Capacity: 5}, "")
	if code != 0 || res.Assign != 0 {
		t.Fatalf("full pool should assign 0: %+v", res)
	}
	s.SetPoolProvider(func() PoolSnapshot {
		return PoolSnapshot{Healthy: 0, Total: 0}
	})
	res, _, _ = s.Heartbeat(HeartbeatRequest{NodeID: "n", Capacity: 5, Busy: true}, "")
	if res.Assign != 0 {
		t.Fatalf("busy should assign 0")
	}
}

func TestPublicTokenAuth(t *testing.T) {
	s := New(filepath.Join(t.TempDir(), "cluster-state.json"), testCfg(func(c *config.Config) {
		c.ClusterPublicToken = "secret"
	}))
	_, code, _ := s.PublicInfo("")
	if code != 401 {
		t.Fatalf("want 401 got %d", code)
	}
	info, code, _ := s.PublicInfo("secret")
	if code != 0 || !info.OK {
		t.Fatalf("auth info failed code=%d", code)
	}
}

func TestSlaveRejectsNonMaster(t *testing.T) {
	s := New(filepath.Join(t.TempDir(), "cluster-state.json"), testCfg(func(c *config.Config) {
		c.ClusterRole = RoleSlave
	}))
	_, code, _ := s.Heartbeat(HeartbeatRequest{NodeID: "x"}, "")
	if code != 400 {
		t.Fatalf("want 400 got %d", code)
	}
}

func TestKick(t *testing.T) {
	s := New(filepath.Join(t.TempDir(), "cluster-state.json"), testCfg(nil))
	s.SetPoolProvider(func() PoolSnapshot { return PoolSnapshot{} })
	_, _, _ = s.Heartbeat(HeartbeatRequest{NodeID: "kick-me"}, "")
	if !s.Kick("kick-me") {
		t.Fatal("kick failed")
	}
	if s.Kick("kick-me") {
		t.Fatal("second kick should fail")
	}
	// stale mark shouldn't panic
	s.nodes["ghost"] = &Node{ID: "ghost", LastSeen: time.Now().Add(-time.Hour)}
	s.markStale()
}
