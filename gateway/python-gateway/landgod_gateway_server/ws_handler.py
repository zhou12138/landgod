"""WebSocket handler for worker connections."""
from __future__ import annotations

import asyncio
import json
import logging
import uuid

import websockets

from .security import sign_tool_call

logger = logging.getLogger("landgod.ws")


class WSHandler:
    """Manages WebSocket worker connections."""

    def __init__(self, gateway) -> None:
        self.gw = gateway
        # connection_id -> {ws, binding, pending_requests, token}
        self.connections: dict[str, dict] = {}

    async def handle(self, websocket) -> None:
        # Only accept /api/mcphub/ws
        # websockets >= 13: path from request
        path = websocket.request.path if hasattr(websocket, 'request') and websocket.request else "/api/mcphub/ws"
        if path != "/api/mcphub/ws":
            await websocket.close(4000, "Invalid path")
            return

        # Token auth
        auth = websocket.request.headers.get("Authorization", "")
        token = auth.split(" ", 1)[1] if auth.startswith("Bearer ") else ""
        if not await self.gw.is_valid_token(token):
            logger.warning("Connection rejected: invalid token")
            await websocket.close(4001, "Invalid token")
            return

        connection_id = f"conn-{uuid.uuid4()}"
        logger.info(f"Client connected: {connection_id}")

        # Send session_opened
        await websocket.send(json.dumps({
            "type": "event",
            "event": "session_opened",
            "payload": {"connection_id": connection_id},
        }))

        conn_info = {
            "ws": websocket,
            "binding": None,
            "pending_requests": {},
            "token": token,
        }
        self.connections[connection_id] = conn_info

        # Heartbeat
        ping_task = asyncio.create_task(self._ping_loop(websocket, connection_id))

        try:
            async for raw in websocket:
                try:
                    msg = json.loads(raw)
                    await self._on_message(connection_id, msg)
                except json.JSONDecodeError:
                    logger.error("Invalid JSON from client")
                except Exception as e:
                    logger.error(f"Message handling error: {e}")
        except websockets.ConnectionClosed:
            pass
        finally:
            ping_task.cancel()
            self.connections.pop(connection_id, None)
            await self.gw.store.delete_client(connection_id)
            logger.info(f"Client disconnected: {connection_id}")

    async def _ping_loop(self, ws, connection_id: str) -> None:
        try:
            while True:
                await asyncio.sleep(30)
                try:
                    await ws.ping()
                    # Refresh TTL in store
                    info = self.connections.get(connection_id)
                    if info and info["binding"]:
                        await self.gw.store.set_client(connection_id, {
                            "connectionId": connection_id,
                            "clientId": info["binding"]["clientId"],
                            "clientName": info["binding"]["clientName"],
                            "labels": info["binding"].get("labels", {}),
                            "resources": info["binding"].get("resources", {}),
                            "sessionId": info["binding"]["sessionId"],
                            "node_id": getattr(self.gw, "node_id", "local"),
                            "connected": True,
                        })
                except Exception:
                    break
        except asyncio.CancelledError:
            pass

    async def _on_message(self, connection_id: str, msg: dict) -> None:
        conn = self.connections.get(connection_id)
        if not conn:
            return
        ws = conn["ws"]
        task_id = msg.get("id")
        method = msg.get("method")

        if method == "ping":
            await ws.send(json.dumps({
                "type": "res", "id": task_id, "ok": True,
                "payload": {"message": "Pong!"},
            }))

        elif method == "register":
            params = msg.get("params", {})
            session_id = f"session-{uuid.uuid4()}"
            server_key_id = f"key-{uuid.uuid4()}"
            user_id = f"user-{uuid.uuid4()}"

            binding = {
                "userId": user_id,
                "clientId": params.get("client_id", ""),
                "clientName": params.get("client_name", ""),
                "labels": params.get("labels", {}),
                "resources": params.get("resources", {}),
                "connectionId": connection_id,
                "sessionId": session_id,
                "serverKeyId": server_key_id,
            }

            # Clean up stale connections with same clientName
            stale = [
                cid for cid, c in self.connections.items()
                if c["binding"] and c["binding"]["clientName"] == binding["clientName"] and cid != connection_id
            ]
            for cid in stale:
                old = self.connections.pop(cid, None)
                if old:
                    try:
                        await old["ws"].close(1000, "Replaced by new connection")
                    except Exception:
                        pass
                    await self.gw.store.delete_client(cid)
                    logger.info(f"Removed stale connection: {cid}")

            conn["binding"] = binding

            # Store in state store
            await self.gw.store.set_client(connection_id, {
                "connectionId": connection_id,
                "clientId": binding["clientId"],
                "clientName": binding["clientName"],
                "labels": binding.get("labels", {}),
                "resources": binding.get("resources", {}),
                "sessionId": session_id,
                "node_id": getattr(self.gw, "node_id", "local"),
                "connected": True,
            })

            await ws.send(json.dumps({
                "type": "res", "id": task_id, "ok": True,
                "payload": {
                    "user_id": user_id,
                    "client_id": binding["clientId"],
                    "connection_id": connection_id,
                    "session_id": session_id,
                    "server_key_id": server_key_id,
                    "server_public_key": self.gw.public_key_pem,
                    "server_time": self._now_iso(),
                },
            }))
            logger.info(f"[register] {binding['clientName']} session={session_id} conn={connection_id}")

            # Drain queued tasks for this worker
            if hasattr(self.gw, '_drain_queue'):
                asyncio.create_task(self.gw._drain_queue(self.gw, connection_id, binding["clientName"], binding.get("labels", {})))

        elif method == "update_tools":
            tools_data = (msg.get("params") or {}).get("tools", {})
            tools = list(tools_data.keys())
            # Store tools in connection info
            conn["tools"] = tools_data
            await ws.send(json.dumps({
                "type": "res", "id": task_id, "ok": True,
                "payload": {"accepted": True},
            }))
            logger.info(f"[update_tools] {', '.join(tools)}")

        elif method == "resource_heartbeat":
            resources = (msg.get("params") or {}).get("resources", {})
            if conn["binding"]:
                conn["binding"]["resources"] = resources
            await ws.send(json.dumps({
                "type": "res", "id": task_id, "ok": True,
                "payload": {"accepted": True},
            }))

        elif msg.get("type") == "res":
            # tool_call response from worker
            pending = conn["pending_requests"]
            if task_id in pending:
                pending[task_id].set_result(msg)

        elif msg.get("type") == "event":
            # tool_result / tool_error event from worker
            req_id = (msg.get("payload") or {}).get("request_id")
            pending = conn["pending_requests"]
            if req_id and req_id in pending:
                pending[req_id].set_result(msg)
            else:
                logger.info(f"[event] {msg.get('event')}")

        else:
            await ws.send(json.dumps({
                "type": "res", "id": task_id, "ok": False,
                "payload": {"error": f"Unknown method: {method}"},
            }))

    async def send_tool_call(self, connection_id: str, tool_name: str, arguments: dict, timeout: int = 300000) -> dict | None:
        """Send tool_call to a locally-connected worker. Returns response or None if not local."""
        conn = self.connections.get(connection_id)
        if not conn or not conn["binding"]:
            return None

        ws = conn["ws"]
        if ws.protocol.state.name == "CLOSED":
            return None

        request_id = f"tool_call-{uuid.uuid4()}"
        meta = sign_tool_call(request_id, tool_name, arguments, conn["binding"], self.gw.private_key)

        message = {
            "type": "req",
            "id": request_id,
            "method": "tool_call",
            "params": {
                "tool_name": tool_name,
                "arguments": arguments,
                "meta": meta,
            },
        }

        future = asyncio.get_event_loop().create_future()
        conn["pending_requests"][request_id] = future

        await ws.send(json.dumps(message))
        logger.info(f"[tool_call] Sent {tool_name} to {connection_id}")

        try:
            return await asyncio.wait_for(future, timeout=timeout / 1000)
        except asyncio.TimeoutError:
            conn["pending_requests"].pop(request_id, None)
            raise TimeoutError(f"tool_call {tool_name} timed out after {timeout}ms")

    def find_connection_by_client_name(self, client_name: str) -> str | None:
        """Find local connection_id by clientName."""
        for cid, info in self.connections.items():
            if info["binding"] and info["binding"]["clientName"] == client_name and info["ws"].protocol.state.name != "CLOSED":
                return cid
        return None

    def find_connection_by_labels(self, labels: dict) -> str | None:
        """Find local connection_id matching all labels."""
        for cid, info in self.connections.items():
            if not info["binding"] or info["ws"].protocol.state.name == "CLOSED":
                continue
            worker_labels = info["binding"].get("labels", {})
            if all(worker_labels.get(k) == v for k, v in labels.items()):
                return cid
        return None

    def get_first_open_connection(self) -> str | None:
        for cid, info in self.connections.items():
            if info["ws"].protocol.state.name != "CLOSED":
                return cid
        return None

    @staticmethod
    def _now_iso() -> str:
        from datetime import datetime, timezone
        return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
