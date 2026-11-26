#!/bin/bash
# setup_pi.sh - one-time setup of the Haply lab console on a Raspberry Pi (or any Debian/Ubuntu machine).
# Run it as the lab admin account (needs sudo) from inside the repository:   bash lab/setup_pi.sh
#
#  1. builds the C++ engine and examples
#  2. creates the restricted user 'student' (no password, no sudo, only group dialout) with its own clone of the repo
#  3. installs and starts two services: haply-lab (engine + web page, port 8780) and haply-term (the page's terminal)
#  4. prints the link to hand to students
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
ADMIN="$(id -un)"
UPSTREAM="https://github.com/harshaturlapati/myHAPLY-PyBULLET.git"

echo "== 1/4 build ($REPO)"
command -v cmake >/dev/null || sudo apt-get install -y --no-upgrade cmake g++
cmake -S "$REPO" -B "$REPO/build" -DCMAKE_BUILD_TYPE=Release >/dev/null
cmake --build "$REPO/build" -j3

echo "== 2/4 restricted user 'student'"
if ! id student >/dev/null 2>&1; then
  sudo adduser --disabled-password --gecos "Haply lab student" student
fi
sudo usermod -G dialout student          # supplementary groups = dialout only (no sudo, video, gpio, netdev...)
sudo passwd -l student >/dev/null        # no password login at all
sudo -u student bash -c "cd ~ && { [ -d myHAPLY-PyBULLET ] || git clone -q $UPSTREAM; }"

echo "== 3/4 services"
for s in haply-lab haply-term; do
  sed "s#@ADMIN@#$ADMIN#g; s#@REPO@#$REPO#g" "$REPO/lab/systemd/$s.service" | sudo tee /etc/systemd/system/$s.service >/dev/null
done
sudo systemctl daemon-reload
sudo systemctl enable --now haply-lab haply-term
sleep 3
systemctl --no-pager --lines=0 status haply-lab haply-term | grep -E "Active:|●" || true

echo "== 4/4 links for students"
KEY="$(cat "$HOME/.config/haply-lab/key")"
for ip in $(hostname -I); do case "$ip" in *:*) ;; *) echo "   http://$ip:8780/?key=$KEY";; esac; done
echo "   http://$(hostname).local:8780/?key=$KEY"
