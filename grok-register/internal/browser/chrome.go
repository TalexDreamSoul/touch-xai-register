package browser

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

// FindChrome returns a Chromium/Chrome executable path.
// Prefer CloakBrowser (stealth) over system chromium for Turnstile.
func FindChrome() string {
	if p := strings.TrimSpace(os.Getenv("CHROME_PATH")); p != "" {
		if fileExists(p) {
			return p
		}
	}

	// 1) CloakBrowser first — better against CF Turnstile than stock Chromium.
	if home, err := os.UserHomeDir(); err == nil {
		bases := []string{
			filepath.Join(home, ".cloakbrowser"),
			"/root/.cloakbrowser",
			"/home/charles/.cloakbrowser",
		}
		var matches []string
		for _, base := range bases {
			matches = append(matches, globOrNil(filepath.Join(base, "chromium-*", "chrome"))...)
			if runtime.GOOS == "darwin" {
				matches = append(matches, globOrNil(filepath.Join(base, "chromium-*", "Chromium.app", "Contents", "MacOS", "Chromium"))...)
			}
		}
		if len(matches) > 0 {
			sort.Strings(matches)
			return matches[len(matches)-1]
		}
	}

	// 2) System browsers
	var candidates []string
	switch runtime.GOOS {
	case "darwin":
		candidates = []string{
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			"/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		}
	case "linux":
		candidates = []string{
			"/usr/bin/google-chrome",
			"/usr/bin/google-chrome-stable",
			"/opt/google/chrome/chrome",
			"/usr/bin/chromium",
			"/usr/bin/chromium-browser",
			"/snap/bin/chromium",
			"/usr/bin/microsoft-edge",
			"/usr/bin/microsoft-edge-stable",
		}
	case "windows":
		candidates = []string{
			`C:\Program Files\Google\Chrome\Application\chrome.exe`,
			`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`,
		}
	}
	for _, p := range candidates {
		if fileExists(p) {
			return p
		}
	}
	for _, name := range []string{"google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"} {
		if p, err := exec.LookPath(name); err == nil {
			return p
		}
	}
	return ""
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

func globOrNil(pattern string) []string {
	m, err := filepath.Glob(pattern)
	if err != nil {
		return nil
	}
	return m
}
