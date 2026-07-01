"""Core Gateway class - orchestrates WS, HTTP, store, and cluster."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid

import websockets
from aiohttp import web

from .security import generate_ed25519_keypair
from .store import MemoryStore, RedisStore
from .ws_handler import WSHandler
from .http_handler import create_http_app
from .cluster import ClusterCoordinator

logger = logging.getLogger("landgod.gateway")


class Gateway:
    def __init__(
        self,
        ws_port: int = 8080,
        http_port: int = 8081,
        redis_url: str | None = None,
        auth_token: str | None = None,
        data_dir: str | None = None,
    ) -> None:
        self.ws_port = ws_port
        self.http_port = http_port
        self.redis_url = redis_url
        self.auth_token = auth_token or os.environ.get("LANDGOD_AUTH_TOKEN", "")
        if not self.auth_token:
            raise ValueError("Auth token is required. Use --token or set LANDGOD_AUTH_TOKEN environment variable.")
        self.data_dir = data_dir or os.path.join(os.path.expanduser("~"), ".landgod-gateway")
        self.node_id = f"node-{uuid.uuid4().hex[:8]}"

        # Ed25519 keypair
        self.public_key_pem, self.private_key = generate_ed25519_keypair()
        logger.info("Server Ed25519 key pair generated.")

        # Store
        if redis_url:
            self.store = RedisStore(redis_url)
        else:
            self.store = MemoryStore()

        # WS handler
        self.ws_handler = WSHandler(self)

        # Cluster
        self.cluster: ClusterCoordinator | None = None
        if redis_url:
            self.cluster = ClusterCoordinator(redis_url, self.node_id)

        # Load legacy tokens
        self._load_tokens()

    def _load_tokens(self) -> None:
        """Register the single auth token. No tokens.json file used."""
        os.makedirs(self.data_dir, exist_ok=True)
        # Only the startup token is valid — no file-based token registry
        if isinstance(self.store, MemoryStore):
            self.store.tokens.clear()
            self.store.tokens[self.auth_token] = {"device_name": "*", "created_at": "startup", "active": True}
        logger.info(f"Auth token registered (single-token mode)")

    def _save_tokens(self) -> None:
        pass  # Single-token mode: no file persistence

    async def is_valid_token(self, token: str) -> bool:
        """Accept the startup token and any active token created via the token APIs."""
        if not token:
            return False
        if token == self.auth_token:
            return True

        token_info = await self.store.get_token(token)
        return bool(token_info and token_info.get("active", True))

    async def start(self) -> None:
        """Start the gateway (WS + HTTP servers)."""
        # Start cluster if configured
        if self.cluster:
            await self.cluster.start(self.ws_handler.send_tool_call)

        # Start WebSocket server
        self._ws_server = await websockets.serve(
            self.ws_handler.handle,
            "0.0.0.0",
            self.ws_port,
            ping_interval=None,  # we handle pings ourselves
        )
        logger.info(f"WebSocket server running at ws://0.0.0.0:{self.ws_port}")

        # Start HTTP server
        self._http_app = create_http_app(self)
        self._http_runner = web.AppRunner(self._http_app)
        await self._http_runner.setup()
        site = web.TCPSite(self._http_runner, "0.0.0.0", self.http_port)
        await site.start()
        logger.info(f"HTTP API server running at http://0.0.0.0:{self.http_port}")
        logger.info("")
        logger.info("=== API Endpoints ===")
        logger.info("GET  /tools      - 列出已注册的工具")
        logger.info("GET  /health      - 健康检查")
        logger.info("GET  /clients     - 列出已连接的客户端")
        logger.info("POST /tool_call   - 发送工具调用")
        logger.info("POST /tokens      - 创建 Token")
        logger.info("GET  /tokens      - 列出 Token")
        logger.info("DELETE /tokens/:t - 吊销 Token")

    async def stop(self) -> None:
        if self.cluster:
            await self.cluster.stop()
        self._ws_server.close()
        await self._ws_server.wait_closed()
        await self._http_runner.cleanup()
        await self.store.close()
        self._save_tokens()
        logger.info("Gateway stopped.")

    async def run_forever(self) -> None:
        await self.start()
        try:
            await asyncio.Future()  # run forever
        except asyncio.CancelledError:
            pass
        finally:
            await self.stop()
