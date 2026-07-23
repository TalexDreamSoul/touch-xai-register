package email

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/grok-free-register/grok-reg/internal/config"
)

func TestFreemailCreateAndFetchCode(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/domains", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode([]string{"mail.example.com", "other.test"})
	})
	mux.HandleFunc("/api/generate", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer secret-jwt" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"email":   "ocdemo@mail.example.com",
			"expires": time.Now().Add(time.Hour).UnixMilli(),
		})
	})
	mux.HandleFunc("/api/emails", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("mailbox") == "" {
			http.Error(w, "mailbox required", 400)
			return
		}
		_ = json.NewEncoder(w).Encode([]map[string]any{
			{
				"id":                "1",
				"subject":           "Your verification code",
				"verification_code": "AB12CD",
				"preview":           "code AB12CD",
			},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	p := New(Config{
		Mode:           config.EmailFreemail,
		Domain:         "mail.example.com",
		FreeMailBase:   srv.URL,
		FreeMailAPIKey: "secret-jwt",
		HTTPClient:     srv.Client(),
	})
	h, err := p.Create()
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if h.Kind != "freemail" {
		t.Fatalf("kind=%s", h.Kind)
	}
	if !strings.HasSuffix(h.Email, "@mail.example.com") {
		t.Fatalf("email=%s", h.Email)
	}
	code, err := p.PollCode(h, 3*time.Second)
	if err != nil {
		t.Fatalf("poll: %v", err)
	}
	if code != "AB12CD" {
		t.Fatalf("code=%s", code)
	}
}

func TestCustomCheckViaBridgeShape(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/check/", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"code": "XY99ZZ"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	p := New(Config{
		Mode:       config.EmailCustom,
		Domain:     "example.com",
		API:        srv.URL,
		HTTPClient: srv.Client(),
	})
	h, err := p.Create()
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	code, err := p.PollCode(h, 2*time.Second)
	if err != nil {
		t.Fatalf("poll: %v", err)
	}
	if code != "XY99ZZ" {
		t.Fatalf("code=%s", code)
	}
}
