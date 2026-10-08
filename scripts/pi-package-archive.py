#!/usr/bin/env python3
"""Trusted tar extraction and snapshot inventory. Never execute package contents."""
import base64
import hashlib
import json
import os
import posixpath
import stat
import sys
import tarfile

MAX_ENTRIES = 20000
MAX_FILE = 16 * 1024 * 1024
MAX_TOTAL = 64 * 1024 * 1024


def safe_path(path):
    if not isinstance(path, str) or not path or path.startswith('/') or '\\' in path or '\0' in path:
        raise ValueError('invalid_path')
    if any(part in ('', '.', '..') for part in path.split('/')):
        raise ValueError('invalid_path')
    return path


def validate_link(target):
    if not target or target.startswith('/') or '\\' in target or '\0' in target:
        raise ValueError('invalid_link')


def check_tree(nodes):
    directories = set()
    for path, node in nodes.items():
        parent = posixpath.dirname(path)
        while parent:
            directories.add(parent)
            if parent in nodes and nodes[parent][0] != 'directory':
                raise ValueError('path_conflict')
            parent = posixpath.dirname(parent)
        if node[0] == 'directory':
            directories.add(path)
        elif node[0] == 'symlink':
            validate_link(node[1])
    cache = {}
    def follow(path):
        pending = list(reversed(path.split('/')))
        resolved = []
        active = set()
        while pending:
            part = pending.pop()
            if isinstance(part, tuple):
                cache[part[0]] = tuple(resolved)
                active.remove(part[0])
                continue
            if part in ('', '.'):
                continue
            if part == '..':
                if not resolved:
                    raise ValueError('link_escape')
                resolved.pop()
                continue
            candidate = '/'.join(resolved + [part])
            node = nodes.get(candidate)
            if node and node[0] == 'symlink':
                if candidate in active:
                    raise ValueError('link_cycle')
                if candidate in cache:
                    resolved = list(cache[candidate])
                else:
                    active.add(candidate)
                    pending.append((candidate,))
                    pending.extend(reversed(node[1].split('/')))
                    continue
            else:
                if node is None and candidate not in directories:
                    raise ValueError('link_missing')
                resolved.append(part)
            current = nodes.get('/'.join(resolved))
            if current and current[0] != 'directory' and any(isinstance(segment, str) for segment in pending):
                raise ValueError('path_conflict')
    for path, node in nodes.items():
        if node[0] == 'symlink':
            follow(path)


def extract(archive, destination, mode):
    if os.path.lexists(destination):
        raise ValueError('destination_exists')
    nodes = {}
    members = {}
    total = 0
    with tarfile.open(archive, 'r:*') as tar:
        for member in tar:
            name = member.name.rstrip('/') if member.isdir() else member.name
            safe_path(name)
            if mode == 'npm':
                if name != 'package' and not name.startswith('package/'):
                    raise ValueError('npm_root')
                name = name[len('package/'): ] if name != 'package' else ''
            if not name:
                if not member.isdir():
                    raise ValueError('root_conflict')
                continue
            if name in nodes or len(nodes) >= MAX_ENTRIES:
                raise ValueError('duplicate_or_limit')
            if member.sparse is not None or any(key.startswith('GNU.sparse') for key in member.pax_headers):
                raise ValueError('sparse_file')
            if member.isdir():
                nodes[name] = ('directory', None)
            elif member.issym():
                validate_link(member.linkname)
                nodes[name] = ('symlink', member.linkname)
            elif member.islnk():
                target = member.linkname
                safe_path(target)
                if mode == 'npm':
                    if not target.startswith('package/'):
                        raise ValueError('hardlink_escape')
                    target = target[len('package/'):]
                nodes[name] = ('hardlink', target)
            elif member.isfile():
                if member.size > MAX_FILE or member.size < 0:
                    raise ValueError('file_limit')
                total += member.size
                if total > MAX_TOTAL:
                    raise ValueError('total_limit')
                nodes[name] = ('file', None)
            else:
                raise ValueError('special_file')
            members[name] = member
        # Normalize hard links only to actual archive regular files, never links or host files.
        for name, node in list(nodes.items()):
            if node[0] == 'hardlink':
                target = node[1]
                seen = {name}
                while target in nodes and nodes[target][0] == 'hardlink':
                    if target in seen:
                        raise ValueError('hardlink_cycle')
                    seen.add(target)
                    target = nodes[target][1]
                if target not in nodes or nodes[target][0] != 'file':
                    raise ValueError('invalid_hardlink')
                members[name] = members[target]
                nodes[name] = ('file', None)
                total += members[name].size
                if total > MAX_TOTAL:
                    raise ValueError('total_limit')
        prefix = os.path.basename(destination)
        check_tree({prefix: ('directory', None), **{prefix + '/' + name: node for name, node in nodes.items()}})
        os.mkdir(destination, 0o700)
        # All directories and regular files precede symlinks; no write follows a symlink.
        for name in sorted(nodes, key=lambda name: (name.count('/'), name)):
            kind = nodes[name][0]
            if kind == 'symlink':
                continue
            path = os.path.join(destination, name)
            os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
            if kind == 'directory':
                os.makedirs(path, mode=0o700, exist_ok=True)
            else:
                member = members[name]
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o700 if member.mode & 0o111 else 0o600)
                with os.fdopen(fd, 'wb') as out, tar.extractfile(member) as source:
                    remaining = member.size
                    while remaining:
                        chunk = source.read(min(65536, remaining))
                        if not chunk:
                            raise ValueError('truncated_archive')
                        out.write(chunk)
                        remaining -= len(chunk)
        for name, node in nodes.items():
            if node[0] == 'symlink':
                path = os.path.join(destination, name)
                os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
                os.symlink(node[1], path)
    inventory(os.path.dirname(destination))


def inventory(root):
    entries = []
    nodes = {}
    total = 0
    def visit(directory, prefix):
        nonlocal total
        for item in sorted(os.scandir(directory), key=lambda item: item.name):
            path = safe_path(posixpath.join(prefix, item.name))
            info = item.stat(follow_symlinks=False)
            if len(entries) >= MAX_ENTRIES:
                raise ValueError('entry_limit')
            if stat.S_ISLNK(info.st_mode):
                target = os.readlink(item.path)
                validate_link(target)
                nodes[path] = ('symlink', target)
                entries.append({'type': 'symlink', 'path': path, 'target': target})
            elif stat.S_ISDIR(info.st_mode):
                nodes[path] = ('directory', None)
                entries.append({'type': 'directory', 'path': path})
                visit(item.path, path)
            elif stat.S_ISREG(info.st_mode):
                if info.st_size > MAX_FILE:
                    raise ValueError('file_limit')
                chunks = []
                count = 0
                with os.fdopen(os.open(item.path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as source:
                    while True:
                        chunk = source.read(65536)
                        if not chunk:
                            break
                        count += len(chunk)
                        total += len(chunk)
                        if count > MAX_FILE or total > MAX_TOTAL:
                            raise ValueError('byte_limit')
                        chunks.append(chunk)
                data = b''.join(chunks)
                nodes[path] = ('file', None)
                entries.append({'type': 'file', 'path': path, 'contentEncoding': 'base64', 'content': base64.b64encode(data).decode('ascii'), 'executable': bool(info.st_mode & 0o111), 'sha256': hashlib.sha256(data).hexdigest()})
            else:
                raise ValueError('special_file')
    visit(root, '')
    check_tree(nodes)
    return entries


def self_test():
    import io
    import tempfile
    with tempfile.TemporaryDirectory() as temporary:
        def archive_case(label, records, allowed=False):
            archive = os.path.join(temporary, label + '.tar')
            destination = os.path.join(temporary, label)
            with tarfile.open(archive, 'w') as tar:
                for name, kind, payload in records:
                    member = tarfile.TarInfo(name)
                    member.type = kind
                    if kind == tarfile.REGTYPE:
                        member.size = len(payload)
                        tar.addfile(member, io.BytesIO(payload))
                    else:
                        member.linkname = payload
                        tar.addfile(member)
            try:
                extract(archive, destination, 'git')
            except ValueError:
                assert not allowed, label
                assert not os.path.exists(destination), label
            else:
                assert allowed, label
                entries = {entry['path']: entry for entry in inventory(destination)}
                assert base64.b64decode(entries['file']['content']) == b'hello'
                assert base64.b64decode(entries['hard']['content']) == b'hello'
                assert entries['nested/link']['target'] == '../file'
        archive_case('valid', [('file', tarfile.REGTYPE, b'hello'), ('hard', tarfile.LNKTYPE, 'file'), ('nested/link', tarfile.SYMTYPE, '../file')], True)
        archive_case('traversal', [('../escape', tarfile.REGTYPE, b'x')])
        archive_case('absolute', [('/escape', tarfile.REGTYPE, b'x')])
        archive_case('cycle', [('one', tarfile.SYMTYPE, 'two'), ('two', tarfile.SYMTYPE, 'one')])
        archive_case('indirect_escape', [('one', tarfile.SYMTYPE, 'nested/two'), ('nested/two', tarfile.SYMTYPE, '../../../escape')])
        archive_case('posix_escape', [('nested/up', tarfile.SYMTYPE, '..'), ('one', tarfile.SYMTYPE, 'nested/up/../../escape')])
        check_tree({'package': ('directory', None), 'package/deep/deeper': ('directory', None), 'package/file': ('file', None), 'package/a': ('symlink', 'deep/deeper'), 'package/b': ('symlink', 'a/../../file')})
        try:
            check_tree({'package': ('directory', None), 'package/dir': ('directory', None), 'package/a': ('symlink', 'dir/..'), 'package/b': ('symlink', 'a/../escape')})
        except ValueError:
            pass
        else:
            raise AssertionError('POSIX symlink-before-parent escape accepted')
        archive_case('nofollow', [('one', tarfile.SYMTYPE, 'other'), ('one/file', tarfile.REGTYPE, b'x')])
        archive_case('fifo', [('pipe', tarfile.FIFOTYPE, '')])
        archive_case('duplicate', [('file', tarfile.REGTYPE, b'x'), ('file', tarfile.REGTYPE, b'y')])
        archive_case('hard_escape', [('hard', tarfile.LNKTYPE, '../escape')])
    print('archive self-check passed')


if __name__ == '__main__':
    try:
        if sys.argv[1] == '--self-test':
            self_test()
        elif sys.argv[1] == 'extract':
            extract(sys.argv[2], sys.argv[3], sys.argv[4])
        elif sys.argv[1] == 'inventory':
            print(json.dumps(inventory(sys.argv[2]), separators=(',', ':')))
        else:
            raise ValueError('invalid_command')
    except Exception as error:
        codes = {'invalid_path', 'invalid_link', 'path_conflict', 'link_escape', 'link_cycle', 'link_missing', 'destination_exists', 'npm_root', 'root_conflict', 'duplicate_or_limit', 'sparse_file', 'hardlink_escape', 'file_limit', 'total_limit', 'special_file', 'hardlink_cycle', 'invalid_hardlink', 'truncated_archive', 'entry_limit', 'byte_limit', 'invalid_command'}
        code = str(error) if isinstance(error, ValueError) and str(error) in codes else 'invalid'
        print('package_archive_invalid:' + code, file=sys.stderr)
        sys.exit(1)
