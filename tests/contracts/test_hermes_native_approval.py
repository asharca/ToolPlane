"""Run against an unmodified pinned Hermes middleware module, not a model/CLI E2E.
TOOLPLANE_HERMES_SOURCE=/path/to/pinned/hermes python3 tests/contracts/test_hermes_native_approval.py
"""
import importlib.util
import json
import os
from pathlib import Path
import runpy
import sys
import threading
import types
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
source = os.environ.get('TOOLPLANE_HERMES_SOURCE')
if not source or not (Path(source) / 'hermes_cli/middleware.py').is_file():
    raise SystemExit('BLOCKED: provide the pinned Hermes source; no compatibility result was produced.')
spec = importlib.util.spec_from_file_location('pinned_hermes_middleware', Path(source) / 'hermes_cli/middleware.py')
upstream = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = upstream
spec.loader.exec_module(upstream)

class ApprovalMiddlewareContract(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.result = {'status': 'deny'}
        self.http_status = 200
        self.requests = []
        outer = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass
            def do_POST(self):
                data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                outer.requests.append(data)
                value = {'status': 'ready'} if data['action'] == 'ready' else outer.result
                self.send_response(200 if data['action'] == 'ready' else outer.http_status)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(value).encode())
        self.server = HTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.registry = []
        class Context:
            def __init__(self, *_):
                pass
            def register_middleware(_self, kind, callback):
                self.assertEqual(kind, 'tool_execution')
                self.registry.append(callback)
        plugin = types.ModuleType('hermes_cli.plugins')
        plugin.PluginContext = Context
        plugin.PluginManifest = lambda **kwargs: kwargs
        plugin.get_plugin_manager = lambda: types.SimpleNamespace(discover_and_load=lambda: None, _middleware={'tool_execution': self.registry})
        package = types.ModuleType('hermes_cli')
        self.modules = patch.dict(sys.modules, {'hermes_cli': package, 'hermes_cli.plugins': plugin})
        self.modules.start()
        self.helper = runpy.run_path(str(ROOT / 'scripts/a2a-hermes-approval.py'))
        self.helper['install_approval_gate'](f'http://127.0.0.1:{self.server.server_port}/api/v1/agent-runtime/a2a/task/approvals', 'isolated-test-fixture')

    def tearDown(self):
        self.modules.stop()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def run_tool(self, args=None, downstream=None):
        def terminal(value):
            self.calls.append(value)
            return 'tool result'
        return upstream.run_tool_execution_middleware('terminal', args or {'command': 'echo fixture'}, downstream or terminal, tool_call_id='one-call')

    def test_denial_never_reaches_real_execution_callback(self):
        self.assertIn('error', json.loads(self.run_tool()))
        self.assertEqual(self.calls, [])

    def test_allow_passes_exact_arguments_once(self):
        self.result = {'status': 'allow'}
        self.assertEqual(self.run_tool(), 'tool result')
        self.assertEqual(self.calls, [{'command': 'echo fixture'}])
        self.assertEqual(self.requests[-1]['callId'], 'one-call')

    def test_network_error_does_not_trigger_upstream_fail_open(self):
        self.http_status = 503
        self.assertIn('error', json.loads(self.run_tool()))
        self.assertEqual(self.calls, [])

    def test_unknown_response_is_denied(self):
        self.result = {'status': 'approved'}
        self.assertIn('error', json.loads(self.run_tool()))
        self.assertEqual(self.calls, [])

    def test_downstream_failure_is_not_replayed(self):
        self.result = {'status': 'allow'}
        count = []
        def fail(_):
            count.append(1)
            raise RuntimeError('partial external action')
        with self.assertRaisesRegex(RuntimeError, 'partial external action'):
            self.run_tool(downstream=fail)
        self.assertEqual(len(count), 1)

    def test_prior_middleware_rewrite_is_what_the_human_approves(self):
        self.result = {'status': 'allow'}
        self.registry.insert(0, lambda args, next_call, **_: next_call({'command': 'rewritten'}))
        self.run_tool()
        self.assertEqual(self.requests[-1]['input'], {'command': 'rewritten'})
        self.assertEqual(self.calls, [{'command': 'rewritten'}])

    def test_gate_does_not_disable_builtin_hermes_approvals(self):
        bootstrap = (ROOT / 'scripts/hermes-rpc-bootstrap.py').read_text()
        self.assertNotIn('approvals.mode', bootstrap)
        driver = (ROOT / 'scripts/hermes-rpc-session.mjs').read_text()
        self.assertIn('approval.request', driver)
        self.assertNotIn("choice: 'always'", driver)

if __name__ == '__main__':
    unittest.main(verbosity=2)
