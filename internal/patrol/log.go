package patrol

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const eventLogCap = 500

// appendEvent records a human-readable patrol/cleanup line for the panel log view.
// Also appends to GROK_HOME/logs/patrol.log when possible.
// Safe to call while holding s.mu (uses a separate lock).
func (s *Service) appendEvent(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	line := fmt.Sprintf("[%s] %s", time.Now().Format("15:04:05"), msg)

	s.logMu.Lock()
	s.eventLog = append(s.eventLog, line)
	if len(s.eventLog) > eventLogCap {
		s.eventLog = s.eventLog[len(s.eventLog)-eventLogCap:]
	}
	logPath := s.eventLogPath
	s.logMu.Unlock()

	if logPath == "" {
		logPath = filepath.Join(filepath.Dir(s.statePath), "logs", "patrol.log")
	}
	_ = os.MkdirAll(filepath.Dir(logPath), 0o700)
	f, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	_, _ = f.WriteString(line + "\n")
	_ = f.Close()
}

// EventLogs returns recent event lines (oldest first). tail<=0 means all buffered.
func (s *Service) EventLogs(tail int) []string {
	s.logMu.Lock()
	n := len(s.eventLog)
	needHydrate := n == 0
	s.logMu.Unlock()
	if needHydrate {
		s.hydrateEventLogFromFile()
	}
	s.logMu.Lock()
	defer s.logMu.Unlock()
	n = len(s.eventLog)
	if tail <= 0 || tail >= n {
		out := make([]string, n)
		copy(out, s.eventLog)
		return out
	}
	out := make([]string, tail)
	copy(out, s.eventLog[n-tail:])
	return out
}

func (s *Service) hydrateEventLogFromFile() {
	s.logMu.Lock()
	path := s.eventLogPath
	already := len(s.eventLog) > 0
	s.logMu.Unlock()
	if already {
		return
	}
	if path == "" {
		path = filepath.Join(filepath.Dir(s.statePath), "logs", "patrol.log")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	lines := strings.Split(strings.ReplaceAll(string(b), "\r\n", "\n"), "\n")
	var cleaned []string
	for _, ln := range lines {
		ln = strings.TrimRight(ln, "\r")
		if ln != "" {
			cleaned = append(cleaned, ln)
		}
	}
	if len(cleaned) > eventLogCap {
		cleaned = cleaned[len(cleaned)-eventLogCap:]
	}
	s.logMu.Lock()
	if len(s.eventLog) == 0 {
		s.eventLog = cleaned
	}
	s.logMu.Unlock()
}

// SetEventLogPath overrides the patrol event log file path (tests).
func (s *Service) SetEventLogPath(path string) {
	s.logMu.Lock()
	s.eventLogPath = path
	s.logMu.Unlock()
}
