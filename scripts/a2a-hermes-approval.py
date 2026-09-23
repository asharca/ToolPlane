"""Execution middleware for the pinned Hermes contract; failures never call next_call."""
import json
import time
import uuid
import urllib.request
import urllib.parse

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError('Approval redirects are forbidden')

def install_approval_gate(url, token):
    from hermes_cli.plugins import PluginContext, PluginManifest, get_plugin_manager
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in ('http', 'https') or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise RuntimeError('Invalid approval endpoint')
    if not token or '/api/v1/agent-runtime/a2a/' not in parsed.path or not parsed.path.endswith('/approvals'):
        raise RuntimeError('Invalid approval endpoint')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    def post(payload):
        raw = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        if len(raw) > 17408:
            raise RuntimeError('Approval input limit')
        req = urllib.request.Request(url, data=raw, headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token})
        with opener.open(req, timeout=8) as response:
            if response.status != 200 or 'application/json' not in response.headers.get('content-type', ''):
                raise RuntimeError('Approval unavailable')
            data = response.read(4097)
            if len(data) > 4096:
                raise RuntimeError('Approval response limit')
            return json.loads(data)
    def execute_tool(tool_name, args, next_call, tool_call_id='', **_):
        approved_input = None
        allowed = False
        try:
            # One serialized argument snapshot for the entire decision; no model-selected URL or identity.
            payload = json.loads(json.dumps({'action': 'check', 'callId': tool_call_id or str(uuid.uuid4()), 'toolName': tool_name, 'input': args}))
            deadline = time.monotonic() + 290
            while time.monotonic() < deadline:
                status = post(payload).get('status')
                if status == 'allow':
                    approved_input = payload['input']
                    allowed = True
                    break
                if status != 'pending':
                    break
                time.sleep(2.5)
        except BaseException:
            # Hermes middleware failures before next_call fail open. Never raise here.
            pass
        if not allowed:
            return json.dumps({'error': 'This tool call was not approved in ToolPlane.'})
        # Pass the exact approved snapshot. Do not catch/retry downstream tool failures.
        return next_call(approved_input)
    manager = get_plugin_manager()
    manager.discover_and_load()
    PluginContext(PluginManifest(name='toolplane-native-approval', version='1'), manager).register_middleware('tool_execution', execute_tool)
    if post({'action': 'ready'}).get('status') != 'ready':
        raise RuntimeError('Approval gate was not initialized')
