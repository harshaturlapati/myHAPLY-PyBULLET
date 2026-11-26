#!/bin/bash
# setup_pi.sh - setup of the Haply lab console on a Raspberry Pi (or any Debian/Ubuntu machine).
# Run it from inside the repository as the lab admin account (the one that owns the lab and has sudo), not as root
# and not with sudo:   bash lab/setup_pi.sh
# It is safe to run again, e.g. after a git pull: it rebuilds, reinstalls the services and restarts them.
#
#  1. builds the C++ engine and examples
#  2. creates the restricted user 'student' (no password, no SSH, no sudo, only group dialout) with its own clone of the repo
#  3. installs and (re)starts two services: haply-lab (engine + web page, port 8780) and haply-term (the page's terminal)
#  4. prints two links: the lab link for students and the view-only link for the lab TV
set -euo pipefail
# -e: stop at the first command that fails, -u: at an unset variable, pipefail: also when a command inside a pipe
# fails. Commands that may fail for a good reason (no SSH server, a key not written yet, ...) are tested with 'if'
# or followed by '||', so they do not stop the script.

if [ "$(id -u)" -eq 0 ]; then
  echo "Do not run this as root or with sudo: the lab services run as the account that runs this script."
  echo "Log in as the lab admin account (the one that owns the lab and has sudo) and run:   bash lab/setup_pi.sh"
  exit 1
fi
REPO="$(cd "$(dirname "$0")/.." && pwd)"
ADMIN="$(id -un)"
UPSTREAM="https://github.com/harshaturlapati/myHAPLY-PyBULLET.git"
KEYDIR="$HOME/.config/haply-lab"          # the lab key and the view key, written by lab/haply_lab.py
case "$REPO" in                          # the path goes into the service files, where these characters break it
  *[[:space:]#%\&]*) echo "Move the repository to a path without spaces or # % & (now: $REPO)."; exit 1;;
esac
# "sudo -n true" runs a harmless command without asking for a password. ("sudo -v" would ask even when
# commands need no password, e.g. on Raspberry Pi OS, where the sudo group's rule also matches the user.)
sudo -n true 2>/dev/null || sudo true || { echo "This account needs sudo."; exit 1; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
WARNINGS=""
warn() { echo "   WARNING: $*"; WARNINGS="$WARNINGS   - $*"$'\n'; }   # also repeated at the end

echo "== 1/4 build ($REPO)"
MISSING=""
for tool in cmake g++ make git python3; do              # the Debian packages have the same names as the commands
  command -v "$tool" >/dev/null || MISSING="$MISSING $tool"
done
if [ -n "$MISSING" ]; then
  sudo apt-get update
  sudo apt-get install -y --no-upgrade $MISSING         # $MISSING unquoted on purpose: one word per package
fi
cmake -S "$REPO" -B "$REPO/build" -DCMAKE_BUILD_TYPE=Release >/dev/null
cmake --build "$REPO/build" -j3

echo "== 2/4 restricted user 'student'"
if ! id student >/dev/null 2>&1; then
  sudo adduser --disabled-password --gecos "Haply lab student" student
fi
sudo usermod -G dialout student          # supplementary groups = dialout only (no sudo, video, gpio, netdev...)
sudo passwd -l student >/dev/null        # no password login at all
sudo usermod -s /usr/sbin/nologin student   # no login shell either: the Terminal tab starts bash itself, in its sandbox
# A locked password does not stop SSH logins with a key, and a student could add one to ~/.ssh/authorized_keys from
# the Terminal tab, then log in from a laptop with none of the sandbox (CAN sockets to the robot arms included).
# So the SSH server refuses the user 'student' outright. It is reloaded only if its whole configuration is valid.
echo "DenyUsers student" > "$TMP/haply-student.conf"
sudo mkdir -p /etc/ssh/sshd_config.d
sudo install -m 0644 "$TMP/haply-student.conf" /etc/ssh/sshd_config.d/haply-student.conf
if [ -x /usr/sbin/sshd ]; then
  sudo mkdir -p /run/sshd                 # 'sshd -t' needs it, and it exists only while ssh runs
  if sudo /usr/sbin/sshd -t; then
    if systemctl is-active --quiet ssh; then
      sudo systemctl reload ssh || warn "could not reload ssh: run 'sudo systemctl reload ssh'"
    fi
    if ! sudo /usr/sbin/sshd -T 2>/dev/null | grep -iE '^denyusers .*\bstudent\b' >/dev/null; then
      warn "the SSH server does not read /etc/ssh/sshd_config.d (no Include line?): add the line 'DenyUsers student' to /etc/ssh/sshd_config"
    fi
  else
    warn "'sudo sshd -t' finds an error in the SSH configuration, so ssh was not reloaded: fix it, then 'sudo systemctl reload ssh'"
  fi
fi
if ! sudo -H -u student bash -c "cd ~ && { [ -d myHAPLY-PyBULLET ] || git clone -q $UPSTREAM; }"; then
  warn "could not clone $UPSTREAM for 'student' (offline?): run this script again later"
fi

echo "== 3/4 services"
# The engine (run by haply-lab as $ADMIN) opens /dev/haply, which belongs to group dialout. The service gets the
# new group when it starts; your own shell only after you log in again.
if ! id -nG "$ADMIN" | grep -w dialout >/dev/null; then
  sudo usermod -aG dialout "$ADMIN"
  echo "   added $ADMIN to group dialout (log out and in again before you run the engine by hand)"
fi
# The keys must stay private to $ADMIN: every key holder can open a shell as 'student' in the Terminal tab.
mkdir -p "$KEYDIR"
chmod 0700 "$KEYDIR"
for f in "$KEYDIR/key" "$KEYDIR/viewkey"; do
  if [ -f "$f" ]; then chmod 0600 "$f"; fi
done
# haply-term runs lab/haply_term.py from this repository as 'student', so 'student' must be able to read it.
if ! sudo -u student test -r "$REPO/lab/haply_term.py"; then
  warn "user 'student' cannot read $REPO (is your home folder private?), so the Terminal tab cannot start. Fix: chmod o+x \"$HOME\""
fi
# The memory limits in haply-term.service need the kernel's memory controller. Some Raspberry Pi kernels switch it
# off unless the boot command line (cmdline.txt, one single line) says cgroup_enable=memory.
memory_controller_on() {
  if [ -r /sys/fs/cgroup/cgroup.controllers ]; then grep -w memory /sys/fs/cgroup/cgroup.controllers >/dev/null
  else awk '$1 == "memory" { on = $4 } END { exit !(on == 1) }' /proc/cgroups 2>/dev/null; fi
}
if ! memory_controller_on; then
  CMDLINE=""
  if [ -f /boot/firmware/cmdline.txt ]; then CMDLINE=/boot/firmware/cmdline.txt
  elif [ -f /boot/cmdline.txt ]; then CMDLINE=/boot/cmdline.txt; fi
  if [ -n "$CMDLINE" ]; then
    if ! grep -w "cgroup_enable=memory" "$CMDLINE" >/dev/null; then
      sudo cp "$CMDLINE" "$CMDLINE.before-haply"
      sudo sed -i '1 s/$/ cgroup_enable=memory cgroup_memory=1/' "$CMDLINE"
    fi
    warn "the memory limits for student shells start working after a reboot (cgroup_enable=memory is in $CMDLINE): sudo reboot"
  else
    warn "the kernel's memory controller is off, so the memory limits for student shells do nothing: boot with cgroup_enable=memory"
  fi
fi
for s in haply-lab haply-term; do
  sed "s#@ADMIN@#$ADMIN#g; s#@REPO@#$REPO#g" "$REPO/lab/systemd/$s.service" > "$TMP/$s.service"
  sudo install -m 0644 "$TMP/$s.service" "/etc/systemd/system/$s.service"
done
sudo systemctl daemon-reload
sudo systemctl enable haply-lab haply-term
# restart, not 'enable --now', which leaves running services alone: a re-run must pick up the new engine and unit files.
# A restart switches forces off (the engine sends a zero force first) and ends every terminal session: not during a class.
sudo systemctl restart haply-lab haply-term

echo "== 4/4 links"
# lab/haply_lab.py writes the keys when it starts (they stay the same across restarts). Wait up to 15 s for the page.
page_up() { python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8780/', timeout=1)" 2>/dev/null; }
for _ in $(seq 30); do
  if page_up && [ -s "$KEYDIR/key" ] && [ -s "$KEYDIR/viewkey" ]; then break; fi
  sleep 0.5
done
systemctl --no-pager --lines=0 status haply-lab haply-term | grep -E "Active:|●" || true
RC=0
if ! page_up || [ ! -s "$KEYDIR/key" ]; then
  echo "   haply-lab does not answer on port 8780 or has not written its key. Its last log lines:"
  sudo journalctl -u haply-lab -n 30 --no-pager || true
  warn "haply-lab is not running properly: read 'journalctl -u haply-lab', fix the problem, then run this script again"
  RC=1
fi
links() {   # $1 = the query string; one link per IPv4 address of this machine, and one with its .local name
  for ip in $(hostname -I 2>/dev/null || true); do case "$ip" in *:*) ;; *) echo "   http://$ip:8780/?$1";; esac; done
  echo "   http://$(hostname).local:8780/?$1"
}
if [ -s "$KEYDIR/key" ]; then
  echo "Lab link for students (the lab key is in $KEYDIR/key):"
  links "key=$(tr -d '[:space:]' < "$KEYDIR/key")"
fi
if [ -s "$KEYDIR/viewkey" ]; then
  echo "View-only link for the lab TV or a projector: watch and stop forces, never take control ($KEYDIR/viewkey):"
  links "key=$(tr -d '[:space:]' < "$KEYDIR/viewkey")&view=tv"
elif [ "$RC" -eq 0 ]; then
  warn "no view key ($KEYDIR/viewkey) yet: is lab/haply_lab.py up to date?"
fi
if [ -n "$WARNINGS" ]; then printf '\n== please check\n%s' "$WARNINGS"; fi
exit "$RC"
