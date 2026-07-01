"""Basic tests for LandGod Gateway Python."""
import asyncio
import json
import pytest


def test_security_sign_tool_call():
    from landgod_gateway_server.security import generate_ed25519_keypair, sign_tool_call

    pub_pem, priv_key = generate_ed25519_keypair()
    binding = {
        "userId": "user-1",
        "clientId": "client-1",
        "connectionId": "conn-1",
        "sessionId": "session-1",
        "serverKeyId": "key-1",
    }
    meta = sign_tool_call("req-1", "test_tool", {"arg": "val"}, binding, priv_key)
    assert meta["schema_version"] == "1.0"
    assert meta["request_id"] == "req-1"
    assert "signature" in meta
    assert "nonce" in meta
    assert "body_sha256" in meta


def test_canonicalize_json():
    from landgod_gateway_server.security import _canonicalize_json
    result = _canonicalize_json({"b": 2, "a": 1})
    assert result == '{"a":1,"b":2}'


def test_memory_store():
    from landgod_gateway_server.store import MemoryStore

    async def _run():
        store = MemoryStore()
        await store.set_client("c1", {"name": "test"})
        assert await store.get_client("c1") == {"name": "test"}
        clients = await store.list_clients()
        assert len(clients) == 1
        await store.delete_client("c1")
        assert await store.get_client("c1") is None

        await store.set_token("tok1", {"device_name": "dev1", "active": True})
        assert (await store.get_token("tok1"))["active"] is True
        tokens = await store.list_tokens()
        assert len(tokens) == 1

    asyncio.run(_run())


def test_gateway_accepts_active_store_token():
    from landgod_gateway_server.gateway import Gateway

    async def _run():
        gw = Gateway(auth_token="root-token")
        await gw.store.set_token("worker-token", {"device_name": "worker-1", "active": True})

        assert await gw.is_valid_token("root-token") is True
        assert await gw.is_valid_token("worker-token") is True
        assert await gw.is_valid_token("missing-token") is False

        await gw.store.close()

    asyncio.run(_run())


@pytest.mark.asyncio
async def test_cluster_route_tool_call_times_out_without_response():
    from landgod_gateway_server.cluster import ClusterCoordinator

    class FakePubSub:
        async def subscribe(self, *_args):
            return None

        async def unsubscribe(self, *_args):
            return None

        async def aclose(self):
            return None

        async def listen(self):
            while True:
                await asyncio.sleep(1)
                yield {"type": "subscribe"}

    class FakeRedis:
        def pubsub(self):
            return FakePubSub()

        async def publish(self, *_args):
            return None

    async def local_handler(*_args, **_kwargs):
        return None

    cluster = ClusterCoordinator("redis://unused")
    cluster._redis = FakeRedis()
    cluster._local_handler = local_handler

    result = await cluster.route_tool_call("conn-1", "shell_execute", {}, timeout=50)
    assert result is None


def test_extract_audit_entries_from_tool_result_text():
    from landgod_gateway_server.http_handler import _extract_audit_entries

    audit_entries = [{"id": "1", "command": "hostname"}, {"id": "2", "command": "whoami"}]
    tool_result = {
        "type": "event",
        "event": "tool_result_chunk",
        "payload": {
            "data": {
                "text": json.dumps({"entries": audit_entries, "total": 2})
            }
        }
    }

    assert _extract_audit_entries(tool_result) == audit_entries


def test_extract_audit_entries_returns_empty_on_invalid_payload():
    from landgod_gateway_server.http_handler import _extract_audit_entries

    assert _extract_audit_entries({"payload": {"data": {"text": "not-json"}}}) == []
    assert _extract_audit_entries({"stdout": "plain text"}) == []
