import base64
import importlib.util
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
WORKER = ROOT / 'scripts/ssh-sandbox-worker.py'
spec = importlib.util.spec_from_file_location('ssh_worker', WORKER)
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)

class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='toolplane-test-')
        self.root = str(Path(self.temp.name).resolve())
    def tearDown(self): self.temp.cleanup()
    def call(self, tool, **args):
        return w.dispatch({'root': self.root, 'tool': tool, 'args': args})
    def test_info_is_posix_without_host_credentials(self):
        result = self.call('sandbox_info')
        self.assertEqual(result['kind'], 'ssh')
        self.assertEqual(result['shellFamily'], 'posix')
        self.assertNotIn('identityFile', result)
    def test_utf8_roundtrip(self):
        self.call('write_file', path='sub/你好.txt', content='你好\nWorld')
        self.assertEqual(self.call('read_file', path='sub/你好.txt')['content'], '你好\nWorld')
    def test_binary_roundtrip(self):
        data = bytes(range(256)) * 32
        self.call('write_file', path='file.bin', encoding='base64', content=base64.b64encode(data).decode())
        self.assertEqual(base64.b64decode(self.call('download_file', path='file.bin')['content']), data)
    def test_invalid_base64(self):
        with self.assertRaises(ValueError): self.call('write_file', path='x', content='bad@!', encoding='base64')
    def test_parent_and_absolute_paths(self):
        for path in ['../outside', '/etc/passwd', 'safe/../../outside', 'safe\\outside', 'nul\0']:
            with self.subTest(path=path), self.assertRaises((ValueError, OSError)):
                self.call('read_file', path=path)
    def test_symlink_file(self):
        os.symlink('/etc/passwd', Path(self.root) / 'link')
        for tool, args in [('read_file', {}), ('download_file', {}), ('write_file', {'content': 'no'}), ('delete_file', {})]:
            with self.subTest(tool=tool), self.assertRaises((ValueError, OSError)):
                self.call(tool, path='link', **args)
    def test_symlink_parent(self):
        with tempfile.TemporaryDirectory() as outside:
            os.symlink(outside, Path(self.root) / 'link')
            with self.assertRaises(OSError): self.call('write_file', path='link/x', content='no')
            self.assertFalse((Path(outside) / 'x').exists())
    def test_symlink_root(self):
        with tempfile.TemporaryDirectory() as parent:
            link=Path(parent)/'linked';os.symlink(self.root,link)
            with self.assertRaises(OSError): w.dispatch({'root': str(link), 'tool': 'sandbox_info'})
    def test_fifo_does_not_block(self):
        os.mkfifo(Path(self.root) / 'fifo')
        with self.assertRaises(ValueError): self.call('read_file', path='fifo')
    def test_write_size_limit(self):
        with self.assertRaises(ValueError): self.call('write_file', path='large', content='x' * (w.MAX_WRITE + 1))
    def test_download_size_limit(self):
        (Path(self.root)/'large').write_bytes(b'x' * (w.MAX_DOWNLOAD + 1))
        with self.assertRaises(ValueError): self.call('download_file', path='large')
    def test_read_truncation(self):
        (Path(self.root)/'large').write_text('x' * (w.MAX_READ + 20))
        result=self.call('read_file',path='large')
        self.assertTrue(result['truncated']);self.assertEqual(len(result['content']), w.MAX_READ)
    def test_listing_and_delete(self):
        self.call('write_file',path='a',content='1');self.call('write_file',path='sub/b',content='2')
        self.assertEqual([x['name'] for x in self.call('list_dir')['entries']], ['a','sub'])
        self.assertTrue(self.call('delete_file',path='a')['deleted'])
        self.assertTrue(self.call('delete_file',path='a',missingOk=True)['deleted'])
        with self.assertRaises(ValueError): self.call('delete_file',path='sub')
    def test_atomic_write_has_no_leftover(self):
        self.call('write_file',path='a',content='old');self.call('write_file',path='a',content='new')
        self.assertEqual([x.name for x in Path(self.root).iterdir()],['a'])
        self.assertEqual((Path(self.root)/'a').stat().st_mode & 0o777,0o600)
    def test_structured_arguments_are_literal(self):
        value="; touch SHOULD_NOT_EXIST; $(echo expansion) ' quote"
        result=self.call('process_exec',runtime='python',args=['-c','import sys; print(sys.argv[1])',value])
        self.assertEqual(result['stdout'].strip(),value)
        self.assertFalse((Path(self.root)/'SHOULD_NOT_EXIST').exists())
    def test_shell_nonzero(self):
        result=self.call('shell_exec',command='printf output; printf error >&2; exit 7')
        self.assertEqual((result['stdout'],result['stderr'],result['exitCode']),('output','error',7))
    def test_invalid_runtime_and_timeout(self):
        for args in [dict(runtime='perl',args=[]),dict(runtime='python',args=['-c','pass'],timeoutMs=0),dict(runtime='python',args=['-c','pass'],timeoutMs=120001)]:
            with self.subTest(args=args),self.assertRaises(ValueError): self.call('process_exec',**args)
    def test_output_drain_does_not_deadlock_stdin(self):
        script="import sys; sys.stdout.write('x'*200000); sys.stdout.flush(); data=sys.stdin.read(); sys.stderr.write(str(len(data)))"
        result=self.call('process_exec',runtime='python',args=['-c',script],stdin='a'*500000,timeoutMs=5000)
        self.assertEqual(result['stderr'],'500000');self.assertTrue(result['truncated']);self.assertFalse(result['timedOut'])
    def test_timeout_kills_background_group(self):
        result=self.call('shell_exec',command='(sleep 0.5; touch leaked) & wait',timeoutMs=100)
        self.assertTrue(result['timedOut']);time.sleep(0.6)
        self.assertFalse((Path(self.root)/'leaked').exists())
    def test_process_environment(self):
        result=w.dispatch({'root':self.root,'tool':'shell_exec','args':{'command':'printf "%s" "$CHECK"'},'env':{'CHECK':'literal $HOME'}})
        self.assertEqual(result['stdout'],'literal $HOME')
    def worker_process(self):
        child=subprocess.Popen([sys.executable,str(WORKER)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        child.stdin.write((json.dumps({'root':self.root,'tool':'shell_exec','args':{'command':'echo ready > ready; (sleep 0.7; touch leaked) & wait','timeoutMs':5000}})+'\n').encode());child.stdin.flush()
        deadline=time.monotonic()+3
        while not (Path(self.root)/'ready').exists() and time.monotonic()<deadline:time.sleep(.01)
        self.assertTrue((Path(self.root)/'ready').exists())
        return child
    def finish_worker(self, child):
        self.assertTrue(select.select([child.stdout],[],[],3)[0], 'worker reply deadline')
        result=json.loads(child.stdout.readline());child.wait(timeout=3)
        for stream in (child.stdin,child.stdout,child.stderr):stream.close()
        return result
    def test_disconnect_cleans_process_group(self):
        child=self.worker_process();child.stdin.close()
        result=self.finish_worker(child)
        self.assertTrue(result['isError']);self.assertTrue(result['result']['disconnected'])
        time.sleep(.8);self.assertFalse((Path(self.root)/'leaked').exists())
    def test_termination_unwinds_process_cleanup(self):
        child=self.worker_process();child.send_signal(signal.SIGTERM)
        result=self.finish_worker(child);self.assertFalse(result['ok'])
        time.sleep(.8);self.assertFalse((Path(self.root)/'leaked').exists())

if __name__=='__main__':unittest.main(verbosity=2)
