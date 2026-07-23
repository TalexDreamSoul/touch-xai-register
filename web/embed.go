package web

import "embed"

// FS is the static panel assets (Next.js + Cloudflare Kumo export).
// Root contains index.html, _next/, and app routes.
//
//go:embed all:out/*
var FS embed.FS
