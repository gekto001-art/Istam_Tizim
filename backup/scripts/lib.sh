#!/bin/sh
# Zaxira skriptlari uchun umumiy sozlamalar va yordamchi funksiyalar.
# Sozlamalar muhit o'zgaruvchilaridan olinadi (docker-compose.yml / .env).

: "${PGDATABASE:=istam}"
: "${BACKUP_DIR:=/backups}"
: "${BACKUP_KEEP_LOCAL_DAYS:=7}"     # serverdagi nusxalar necha kun saqlanadi
: "${BACKUP_KEEP_DAILY_DAYS:=30}"    # S3 dagi kunlik nusxalar necha kun saqlanadi
: "${BACKUP_KEEP_MONTHLY:=12}"       # S3 dagi oylik nusxalar (har oy 1-sanasi) necha oy saqlanadi
: "${S3_PREFIX:=istam}"
: "${BACKUP_LABEL:=istam}"
: "${NOTIFY_SUCCESS:=false}"
export PGDATABASE
# NOTICE xabarlari loglarni to'ldirmasin
export PGOPTIONS="${PGOPTIONS:--c client_min_messages=warning}"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }

# Telegram xabar (sozlangan bo'lsa)
notify() {
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
    curl -fsS -m 20 -X POST "${TELEGRAM_API:-https://api.telegram.org}/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
      --data-urlencode "text=[$BACKUP_LABEL] $1" >/dev/null 2>&1 || log "Telegram xabar yuborilmadi"
  fi
}

# Tashqi kuzatuv xizmatiga "tirikman" signali (masalan, healthchecks.io). Signal kelmasa ular ogohlantiradi.
heartbeat() {
  if [ -n "${HEARTBEAT_URL:-}" ]; then
    curl -fsS -m 20 "${HEARTBEAT_URL}${1:-}" >/dev/null 2>&1 || log "Heartbeat yuborilmadi"
  fi
}

s3_enabled() { [ -n "${S3_BUCKET:-}" ]; }

aws_s3() {
  if [ -n "${S3_ENDPOINT:-}" ]; then aws --endpoint-url "$S3_ENDPOINT" s3 "$@"; else aws s3 "$@"; fi
}

s3_url() { echo "s3://${S3_BUCKET}/${S3_PREFIX}/$1"; }

# Fayl nomidan sanani oladi: istam_20261023T0200.dump(.enc) -> 20261023
file_date() { echo "$1" | sed -n 's/^istam_\([0-9]\{8\}\)T[0-9]\{4\}\.dump.*$/\1/p'; }

# N kun oldingi sana YYYYMMDD ko'rinishida (busybox va GNU date bilan ishlaydi)
days_ago() { date -d "@$(( $(date +%s) - $1 * 86400 ))" +%Y%m%d; }

# Shifrlangan bo'lsa ochadi: decrypt <kirish> <chiqish>
decrypt() {
  if [ -z "${BACKUP_ENCRYPTION_KEY:-}" ]; then
    log "XATO: fayl shifrlangan, BACKUP_ENCRYPTION_KEY berilmagan"; return 1
  fi
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_ENCRYPTION_KEY -in "$1" -out "$2"
}
