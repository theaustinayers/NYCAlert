#!/usr/bin/env bash
set -Eeuo pipefail

DOMAIN="${DOMAIN:-nycalert.ai}"
EMAIL="${1:-${LETSENCRYPT_EMAIL:-}}"
APP_SERVICE="nyc-alert-bot.service"
DROPIN_DIR="/etc/systemd/system/${APP_SERVICE}.d"
DROPIN_FILE="${DROPIN_DIR}/zzzz-https-proxy.conf"
SITE_FILE="/etc/nginx/sites-available/${DOMAIN}"
ENABLED_SITE="/etc/nginx/sites-enabled/${DOMAIN}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo bash deploy/setup-letsencrypt.sh you@example.com" >&2
  exit 1
fi
if [[ -z "${EMAIL}" || "${EMAIL}" != *@*.* ]]; then
  echo "Provide a contact email: sudo bash deploy/setup-letsencrypt.sh you@example.com" >&2
  exit 1
fi
if [[ ! -f "/etc/systemd/system/${APP_SERVICE}" && ! -f "/lib/systemd/system/${APP_SERVICE}" ]]; then
  echo "${APP_SERVICE} is not installed. Install the NYC Alert service first." >&2
  exit 1
fi
if [[ -e "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]]; then
  echo "A certificate for ${DOMAIN} already exists. Use 'sudo certbot renew' to renew it; refusing to overwrite its Nginx configuration." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
was_active=0
systemctl is-active --quiet "${APP_SERVICE}" && was_active=1 || true
restore_app_on_error() {
  status=$?
  if (( status != 0 )) && (( was_active == 1 )); then
    systemctl restart "${APP_SERVICE}" || true
  fi
}
trap restore_app_on_error EXIT

# The application currently binds port 80. Stop it before installing Nginx,
# then run it only on loopback behind the public reverse proxy.
systemctl stop "${APP_SERVICE}" || true
apt-get update
apt-get install -y nginx certbot python3-certbot-nginx

install -d -m 0755 "${DROPIN_DIR}"
if [[ -f "${DROPIN_FILE}" ]]; then
  cp -a "${DROPIN_FILE}" "${DROPIN_FILE}.bak.$(date +%Y%m%d%H%M%S)"
fi
cat > "${DROPIN_FILE}" <<'UNIT'
[Service]
Environment=DASHBOARD_HOST=127.0.0.1
Environment=DASHBOARD_PORT=8080
UNIT
chmod 0644 "${DROPIN_FILE}"

# EnvironmentFile values override unit Environment= values in systemd. Update
# the existing protected file too; support both paths used by earlier installs.
set_env_value() {
  local file="$1" key="$2" value="$3"
  if grep -qE "^${key}=" "${file}"; then
    sed -i "s|^${key}=.*$|${key}=${value}|" "${file}"
  else
    printf '\n%s=%s\n' "${key}" "${value}" >> "${file}"
  fi
  chmod 0600 "${file}"
  chown root:root "${file}"
}

env_files_found=0
for candidate in /etc/nyc-alert-bot.env /etc/nyc-alert-bot/nyc-alert-bot.env; do
  if [[ -f "${candidate}" ]]; then
    set_env_value "${candidate}" DASHBOARD_HOST 127.0.0.1
    set_env_value "${candidate}" DASHBOARD_PORT 8080
    set_env_value "${candidate}" TRUST_PROXY true
    env_files_found=1
  fi
done
if (( env_files_found == 0 )); then
  echo "Could not find the bot environment file; inspect: systemctl cat ${APP_SERVICE}" >&2
  exit 1
fi

# Remove the earlier drop-in name from the first setup attempt if it exists;
# keep a backup so unrelated/manual changes can be restored if needed.
old_dropin="${DROPIN_DIR}/https-proxy.conf"
if [[ -f "${old_dropin}" ]]; then
  cp -a "${old_dropin}" "${old_dropin}.bak.$(date +%Y%m%d%H%M%S)"
  rm -f "${old_dropin}"
fi

cat > "${SITE_FILE}" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 3600s;
        proxy_buffering off;
    }
}
NGINX
ln -sfn "${SITE_FILE}" "${ENABLED_SITE}"
nginx -t
systemctl enable --now nginx
systemctl daemon-reload
systemctl enable "${APP_SERVICE}"
systemctl restart "${APP_SERVICE}"

if ! curl --fail --silent --show-error http://127.0.0.1:8080/api/health >/dev/null; then
  echo "NYC Alert did not respond on 127.0.0.1:8080; inspect: journalctl -u ${APP_SERVICE} -n 80" >&2
  exit 1
fi

# If UFW is active, allow only the standard web ports for Nginx/ACME.
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
  ufw allow 'Nginx Full'
fi

certbot --nginx --non-interactive --agree-tos --redirect --email "${EMAIL}" -d "${DOMAIN}"

trap - EXIT
cat <<DONE

HTTPS setup complete for https://${DOMAIN}
- Nginx proxies public HTTP/HTTPS to the app on 127.0.0.1:8080.
- Certbot's systemd timer will renew the certificate automatically.
- Ensure the domain A record (and AAAA record, if present) points to this server.
- Ensure provider firewalls allow inbound TCP ports 80 and 443.

Checks:
  systemctl status nginx ${APP_SERVICE} --no-pager
  certbot renew --dry-run
  curl -I https://${DOMAIN}
DONE
