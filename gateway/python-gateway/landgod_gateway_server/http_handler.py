"""HTTP API handler using aiohttp."""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone

from aiohttp import web

logger = logging.getLogger("landgod.http")

# In-memory task store (shared across requests)
_tasks: dict[str, dict] = {}
_task_queue: list[dict] = []
TASK_TTL = 3600  # 1 hour


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _create_task(request_info: dict) -> str:
    task_id = f"task-{uuid.uuid4()}"
    _tasks[task_id] = {
        "taskId": task_id,
        "status": "pending",
        "result": None,
        "error": None,
        "createdAt": _now_iso(),
        "completedAt": None,
        "request": request_info,
    }
    return task_id


def _complete_task(task_id: str, result: dict) -> None:
    if task_id in _tasks:
        _tasks[task_id]["status"] = "completed"
        _tasks[task_id]["result"] = result
        _tasks[task_id]["completedAt"] = _now_iso()


def _fail_task(task_id: str, error: str) -> None:
    if task_id in _tasks:
        _tasks[task_id]["status"] = "failed"
        _tasks[task_id]["error"] = error
        _tasks[task_id]["completedAt"] = _now_iso()


async def _drain_queue(gw, connection_id: str, client_name: str, worker_labels: dict) -> None:
    """Execute queued tasks matching this newly-connected worker."""
    to_remove = []
    for i, queued in enumerate(_task_queue):
        match = False
        if queued.get("clientName") and queued["clientName"] == client_name:
            match = True
        elif queued.get("labels") and isinstance(queued["labels"], dict):
            match = all(worker_labels.get(k) == v for k, v in queued["labels"].items())
        if match:
            to_remove.append(i)
            tid = queued["taskId"]
            asyncio.create_task(_execute_queued(gw, connection_id, queued, tid))
    for i in reversed(to_remove):
        _task_queue.pop(i)


async def _execute_queued(gw, connection_id: str, queued: dict, task_id: str) -> None:
    try:
        result = await gw.ws_handler.send_tool_call(
            connection_id, queued["tool_name"], queued.get("arguments", {}), queued.get("timeout", 300000)
        )
        _complete_task(task_id, result)
        logger.info(f"[queue] Drained task {task_id}")
    except Exception as e:
        _fail_task(task_id, str(e))
        logger.error(f"[queue] Task {task_id} failed: {e}")


def create_http_app(gateway) -> web.Application:
    app = web.Application()
    app["gw"] = gateway

    app.router.add_get("/health", health)
    app.router.add_get("/clients", clients)
    app.router.add_get("/tools", tools)
    app.router.add_post("/tool_call", tool_call)
    app.router.add_post("/batch_tool_call", batch_tool_call)
    app.router.add_get("/tasks/{task_id}", get_task)
    app.router.add_get("/tasks", list_tasks)
    app.router.add_get("/audit", audit)
    app.router.add_post("/tokens", create_token)
    app.router.add_get("/tokens", list_tokens)
    app.router.add_delete("/tokens/{token}", revoke_token)

    # Expose drain_queue for ws_handler to call on register
    gateway._drain_queue = _drain_queue

    return app


async def health(request: web.Request) -> web.Response:
    gw = request.app["gw"]
    tokens = await gw.store.list_tokens()
    all_clients = await gw.store.list_clients()
    return web.json_response({
        "status": "ok",
        "connectedClients": len(all_clients),
        "registeredTokens": len(tokens),
        "wsPort": gw.ws_port,
        "httpPort": gw.http_port,
    })


async def clients(request: web.Request) -> web.Response:
    gw = request.app["gw"]
    all_clients = await gw.store.list_clients()
    result = []
    seen = set()
    for cid, info in gw.ws_handler.connections.items():
        if info["ws"].protocol.state.name != "CLOSED" and info["binding"]:
            seen.add(cid)
            result.append({
                "connectionId": cid,
                "clientId": info["binding"]["clientId"],
                "clientName": info["binding"]["clientName"],
                "labels": info["binding"].get("labels", {}),
                "resources": info["binding"].get("resources", {}),
                "sessionId": info["binding"]["sessionId"],
                "connected": True,
            })
    for c in all_clients:
        if c.get("connectionId") not in seen:
            result.append(c)
    return web.json_response({"clients": result})


async def tools(request: web.Request) -> web.Response:
    gw = request.app["gw"]
    result = []
    for conn_id, info in gw.ws_handler.connections.items():
        if info["binding"]:
            tool_names = list((info.get("tools") or {}).keys())
            result.append({
                "clientName": info["binding"]["clientName"],
                "connectionId": conn_id,
                "toolCount": len(tool_names),
                "tools": tool_names,
            })
    return web.json_response({"tools": result})


async def _resolve_target(gw, body: dict) -> str | None:
    """Resolve target connection_id from clientName, labels, or connection_id."""
    connection_id = body.get("connection_id")
    client_name = body.get("clientName") or body.get("client_name") or (body.get("target", {}) or {}).get("clientName")
    labels = body.get("labels")

    if not connection_id and client_name:
        connection_id = gw.ws_handler.find_connection_by_client_name(client_name)
        if not connection_id and gw.cluster:
            for c in await gw.store.list_clients():
                if c.get("clientName") == client_name:
                    connection_id = c["connectionId"]
                    break

    if not connection_id and labels and isinstance(labels, dict):
        connection_id = gw.ws_handler.find_connection_by_labels(labels)
        if not connection_id and gw.cluster:
            for c in await gw.store.list_clients():
                wl = c.get("labels", {})
                if all(wl.get(k) == v for k, v in labels.items()):
                    connection_id = c["connectionId"]
                    break

    if not connection_id:
        connection_id = gw.ws_handler.get_first_open_connection()

    return connection_id


async def _execute_tool_call(gw, connection_id: str, tool_name: str, arguments: dict, timeout: int) -> dict:
    if gw.cluster:
        result = await gw.cluster.route_tool_call(connection_id, tool_name, arguments, timeout)
    else:
        result = await gw.ws_handler.send_tool_call(connection_id, tool_name, arguments, timeout)
    if result is None:
        raise ConnectionError("Client not reachable")
    return result


async def tool_call(request: web.Request) -> web.Response:
    gw = request.app["gw"]
    is_async = request.query.get("async") == "true"
    is_queue = request.query.get("queue") == "true"

    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    tool_name = body.get("tool_name")
    if not tool_name:
        return web.json_response({"error": "Missing tool_name"}, status=400)

    arguments = body.get("arguments", {})
    timeout = body.get("timeout", 300000)
    client_name = body.get("clientName") or body.get("client_name")
    labels = body.get("labels")

    try:
        connection_id = await _resolve_target(gw, body)
        if not connection_id:
            if is_queue:
                task_id = _create_task({"clientName": client_name, "labels": labels, "tool_name": tool_name, "arguments": arguments, "timeout": timeout})
                _task_queue.append({"taskId": task_id, "clientName": client_name, "labels": labels, "tool_name": tool_name, "arguments": arguments, "timeout": timeout, "createdAt": _now_iso()})
                logger.info(f"[queue] Task {task_id} queued")
                return web.json_response({"taskId": task_id, "status": "queued"}, status=202)
            target_desc = client_name or (json.dumps(labels) if labels else "any")
            return web.json_response({"error": f"No connected client: {target_desc}"}, status=404)

        if is_async:
            task_id = _create_task({"clientName": client_name, "labels": labels, "tool_name": tool_name, "arguments": arguments, "timeout": timeout})

            async def _bg():
                try:
                    result = await _execute_tool_call(gw, connection_id, tool_name, arguments, timeout)
                    _complete_task(task_id, result)
                except Exception as e:
                    _fail_task(task_id, str(e))

            asyncio.create_task(_bg())
            return web.json_response({"taskId": task_id, "status": "pending"}, status=202)

        result = await _execute_tool_call(gw, connection_id, tool_name, arguments, timeout)
        return web.json_response(result)

    except TimeoutError as e:
        return web.json_response({"error": str(e)}, status=504)
    except Exception as e:
        logger.error(f"tool_call error: {e}")
        return web.json_response({"error": str(e)}, status=500)


async def batch_tool_call(request: web.Request) -> web.Response:
    gw = request.app["gw"]
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    calls = body.get("calls", [])
    global_timeout = body.get("timeout", 30000)

    if not isinstance(calls, list) or not calls:
        return web.json_response({"error": "Missing or empty 'calls' array"}, status=400)

    async def execute_one(index: int, call: dict) -> dict:
        tool_name = call.get("tool_name")
        if not tool_name:
            return {"index": index, "error": "Missing tool_name"}
        try:
            conn_id = await _resolve_target(gw, call)
            if not conn_id:
                return {"index": index, "clientName": call.get("clientName"), "error": "No target found"}
            result = await _execute_tool_call(gw, conn_id, tool_name, call.get("arguments", {}), call.get("timeout", global_timeout))
            return {"index": index, "clientName": call.get("clientName"), "tool_name": tool_name, "result": result}
        except Exception as e:
            return {"index": index, "clientName": call.get("clientName"), "error": str(e)}

    results = await asyncio.gather(*[execute_one(i, c) for i, c in enumerate(calls)])
    return web.json_response({"results": list(results)})


async def get_task(request: web.Request) -> web.Response:
    task_id = request.match_info["task_id"]
    task = _tasks.get(task_id)
    if not task:
        return web.json_response({"error": f"Task not found: {task_id}"}, status=404)
    return web.json_response(task)


async def list_tasks(request: web.Request) -> web.Response:
    status_filter = request.query.get("status")
    limit = int(request.query.get("limit", "50"))
    result = list(_tasks.values())
    if status_filter:
        result = [t for t in result if t["status"] == status_filter]
    result = result[-limit:]
    queued = [{"taskId": q["taskId"], "clientName": q.get("clientName"), "labels": q.get("labels"), "tool_name": q["tool_name"], "createdAt": q["createdAt"]} for q in _task_queue]
    return web.json_response({"tasks": result, "queued": queued})


async def audit(request: web.Request) -> web.Response:
    gw = request.app["gw"]
    client_name = request.query.get("clientName")
    limit = int(request.query.get("limit", "50"))
    timeout = int(request.query.get("timeout", "15000"))

    targets = []
    for cid, info in gw.ws_handler.connections.items():
        if info["ws"].protocol.state.name == "CLOSED" or not info["binding"]:
            continue
        if client_name and info["binding"]["clientName"] != client_name:
            continue
        targets.append({"connId": cid, "clientName": info["binding"]["clientName"]})

    if not targets:
        return web.json_response({"error": "No matching connected clients"}, status=404)

    async def fetch_audit(t: dict) -> dict:
        try:
            cmd = f'tail -n {limit} $(dirname $(node -e "console.log(require.resolve(\'landgod/package.json\'))" 2>/dev/null || echo "/tmp"))/.landgod-data/audit.jsonl 2>/dev/null || echo "[]"'
            result = await gw.ws_handler.send_tool_call(t["connId"], "shell_execute", {"command": cmd}, timeout)
            stdout = (result.get("payload", {}) if isinstance(result, dict) else {}).get("data", {}).get("stdout", "")
            lines = [l for l in stdout.strip().split("\n") if l.startswith("{")]
            entries = []
            for l in lines:
                try:
                    entries.append(json.loads(l))
                except Exception:
                    pass
            return {"clientName": t["clientName"], "entries": entries, "error": None}
        except Exception as e:
            return {"clientName": t["clientName"], "entries": [], "error": str(e)}

    results = await asyncio.gather(*[fetch_audit(t) for t in targets])
    return web.json_response({"audit": list(results)})


async def create_token(request: web.Request) -> web.Response:
    gw = request.app["gw"]
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    device_name = body.get("device_name")
    if not device_name:
        return web.json_response({"error": "Missing device_name"}, status=400)

    token = f"tok_{uuid.uuid4().hex}"
    created_at = _now_iso()
    await gw.store.set_token(token, {
        "device_name": device_name,
        "created_at": created_at,
        "active": True,
    })
    logger.info(f"[token] Created for {device_name}: {token[:12]}...")
    return web.json_response({"token": token, "device_name": device_name, "created_at": created_at}, status=201)


async def list_tokens(request: web.Request) -> web.Response:
    gw = request.app["gw"]
    tokens = await gw.store.list_tokens()
    result = []
    for t in tokens:
        full = t.get("token_full", "")
        result.append({
            "token": full[:12] + "..." if full else "",
            "token_full": full,
            "device_name": t.get("device_name", ""),
            "created_at": t.get("created_at", ""),
            "active": t.get("active", True),
        })
    return web.json_response({"tokens": result})


async def revoke_token(request: web.Request) -> web.Response:
    gw = request.app["gw"]
    token = request.match_info["token"]
    info = await gw.store.get_token(token)
    if not info:
        return web.json_response({"error": "Token not found"}, status=404)

    info["active"] = False
    await gw.store.set_token(token, info)

    to_remove = []
    for cid, conn in gw.ws_handler.connections.items():
        if conn["token"] == token:
            to_remove.append(cid)
            try:
                await conn["ws"].close(4002, "Token revoked")
            except Exception:
                pass
    for cid in to_remove:
        gw.ws_handler.connections.pop(cid, None)
        await gw.store.delete_client(cid)
        logger.info(f"[token] Revoked and disconnected: {cid}")

    return web.json_response({"revoked": True, "token": token[:12] + "..."})
