#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/opt/nyc-alert-bot"
ENV_FILE="/etc/nyc-alert-bot.env"
REPOSITORY="git@github.com:theaustinayers/NYCAlert.git"
BRANCH="main"
KEY_FILE="/etc/nyc-alert-updater/deploy_key"
KNOWN_HOSTS="/etc/nyc-alert-updater/known_hosts"
DATA_DIR="/var/lib/nyc-alert-bot"
STATUS_DIR="/var/lib/nyc-alert-updater"
BACKUP_ROOT="/var/backups/nyc-alert-bot"
LOCK_FILE="/run/lock/nyc-alert-updater.lock"
WORK_DIR=""
STATUS_TMP=""

unit_data_dir="$(systemctl show nyc-alert-bot.service --property=Environment --value 2>/dev/null | tr ' ' '\n' | sed -n 's/^DATA_DIR=//p' | tail -n 1)"
if [[ -n "${unit_data_dir}" ]]; then
  DATA_DIR="${unit_data_dir}"
elif [[ -f "${ENV_FILE}" ]]; then
  configured_data_dir="$(awk -F= '$1 == "DATA_DIR" { value=substr($0, index($0, "=")+1); gsub(/^[[:space:]\"]+|[[:space:]\"]+$/, "", value); print value }' "${ENV_FILE}" | tail -n 1)"
  if [[ -n "${configured_data_dir}" && "${configured_data_dir}" != "./data" ]]; then
    if [[ "${configured_data_dir}" == /* ]]; then DATA_DIR="${configured_data_dir}"; else DATA_DIR="${APP_DIR}/${configured_data_dir}"; fi
  fi
fi

write_status() {
  local state="$1" message="$2" commit="${3:-}" now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  install -d -o root -g nyc-alert -m 0750 "${STATUS_DIR}"
  STATUS_TMP="${STATUS_DIR}/status.json.tmp"
  if [[ "${state}" == "updating" ]]; then
    printf '{"state":"updating","requestedAt":"%s","startedAt":"%s","message":"%s"}\n' "${request_at:-${now}}" "${now}" "${message}" > "${STATUS_TMP}"
  else
    printf '{"state":"%s","finishedAt":"%s","message":"%s"%s}\n' "${state}" "${now}" "${message}" "${commit:+,\"commit\":\"${commit}\"}" > "${STATUS_TMP}"
  fi
  chmod 0640 "${STATUS_TMP}"
  chown root:nyc-alert "${STATUS_TMP}"
  mv -f "${STATUS_TMP}" "${STATUS_DIR}/status.json"
}

finish() {
  local status=$?
  if (( status != 0 )); then
    write_status failed "Update failed; previous application files were restored when deployment had started. Check system journal." || true
  fi
  if [[ -n "${WORK_DIR}" && -d "${WORK_DIR}" ]]; then rm -rf -- "${WORK_DIR}"; fi
  exit "${status}"
}
trap finish EXIT

if [[ "${EUID}" -ne 0 ]]; then
  echo 'Protected updater must run as root.' >&2
  exit 1
fi
exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  echo 'Another update is already running.' >&2
  exit 1
fi
if [[ ! -s "${KEY_FILE}" || ! -s "${KNOWN_HOSTS}" ]]; then
  echo 'GitHub read-only deploy key or known_hosts is missing.' >&2
  exit 1
fi

request_at="$(cat "${DATA_DIR}/update-request" 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"
if [[ ! "${request_at}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.+-]+Z?$ ]]; then
  request_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi
write_status updating 'Fetching the private GitHub main branch and building staged application.'
rm -f -- "${DATA_DIR}/update-request"
WORK_DIR="$(mktemp -d /var/tmp/nyc-alert-update.XXXXXX)"
chmod 0700 "${WORK_DIR}"
export GIT_SSH_COMMAND="ssh -i ${KEY_FILE} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${KNOWN_HOSTS}"
git clone --depth 1 --branch "${BRANCH}" "${REPOSITORY}" "${WORK_DIR}/source"
commit="$(git -C "${WORK_DIR}/source" rev-parse --short HEAD)"
APP_DIR="${APP_DIR}" ENV_FILE="${ENV_FILE}" BACKUP_ROOT="${BACKUP_ROOT}" bash "${WORK_DIR}/source/deploy/update.sh"
write_status succeeded "Update to GitHub main passed build and health check." "${commit}"
trap - EXIT
rm -rf -- "${WORK_DIR}"
