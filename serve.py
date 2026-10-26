#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
serve.py —— 零依赖本地静态服务器

为什么需要它：
  浏览器在 file:// 协议下会以 CORS 为由拒绝 fetch()，
  而本作的所有游戏数据都是运行时 fetch 的 JSON。
  所以必须通过 http:// 访问。

用法：
  python serve.py            # 默认 http://127.0.0.1:5173
  python serve.py 8080       # 指定端口
"""

import functools
import http.server
import os
import socketserver
import sys
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5173


class Handler(http.server.SimpleHTTPRequestHandler):
    # Windows 上注册表里的 MIME 有时会把 .js 认成 text/plain，
    # 导致 <script type="module"> 被浏览器拒绝。这里强制覆盖。
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".svg": "image/svg+xml",
        ".md": "text/markdown; charset=utf-8",
    }

    def end_headers(self):
        # 开发期禁用缓存，改完 JSON 刷新即可生效
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # 静音访问日志，只保留错误
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    os.chdir(ROOT)
    handler = functools.partial(Handler, directory=ROOT)

    with Server(("127.0.0.1", PORT), handler) as httpd:
        url = f"http://127.0.0.1:{PORT}/"
        print("=" * 56)
        print("  国策 · Focus Engine")
        print(f"  {url}")
        print("  Ctrl+C 停止")
        print("=" * 56)
        try:
            if not os.environ.get("NO_BROWSER"):
                webbrowser.open(url)
        except Exception:
            pass
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n已停止。")


if __name__ == "__main__":
    main()
