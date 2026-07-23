package config

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
)

type EmailMode string

const (
	EmailTempmail EmailMode = "tempmail"
	EmailCustom   EmailMode = "custom"
)

type Config struct {
	EmailMode   EmailMode
	EmailDomain string
	EmailAPI    string

	ClearanceEnabled bool
	RegisterProxy    string
	FlareSolverrURL  string
	ClearanceProxy   string
	ClearanceURLs    string

	Target      int
	PhysicalCap int

	TurnstileProvider string
	LiteSolverURL     string

	ProtocolHTTP bool
	HTTPPoolSize int

	TempmailLOLRetries    int
	TempmailLOLIntervalMS int

	OAuthMinIntervalSec float64
	OAuthRetrySec       float64
	ProbeEnabled        bool

	HTTPProxy  string
	HTTPSProxy string
	NoProxy    string

	// CPA Management upload
	CPAUploadEnabled      bool
	CPAManagementBase     string
	CPAManagementKey      string
	CPAUploadTimeoutSec   int
	CPAUploadRetries      int
	CPAUploadNameTemplate string
	CPAUploadVerify       bool
	CPAUploadMode         string // multipart | json

	// Transfer (upload/export jobs) defaults
	UploadConcurrency int
	UploadBatchSize   int
	ExportBatchSize   int
	ExportConcurrency int

	// Pool patrol (巡检) & quota estimate
	PatrolEnabled     bool
	PatrolIntervalMin int
	PatrolDeepProbe   bool
	PatrolConcurrency int
	QuotaPerAccount   int

	// Auto refill (自动补号)
	RefillEnabled     bool
	RefillMinHealthy  int
	RefillBatch       int
	RefillCooldownMin int
	RefillDailyCap    int

	// Cleanup free-usage / quota exhausted accounts from the live CPA pool.
	// Transient 429 rate limits are never deleted by this path.
	CleanupQuotaEnabled bool
	CleanupOnPatrol     bool // run after each successful patrol
	CleanupBackup       bool // download before delete
	CleanupDryRun       bool // scan + report only

	// Cluster / federation (master–slave pool orchestration)
	// Role: standalone | master | slave
	ClusterRole         string
	ClusterNodeName     string
	ClusterPublicToken  string // optional shared secret for federation endpoints (slave↔master)
	ClusterMasterURL    string // legacy single master URL (still honored)
	ClusterMasterURLs   string // slave: multi masters, comma/newline separated
	ClusterHeartbeatSec int    // slave poll interval
	ClusterPoolTarget   int    // master desired healthy pool size
	ClusterAssignMin    int    // per-slave assign lower bound (1-10)
	ClusterAssignMax    int    // per-slave assign upper bound (1-10)
	ClusterAutoRegister bool   // slave auto start pipeline when assigned
	ClusterAutoUpload   bool   // slave upload CPA after batch
	// Public status page (human-facing), independent from ClusterPublicToken
	ClusterStatusPassword string // empty = open; set to require password on /status

	// Local pool (register results)
	LocalPoolAutoImport bool // after register, copy CPA json into GROK_HOME/local-pool
	LocalPoolAutoSync   bool // upload local-pool to CPA management (master formal pool)
}

func Defaults() Config {
	return Config{
		EmailMode:             EmailTempmail,
		EmailAPI:              "http://127.0.0.1:8080",
		ClearanceEnabled:      true,
		RegisterProxy:         "http://127.0.0.1:40080",
		FlareSolverrURL:       "http://127.0.0.1:8191",
		ClearanceProxy:        "http://privoxy:8118",
		ClearanceURLs:         "https://accounts.x.ai,https://x.ai,https://status.x.ai,https://console.x.ai,https://auth.x.ai",
		Target:                10,
		PhysicalCap:           0,
		TurnstileProvider:     "browser",
		LiteSolverURL:         "http://127.0.0.1:5072",
		ProtocolHTTP:          true,
		HTTPPoolSize:          8,
		TempmailLOLRetries:    30,
		TempmailLOLIntervalMS: 1500,
		OAuthMinIntervalSec:   10,
		OAuthRetrySec:         60,
		ProbeEnabled:          true,
		HTTPProxy:             "http://127.0.0.1:40080",
		HTTPSProxy:            "http://127.0.0.1:40080",
		NoProxy:               "127.0.0.1,localhost",
		CPAUploadEnabled:      false,
		CPAManagementBase:     "http://localhost:8317/v0/management",
		CPAUploadTimeoutSec:   30,
		CPAUploadRetries:      2,
		CPAUploadNameTemplate: "{email}.json",
		CPAUploadVerify:       true,
		CPAUploadMode:         "multipart",
		UploadConcurrency:     3,
		UploadBatchSize:       20,
		ExportBatchSize:       500,
		ExportConcurrency:     15,
		PatrolEnabled:         false,
		PatrolIntervalMin:     30,
		PatrolDeepProbe:       false,
		PatrolConcurrency:     10,
		QuotaPerAccount:       60,
		RefillEnabled:         false,
		RefillMinHealthy:      5,
		RefillBatch:           10,
		RefillCooldownMin:     60,
		RefillDailyCap:        50,
		CleanupQuotaEnabled:   false,
		CleanupOnPatrol:       true,
		CleanupBackup:         true,
		CleanupDryRun:         false,
		ClusterRole:           "standalone",
		ClusterHeartbeatSec:   15,
		ClusterPoolTarget:     50,
		ClusterAssignMin:      1,
		ClusterAssignMax:      10,
		ClusterAutoRegister:   true,
		ClusterAutoUpload:     true,
		LocalPoolAutoImport:   true,
		LocalPoolAutoSync:     false,
	}
}

func Load(path string) (Config, error) {
	cfg := Defaults()
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return cfg, nil
		}
		return cfg, err
	}
	env := parseEnvFile(string(data))
	applyMap(&cfg, env)
	return cfg, nil
}

func Save(path string, cfg Config) error {
	var b strings.Builder
	b.WriteString("# grok-reg config\n")
	b.WriteString(fmt.Sprintf("EMAIL_MODE=%s\n", cfg.EmailMode))
	if cfg.EmailDomain != "" {
		b.WriteString(fmt.Sprintf("EMAIL_DOMAIN=%s\n", cfg.EmailDomain))
	}
	if cfg.EmailAPI != "" {
		b.WriteString(fmt.Sprintf("EMAIL_API=%s\n", cfg.EmailAPI))
	}
	b.WriteString(fmt.Sprintf("CLEARANCE_ENABLED=%s\n", bool01(cfg.ClearanceEnabled)))
	b.WriteString(fmt.Sprintf("REGISTER_PROXY=%s\n", cfg.RegisterProxy))
	b.WriteString(fmt.Sprintf("FLARESOLVERR_URL=%s\n", cfg.FlareSolverrURL))
	b.WriteString(fmt.Sprintf("CLEARANCE_PROXY=%s\n", cfg.ClearanceProxy))
	b.WriteString(fmt.Sprintf("CLEARANCE_URLS=%s\n", cfg.ClearanceURLs))
	b.WriteString(fmt.Sprintf("TURNSTILE_PROVIDER=%s\n", cfg.TurnstileProvider))
	if cfg.LiteSolverURL != "" {
		b.WriteString(fmt.Sprintf("LITE_SOLVER_URL=%s\n", cfg.LiteSolverURL))
	}
	b.WriteString(fmt.Sprintf("PROTOCOL_HTTP=%s\n", bool01(cfg.ProtocolHTTP)))
	b.WriteString(fmt.Sprintf("HTTP_POOL_SIZE=%d\n", cfg.HTTPPoolSize))
	b.WriteString(fmt.Sprintf("TEMPMAIL_LOL_RETRIES=%d\n", cfg.TempmailLOLRetries))
	b.WriteString(fmt.Sprintf("TEMPMAIL_LOL_MIN_INTERVAL_MS=%d\n", cfg.TempmailLOLIntervalMS))
	b.WriteString(fmt.Sprintf("HTTPS_PROXY=%s\n", cfg.HTTPSProxy))
	b.WriteString(fmt.Sprintf("HTTP_PROXY=%s\n", cfg.HTTPProxy))
	b.WriteString(fmt.Sprintf("NO_PROXY=%s\n", cfg.NoProxy))
	b.WriteString(fmt.Sprintf("PROBE_ENABLED=%s\n", bool01(cfg.ProbeEnabled)))
	b.WriteString(fmt.Sprintf("PHYSICAL_CAP=%d\n", cfg.PhysicalCap))
	b.WriteString(fmt.Sprintf("CPA_UPLOAD_ENABLED=%s\n", bool01(cfg.CPAUploadEnabled)))
	b.WriteString(fmt.Sprintf("CPA_MANAGEMENT_BASE=%s\n", cfg.CPAManagementBase))
	// CPA_MANAGEMENT_KEY: never auto-written (set manually in config.env)
	b.WriteString(fmt.Sprintf("CPA_UPLOAD_TIMEOUT_SEC=%d\n", cfg.CPAUploadTimeoutSec))
	b.WriteString(fmt.Sprintf("CPA_UPLOAD_RETRIES=%d\n", cfg.CPAUploadRetries))
	b.WriteString(fmt.Sprintf("CPA_UPLOAD_NAME_TEMPLATE=%s\n", cfg.CPAUploadNameTemplate))
	b.WriteString(fmt.Sprintf("UPLOAD_CONCURRENCY=%d\n", cfg.UploadConcurrency))
	b.WriteString(fmt.Sprintf("UPLOAD_BATCH_SIZE=%d\n", cfg.UploadBatchSize))
	b.WriteString(fmt.Sprintf("EXPORT_BATCH_SIZE=%d\n", cfg.ExportBatchSize))
	b.WriteString(fmt.Sprintf("EXPORT_CONCURRENCY=%d\n", cfg.ExportConcurrency))
	b.WriteString(fmt.Sprintf("PATROL_ENABLED=%s\n", bool01(cfg.PatrolEnabled)))
	b.WriteString(fmt.Sprintf("PATROL_INTERVAL_MIN=%d\n", cfg.PatrolIntervalMin))
	b.WriteString(fmt.Sprintf("PATROL_DEEP_PROBE=%s\n", bool01(cfg.PatrolDeepProbe)))
	b.WriteString(fmt.Sprintf("PATROL_CONCURRENCY=%d\n", cfg.PatrolConcurrency))
	b.WriteString(fmt.Sprintf("QUOTA_PER_ACCOUNT=%d\n", cfg.QuotaPerAccount))
	b.WriteString(fmt.Sprintf("REFILL_ENABLED=%s\n", bool01(cfg.RefillEnabled)))
	b.WriteString(fmt.Sprintf("REFILL_MIN_HEALTHY=%d\n", cfg.RefillMinHealthy))
	b.WriteString(fmt.Sprintf("REFILL_BATCH=%d\n", cfg.RefillBatch))
	b.WriteString(fmt.Sprintf("REFILL_COOLDOWN_MIN=%d\n", cfg.RefillCooldownMin))
	b.WriteString(fmt.Sprintf("REFILL_DAILY_CAP=%d\n", cfg.RefillDailyCap))
	b.WriteString(fmt.Sprintf("CLEANUP_QUOTA_ENABLED=%s\n", bool01(cfg.CleanupQuotaEnabled)))
	b.WriteString(fmt.Sprintf("CLEANUP_ON_PATROL=%s\n", bool01(cfg.CleanupOnPatrol)))
	b.WriteString(fmt.Sprintf("CLEANUP_BACKUP=%s\n", bool01(cfg.CleanupBackup)))
	b.WriteString(fmt.Sprintf("CLEANUP_DRY_RUN=%s\n", bool01(cfg.CleanupDryRun)))
	b.WriteString(fmt.Sprintf("CLUSTER_ROLE=%s\n", cfg.ClusterRole))
	b.WriteString(fmt.Sprintf("CLUSTER_NODE_NAME=%s\n", cfg.ClusterNodeName))
	// CLUSTER_PUBLIC_TOKEN: written via appendEnvKey when set from panel
	b.WriteString(fmt.Sprintf("CLUSTER_MASTER_URL=%s\n", cfg.ClusterMasterURL))
	b.WriteString(fmt.Sprintf("CLUSTER_MASTER_URLS=%s\n", strings.Join(cfg.ClusterMasters(), ",")))
	b.WriteString(fmt.Sprintf("CLUSTER_HEARTBEAT_SEC=%d\n", cfg.ClusterHeartbeatSec))
	b.WriteString(fmt.Sprintf("CLUSTER_POOL_TARGET=%d\n", cfg.ClusterPoolTarget))
	b.WriteString(fmt.Sprintf("CLUSTER_ASSIGN_MIN=%d\n", cfg.ClusterAssignMin))
	b.WriteString(fmt.Sprintf("CLUSTER_ASSIGN_MAX=%d\n", cfg.ClusterAssignMax))
	b.WriteString(fmt.Sprintf("CLUSTER_AUTO_REGISTER=%s\n", bool01(cfg.ClusterAutoRegister)))
	b.WriteString(fmt.Sprintf("CLUSTER_AUTO_UPLOAD=%s\n", bool01(cfg.ClusterAutoUpload)))
	b.WriteString(fmt.Sprintf("LOCAL_POOL_AUTO_IMPORT=%s\n", bool01(cfg.LocalPoolAutoImport)))
	b.WriteString(fmt.Sprintf("LOCAL_POOL_AUTO_SYNC=%s\n", bool01(cfg.LocalPoolAutoSync)))
	// CLUSTER_STATUS_PASSWORD via appendEnvKey when set from panel
	return os.WriteFile(path, []byte(b.String()), 0o600)
}

func InteractiveSetup(path string) (Config, error) {
	cfg := Defaults()
	fmt.Println()
	fmt.Println("选择邮箱模式:")
	fmt.Println("  [1] 免费临时邮箱           (默认 · 零配置 · 直接回车)")
	fmt.Println("  [2] 自建域名邮箱           (需 Cloudflare Email Routing + 本地 webhook)")
	fmt.Print("输入 1 或 2 [1]: ")
	reader := bufio.NewReader(os.Stdin)
	line, _ := reader.ReadString('\n')
	line = strings.TrimSpace(line)
	if line == "2" {
		cfg.EmailMode = EmailCustom
		fmt.Print("  你的域名 (如 example.com): ")
		dom, _ := reader.ReadString('\n')
		cfg.EmailDomain = strings.TrimSpace(dom)
		fmt.Print("  webhook 地址 [http://127.0.0.1:8080]: ")
		api, _ := reader.ReadString('\n')
		api = strings.TrimSpace(api)
		if api == "" {
			api = "http://127.0.0.1:8080"
		}
		cfg.EmailAPI = api
	} else {
		cfg.EmailMode = EmailTempmail
	}
	if err := Save(path, cfg); err != nil {
		return cfg, err
	}
	fmt.Printf("[*] 已写入 %s\n", path)
	return cfg, nil
}

func ClampTarget(n int) (int, error) {
	if n < 1 {
		return 0, fmt.Errorf("target must be >= 1, got %d", n)
	}
	if n > 10000 {
		return 0, fmt.Errorf("target max is 10000, got %d", n)
	}
	return n, nil
}

func parseEnvFile(content string) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		i := strings.IndexByte(line, '=')
		if i <= 0 {
			continue
		}
		k := strings.TrimSpace(line[:i])
		v := strings.TrimSpace(line[i+1:])
		v = strings.Trim(v, `"'`)
		out[k] = v
	}
	return out
}

func applyMap(cfg *Config, env map[string]string) {
	if v, ok := env["EMAIL_MODE"]; ok {
		cfg.EmailMode = EmailMode(strings.ToLower(v))
	}
	if v, ok := env["EMAIL_DOMAIN"]; ok {
		cfg.EmailDomain = v
	}
	if v, ok := env["EMAIL_API"]; ok {
		cfg.EmailAPI = v
	}
	if v, ok := env["CLEARANCE_ENABLED"]; ok {
		cfg.ClearanceEnabled = truthy(v)
	}
	if v, ok := env["REGISTER_PROXY"]; ok {
		cfg.RegisterProxy = v
	}
	if v, ok := env["FLARESOLVERR_URL"]; ok {
		cfg.FlareSolverrURL = v
	}
	if v, ok := env["CLEARANCE_PROXY"]; ok {
		cfg.ClearanceProxy = v
	}
	if v, ok := env["CLEARANCE_URLS"]; ok {
		cfg.ClearanceURLs = v
	}
	if v, ok := env["TURNSTILE_PROVIDER"]; ok {
		cfg.TurnstileProvider = v
	}
	if v, ok := env["LITE_SOLVER_URL"]; ok {
		cfg.LiteSolverURL = v
	}
	if v, ok := env["PROTOCOL_HTTP"]; ok {
		cfg.ProtocolHTTP = truthy(v)
	}
	if v, ok := env["HTTP_POOL_SIZE"]; ok {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.HTTPPoolSize = n
		}
	}
	if v, ok := env["TEMPMAIL_LOL_RETRIES"]; ok {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.TempmailLOLRetries = n
		}
	}
	if v, ok := env["TEMPMAIL_LOL_MIN_INTERVAL_MS"]; ok {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.TempmailLOLIntervalMS = n
		}
	}
	if v, ok := env["HTTPS_PROXY"]; ok {
		cfg.HTTPSProxy = v
	}
	if v, ok := env["HTTP_PROXY"]; ok {
		cfg.HTTPProxy = v
	}
	if v, ok := env["NO_PROXY"]; ok {
		cfg.NoProxy = v
	}
	if v, ok := env["PROBE_ENABLED"]; ok {
		cfg.ProbeEnabled = truthy(v)
	}
	if v, ok := env["PHYSICAL_CAP"]; ok {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.PhysicalCap = n
		}
	}
	if v, ok := env["CPA_UPLOAD_ENABLED"]; ok {
		cfg.CPAUploadEnabled = truthy(v)
	}
	if v, ok := env["CPA_MANAGEMENT_BASE"]; ok {
		cfg.CPAManagementBase = v
	}
	if v, ok := env["CPA_MANAGEMENT_KEY"]; ok {
		cfg.CPAManagementKey = v
	}
	if v, ok := env["CPA_UPLOAD_TIMEOUT_SEC"]; ok {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.CPAUploadTimeoutSec = n
		}
	}
	if v, ok := env["CPA_UPLOAD_RETRIES"]; ok {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.CPAUploadRetries = n
		}
	}
	if v, ok := env["CPA_UPLOAD_NAME_TEMPLATE"]; ok {
		cfg.CPAUploadNameTemplate = v
	}
	if v, ok := env["CPA_UPLOAD_VERIFY"]; ok {
		cfg.CPAUploadVerify = truthy(v)
	}
	if v, ok := env["CPA_UPLOAD_MODE"]; ok {
		cfg.CPAUploadMode = v
	}
	if v, ok := env["UPLOAD_CONCURRENCY"]; ok {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.UploadConcurrency = n
		}
	}
	if v, ok := env["UPLOAD_BATCH_SIZE"]; ok {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.UploadBatchSize = n
		}
	}
	if v, ok := env["EXPORT_BATCH_SIZE"]; ok {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.ExportBatchSize = n
		}
	}
	if v, ok := env["EXPORT_CONCURRENCY"]; ok {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.ExportConcurrency = n
		}
	}
	if v, ok := env["PATROL_ENABLED"]; ok {
		cfg.PatrolEnabled = truthy(v)
	}
	if v, ok := env["PATROL_INTERVAL_MIN"]; ok {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.PatrolIntervalMin = n
		}
	}
	if v, ok := env["PATROL_DEEP_PROBE"]; ok {
		cfg.PatrolDeepProbe = truthy(v)
	}
	if v, ok := env["PATROL_CONCURRENCY"]; ok {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.PatrolConcurrency = n
		}
	}
	if v, ok := env["QUOTA_PER_ACCOUNT"]; ok {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.QuotaPerAccount = n
		}
	}
	if v, ok := env["REFILL_ENABLED"]; ok {
		cfg.RefillEnabled = truthy(v)
	}
	if v, ok := env["REFILL_MIN_HEALTHY"]; ok {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.RefillMinHealthy = n
		}
	}
	if v, ok := env["REFILL_BATCH"]; ok {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.RefillBatch = n
		}
	}
	if v, ok := env["REFILL_COOLDOWN_MIN"]; ok {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.RefillCooldownMin = n
		}
	}
	if v, ok := env["REFILL_DAILY_CAP"]; ok {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.RefillDailyCap = n
		}
	}
	if v, ok := env["CLEANUP_QUOTA_ENABLED"]; ok {
		cfg.CleanupQuotaEnabled = truthy(v)
	}
	if v, ok := env["CLEANUP_ON_PATROL"]; ok {
		cfg.CleanupOnPatrol = truthy(v)
	}
	if v, ok := env["CLEANUP_BACKUP"]; ok {
		cfg.CleanupBackup = truthy(v)
	}
	if v, ok := env["CLEANUP_DRY_RUN"]; ok {
		cfg.CleanupDryRun = truthy(v)
	}
	if v, ok := env["CLUSTER_ROLE"]; ok {
		cfg.ClusterRole = strings.ToLower(strings.TrimSpace(v))
	}
	if v, ok := env["CLUSTER_NODE_NAME"]; ok {
		cfg.ClusterNodeName = v
	}
	if v, ok := env["CLUSTER_PUBLIC_TOKEN"]; ok {
		cfg.ClusterPublicToken = v
	}
	if v, ok := env["CLUSTER_MASTER_URL"]; ok {
		cfg.ClusterMasterURL = strings.TrimRight(strings.TrimSpace(v), "/")
	}
	if v, ok := env["CLUSTER_MASTER_URLS"]; ok {
		cfg.ClusterMasterURLs = v
	}
	if v, ok := env["CLUSTER_STATUS_PASSWORD"]; ok {
		cfg.ClusterStatusPassword = v
	}
	if v, ok := env["CLUSTER_HEARTBEAT_SEC"]; ok {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.ClusterHeartbeatSec = n
		}
	}
	if v, ok := env["CLUSTER_POOL_TARGET"]; ok {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.ClusterPoolTarget = n
		}
	}
	if v, ok := env["CLUSTER_ASSIGN_MIN"]; ok {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.ClusterAssignMin = n
		}
	}
	if v, ok := env["CLUSTER_ASSIGN_MAX"]; ok {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.ClusterAssignMax = n
		}
	}
	if v, ok := env["CLUSTER_AUTO_REGISTER"]; ok {
		cfg.ClusterAutoRegister = truthy(v)
	}
	if v, ok := env["CLUSTER_AUTO_UPLOAD"]; ok {
		cfg.ClusterAutoUpload = truthy(v)
	}
	if v, ok := env["LOCAL_POOL_AUTO_IMPORT"]; ok {
		cfg.LocalPoolAutoImport = truthy(v)
	}
	if v, ok := env["LOCAL_POOL_AUTO_SYNC"]; ok {
		cfg.LocalPoolAutoSync = truthy(v)
	}
}

func truthy(v string) bool {
	v = strings.ToLower(strings.TrimSpace(v))
	return v == "1" || v == "true" || v == "yes" || v == "on"
}

func bool01(b bool) string {
	if b {
		return "1"
	}
	return "0"
}

// ApplyProxyEnv sets process proxy env for outbound HTTP (tempmail etc).
func ApplyProxyEnv(cfg Config) {
	if cfg.HTTPProxy != "" {
		_ = os.Setenv("HTTP_PROXY", cfg.HTTPProxy)
		_ = os.Setenv("http_proxy", cfg.HTTPProxy)
	}
	if cfg.HTTPSProxy != "" {
		_ = os.Setenv("HTTPS_PROXY", cfg.HTTPSProxy)
		_ = os.Setenv("https_proxy", cfg.HTTPSProxy)
	}
	if cfg.NoProxy != "" {
		_ = os.Setenv("NO_PROXY", cfg.NoProxy)
		_ = os.Setenv("no_proxy", cfg.NoProxy)
	}
}


// ClusterMasters returns de-duplicated master base URLs for a slave node.
// Prefers CLUSTER_MASTER_URLS (comma/newline/space separated); falls back to CLUSTER_MASTER_URL.
func (cfg Config) ClusterMasters() []string {
	raw := cfg.ClusterMasterURLs
	if strings.TrimSpace(raw) == "" {
		raw = cfg.ClusterMasterURL
	}
	// UI may send real newlines or the two-char sequence \n
	raw = strings.ReplaceAll(raw, "\\n", "\n")
	raw = strings.ReplaceAll(raw, "\\r", "\r")
	parts := strings.FieldsFunc(raw, func(r rune) bool {
		switch r {
		case ',', ';', '\n', '\r', '\t', ' ':
			return true
		default:
			return false
		}
	})
	seen := map[string]struct{}{}
	var out []string
	for _, part := range parts {
		u := strings.TrimRight(strings.TrimSpace(part), "/")
		if u == "" {
			continue
		}
		if _, ok := seen[u]; ok {
			continue
		}
		seen[u] = struct{}{}
		out = append(out, u)
	}
	return out
}

