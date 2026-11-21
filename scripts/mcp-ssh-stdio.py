"""Keep a POSIX SSH MCP process group tied to its OpenSSH stdin channel."""
import json
import os
import select
import signal
import subprocess


# stdin is unbuffered: readline must not consume any subsequent MCP bytes.
channel = os.fdopen(0, 'rb', buffering=0, closefd=False)
request = json.loads(channel.readline(512_000))
root = os.path.realpath(request['root'])
cwd = os.path.realpath(os.path.join(root, request['cwd']))
if os.path.commonpath([root, cwd]) != root:
    raise SystemExit(125)
child = subprocess.Popen(request['argv'], cwd=cwd, env={**os.environ, **request['env']},
                         stdin=subprocess.PIPE, start_new_session=True, bufsize=0)
try:
    def terminate(*_):
        raise SystemExit(0)

    signal.signal(signal.SIGHUP, terminate)
    signal.signal(signal.SIGTERM, terminate)
    fd = child.stdin.fileno()
    os.set_blocking(fd, False)
    poll = select.poll()
    pending = b''
    while child.poll() is None:
        poll.register(0, 0 if pending else select.POLLIN)
        poll.register(fd, select.POLLOUT if pending else 0)
        for ready, flags in poll.poll(1000):
            if flags & (select.POLLHUP | select.POLLERR | select.POLLNVAL):
                raise SystemExit(0)
            if ready == 0:
                pending = os.read(0, 64_000)
                if not pending:
                    raise SystemExit(0)
            elif pending:
                pending = pending[os.write(fd, pending):]
finally:
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    child.wait()
