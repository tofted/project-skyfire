#!/usr/bin/env python3
"""Skyfire local server: serves this folder on 127.0.0.1 and opens the game in the browser.
  python3 serve.py [--port 8187] [--no-open] [--touch]
  --touch opens the touch-screen layout (?touch=1), on a Mac with Chrome in its own app window (no browser toolbar).
Browsers do not run the game from file:// (ES modules, fetch), so the game needs this tiny server.
The port stays 8187 when it is free, so settings and records saved by the browser are kept between runs.
"""
import argparse, http.server, os, shutil, socket, subprocess, sys, urllib.request, webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
    '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream', '.wasm': 'application/wasm',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
}
MARK = b'Riders of the Cloud Sea'


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def guess_type(self, path):
        return TYPES.get(os.path.splitext(path)[1].lower()) or super().guess_type(path)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def log_message(self, *a):
        pass


def is_skyfire(port):
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/index.html', timeout=2) as r:
            return MARK in r.read()
    except Exception:
        return False


def open_browser(url, app=False):
    chrome = sys.platform == 'darwin' and os.path.exists('/Applications/Google Chrome.app')
    if chrome and app:
        # a separate profile makes Chrome start a new app window even when it is already running
        prof = os.path.expanduser('~/Library/Application Support/Skyfire/Browser')
        os.makedirs(prof, exist_ok=True)
        if subprocess.call(['open', '-na', 'Google Chrome', '--args', f'--app={url}', f'--user-data-dir={prof}',
                            '--no-first-run', '--no-default-browser-check', '--start-fullscreen']) == 0:
            return
    if chrome and subprocess.call(['open', '-a', 'Google Chrome', url]) == 0:
        return
    webbrowser.open(url)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8187)
    ap.add_argument('--no-open', action='store_true')
    ap.add_argument('--touch', action='store_true')
    args = ap.parse_args()
    query = '?touch=1' if args.touch else ''
    server = None
    for port in range(args.port, args.port + 20):
        if is_skyfire(port):                       # already running (another window): just open it
            url = f'http://127.0.0.1:{port}/'
            print(f'Skyfire is already running at {url}')
            if not args.no_open:
                open_browser(url + query, app=args.touch)
            return
        try:
            server = http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler)
            break
        except OSError:
            continue
    if server is None:
        sys.exit('Could not find a free port for the Skyfire server.')
    url = f'http://127.0.0.1:{server.server_address[1]}/'
    print(f'Skyfire is running at {url}')
    print('Keep this window open while you play. Close it (or press Ctrl+C) to stop.', flush=True)
    if not args.no_open:
        open_browser(url + query, app=args.touch)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
