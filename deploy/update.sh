#!/usr/bin/env bash
set -Eeuo pipefail

# Safely update an existing NYC Alert install without replacing its environment or DATA_DIR.
# Run from the updated project root: sudo bash deploy/update.sh

APP_DIR="${APP_DIR:-/opt/nyc-alert-bot}"
ENV_FILE="${ENV_FILE:-/etc/nyc-alert-bot.env}"
SERVICE="nyc-alert-bot.service"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/nyc-alert-bot}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
STAGE=""
ROLLBACK_STAGE=""
BACKUP="${BACKUP_ROOT}/app-${STAMP}.tar.gz"
SERVICE_WAS_ACTIVE=0
DEPLOY_STARTED=0

report_update_progress() {
  local message="$1" status_file="${NYC_ALERT_UPDATE_STATUS_FILE:-}"
  [[ -n "${status_file}" ]] || return 0
  local now tmp
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  tmp="${status_file}.tmp"
  jq -n \
    --arg requestedAt "${NYC_ALERT_UPDATE_REQUESTED_AT:-${now}}" \
    --arg startedAt "${NYC_ALERT_UPDATE_STARTED_AT:-${now}}" \
    --arg message "${message}" \
    '{state:"updating",requestedAt:$requestedAt,startedAt:$startedAt,message:$message}' > "${tmp}"
  chmod 0640 "${tmp}"
  chown root:nyc-alert "${tmp}"
  mv -f -- "${tmp}" "${status_file}"
}

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root, for example: sudo bash deploy/update.sh" >&2
  exit 1
fi
if [[ ! -f "${SOURCE_DIR}/package.json" || ! -f "${SOURCE_DIR}/package-lock.json" || ! -d "${SOURCE_DIR}/src" ]]; then
  echo "Run this script from the updated NYCAlert project root (package.json, package-lock.json and src/ must be present)." >&2
  exit 1
fi
if [[ ! -d "${APP_DIR}" || ! -f "${APP_DIR}/package.json" ]]; then
  echo "Installed app not found at ${APP_DIR}. Run deploy/install-ubuntu.sh for a first install." >&2
  exit 1
fi
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Protected service environment file not found: ${ENV_FILE}" >&2
  exit 1
fi
if ! command -v rsync >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1; then
  echo "rsync, curl and tar are required. On Ubuntu run: sudo apt-get install rsync curl tar" >&2
  exit 1
fi

DATA_DIR="$(sed -n 's/^DATA_DIR=//p' "${ENV_FILE}" | tail -n 1 | tr -d '\r"' | xargs || true)"
if [[ -z "${DATA_DIR}" || "${DATA_DIR}" == "./data" ]]; then
  echo "DATA_DIR in ${ENV_FILE} must point to persistent storage (installer default: /var/lib/nyc-alert-bot)." >&2
  echo "Refusing to update an installation whose account/subscription data may be inside the replaceable app directory." >&2
  exit 1
fi
if [[ "${DATA_DIR}" != /* ]]; then
  DATA_DIR="${APP_DIR}/${DATA_DIR}"
fi
case "${DATA_DIR}/" in
  "${APP_DIR}/"*)
    echo "DATA_DIR resolves inside ${APP_DIR}; refusing update to protect account and webhook data." >&2
    echo "Move DATA_DIR to a persistent path such as /var/lib/nyc-alert-bot before retrying." >&2
    exit 1
    ;;
esac

install -d -m 0700 "${BACKUP_ROOT}"
install -d -m 0755 "$(dirname "${APP_DIR}")"
STAGE="$(mktemp -d /var/tmp/nyc-alert-stage.XXXXXX)"
install -d -m 0700 "${STAGE}/home" "${STAGE}/npm-cache" "${STAGE}/node-gyp" "${STAGE}/xdg-cache" "${STAGE}/tmp"
cleanup() {
  if [[ -n "${STAGE}" && -d "${STAGE}" ]]; then rm -rf -- "${STAGE}"; fi
  if [[ -n "${ROLLBACK_STAGE}" && -d "${ROLLBACK_STAGE}" ]]; then rm -rf -- "${ROLLBACK_STAGE}"; fi
}
restore_on_failure() {
  status=$?
  if (( status != 0 )); then
    if (( DEPLOY_STARTED == 1 )); then
      report_update_progress 'Update failed during deployment; restoring the previous application files.' || true
    else
      report_update_progress 'Update failed before deployment; the existing application remains in place.' || true
    fi
  fi
  if (( status != 0 )) && (( DEPLOY_STARTED == 1 )); then
    echo "Update failed; restoring application files from ${BACKUP}. Persistent DATA_DIR and environment file were not touched." >&2
    systemctl stop "${SERVICE}" || true
    ROLLBACK_STAGE="$(mktemp -d /var/tmp/nyc-alert-rollback.XXXXXX)"
    tar -xzf "${BACKUP}" -C "${ROLLBACK_STAGE}" --numeric-owner || true
    if [[ -d "${ROLLBACK_STAGE}/$(basename "${APP_DIR}")" ]]; then
      rsync -a --delete \
        --exclude='data/' \
        --exclude='.env' \
        --exclude='*.log' \
        "${ROLLBACK_STAGE}/$(basename "${APP_DIR}")/" "${APP_DIR}/" || true
    fi
    if [[ -d "${APP_DIR}/dist" ]]; then chown -R nyc-alert:nyc-alert "${APP_DIR}/dist" || true; fi
    systemctl start "${SERVICE}" || true
    report_update_progress 'Update failed; the previous application files were restored.' || true
    echo "Inspect the service with: sudo journalctl -u ${SERVICE} -n 100 --no-pager" >&2
  fi
  cleanup
  exit "${status}"
}
trap restore_on_failure EXIT

# Stage and compile before interrupting the running service.
report_update_progress 'Preparing a clean staging directory from GitHub main.'
rsync -a --delete \
  --exclude='.git/' \
  --exclude='node_modules/' \
  --exclude='dist/' \
  --exclude='data/' \
  --exclude='.env' \
  --exclude='*.log' \
  "${SOURCE_DIR}/" "${STAGE}/"
(
  cd "${STAGE}"
  export HOME="${STAGE}/home"
  export XDG_CACHE_HOME="${STAGE}/xdg-cache"
  export TMPDIR="${STAGE}/tmp"
  export TMP="${STAGE}/tmp"
  export TEMP="${STAGE}/tmp"
  export npm_config_cache="${STAGE}/npm-cache"
  export npm_config_devdir="${STAGE}/node-gyp"
  report_update_progress 'Installing dependencies in the isolated staging directory (npm ci).'
  npm ci
  report_update_progress 'Building the staged application.'
  npm run build
)

# Save installed app code and runtime files, but never archive its data directory or secrets.
report_update_progress 'Creating a protected backup of the current application files.'
tar -czf "${BACKUP}" -C "$(dirname "${APP_DIR}")" \
  --exclude="$(basename "${APP_DIR}")/data" \
  --exclude="$(basename "${APP_DIR}")/data/**" \
  --exclude="$(basename "${APP_DIR}")/.env" \
  --exclude="$(basename "${APP_DIR}")/*.log" \
  "$(basename "${APP_DIR}")"
chmod 0600 "${BACKUP}"

systemctl is-active --quiet "${SERVICE}" && SERVICE_WAS_ACTIVE=1 || true
DEPLOY_STARTED=1
report_update_progress 'Installing the staged application; persistent DATA_DIR and environment are untouched.'
if (( SERVICE_WAS_ACTIVE == 1 )); then systemctl stop "${SERVICE}"; fi

# Preserve the existing DATA_DIR (including accounts, subscriptions, site settings and webhook assignments).
rsync -a --delete \
  --exclude='data/' \
  --exclude='.env' \
  --exclude='*.log' \
  "${STAGE}/" "${APP_DIR}/"
chown -R root:root "${APP_DIR}"
chmod -R a+rX "${APP_DIR}"
install -d -o nyc-alert -g nyc-alert -m 0750 "${APP_DIR}/dist"
chown -R nyc-alert:nyc-alert "${APP_DIR}/dist"

systemctl start "${SERVICE}"
PORT="$(sed -n 's/^DASHBOARD_PORT=//p' "${ENV_FILE}" | tail -n 1 | tr -d '\r"' | xargs || true)"
if [[ -z "${PORT}" ]]; then PORT="${SERVER_PORT:-${PORT:-8080}}"; fi
report_update_progress "Waiting for the application health check on port ${PORT}."
if ! curl --fail --silent --show-error --retry 15 --retry-connrefused --retry-delay 2 "http://127.0.0.1:${PORT}/api/health" >/dev/null; then
  echo "New app did not pass its health check at 127.0.0.1:${PORT}." >&2
  exit 1
fi

DEPLOY_STARTED=0
trap cleanup EXIT
cat <<DONE

NYC Alert update complete.
- Environment preserved: ${ENV_FILE}
- Persistent application data preserved: ${DATA_DIR}
- Users, reviewers/moderators, subscriptions, webhook assignments and site settings were not replaced.
- AI Learning Debugger data is preserved unless you clear it from Admin → Settings.
- Rollback snapshot: ${BACKUP}
- Health check passed: http://127.0.0.1:${PORT}/api/health

DONE
