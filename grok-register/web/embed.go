package web

import "embed"

// FS holds the panel static assets (index.html, ...).
//
//go:embed index.html
var FS embed.FS
