package web

import "embed"

// FS holds the panel static assets (index.html, app.js, styles.css).
//
//go:embed index.html app.js styles.css
var FS embed.FS
