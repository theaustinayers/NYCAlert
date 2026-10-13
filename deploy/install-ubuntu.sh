#!/usr/bin/env bash
set -Eeuo pipefail

# Installs the app, Node.js 22, loopback-only Postfix mail, CPU whisper.cpp + English base model, and a systemd unit.
# Run from the project root: sudo bash deploy/install-ubuntu.sh

APP_DIR="${APP_DIR:-/opt/nyc-alert-bot}"
WHISPER_DIR="${WHISPER_DIR:-/opt/whisper.cpp}"
MODEL_NAME="${WHISPER_MODEL_NAME:-base.en}"
SERVICE_USER="nyc-alert"
ENV_FILE="/etc/nyc-alert-bot.env"
UNIT_FILE="/etc/systemd/system/nyc-alert-bot.service"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root, for example: sudo bash deploy/install-ubuntu.sh" >&2
  exit 1
fi
if [[ ! -f package.json || ! -f package-lock.json || ! -d src ]]; then
  echo "Run this script from the NYCAlert project root (package.json and src/ must be here)." >&2
  exit 1
fi
if [[ "$(. /etc/os-release && echo "${ID}:${VERSION_ID}")" != "ubuntu:24.04" ]]; then
  echo "This installer targets Ubuntu 24.04; detected $(. /etc/os-release && echo "${PRETTY_NAME:-unknown}")." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
printf '%s\n' 'postfix postfix/main_mailer_type select Internet Site' 'postfix postfix/mailname string nycalert.ai' | debconf-set-selections
apt-get update
apt-get install -y ca-certificates curl cmake build-essential git gnupg wget rsync pkg-config ffmpeg postfix opendkim opendkim-tools
if [[ -f /etc/postfix/main.cf ]]; then
  cp -a /etc/postfix/main.cf "/etc/postfix/main.cf.nycalert.bak.$(date +%Y%m%d%H%M%S)"
fi
if [[ -f /etc/opendkim.conf ]]; then
  cp -a /etc/opendkim.conf "/etc/opendkim.conf.nycalert.bak.$(date +%Y%m%d%H%M%S)"
fi
postconf -e 'myhostname = mail.nycalert.ai'
postconf -e 'myorigin = nycalert.ai'
postconf -e 'mydestination = localhost'
postconf -e 'inet_interfaces = loopback-only'
postconf -e 'mynetworks = 127.0.0.0/8 [::1]/128'
postconf -e 'smtpd_relay_restrictions = permit_mynetworks, reject_unauth_destination'
postconf -e 'smtp_tls_security_level = may'
install -d -o opendkim -g opendkim -m 0750 /etc/opendkim/keys/nycalert.ai
if [[ ! -s /etc/opendkim/keys/nycalert.ai/nyc-alert.private ]]; then
  opendkim-genkey -b 2048 -d nycalert.ai -s nyc-alert -D /etc/opendkim/keys/nycalert.ai
fi
chown opendkim:opendkim /etc/opendkim/keys/nycalert.ai/nyc-alert.private
chmod 0600 /etc/opendkim/keys/nycalert.ai/nyc-alert.private
cat > /etc/opendkim.conf <<'OPENDKIM'
Syslog                  yes
UMask                   007
Mode                    sv
Canonicalization        relaxed/simple
Domain                  nycalert.ai
Selector                nyc-alert
KeyFile                 /etc/opendkim/keys/nycalert.ai/nyc-alert.private
Socket                  inet:8891@127.0.0.1
PidFile                 /run/opendkim/opendkim.pid
UserID                  opendkim
InternalHosts           refile:/etc/opendkim/trusted.hosts
OPENDKIM
cat > /etc/opendkim/trusted.hosts <<'TRUSTED'
127.0.0.1
::1
localhost
TRUSTED
chown root:opendkim /etc/opendkim.conf /etc/opendkim/trusted.hosts
chmod 0640 /etc/opendkim.conf /etc/opendkim/trusted.hosts
postconf -e 'smtpd_milters = inet:127.0.0.1:8891'
postconf -e 'smtp_milters = inet:127.0.0.1:8891'
postconf -e 'milter_default_action = accept'
postconf -e 'milter_protocol = 6'
systemctl enable --now opendkim
systemctl enable --now postfix

# Install Node.js 22 LTS from the NodeSource APT repository.
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
chmod 0644 /etc/apt/keyrings/nodesource.gpg
printf '%s\n' 'deb [arch=amd64,arm64 signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main' \
  > /etc/apt/sources.list.d/nodesource.list
apt-get update
apt-get install -y nodejs
node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 20 )); then
  echo "Node.js 20 or newer is required; installed $(node --version)." >&2
  exit 1
fi

# Compile whisper.cpp for CPU. The GGML base.en model is downloaded once and stored outside the app.
if [[ ! -d "${WHISPER_DIR}/.git" ]]; then
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git "${WHISPER_DIR}"
fi
cmake -S "${WHISPER_DIR}" -B "${WHISPER_DIR}/build" \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_EXAMPLES=ON \
  -DWHISPER_BUILD_SERVER=OFF
cmake --build "${WHISPER_DIR}/build" --config Release --parallel "$(nproc)" --target whisper-cli
if [[ ! -s "${WHISPER_DIR}/models/ggml-${MODEL_NAME}.bin" ]]; then
  bash "${WHISPER_DIR}/models/download-ggml-model.sh" "${MODEL_NAME}"
fi

if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/nyc-alert-bot --create-home --shell /usr/sbin/nologin "${SERVICE_USER}"
fi
install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 0750 /var/lib/nyc-alert-bot

SOURCE_DIR="$(pwd -P)"
mkdir -p "${APP_DIR}"
if [[ "${SOURCE_DIR}" != "$(realpath -m "${APP_DIR}")" ]]; then
  rsync -a \
    --exclude='.git/' \
    --exclude='node_modules/' \
    --exclude='dist/' \
    --exclude='data/' \
    --exclude='.env' \
    --exclude='*.log' \
    "${SOURCE_DIR}/" "${APP_DIR}/"
fi

cd "${APP_DIR}"
npm ci
npm run build
chown -R root:root "${APP_DIR}"
chmod -R a+rX "${APP_DIR}"
install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 0750 "${APP_DIR}/dist"
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${APP_DIR}/dist"

if [[ ! -e "${ENV_FILE}" ]]; then
  install -m 0600 .env.example "${ENV_FILE}"
  chown root:root "${ENV_FILE}"
fi
if ! grep -q '^SMTP_HOST=.' "${ENV_FILE}"; then
  if grep -q '^SMTP_HOST=' "${ENV_FILE}"; then
    sed -i 's|^SMTP_HOST=.*|SMTP_HOST=127.0.0.1|' "${ENV_FILE}"
  else
    printf '\nSMTP_HOST=127.0.0.1\n' >> "${ENV_FILE}"
  fi
  if grep -q '^SMTP_PORT=' "${ENV_FILE}"; then
    sed -i 's|^SMTP_PORT=.*|SMTP_PORT=25|' "${ENV_FILE}"
  else
    printf 'SMTP_PORT=25\n' >> "${ENV_FILE}"
  fi
fi
if ! grep -q '^SMTP_FROM=.' "${ENV_FILE}" || grep -q '^SMTP_FROM=noreply@nycalert\.ai$' "${ENV_FILE}"; then
  if grep -q '^SMTP_FROM=' "${ENV_FILE}"; then
    sed -i 's|^SMTP_FROM=.*|SMTP_FROM="NYC Alert <noreply@nycalert.ai>"|' "${ENV_FILE}"
  else
    printf 'SMTP_FROM="NYC Alert <noreply@nycalert.ai>"\n' >> "${ENV_FILE}"
  fi
fi
# The systemd unit is write-restricted; keep subscriptions in its writable state directory.
if grep -q '^DATA_DIR=\./data$' "${ENV_FILE}" || ! grep -q '^DATA_DIR=' "${ENV_FILE}"; then
  if grep -q '^DATA_DIR=' "${ENV_FILE}"; then
    sed -i 's|^DATA_DIR=.*|DATA_DIR=/var/lib/nyc-alert-bot|' "${ENV_FILE}"
  else
    printf '\nDATA_DIR=/var/lib/nyc-alert-bot\n' >> "${ENV_FILE}"
  fi
fi
chown root:root "${ENV_FILE}"
chmod 0600 "${ENV_FILE}"

# Trust forwarded client metadata only when the installer-managed HTTPS proxy is present.
HTTPS_PROXY_DROPIN="/etc/systemd/system/nyc-alert-bot.service.d/zzzz-https-proxy.conf"
if [[ -f "${HTTPS_PROXY_DROPIN}" ]] && grep -q '^Environment=DASHBOARD_HOST=127\.0\.0\.1$' "${HTTPS_PROXY_DROPIN}"; then
  if grep -q '^TRUST_PROXY=' "${ENV_FILE}"; then
    sed -i 's|^TRUST_PROXY=.*|TRUST_PROXY=true|' "${ENV_FILE}"
  else
    printf '\nTRUST_PROXY=true\n' >> "${ENV_FILE}"
  fi
  chmod 0600 "${ENV_FILE}"
fi

NPM_PATH="$(command -v npm)"
cat > "${UNIT_FILE}" <<UNIT
[Unit]
Description=NYC Public Safety Alert Bot and Dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${ENV_FILE}
Environment=DATA_DIR=/var/lib/nyc-alert-bot
Environment=WHISPER_CPP_PATH=${WHISPER_DIR}/build/bin/whisper-cli
Environment=WHISPER_MODEL_PATH=${WHISPER_DIR}/models/ggml-${MODEL_NAME}.bin
ExecStart=${NPM_PATH} start
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/nyc-alert-bot ${APP_DIR}/dist

[Install]
WantedBy=multi-user.target
UNIT
chmod 0644 "${UNIT_FILE}"
systemctl daemon-reload

cat <<'DONE'

Install complete.

Next steps:
  1. Edit /etc/nyc-alert-bot.env using your hosting provider's secure file/secret manager.
    2. Set DISCORD_TOKEN, DISCORD_APPLICATION_ID, OPENAI_API_KEY (for AI summaries/triage),
      and approved Broadcastify JWT values: API Key ID, application ID as ISSUER, and API Key as SECRET.
      3. Configure ADMIN_EMAIL and ADMIN_PASSWORD, and publish the DKIM TXT record from:
           /etc/opendkim/keys/nycalert.ai/nyc-alert.txt
         Also publish SPF and DMARC for your sending host. Postfix accepts mail from the app only
         on loopback and attempts direct outbound delivery;
        your provider must allow outbound TCP 25. You may set SMTP_HOST/PORT/USERNAME/PASSWORD to
        use a managed SMTP relay instead. The From address defaults to noreply@nycalert.ai.
      4. Keep Broadcastify audio/feed processing disabled until its documented audio retrieval
     behavior is implemented and confirmed to permit transcription.
      5. Start at boot and launch the service with:
       sudo systemctl enable --now nyc-alert-bot
     Inspect service logs with:
       sudo journalctl -u nyc-alert-bot -f

Local whisper.cpp transcription runs on this server and does not incur a hosted Whisper
per-minute fee. CPU speed and model quality depend on the machine. OpenAI triage is still
an API call. The installer does not enable public MP3 redistribution.
DONE
