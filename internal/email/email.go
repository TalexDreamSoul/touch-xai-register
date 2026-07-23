package email

import (
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/grok-free-register/grok-reg/internal/config"
)

var bannedDomains = map[string]struct{}{
	"duckmail.sbs":    {},
	"web-library.net": {},
	"mail.tm":         {},
	"mail.gw":         {},
	"baldur.edu.kg":   {},
}

var codeRe = []*regexp.Regexp{
	regexp.MustCompile(`>([A-Z0-9]{3}-[A-Z0-9]{3})<`),
	regexp.MustCompile(`>([A-Z0-9]{6})<`),
	regexp.MustCompile(`\b([A-Z0-9]{3}-?[A-Z0-9]{3})\b`),
	regexp.MustCompile(`(?i)(?:code|验证码|verification)[^\dA-Z]{0,20}([A-Z0-9]{6})\b`),
}

type Handle struct {
	Kind     string // lol | mt | custom | freemail
	Email    string
	Password string
	Token    string
	Base     string // mail.tm base or freemail base
}

type Provider struct {
	cfg Config
	mu  sync.Mutex
	// lol rate limit
	lolNextOK time.Time
}

type Config struct {
	Mode           config.EmailMode
	Domain         string
	API            string
	FreeMailBase   string
	FreeMailAPIKey string
	LOLRetries     int
	LOLIntervalMS  int
	HTTPClient     *http.Client
}

func New(cfg Config) *Provider {
	if cfg.HTTPClient == nil {
		cfg.HTTPClient = &http.Client{Timeout: 20 * time.Second}
	}
	if cfg.LOLRetries <= 0 {
		cfg.LOLRetries = 8
	}
	if cfg.LOLIntervalMS <= 0 {
		cfg.LOLIntervalMS = 400
	}
	cfg.FreeMailBase = strings.TrimRight(strings.TrimSpace(cfg.FreeMailBase), "/")
	if cfg.Mode == config.EmailFreemail && cfg.FreeMailBase == "" {
		cfg.FreeMailBase = strings.TrimRight(strings.TrimSpace(cfg.API), "/")
	}
	return &Provider{cfg: cfg}
}

func randStr(n int) string {
	const letters = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, n)
	for i := range b {
		b[i] = letters[rand.Intn(len(letters))]
	}
	return string(b)
}

func (p *Provider) Create() (Handle, error) {
	password := randStr(15)
	switch p.cfg.Mode {
	case config.EmailCustom:
		dom := strings.TrimSpace(p.cfg.Domain)
		if dom == "" {
			return Handle{}, fmt.Errorf("EMAIL_DOMAIN 未配置（custom 模式需要）")
		}
		email := fmt.Sprintf("oc%s@%s", randStr(10), dom)
		return Handle{Kind: "custom", Email: email, Password: password}, nil
	case config.EmailFreemail:
		h, err := p.freemailCreate()
		if err != nil {
			return Handle{}, err
		}
		h.Password = password
		return h, nil
	}

	var last error
	for i := 0; i < p.cfg.LOLRetries; i++ {
		h, err := p.lolCreate()
		if err == nil {
			h.Password = password
			return h, nil
		}
		last = err
		time.Sleep(time.Duration(50*(i+1)) * time.Millisecond)
	}
	// mail.tm family fallback
	for _, base := range []string{"https://api.mail.tm", "https://api.mail.gw", "https://api.duckmail.sbs"} {
		h, err := p.mailtmCreate(base, password)
		if err == nil {
			return h, nil
		}
		last = err
	}
	if last == nil {
		last = fmt.Errorf("所有临时邮箱 provider 均不可用")
	}
	return Handle{}, last
}

func (p *Provider) freemailAuth(req *http.Request) {
	if p.cfg.FreeMailAPIKey != "" {
		req.Header.Set("Authorization", "Bearer "+p.cfg.FreeMailAPIKey)
	}
	req.Header.Set("Accept", "application/json")
}

func (p *Provider) freemailCreate() (Handle, error) {
	base := p.cfg.FreeMailBase
	if base == "" {
		return Handle{}, fmt.Errorf("FREEMAIL_BASE / EMAIL_API 未配置（freemail 模式需要）")
	}
	// Prefer generate; if EMAIL_DOMAIN set, try domainIndex match via /api/domains
	domainIndex := 0
	if p.cfg.Domain != "" {
		if idx, err := p.freemailDomainIndex(p.cfg.Domain); err == nil {
			domainIndex = idx
		}
	}
	u := fmt.Sprintf("%s/api/generate?length=12&domainIndex=%d", base, domainIndex)
	req, err := http.NewRequest(http.MethodGet, u, nil)
	if err != nil {
		return Handle{}, err
	}
	p.freemailAuth(req)
	resp, err := p.cfg.HTTPClient.Do(req)
	if err != nil {
		return Handle{}, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != 200 {
		return Handle{}, fmt.Errorf("freemail generate status %d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	var doc map[string]any
	if err := json.Unmarshal(body, &doc); err != nil {
		return Handle{}, err
	}
	addr, _ := doc["email"].(string)
	if addr == "" {
		addr, _ = doc["address"].(string)
	}
	if addr == "" {
		return Handle{}, fmt.Errorf("freemail generate missing email: %s", truncate(string(body), 200))
	}
	if domainBanned(addr) {
		return Handle{}, fmt.Errorf("banned domain: %s", domainOf(addr))
	}
	return Handle{
		Kind:  "freemail",
		Email: strings.ToLower(addr),
		Token: p.cfg.FreeMailAPIKey,
		Base:  base,
	}, nil
}

func (p *Provider) freemailDomainIndex(want string) (int, error) {
	base := p.cfg.FreeMailBase
	req, err := http.NewRequest(http.MethodGet, base+"/api/domains", nil)
	if err != nil {
		return 0, err
	}
	p.freemailAuth(req)
	resp, err := p.cfg.HTTPClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != 200 {
		return 0, fmt.Errorf("domains status %d", resp.StatusCode)
	}
	want = strings.ToLower(strings.TrimSpace(want))
	var list []any
	if err := json.Unmarshal(body, &list); err == nil {
		for i, it := range list {
			switch v := it.(type) {
			case string:
				if strings.EqualFold(v, want) {
					return i, nil
				}
			case map[string]any:
				if d, _ := v["domain"].(string); strings.EqualFold(d, want) {
					return i, nil
				}
			}
		}
		return 0, fmt.Errorf("domain %s not found", want)
	}
	var doc map[string]any
	if err := json.Unmarshal(body, &doc); err != nil {
		return 0, err
	}
	for _, key := range []string{"domains", "results", "data"} {
		arr, _ := doc[key].([]any)
		for i, it := range arr {
			switch v := it.(type) {
			case string:
				if strings.EqualFold(v, want) {
					return i, nil
				}
			case map[string]any:
				if d, _ := v["domain"].(string); strings.EqualFold(d, want) {
					return i, nil
				}
			}
		}
	}
	return 0, fmt.Errorf("domain %s not found", want)
}

func (p *Provider) lolCreate() (Handle, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := time.Now()
	if now.Before(p.lolNextOK) {
		time.Sleep(time.Until(p.lolNextOK))
	}
	req, err := http.NewRequest(http.MethodPost, "https://api.tempmail.lol/v2/inbox/create", nil)
	if err != nil {
		return Handle{}, err
	}
	resp, err := p.cfg.HTTPClient.Do(req)
	if err != nil {
		return Handle{}, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var data map[string]any
	_ = json.Unmarshal(body, &data)
	if resp.StatusCode == 429 || strings.Contains(strings.ToLower(string(body)), "rate limit") {
		cool := 5 * time.Second
		p.lolNextOK = time.Now().Add(cool)
		return Handle{}, fmt.Errorf("lol rate limited status=%d", resp.StatusCode)
	}
	addr, _ := data["address"].(string)
	tok, _ := data["token"].(string)
	if addr == "" || tok == "" {
		p.lolNextOK = time.Now().Add(800 * time.Millisecond)
		return Handle{}, fmt.Errorf("lol create failed status=%d body=%s", resp.StatusCode, truncate(string(body), 80))
	}
	if domainBanned(addr) {
		p.lolNextOK = time.Now().Add(time.Duration(p.cfg.LOLIntervalMS) * time.Millisecond)
		return Handle{}, fmt.Errorf("lol domain banned: %s", domainOf(addr))
	}
	p.lolNextOK = time.Now().Add(time.Duration(p.cfg.LOLIntervalMS) * time.Millisecond)
	return Handle{Kind: "lol", Email: addr, Token: tok}, nil
}

func (p *Provider) mailtmCreate(base, password string) (Handle, error) {
	resp, err := p.cfg.HTTPClient.Get(base + "/domains")
	if err != nil {
		return Handle{}, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var doc map[string]any
	if err := json.Unmarshal(body, &doc); err != nil {
		return Handle{}, err
	}
	members, _ := doc["hydra:member"].([]any)
	var doms []string
	for _, m := range members {
		mm, _ := m.(map[string]any)
		if mm == nil {
			continue
		}
		d, _ := mm["domain"].(string)
		if d == "" || domainBanned(d) {
			continue
		}
		active, _ := mm["isActive"].(bool)
		priv, _ := mm["isPrivate"].(bool)
		if mm["isActive"] != nil && !active {
			continue
		}
		if priv {
			continue
		}
		doms = append(doms, d)
	}
	if len(doms) == 0 {
		return Handle{}, fmt.Errorf("no domain from %s", base)
	}
	rand.Shuffle(len(doms), func(i, j int) { doms[i], doms[j] = doms[j], doms[i] })
	var last error
	for _, dom := range doms {
		if len(doms) > 6 {
			// try at most 6
		}
		email := fmt.Sprintf("oc%s@%s", randStr(10), dom)
		payload := map[string]string{"address": email, "password": password}
		raw, _ := json.Marshal(payload)
		r, err := p.cfg.HTTPClient.Post(base+"/accounts", "application/json", strings.NewReader(string(raw)))
		if err != nil {
			last = err
			continue
		}
		_ = r.Body.Close()
		r2, err := p.cfg.HTTPClient.Post(base+"/token", "application/json", strings.NewReader(string(raw)))
		if err != nil {
			last = err
			continue
		}
		tb, _ := io.ReadAll(io.LimitReader(r2.Body, 1<<20))
		_ = r2.Body.Close()
		var tokDoc map[string]any
		_ = json.Unmarshal(tb, &tokDoc)
		tok, _ := tokDoc["token"].(string)
		if tok == "" {
			last = fmt.Errorf("no token")
			continue
		}
		return Handle{Kind: "mt", Email: email, Password: password, Token: tok, Base: base}, nil
	}
	if last == nil {
		last = fmt.Errorf("mailtm create failed")
	}
	return Handle{}, last
}

func (p *Provider) PollCode(h Handle, maxWait time.Duration) (string, error) {
	if maxWait <= 0 {
		maxWait = 2 * time.Minute
	}
	deadline := time.Now().Add(maxWait)
	for time.Now().Before(deadline) {
		text, err := p.fetch(h)
		if err == nil && text != "" {
			// freemail may already return a bare code
			if h.Kind == "freemail" || h.Kind == "custom" {
				clean := strings.TrimSpace(text)
				if reBare := regexp.MustCompile(`(?i)^[A-Z0-9]{6}$`); reBare.MatchString(strings.ReplaceAll(clean, "-", "")) {
					return strings.ReplaceAll(clean, "-", ""), nil
				}
			}
			if code := extractCode(text); code != "" {
				return code, nil
			}
		}
		time.Sleep(time.Second)
	}
	return "", fmt.Errorf("验证码超时")
}

func (p *Provider) fetch(h Handle) (string, error) {
	switch h.Kind {
	case "custom":
		u := strings.TrimRight(p.cfg.API, "/") + "/check/" + url.PathEscape(h.Email)
		resp, err := p.cfg.HTTPClient.Get(u)
		if err != nil {
			return "", err
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return "", fmt.Errorf("status %d", resp.StatusCode)
		}
		var doc map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&doc)
		if c, _ := doc["code"].(string); c != "" {
			return c, nil
		}
		return "", nil
	case "freemail":
		return p.freemailFetch(h)
	case "lol":
		resp, err := p.cfg.HTTPClient.Get("https://api.tempmail.lol/v2/inbox?token=" + url.QueryEscape(h.Token))
		if err != nil {
			return "", err
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
		var data map[string]any
		_ = json.Unmarshal(body, &data)
		items, _ := data["emails"].([]any)
		if items == nil {
			items, _ = data["messages"].([]any)
		}
		var b strings.Builder
		for _, it := range items {
			m, _ := it.(map[string]any)
			if m == nil {
				continue
			}
			fmt.Fprintf(&b, "%v\n%v\n%v\n", m["subject"], m["body"], m["html"])
		}
		return b.String(), nil
	case "mt":
		req, _ := http.NewRequest(http.MethodGet, h.Base+"/messages", nil)
		req.Header.Set("Authorization", "Bearer "+h.Token)
		req.Header.Set("Accept", "application/json")
		resp, err := p.cfg.HTTPClient.Do(req)
		if err != nil {
			return "", err
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
		var data map[string]any
		_ = json.Unmarshal(body, &data)
		msgs, _ := data["hydra:member"].([]any)
		if len(msgs) == 0 {
			return "", nil
		}
		m0, _ := msgs[0].(map[string]any)
		id, _ := m0["id"].(string)
		req2, _ := http.NewRequest(http.MethodGet, h.Base+"/messages/"+id, nil)
		req2.Header.Set("Authorization", "Bearer "+h.Token)
		resp2, err := p.cfg.HTTPClient.Do(req2)
		if err != nil {
			return "", err
		}
		defer resp2.Body.Close()
		b2, _ := io.ReadAll(io.LimitReader(resp2.Body, 2<<20))
		return string(b2), nil
	default:
		return "", fmt.Errorf("unknown handle kind")
	}
}

func (p *Provider) freemailFetch(h Handle) (string, error) {
	base := h.Base
	if base == "" {
		base = p.cfg.FreeMailBase
	}
	if base == "" {
		return "", fmt.Errorf("freemail base empty")
	}
	u := fmt.Sprintf("%s/api/emails?mailbox=%s&limit=10", base, url.QueryEscape(h.Email))
	req, err := http.NewRequest(http.MethodGet, u, nil)
	if err != nil {
		return "", err
	}
	if h.Token != "" {
		req.Header.Set("Authorization", "Bearer "+h.Token)
	} else {
		p.freemailAuth(req)
	}
	req.Header.Set("Accept", "application/json")
	resp, err := p.cfg.HTTPClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("freemail emails status %d", resp.StatusCode)
	}
	var list []any
	if err := json.Unmarshal(body, &list); err != nil {
		var doc map[string]any
		if err2 := json.Unmarshal(body, &doc); err2 != nil {
			return "", err
		}
		for _, k := range []string{"results", "emails", "data"} {
			if arr, ok := doc[k].([]any); ok {
				list = arr
				break
			}
		}
	}
	var b strings.Builder
	for _, it := range list {
		m, _ := it.(map[string]any)
		if m == nil {
			continue
		}
		if c, _ := m["verification_code"].(string); strings.TrimSpace(c) != "" {
			return strings.TrimSpace(c), nil
		}
		fmt.Fprintf(&b, "%v\n%v\n%v\n%v\n", m["subject"], m["preview"], m["content"], m["html_content"])
		// try detail for first few
		if id := fmt.Sprint(m["id"]); id != "" && id != "<nil>" {
			if detail, err := p.freemailDetail(base, id, h.Token); err == nil {
				if c := strings.TrimSpace(detail); c != "" {
					if extractCode(c) != "" || regexp.MustCompile(`(?i)^[A-Z0-9-]{6,7}$`).MatchString(c) {
						// if bare code returned
						if reBare := regexp.MustCompile(`(?i)^[A-Z0-9]{6}$`); reBare.MatchString(strings.ReplaceAll(c, "-", "")) {
							return strings.ReplaceAll(c, "-", ""), nil
						}
					}
					b.WriteString(detail)
					b.WriteByte('\n')
				}
			}
		}
	}
	return b.String(), nil
}

func (p *Provider) freemailDetail(base, id, token string) (string, error) {
	req, err := http.NewRequest(http.MethodGet, base+"/api/email/"+url.PathEscape(id), nil)
	if err != nil {
		return "", err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	} else {
		p.freemailAuth(req)
	}
	req.Header.Set("Accept", "application/json")
	resp, err := p.cfg.HTTPClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("status %d", resp.StatusCode)
	}
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		return string(body), nil
	}
	if c, _ := m["verification_code"].(string); strings.TrimSpace(c) != "" {
		return strings.TrimSpace(c), nil
	}
	return fmt.Sprintf("%v\n%v\n%v\n%v\n", m["subject"], m["content"], m["html_content"], m["preview"]), nil
}

func extractCode(text string) string {
	for _, re := range codeRe {
		if m := re.FindStringSubmatch(text); len(m) > 1 {
			return strings.ReplaceAll(m[1], "-", "")
		}
	}
	return ""
}

func domainBanned(emailOrDomain string) bool {
	dom := strings.ToLower(strings.TrimSpace(emailOrDomain))
	if i := strings.LastIndexByte(dom, '@'); i >= 0 {
		dom = dom[i+1:]
	}
	if _, ok := bannedDomains[dom]; ok {
		return true
	}
	parts := strings.Split(dom, ".")
	for i := 0; i < len(parts)-1; i++ {
		if _, ok := bannedDomains[strings.Join(parts[i:], ".")]; ok {
			return true
		}
	}
	return false
}

func domainOf(email string) string {
	if i := strings.LastIndexByte(email, '@'); i >= 0 {
		return email[i+1:]
	}
	return email
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
