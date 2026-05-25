"""
LandGod Link — Python SDK for AI Agent remote device management

Usage:
    from landgod_gateway import LandGod
    
    link = LandGod('http://localhost:8081')
    
    # List online workers
    clients = await link.clients()
    
    # Execute command on remote device
    result = await link.execute('hostname', target='ZhouTest4')
    print(result['stdout'])
    
    # Broadcast to all devices
    results = await link.broadcast('uname -a')
"""

import asyncio
import json
import urllib.request
import urllib.error
from typing import Optional, Any
import uuid


from landgod_gateway.store import create_store, StateStore, MemoryStore, RedisStore


class LandGod:
    """LandGod Link SDK — Connect AI Agents to LandGod Workers"""

    def __init__(self, server_url: str, admin_token: str = None, timeout: int = 300000, store: str = 'memory'):
        """
        Args:
            server_url: Gateway HTTP API URL, e.g. 'http://localhost:8081'
            admin_token: Admin token for token management APIs
            timeout: Default timeout in milliseconds
            store: State backend — 'memory' (单机) or 'redis://host:port' (分布式)
        """
        self.server_url = server_url.rstrip('/')
        self.admin_token = admin_token
        self.timeout = timeout
        self.store = create_store(store)

    # ========================
    # 连接管理
    # ========================

    async def clients(self) -> list:
        """列出所有在线 Worker"""
        resp = await self._get('/clients')
        return resp.get('clients', [])

    async def health(self) -> dict:
        """Gateway 健康检查"""
        return await self._get('/health')

    async def wait_for(self, name: str, timeout_ms: int = 60000) -> dict:
        """等待指定设备上线"""
        import time
        start = time.time()
        while (time.time() - start) * 1000 < timeout_ms:
            clients = await self.clients()
            found = next((c for c in clients if c['clientName'] == name and c['connected']), None)
            if found:
                return found
            await asyncio.sleep(2)
        raise TimeoutError(f"Timeout waiting for device '{name}' to come online")

    # ========================
    # 命令执行
    # ========================

    async def execute(self, command: str, target: str = None, timeout: int = None) -> dict:
        """在指定 Worker 执行命令"""
        body = {
            'tool_name': 'shell_execute',
            'arguments': {'command': command},
            'timeout': timeout or self.timeout,
        }
        if target:
            body['connection_id'] = await self._resolve_target(target)
        resp = await self._post('/tool_call', body)
        result = self._parse_tool_result(resp)
        
        # 记录执行历史到 store
        self.store.incr('stats:total_calls')
        self.store.lpush('history:executions', {
            'command': command,
            'target': target,
            'timestamp': __import__('datetime').datetime.utcnow().isoformat(),
            'exit_code': result.get('exit_code'),
        })
        
        return result

    async def read_file(self, path: str, target: str = None, timeout: int = None) -> dict:
        """读取远程文件"""
        body = {
            'tool_name': 'file_read',
            'arguments': {'path': path},
            'timeout': timeout or self.timeout,
        }
        if target:
            body['connection_id'] = await self._resolve_target(target)
        return await self._post('/tool_call', body)

    async def tool_call(self, tool_name: str, arguments: dict = None, target: str = None, timeout: int = None) -> dict:
        """调用任意工具"""
        body = {
            'tool_name': tool_name,
            'arguments': arguments or {},
            'timeout': timeout or self.timeout,
        }
        if target:
            body['connection_id'] = await self._resolve_target(target)
        return await self._post('/tool_call', body)

    # ========================
    # 批量操作
    # ========================

    async def broadcast(self, command: str, timeout: int = None) -> list:
        """在所有 Worker 上执行同一命令"""
        clients = await self.clients()
        tasks = []
        for c in clients:
            if c['connected']:
                tasks.append(self._safe_execute(command, c['clientName'], timeout))
        return await asyncio.gather(*tasks)

    async def map(self, task_list: list) -> list:
        """并行分发不同命令到不同 Worker
        
        Args:
            task_list: [{'target': 'name', 'command': 'cmd'}, ...]
        """
        tasks = [
            self._safe_execute(t['command'], t['target'], t.get('timeout'))
            for t in task_list
        ]
        return await asyncio.gather(*tasks)

    # ========================
    # MCP 管理
    # ========================

    async def install_mcp(self, name: str, config: dict, target: str = None) -> dict:
        """远程安装 MCP Server 到指定 Worker"""
        return await self.tool_call('remote_configure_mcp_server', {
            'name': name,
            'transport': config.get('transport', 'stdio'),
            'command': config['command'],
            'args': config.get('args', []),
            'env': config.get('env', {}),
        }, target=target)

    # ========================
    # Token 管理
    # ========================

    async def create_token(self, device_name: str) -> dict:
        """创建新设备 Token"""
        return await self._post('/tokens', {'device_name': device_name})

    async def list_tokens(self) -> dict:
        """列出所有 Token"""
        return await self._get('/tokens')

    async def revoke_token(self, token: str) -> dict:
        """吊销 Token"""
        return await self._delete(f'/tokens/{token}')

    # ========================
    # 同步方法（方便非 async 环境）
    # ========================

    def clients_sync(self) -> list:
        return asyncio.get_event_loop().run_until_complete(self.clients())

    def execute_sync(self, command: str, target: str = None, timeout: int = None) -> dict:
        return asyncio.get_event_loop().run_until_complete(self.execute(command, target, timeout))

    def broadcast_sync(self, command: str, timeout: int = None) -> list:
        return asyncio.get_event_loop().run_until_complete(self.broadcast(command, timeout))

    def health_sync(self) -> dict:
        return asyncio.get_event_loop().run_until_complete(self.health())

    # ========================
    # 内部方法
    # ========================

    async def _resolve_target(self, name_or_conn_id: str) -> str:
        if name_or_conn_id.startswith('conn-'):
            return name_or_conn_id
        clients = await self.clients()
        client = next((c for c in clients if c['clientName'] == name_or_conn_id and c['connected']), None)
        if not client:
            raise ConnectionError(f"Device '{name_or_conn_id}' not found or offline")
        return client['connectionId']

    async def _safe_execute(self, command: str, target: str, timeout: int = None) -> dict:
        try:
            result = await self.execute(command, target=target, timeout=timeout)
            return {'device': target, **result}
        except Exception as e:
            return {'device': target, 'error': str(e)}

    def _parse_tool_result(self, resp: dict) -> dict:
        if resp.get('type') == 'event' and resp.get('event') == 'tool_error':
            err = resp.get('payload', {}).get('error', {})
            raise RuntimeError(err.get('message', 'Tool execution failed'))
        
        payload = resp.get('payload', {})
        data = payload.get('data', {})
        text = data.get('text', '')
        
        try:
            inner = json.loads(text)
            return {
                'stdout': inner.get('stdout', ''),
                'stderr': inner.get('stderr', ''),
                'exit_code': inner.get('exit_code'),
                'cwd': inner.get('cwd', ''),
            }
        except (json.JSONDecodeError, TypeError):
            return {'stdout': text, 'stderr': '', 'exit_code': None}

    async def _get(self, path: str) -> dict:
        return await asyncio.get_event_loop().run_in_executor(None, self._request_sync, 'GET', path, None)

    async def _post(self, path: str, body: dict) -> dict:
        return await asyncio.get_event_loop().run_in_executor(None, self._request_sync, 'POST', path, body)

    async def _delete(self, path: str) -> dict:
        return await asyncio.get_event_loop().run_in_executor(None, self._request_sync, 'DELETE', path, None)

    def _request_sync(self, method: str, path: str, body: Optional[dict]) -> dict:
        url = self.server_url + path
        data = json.dumps(body).encode('utf-8') if body else None
        headers = {'Content-Type': 'application/json'}
        if self.admin_token:
            headers['Authorization'] = f'Bearer {self.admin_token}'

        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout / 1000) as resp:
                return json.loads(resp.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            try:
                return json.loads(e.read().decode('utf-8'))
            except:
                raise RuntimeError(f'HTTP {e.code}: {e.reason}')
        except urllib.error.URLError as e:
            raise ConnectionError(f'Cannot connect to {url}: {e.reason}')
