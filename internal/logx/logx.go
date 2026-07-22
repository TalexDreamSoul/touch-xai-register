package logx

import (
	"fmt"
	"io"
	"os"
	"sync"
	"time"
)

type Logger struct {
	mu   sync.Mutex
	out  io.Writer
	file *os.File
}

func New(path string) (*Logger, error) {
	l := &Logger{out: os.Stdout}
	if path != "" {
		f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			return nil, err
		}
		l.file = f
		l.out = io.MultiWriter(os.Stdout, f)
	}
	return l, nil
}

func (l *Logger) Close() error {
	if l.file != nil {
		return l.file.Close()
	}
	return nil
}

func (l *Logger) log(prefix, msg string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	ts := time.Now().Format("15:04:05")
	_, _ = fmt.Fprintf(l.out, "[%s] %s %s\n", ts, prefix, msg)
}

func (l *Logger) Info(msg string)  { l.log("INFO", msg) }
func (l *Logger) OK(msg string)    { l.log("✓", msg) }
func (l *Logger) Start(msg string) { l.log("→", msg) }
func (l *Logger) Warn(msg string)  { l.log("!", msg) }
func (l *Logger) Err(msg string)   { l.log("✗", msg) }
func (l *Logger) Debug(msg string) { l.log("DBG", msg) }

func (l *Logger) Infof(f string, a ...any)  { l.Info(fmt.Sprintf(f, a...)) }
func (l *Logger) OKf(f string, a ...any)    { l.OK(fmt.Sprintf(f, a...)) }
func (l *Logger) Startf(f string, a ...any) { l.Start(fmt.Sprintf(f, a...)) }
func (l *Logger) Warnf(f string, a ...any)  { l.Warn(fmt.Sprintf(f, a...)) }
func (l *Logger) Errf(f string, a ...any)   { l.Err(fmt.Sprintf(f, a...)) }
func (l *Logger) Debugf(f string, a ...any) { l.Debug(fmt.Sprintf(f, a...)) }
