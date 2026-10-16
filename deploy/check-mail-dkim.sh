#!/usr/bin/env bash
# Read-only diagnostics for the mail stack installed by install-ubuntu.sh.
# Does not send email, change settings, restart services, or print private keys.
set -uo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo 'Run on the Ubuntu mail server: sudo bash deploy/check-mail-dkim.sh' >&2
  exit 1
fi

issues=0
warn() { printf 'WARN: %s\n' "$1"; issues=$((issues + 1)); }
ok() { printf 'OK: %s\n' "$1"; }

echo 'NYC Alert DKIM diagnostics (read-only; no test message is sent)'
echo
for tool in systemctl postconf opendkim opendkim-testkey ss timeout runuser; do
  if ! command -v "${tool}" >/dev/null 2>&1; then
    warn "Missing command: ${tool}. Check that Postfix and OpenDKIM are installed."
  fi
done

for service in opendkim postfix; do
  if systemctl is-active --quiet "${service}"; then ok "${service} service is active."
  else warn "${service} service is not active."; fi
done

config=/etc/opendkim.conf
key=/etc/opendkim/keys/nycalert.ai/nyc-alert.private
if [[ -r "${config}" ]]; then
  echo
  echo 'Selected OpenDKIM settings (no key contents):'
  awk '!/^[[:space:]]*#/ && $1 ~ /^(Mode|Domain|Selector|Socket|InternalHosts|ExternalIgnoreList|SigningTable|KeyTable)$/ { print }' "${config}"
  if opendkim -n -x "${config}" >/dev/null 2>&1; then ok 'OpenDKIM configuration parses.'
  else warn 'OpenDKIM configuration check failed. Inspect its service logs locally.'; fi
else
  warn 'The installer OpenDKIM configuration is missing or unreadable.'
fi

if [[ -s "${key}" ]]; then
  if runuser -u opendkim -- test -r "${key}"; then ok 'OpenDKIM user can read the existing private key.'
  else warn 'OpenDKIM user cannot read the existing private key.'; fi
else
  warn 'The installer private-key file is missing or empty. Do not regenerate it without checking the current signing configuration.'
fi

echo
echo 'Postfix signing settings:'
if command -v postconf >/dev/null 2>&1; then
  for setting in smtpd_milters non_smtpd_milters milter_default_action milter_protocol; do
    value="$(postconf -h "${setting}" 2>/dev/null)"
    printf '%s = %s\n' "${setting}" "${value:-<empty>}"
    if [[ "${setting}" == non_smtpd_milters && "${value}" != *inet:127.0.0.1:8891* ]]; then
      warn 'Local PHP/sendmail submissions are not using the installer OpenDKIM endpoint.'
    fi
    if [[ "${setting}" == milter_default_action && "${value}" == accept ]]; then
      echo 'NOTE: Postfix can deliver unsigned mail if the signing milter is unavailable.'
    fi
  done
  echo 'Service-specific milter overrides (if any):'
  postconf -P 2>/dev/null | grep -E '/(smtpd_milters|non_smtpd_milters|receive_override_options)[[:space:]]*=' || true
fi

if ss -H -ltn 'sport = :8891' 2>/dev/null | grep -q .; then
  ok 'A TCP listener exists on port 8891; compare its address with the configured milter endpoint.'
else
  warn 'No TCP listener detected on the installer signing port 8891.'
fi

echo
echo 'DNS/private-key match for nyc-alert._domainkey.nycalert.ai:'
if [[ -s "${key}" ]] && command -v opendkim-testkey >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1; then
  # Capture output rather than dumping diagnostics or key material into shared logs.
  if result="$(timeout 20s opendkim-testkey -x "${config}" -d nycalert.ai -s nyc-alert -k "${key}" -vvv 2>&1)"; then
    if [[ "${result}" == *'key OK'* ]]; then ok 'Published DNS key matches the existing private key.'
    else warn 'Key check returned without a confirmed key OK result.'; fi
  else
    warn 'DNS/private-key check failed or timed out. Check DNS propagation, selector, and key pairing locally.'
  fi
  if [[ "${result}" == *'key not secure'* ]]; then
    echo 'NOTE: key not secure refers to DNSSEC; it does not mean messages lack DKIM signatures.'
  fi
fi

echo
if (( issues > 0 )); then
  printf 'Found %s warning(s). Review these before changing settings or rotating any key.\n' "${issues}"
else
  echo 'Basic checks passed. This does not prove an outgoing message is signed.'
fi
echo 'Next: inspect a NEW received message for DKIM-Signature (d=nycalert.ai; s=nyc-alert) and Authentication-Results: dkim=pass.'
echo 'Do not share private keys, verification links, passwords, or unredacted mail logs.'
if (( issues > 0 )); then exit 1; fi