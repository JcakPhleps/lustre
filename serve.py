#!/usr/bin/env python3
"""Tiny no-cache dev server for Lustre.

    python3 serve.py            # serves this folder on http://localhost:8777
    python3 serve.py 9000       # ...on a different port

Sends no-cache headers so the browser never serves a stale CSS/JS file —
you always see your latest edit on a plain refresh.
"""
import sys, http.server, socketserver

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8777

class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

with socketserver.TCPServer(("", PORT), NoCache) as httpd:
    print(f"Lustre → http://localhost:{PORT}  (no-cache; Ctrl+C to stop)")
    httpd.serve_forever()
