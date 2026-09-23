#!/usr/bin/env python3
"""One-shot, hash-bound source application on the authorized feature branch."""
import hashlib
import lzma
import os
from pathlib import Path
import shutil
import subprocess

root = Path(__file__).resolve().parent.parent
os.chdir(root)
assert os.environ.get('GITHUB_REF') == 'refs/heads/codex/sandbox-mcp-chatgpt-ssh', 'Wrong branch'
subprocess.run(['git', 'merge-base', '--is-ancestor', '84599a8185988d150f68e68ba23baf3d1e9c02de', 'HEAD'], check=True)
folder = root / '.toolplane-patch'
data = b''.join((folder / f'part{i}.xz').read_bytes() for i in range(3))
assert hashlib.sha256(data).hexdigest() == '3f2247d23eca9c81a85b2139d62b01e0a9ad6a6fb9f72794ec3f8018564e20ab', 'Patch integrity failure'
patch = lzma.decompress(data)
assert len(patch) == 171894, 'Unexpected patch size'
for line in patch.splitlines():
    if line.startswith(b'diff --git '):
        assert b'/.github/' not in line and b'/.git/' not in line and b'../' not in line, 'Forbidden patch path'
subprocess.run(['git', 'apply', '--check', '-'], input=patch, check=True)
subprocess.run(['git', 'apply', '-'], input=patch, check=True)
shutil.rmtree(folder)
print('Applied hash-verified sandbox implementation; bootstrap payload removed.')
