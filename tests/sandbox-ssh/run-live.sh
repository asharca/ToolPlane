#!/usr/bin/env bash
set -euo pipefail
# Ephemeral GitHub runner fixture only; never connect to a real target.
fixture=$(mktemp -d)
account="tpssh${RANDOM}"
cleanup() {
  if test -f "$fixture/sshd.pid"; then sudo kill "$(cat "$fixture/sshd.pid")" || true; fi
  sudo pkill -u "$account" || true
  sudo userdel -r "$account" >/dev/null 2>&1 || true
  sudo rm -rf "$fixture"
}
trap cleanup EXIT
chmod 755 "$fixture"
sudo useradd -m -s /bin/sh "$account"
sudo passwd -d "$account" >/dev/null
sudo mkdir -p /run/sshd
ssh-keygen -q -t ed25519 -N '' -f "$fixture/host"
ssh-keygen -q -t ed25519 -N '' -f "$fixture/client"
ssh-keygen -q -t ed25519 -N '' -f "$fixture/wrong"
port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
mkdir "$fixture/work"
sudo chown "$account" "$fixture/work"
cat > "$fixture/sshd.conf" <<CFG
Port $port
ListenAddress 127.0.0.1
HostKey $fixture/host
PidFile $fixture/sshd.pid
AuthorizedKeysFile $fixture/client.pub
AllowUsers $account
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
PermitRootLogin no
AllowAgentForwarding no
AllowTcpForwarding no
StrictModes no
LogLevel ERROR
CFG
sudo /usr/sbin/sshd -f "$fixture/sshd.conf" -E "$fixture/sshd.log"
printf '[127.0.0.1]:%s %s\n' "$port" "$(cat "$fixture/host.pub")" > "$fixture/known_hosts"
printf '[127.0.0.1]:%s %s\n' "$port" "$(cat "$fixture/wrong.pub")" > "$fixture/bad_hosts"
export TOOLPLANE_SSH_LIVE_TARGET="$fixture/target.json"
export TOOLPLANE_SSH_BAD_HOSTS="$fixture/bad_hosts"
python3 - "$fixture" "$account" "$port" <<'PY'
import json, sys
root, user, port = sys.argv[1:]
with open(root+'/target.json','w') as f:
    json.dump(dict(host='127.0.0.1', port=int(port), username=user, root=root+'/work', identityFile=root+'/client', knownHostsFile=root+'/known_hosts'), f)
PY
node --test tests/sandbox-ssh/ssh-live.test.mjs
