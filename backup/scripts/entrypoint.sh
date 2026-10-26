#!/bin/sh
# Cron konteyneri: jadval bo'yicha nusxa olish va oylik tiklash sinovi.
set -eu
: "${BACKUP_CRON:=0 3 * * *}"          # har kuni 03:00
: "${RESTORE_TEST_CRON:=0 5 1 * *}"    # har oyning 1-sanasi 05:00

# busybox crond vazifalarga muhit o'zgaruvchilarini bermaydi — faylga yozib qo'yamiz
ENV_FILE=/etc/backup.env
umask 077
: > "$ENV_FILE"
env | while IFS='=' read -r k v; do
  case "$k" in
    PG*|BACKUP_*|S3_*|AWS_*|TELEGRAM_*|HEARTBEAT_URL|NOTIFY_*|TZ)
      printf "export %s='%s'\n" "$k" "$(printf '%s' "$v" | sed "s/'/'\\\\''/g")" >> "$ENV_FILE" ;;
  esac
done

cat > /etc/crontabs/root <<CRON
$BACKUP_CRON . $ENV_FILE && /scripts/backup.sh >> /proc/1/fd/1 2>&1
$RESTORE_TEST_CRON . $ENV_FILE && /scripts/test-restore.sh >> /proc/1/fd/1 2>&1
CRON

echo "Zaxira jadvali: nusxa '$BACKUP_CRON', tiklash sinovi '$RESTORE_TEST_CRON' ($(date +%Z))"
[ -n "${S3_BUCKET:-}" ] || echo "OGOHLANTIRISH: S3_BUCKET berilmagan — nusxalar faqat shu serverda saqlanadi"
[ -n "${BACKUP_ENCRYPTION_KEY:-}" ] || echo "OGOHLANTIRISH: BACKUP_ENCRYPTION_KEY berilmagan — nusxalar shifrlanmaydi"
exec crond -f -l 8
