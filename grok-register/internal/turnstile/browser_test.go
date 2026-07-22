package turnstile_test

import (
	"testing"

	"github.com/grok-free-register/grok-reg/internal/browser"
	"github.com/grok-free-register/grok-reg/internal/turnstile"
)

func TestBrowserProviderDefault(t *testing.T) {
	p := browser.FindChrome()
	t.Logf("chrome path: %s", p)
	if p == "" {
		t.Fatal("chrome/chromium not found on this machine")
	}
	pr := turnstile.New(turnstile.Options{Provider: "browser"})
	if pr.Name() != "browser" {
		t.Fatalf("provider name=%s", pr.Name())
	}
}

func TestNewDefaultsToBrowser(t *testing.T) {
	pr := turnstile.New(turnstile.Options{})
	if pr.Name() != "browser" {
		t.Fatalf("default provider=%s want browser", pr.Name())
	}
}
