#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/nyc-alert-bot}"
DATA_DIR="${DATA_DIR:-/var/lib/nyc-alert-bot}"
ENV_FILE="/etc/nyc-alert-bot.env"
SERVICE_USER="nyc-alert"
UPDATER_DIR="/etc/nyc-alert-updater"
UPDATER_KEY="${UPDATER_DIR}/deploy_key"
UPDATER_KNOWN_HOSTS="${UPDATER_DIR}/known_hosts"
UPDATER_HELPER="/usr/local/sbin/nyc-alert-update"
UPDATER_UNIT="/etc/systemd/system/nyc-alert-updater.service"
UPDATER_PATH="/etc/systemd/system/nyc-alert-updater.path"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo bash deploy/install-github-updater.sh" >&2
  exit 1
fi
if [[ ! -f "${APP_DIR}/package.json" || ! -f "${APP_DIR}/dist/index.js" ]]; then
  echo "NYC Alert is not installed at ${APP_DIR}; install the app before enabling GitHub updates." >&2
  exit 1
fi
if ! systemctl cat nyc-alert-bot.service >/dev/null 2>&1; then
  echo 'nyc-alert-bot.service was not found.' >&2
  exit 1
fi
unit_data_dir="$(systemctl show nyc-alert-bot.service --property=Environment --value | tr ' ' '\n' | sed -n 's/^DATA_DIR=//p' | tail -n 1)"
if [[ -n "${unit_data_dir}" ]]; then
  DATA_DIR="${unit_data_dir}"
elif [[ -f "${ENV_FILE}" ]]; then
  configured_data_dir="$(awk -F= '$1 == "DATA_DIR" { value=substr($0, index($0, "=")+1); gsub(/^[[:space:]\"]+|[[:space:]\"]+$/, "", value); print value }' "${ENV_FILE}" | tail -n 1)"
  if [[ -n "${configured_data_dir}" && "${configured_data_dir}" != "./data" ]]; then
    if [[ "${configured_data_dir}" == /* ]]; then DATA_DIR="${configured_data_dir}"; else DATA_DIR="${APP_DIR}/${configured_data_dir}"; fi
  fi
fi
if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  echo "Service account ${SERVICE_USER} was not found." >&2
  exit 1
fi
if [[ "${DATA_DIR}" == "${APP_DIR}" || "${DATA_DIR}" == "${APP_DIR}/"* ]]; then
  echo 'Refusing updater setup because DATA_DIR points inside the replaceable app directory.' >&2
  exit 1
fi
if [[ ! -f deploy/nyc-alert-update.sh || ! -f deploy/update.sh ]]; then
  echo 'Run this script from the NYCAlert project root containing both updater scripts.' >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git jq openssh-client rsync tar
install -d -o root -g root -m 0700 "${UPDATER_DIR}"
if [[ ! -s "${UPDATER_KEY}" ]]; then
  ssh-keygen -q -t ed25519 -N '' -C 'NYC Alert read-only deploy key' -f "${UPDATER_KEY}"
fi
chown root:root "${UPDATER_KEY}"
chmod 0600 "${UPDATER_KEY}"
curl -fsSL https://api.github.com/meta | jq -r '.ssh_keys[] | select(startswith("ssh-ed25519 ")) | "github.com " + .' > "${UPDATER_KNOWN_HOSTS}"
if [[ ! -s "${UPDATER_KNOWN_HOSTS}" ]]; then
  echo 'Could not obtain GitHub SSH host keys from the HTTPS metadata API.' >&2
  exit 1
fi
chown root:root "${UPDATER_KNOWN_HOSTS}"
chmod 0600 "${UPDATER_KNOWN_HOSTS}"
install -o root -g root -m 0755 deploy/nyc-alert-update.sh "${UPDATER_HELPER}"
install -d -o root -g "${SERVICE_USER}" -m 0750 /var/lib/nyc-alert-updater
install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 0750 "${DATA_DIR}"

cat > "${UPDATER_UNIT}" <<UNIT
[Unit]
Description=Safely update NYC Alert from private GitHub main
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=root
Group=root
ExecStart=${UPDATER_HELPER}
TimeoutStartSec=20min
UMask=0077
NoNewPrivileges=true
PrivateTmp=false
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${APP_DIR} ${DATA_DIR} /var/lib/nyc-alert-updater /var/backups/nyc-alert-bot /var/tmp /run/lock
UNIT
chmod 0644 "${UPDATER_UNIT}"
cat > "${UPDATER_PATH}" <<'PATHUNIT'
[Unit]
Description=Watch for authorized NYC Alert GitHub update requests

[Path]
PathExists=${DATA_DIR}/update-request
Unit=nyc-alert-updater.service

[Install]
WantedBy=multi-user.target
PATHUNIT
chmod 0644 "${UPDATER_PATH}"
systemctl daemon-reload
systemctl enable --now nyc-alert-updater.path

cat <<'DONE'

Protected GitHub updater is installed.
Add this public key to the private repository's Settings > Deploy keys, leaving
"Allow write access" disabled. The public key is:
DONE
cat "${UPDATER_KEY}.pub"
cat <<'DONE'

The private key remains root-only at /etc/nyc-alert-updater/deploy_key.
Restart the NYC Alert service after deploying the app code that exposes the admin button.
DONE
