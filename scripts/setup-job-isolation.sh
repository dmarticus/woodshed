#!/usr/bin/env bash
# Run once as root on the controller VM. Creates the user that Woodshed's coding agents run as,
# the fixed systemd template each job starts from, and the polkit rule that lets the controller
# start and stop only those units. The controller never needs root after this.
#
#   sudo bash setup-job-isolation.sh            # install or update
#   sudo bash setup-job-isolation.sh --check    # report what is installed, change nothing
set -euo pipefail

CONTROLLER=woodshed
WORKER=woodshed-worker
CONTROLLER_HOME=/home/$CONTROLLER
WORKER_HOME=/var/lib/$WORKER
DATA="$CONTROLLER_HOME/repos/woodshed/.woodshed"
CHECKOUT="$CONTROLLER_HOME/repos/posthog"
TOKEN="$CONTROLLER_HOME/.config/woodshed/worker-github-token"
UNIT=/etc/systemd/system/woodshed-job@.service
RELEASE_UNIT=/etc/systemd/system/woodshed-job-release@.service
POLKIT=/etc/polkit-1/rules.d/50-woodshed-jobs.rules
APPARMOR=/etc/apparmor.d/woodshed-job

if [[ "$(id -u)" != 0 ]]; then echo "Run this script as root." >&2; exit 1; fi
if ! id "$CONTROLLER" >/dev/null 2>&1; then echo "The $CONTROLLER user does not exist. Run bootstrap-linux.sh first." >&2; exit 1; fi

check() {
    local ok=1
    id "$WORKER" >/dev/null 2>&1 && echo "ok   user $WORKER" || { echo "MISSING user $WORKER"; ok=0; }
    command -v setfacl >/dev/null && echo "ok   acl tools" || { echo "MISSING acl tools"; ok=0; }
    [[ -f $UNIT ]] && echo "ok   $UNIT" || { echo "MISSING $UNIT"; ok=0; }
    [[ -f $RELEASE_UNIT ]] && echo "ok   $RELEASE_UNIT" || { echo "MISSING $RELEASE_UNIT"; ok=0; }
    [[ -f $POLKIT ]] && echo "ok   $POLKIT" || { echo "MISSING $POLKIT"; ok=0; }
    grep -qx woodshed-job /sys/kernel/security/apparmor/profiles 2>/dev/null || grep -q "^woodshed-job " /sys/kernel/security/apparmor/profiles 2>/dev/null && echo "ok   AppArmor profile woodshed-job" || { echo "MISSING AppArmor profile woodshed-job"; ok=0; }
    [[ -f $TOKEN ]] && echo "ok   worker GitHub token" || echo "todo worker GitHub token: run scripts/setup-worker-token.ts as $CONTROLLER, or set workerGitHub to controller"
    [[ -f $WORKER_HOME/.codex/auth.json ]] && echo "ok   worker Codex login" || echo "todo worker Codex login: sudo -u $WORKER -H codex login --device-auth"
    [[ $ok == 1 ]]
}
if [[ "${1:-}" == --check ]]; then check; exit; fi

export DEBIAN_FRONTEND=noninteractive
command -v setfacl >/dev/null || { apt-get update; apt-get install -y acl; }

if ! id "$WORKER" >/dev/null 2>&1; then
    useradd --system --create-home --home-dir "$WORKER_HOME" --shell /usr/sbin/nologin "$WORKER"
fi
install -d -m 0750 -o "$WORKER" -g "$WORKER" "$WORKER_HOME"
# The worker runs Git inside checkouts the controller owns.
runuser -u "$WORKER" -- git config --global safe.directory '*'
runuser -u "$WORKER" -- git config --global core.hooksPath /dev/null

# Agents read the shared object store but cannot write it or its config and hooks.
# The default entries keep objects the controller fetches later readable too.
setfacl -R -m "u:$WORKER:rX" "$CHECKOUT/.git"
find "$CHECKOUT/.git" -type d -exec setfacl -d -m "u:$WORKER:rX,u:$CONTROLLER:rwX" {} +
install -d -m 0700 -o "$CONTROLLER" -g "$CONTROLLER" "$CONTROLLER_HOME/.config/woodshed"

# Ubuntu blocks unprivileged user namespaces, which Codex's bubblewrap sandbox needs. Without this,
# sandboxed commands fail and agents escalate to running them unsandboxed. Only job units get it.
cat > "$APPARMOR" <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>

profile woodshed-job flags=(unconfined) {
  userns,
}
PROFILE
apparmor_parser -r "$APPARMOR"

cat > "$UNIT" <<UNIT
# Installed by Woodshed's setup-job-isolation.sh. One instance per job; the instance name is the job name.
[Unit]
Description=Woodshed job %i
ConditionPathExists=$DATA/jobs/%i/worker.json

[Service]
Type=simple
User=$WORKER
Group=$WORKER
WorkingDirectory=$DATA/jobs/%i/checkout
ExecStart=$CONTROLLER_HOME/.bun/bin/bun $CONTROLLER_HOME/woodshed-current/src/worker.ts $DATA/jobs/%i/worker.json
Environment=HOME=$WORKER_HOME
Environment=PATH=$WORKER_HOME/.local/bin:$CONTROLLER_HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin
Environment=FLOX_DISABLE_METRICS=true
LoadCredential=github-token:$TOKEN
StandardInput=null
StandardOutput=append:$DATA/jobs/%i/output.log
StandardError=inherit
UMask=0007
AppArmorProfile=woodshed-job

# The agent sees only its own job, the shared Git objects, and the code it runs.
ProtectHome=tmpfs
BindPaths=$DATA/jobs/%i
BindReadOnlyPaths=$CHECKOUT/.git
BindReadOnlyPaths=$CONTROLLER_HOME/woodshed-current
BindReadOnlyPaths=$CONTROLLER_HOME/.bun
ProtectSystem=full
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
LockPersonality=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
NoNewPrivileges=yes

# No MemoryHigh: throttling a runaway job leaves it crawling for hours. Past MemoryMax it is killed and reported.
MemoryMax=3G
MemorySwapMax=512M
TasksMax=1024
CPUWeight=50
KillMode=control-group
TimeoutStopSec=20
UNIT

cat > "$RELEASE_UNIT" <<UNIT
# Installed by Woodshed's setup-job-isolation.sh. Hands a finished job's files back to the controller
# so it can delete them, even ones the agent made private.
[Unit]
Description=Release Woodshed job %i

[Service]
Type=oneshot
User=$WORKER
Group=$WORKER
ProtectHome=tmpfs
BindPaths=$DATA/jobs/%i
ExecStart=-/usr/bin/find $DATA/jobs/%i -user $WORKER ( -type d -exec chmod u+rwx {} + -exec setfacl -m u:$CONTROLLER:rwx,m::rwx {} + ) , ( ! -type d ! -type l -exec setfacl -m u:$CONTROLLER:rw,m::rw {} + )
UNIT

cat > "$POLKIT" <<'RULES'
// Installed by Woodshed's setup-job-isolation.sh.
polkit.addRule(function (action, subject) {
    if (action.id !== "org.freedesktop.systemd1.manage-units" || subject.user !== "woodshed") return polkit.Result.NOT_HANDLED;
    var unit = action.lookup("unit") || "";
    var verb = action.lookup("verb") || "";
    if (!/^woodshed-job(-release)?@ws-[a-z0-9-]{1,60}\.service$/.test(unit)) return polkit.Result.NOT_HANDLED;
    if (["start", "stop", "kill", "reset-failed"].indexOf(verb) >= 0) return polkit.Result.YES;
    return polkit.Result.NOT_HANDLED;
});
RULES
# The owner answers an isolated run's questions and permission requests with this, over SSH as $CONTROLLER.
cat > /usr/local/bin/woodshed-respond <<RESPOND
#!/bin/sh
exec $CONTROLLER_HOME/.bun/bin/bun $CONTROLLER_HOME/woodshed-current/scripts/respond.ts "\$@"
RESPOND
chmod 0755 /usr/local/bin/woodshed-respond
chmod 0644 "$UNIT" "$RELEASE_UNIT" "$POLKIT"
systemctl daemon-reload
systemctl try-restart polkit.service || true

echo
check || true
echo
echo "Next, as $CONTROLLER: create the worker's read-only GitHub token with scripts/setup-worker-token.ts."
echo "Then log the worker in to Codex: sudo -u $WORKER -H codex login --device-auth"
