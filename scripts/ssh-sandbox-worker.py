"""One bounded SSH sandbox request. POSIX + Python 3.9+, standard library only.

File tools reject symlinks and traverse using directory descriptors. Execution
has the SSH account's full authority; the workspace is NOT an OS jail.
"""
import base64
import json
import os
import platform
import selectors
import signal
import stat
import subprocess
import sys
import time
import uuid

MAX_WRITE = 2_000_000
MAX_READ = 128_000
MAX_DOWNLOAD = 5_000_000
MAX_ENVELOPE = 4_000_000


def components(value, absolute=False):
    if not isinstance(value, str) or "\x00" in value or "\\" in value:
        raise ValueError("Invalid path")
    if absolute != value.startswith("/"):
        raise ValueError("Expected an absolute root" if absolute else "Expected a relative path")
    parts = [p for p in value.split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts):
        raise ValueError("Parent traversal is not allowed")
    return parts


def directory_at(parent, parts, create=False):
    fd = os.dup(parent)
    try:
        for part in parts:
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def root_fd(root):
    start = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        return directory_at(start, components(root, absolute=True))
    finally:
        os.close(start)


def file_operation(root, tool, args):
    parts = components(args.get("path", "."))
    fd = root_fd(root)
    try:
        if tool == "list_dir":
            directory = directory_at(fd, parts)
            try:
                entries = []
                truncated = False
                with os.scandir(directory) as listing:
                    for entry in listing:
                        if len(entries) >= 1000:
                            truncated = True
                            break
                        info = entry.stat(follow_symlinks=False)
                        kind = "dir" if stat.S_ISDIR(info.st_mode) else "symlink" if stat.S_ISLNK(info.st_mode) else "file"
                        entries.append({"name": entry.name, "type": kind, "size": info.st_size})
                return {"path": args.get("path", "."), "entries": sorted(entries, key=lambda e: e["name"]), "truncated": truncated}
            finally:
                os.close(directory)
        if not parts:
            raise ValueError("A file path is required")
        parent = directory_at(fd, parts[:-1], create=tool == "write_file")
        try:
            name = parts[-1]
            if tool == "write_file":
                content = args.get("content")
                encoding = args.get("encoding", "utf8")
                if not isinstance(content, str) or len(content) > MAX_ENVELOPE:
                    raise ValueError("Invalid content")
                if encoding == "base64":
                    content = base64.b64decode(content, validate=True)
                elif encoding == "utf8":
                    content = content.encode("utf8")
                else:
                    raise ValueError("Invalid encoding")
                if len(content) > MAX_WRITE:
                    raise ValueError("File exceeds write limit")
                try:
                    info = os.stat(name, dir_fd=parent, follow_symlinks=False)
                    if not stat.S_ISREG(info.st_mode):
                        raise ValueError("Target is not a regular file")
                except FileNotFoundError:
                    pass
                temp = ".toolplane-write-" + uuid.uuid4().hex
                out = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
                try:
                    with os.fdopen(out, "wb") as stream:
                        stream.write(content)
                        stream.flush()
                        os.fsync(stream.fileno())
                    os.replace(temp, name, src_dir_fd=parent, dst_dir_fd=parent)
                finally:
                    try:
                        os.unlink(temp, dir_fd=parent)
                    except FileNotFoundError:
                        pass
                return {"path": args["path"], "bytes": len(content)}
            if tool == "delete_file":
                try:
                    info = os.stat(name, dir_fd=parent, follow_symlinks=False)
                    if not stat.S_ISREG(info.st_mode):
                        raise ValueError("Target is not a regular file")
                    os.unlink(name, dir_fd=parent)
                except FileNotFoundError:
                    if args.get("missingOk") is not True:
                        raise
                return {"path": args["path"], "deleted": True}
            inp = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            with os.fdopen(inp, "rb") as stream:
                if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                    raise ValueError("Target is not a regular file")
                limit = MAX_DOWNLOAD if tool == "download_file" else MAX_READ
                content = stream.read(limit + 1)
                if tool == "download_file":
                    if len(content) > limit:
                        raise ValueError("File exceeds download limit")
                    return {"path": args["path"], "filename": name, "size": len(content), "encoding": "base64", "content": base64.b64encode(content).decode("ascii")}
                return {"path": args["path"], "content": content[:limit].decode("utf8", errors="replace"), "truncated": len(content) > limit}
        finally:
            os.close(parent)
    finally:
        os.close(fd)


def stop_group(proc):
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def run_process(root, tool, args, env, disconnect_fd=None):
    parts = components(args.get("cwd", "."))
    # Refuse symlink cwd; execution itself is intentionally not root-confined.
    fd = root_fd(root)
    try:
        directory = directory_at(fd, parts)
    finally:
        os.close(fd)
    os.close(directory)
    cwd = os.path.join(root, *parts)
    if tool == "shell_exec":
        command = args.get("command")
        if not isinstance(command, str) or not command or len(command) > 24000 or "\x00" in command:
            raise ValueError("Invalid command")
        argv = ["/bin/sh", "-c", command]
    else:
        runtime = args.get("runtime")
        executable = {"node": "node", "python": "python3", "bash": "bash"}.get(runtime)
        values = args.get("args")
        if not executable or not isinstance(values, list) or len(values) > 128 or any(not isinstance(v, str) or "\x00" in v or len(v) > 8192 for v in values) or sum(len(v) for v in values) > 24000:
            raise ValueError("Invalid structured process arguments")
        argv = [executable] + values
    stdin = args.get("stdin", "")
    if not isinstance(stdin, str) or len(stdin.encode("utf8")) > MAX_WRITE:
        raise ValueError("Invalid stdin")
    timeout = args.get("timeoutMs", 30000)
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 1 <= timeout <= 120000:
        raise ValueError("timeoutMs must be between 1 and 120000")
    if not isinstance(env, dict) or len(env) > 128 or any(not isinstance(k, str) or not k or not k.replace("_", "a").isalnum() or k[0].isdigit() or not isinstance(v, str) or "\x00" in v or len(v) > 32000 for k, v in env.items()):
        raise ValueError("Invalid environment")
    child_env = dict(os.environ)
    child_env.update(env)
    proc = subprocess.Popen(argv, cwd=cwd, env=child_env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    selector = selectors.DefaultSelector()
    output = {"stdout": bytearray(), "stderr": bytearray()}
    truncated = False
    timed_out = False
    disconnected = False
    start = time.monotonic()
    input_bytes = memoryview(stdin.encode("utf8"))
    for channel in ("stdout", "stderr"):
        stream = getattr(proc, channel)
        os.set_blocking(stream.fileno(), False)
        selector.register(stream, selectors.EVENT_READ, channel)
    if input_bytes:
        os.set_blocking(proc.stdin.fileno(), False)
        selector.register(proc.stdin, selectors.EVENT_WRITE, "input")
    else:
        proc.stdin.close()
    if disconnect_fd is not None:
        selector.register(disconnect_fd, selectors.EVENT_READ, "disconnect")
    try:
        while True:
            if time.monotonic() - start >= timeout / 1000:
                timed_out = True
                stop_group(proc)
            if proc.poll() is not None:
                # Synchronous exec does not deliberately leave background jobs.
                stop_group(proc)
                for channel in output:
                    stream = getattr(proc, channel)
                    while True:
                        try:
                            chunk = os.read(stream.fileno(), 65536)
                        except BlockingIOError:
                            break
                        if not chunk:
                            break
                        room = max(0, MAX_READ - len(output[channel]))
                        output[channel].extend(chunk[:room])
                        truncated = truncated or len(chunk) > room
                break
            for key, _ in selector.select(0.05):
                if key.data == "disconnect":
                    if not os.read(key.fd, 1024):
                        disconnected = True
                        stop_group(proc)
                        selector.unregister(key.fileobj)
                elif key.data == "input":
                    try:
                        count = os.write(key.fd, input_bytes[:65536])
                        input_bytes = input_bytes[count:]
                    except BrokenPipeError:
                        input_bytes = memoryview(b"")
                    if not input_bytes:
                        selector.unregister(key.fileobj)
                        proc.stdin.close()
                else:
                    try:
                        chunk = os.read(key.fd, 65536)
                    except BlockingIOError:
                        continue
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    room = max(0, MAX_READ - len(output[key.data]))
                    output[key.data].extend(chunk[:room])
                    truncated = truncated or len(chunk) > room
        return {"stdout": output["stdout"].decode("utf8", errors="replace"), "stderr": output["stderr"].decode("utf8", errors="replace"), "exitCode": proc.wait(), "timedOut": timed_out, "disconnected": disconnected, "truncated": truncated}
    finally:
        stop_group(proc)
        proc.wait()
        selector.close()
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            stream.close()


def dispatch(request, disconnect_fd=None):
    root = request["root"]
    args = request.get("args", {})
    tool = request["tool"]
    if not isinstance(args, dict):
        raise ValueError("Invalid arguments")
    if tool == "sandbox_info":
        fd = root_fd(root)
        os.close(fd)
        return {"kind": "ssh", "root": root, "workspace": root, "workspacePath": root, "platform": platform.system().lower(), "arch": platform.machine(), "shellFamily": "posix", "shell": "/bin/sh", "capabilities": {"shell": True, "files": True, "process": True, "pty": True, "screen": False}, "securityBoundary": "ssh-account-not-workspace"}
    if tool in ("shell_exec", "process_exec"):
        return run_process(root, tool, args, request.get("env", {}), disconnect_fd)
    if tool not in ("read_file", "write_file", "download_file", "delete_file", "list_dir"):
        raise ValueError("Unknown tool")
    return file_operation(root, tool, args)


class RequestInterrupted(Exception):
    pass


def main():
    # An SSH transport can send HUP/TERM before EOF is observed. Unwind the
    # process operation so its finally block kills the owned process group.
    def interrupted(_signum, _frame):
        raise RequestInterrupted("SSH transport stopped")
    for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, interrupted)
    # Read one JSON line without buffering beyond it: subsequent EOF signals a
    # disconnected SSH client during process execution.
    line = sys.stdin.buffer.readline(MAX_ENVELOPE + 1)
    if len(line) > MAX_ENVELOPE or not line.endswith(b"\n"):
        raise ValueError("Request exceeds limit")
    request = json.loads(line)
    try:
        result = dispatch(request, sys.stdin.fileno())
        failed = result.get("timedOut", False) or result.get("disconnected", False) or result.get("exitCode", 0) != 0
        response = {"ok": True, "result": result, "isError": failed}
    except (ValueError, OSError, KeyError, TypeError, RequestInterrupted):
        # No absolute credential paths, exception repr or command content.
        response = {"ok": False, "error": "SSH sandbox operation failed: check the path, arguments and remote account permissions."}
    sys.stdout.write(json.dumps(response, ensure_ascii=True) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
