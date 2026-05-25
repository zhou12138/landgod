"""Cluster coordination via Redis Pub/Sub for distributed tool_call routing."""
from __future__ import annotations

import asyncio
import json
import logging
import uuid

logger = logging.getLogger("landgod.cluster")


class ClusterCoordinator:
    """Routes tool_call requests across nodes via Redis Pub/Sub."""

    CHANNEL = "lgw:tool_call_req"
    RESP_CHANNEL_PREFIX = "lgw:tool_call_resp:"

    def __init__(self, redis_url: str, node_id: str | None = None) -> None:
        self._redis_url = redis_url
        self.node_id = node_id or f"node-{uuid.uuid4().hex[:8]}"
        self._redis = None
        self._pubsub = None
        self._listener_task: asyncio.Task | None = None
        # connection_id -> local handler coroutine
        self._local_handler = None  # set by gateway

    async def start(self, local_handler) -> None:
        import redis.asyncio as aioredis
        self._redis = aioredis.from_url(self._redis_url, decode_responses=True)
        self._local_handler = local_handler
        self._pubsub = self._redis.pubsub()
        await self._pubsub.subscribe(self.CHANNEL)
        self._listener_task = asyncio.create_task(self._listen())
        logger.info(f"Cluster node {self.node_id} started")

    async def _listen(self) -> None:
        try:
            async for msg in self._pubsub.listen():
                if msg["type"] != "message":
                    continue
                try:
                    data = json.loads(msg["data"])
                    if data.get("source_node") == self.node_id:
                        continue  # skip own requests
                    await self._handle_remote_request(data)
                except Exception as e:
                    logger.error(f"Cluster listener error: {e}")
        except asyncio.CancelledError:
            pass

    async def _handle_remote_request(self, data: dict) -> None:
        """Handle a tool_call request from another node."""
        conn_id = data["connection_id"]
        # Check if we hold this connection locally
        if self._local_handler is None:
            return
        result = await self._local_handler(conn_id, data["tool_name"], data.get("arguments", {}), data.get("timeout", 300000))
        if result is not None:
            # Publish response back
            resp_channel = f"{self.RESP_CHANNEL_PREFIX}{data['request_id']}"
            await self._redis.publish(resp_channel, json.dumps(result))

    async def route_tool_call(self, connection_id: str, tool_name: str, arguments: dict, timeout: int = 300000) -> dict | None:
        """Try local first, then broadcast to cluster. Returns result or None."""
        # Try local
        result = await self._local_handler(connection_id, tool_name, arguments, timeout)
        if result is not None:
            return result

        # Broadcast to cluster
        request_id = str(uuid.uuid4())
        resp_channel = f"{self.RESP_CHANNEL_PREFIX}{request_id}"

        sub = self._redis.pubsub()
        await sub.subscribe(resp_channel)

        await self._redis.publish(self.CHANNEL, json.dumps({
            "source_node": self.node_id,
            "request_id": request_id,
            "connection_id": connection_id,
            "tool_name": tool_name,
            "arguments": arguments,
            "timeout": timeout,
        }))

        # Wait for response
        try:
            deadline = asyncio.get_event_loop().time() + (timeout / 1000)
            async for msg in sub.listen():
                if msg["type"] != "message":
                    if asyncio.get_event_loop().time() > deadline:
                        break
                    continue
                await sub.unsubscribe(resp_channel)
                await sub.aclose()
                return json.loads(msg["data"])
        except asyncio.TimeoutError:
            pass
        finally:
            try:
                await sub.unsubscribe(resp_channel)
                await sub.aclose()
            except Exception:
                pass
        return None

    async def stop(self) -> None:
        if self._listener_task:
            self._listener_task.cancel()
            try:
                await self._listener_task
            except asyncio.CancelledError:
                pass
        if self._pubsub:
            await self._pubsub.unsubscribe()
            await self._pubsub.aclose()
        if self._redis:
            await self._redis.aclose()
