#!/usr/bin/env bash
# Prepare a dedicated Ubuntu VM. Run as root, then deploy Woodshed as woodshed.
set -euo pipefail

if [[ "$(id -u)" != 0 ]]; then
    echo "Run this script as root on the new VM." >&2
    exit 1
fi
source /etc/os-release
if [[ "$ID" != ubuntu || "$VERSION_ID" != 24.04 || "$(uname -m)" != x86_64 ]]; then
    echo "This bootstrap supports Ubuntu 24.04 on x86_64." >&2
    exit 1
fi
if [[ ! -s /root/.ssh/authorized_keys ]]; then
    echo "Install an administrator SSH public key before bootstrapping." >&2
    exit 1
fi

export DEBIAN_FRONTEND=noninteractive
if command -v cloud-init >/dev/null; then
    cloud-init status --wait
fi
apt-get update
apt-get install -y ca-certificates curl git gh jq unzip xz-utils build-essential \
    pkg-config libssl-dev ripgrep unattended-upgrades dbus-user-session
# Ubuntu's bundled gh predates API pagination features Woodshed uses.
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
chmod 0644 /etc/apt/keyrings/githubcli-archive-keyring.gpg
echo 'deb [arch=amd64 signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main' > /etc/apt/sources.list.d/github-cli.list
apt-get update
apt-get install -y gh

if ! id woodshed >/dev/null 2>&1; then
    useradd --create-home --shell /bin/bash woodshed
fi
install -d -m 0700 -o woodshed -g woodshed /home/woodshed/.ssh
install -m 0600 -o woodshed -g woodshed /root/.ssh/authorized_keys /home/woodshed/.ssh/authorized_keys
install -d -m 0755 -o woodshed -g woodshed /home/woodshed/repos /home/woodshed/.local /home/woodshed/.local/bin
loginctl enable-linger woodshed
systemctl start "user@$(id -u woodshed).service"

cat > /etc/ssh/sshd_config.d/00-woodshed.conf <<'SSH'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
SSH
sshd -t
systemctl reload ssh

if [[ ! -e /swapfile ]]; then
    fallocate -l 8G /swapfile
    chmod 0600 /swapfile
    mkswap /swapfile
fi
if ! swapon --show=NAME --noheadings | rg -q '^/swapfile$'; then
    swapon /swapfile
fi
if ! rg -q '^/swapfile\s' /etc/fstab; then
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
echo 'vm.swappiness=10' > /etc/sysctl.d/90-woodshed.conf
sysctl --load /etc/sysctl.d/90-woodshed.conf
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'APT'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT

task_tmp="$(mktemp -d)"
trap 'rm -rf "$task_tmp"' EXIT
chmod 0755 "$task_tmp"
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" != 24 ]]; then
    curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o "$task_tmp/SHASUMS256.txt"
    node_archive="$(awk '$2 ~ /^node-v[0-9.]+-linux-x64.tar.xz$/ { print $2 }' "$task_tmp/SHASUMS256.txt")"
    [[ "$node_archive" =~ ^node-v[0-9.]+-linux-x64.tar.xz$ ]]
    curl -fsSL "https://nodejs.org/dist/latest-v24.x/$node_archive" -o "$task_tmp/$node_archive"
    (cd "$task_tmp"; awk -v file="$node_archive" '$2 == file' SHASUMS256.txt | sha256sum -c -)
    tar -xJf "$task_tmp/$node_archive" -C /usr/local --strip-components=1
fi
if [[ ! -x /home/woodshed/.bun/bin/bun ]]; then
    curl -fsSL https://bun.sh/install -o "$task_tmp/install-bun.sh"
    runuser -u woodshed -- bash "$task_tmp/install-bun.sh" bun-v1.3.14
fi
if ! command -v codex >/dev/null || [[ "$(codex --version)" != 'codex-cli 0.166.0' ]]; then
    npm install --global @openai/codex@0.166.0
fi
if [[ ! -x /home/woodshed/.local/bin/hc ]]; then
    curl -fsSL https://releases.herdr.dev/core/install.sh -o "$task_tmp/install-hc.sh"
    runuser -u woodshed -- sh "$task_tmp/install-hc.sh"
fi
if ! command -v flox >/dev/null; then
    curl -fsSL https://get.flox.dev -o "$task_tmp/install-flox.sh"
    FLOX_DISABLE_METRICS=1 sh "$task_tmp/install-flox.sh"
fi

install -d -m 0700 -o woodshed -g woodshed /home/woodshed/.config
cat > /home/woodshed/.config/woodshed-shell.sh <<'PROFILE'
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:$PATH"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
export FLOX_DISABLE_METRICS=true
PROFILE
chown woodshed:woodshed /home/woodshed/.config/woodshed-shell.sh
touch /home/woodshed/.profile
if ! rg -q '^source /home/woodshed/.config/woodshed-shell.sh$' /home/woodshed/.profile; then
    echo 'source /home/woodshed/.config/woodshed-shell.sh' >> /home/woodshed/.profile
fi
chown woodshed:woodshed /home/woodshed/.profile
echo 'Runtime installed. Next: deploy source, authenticate GitHub and Codex, then run setup-headless.ts as woodshed.'
