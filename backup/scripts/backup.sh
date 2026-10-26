#!/bin/sh
# Bazaning to'liq nusxasini oladi, tekshiradi, shifrlaydi, S3 ga yuboradi va eski nusxalarni o'chiradi.
# Ishga tushirish: /scripts/backup.sh
set -u
. "$(dirname "$0")/lib.sh"

STEP="boshlash"
fail() {
  log "XATO ($STEP): $1"
  notify "❌ Zaxira nusxa OLINMADI. Bosqich: $STEP. $1"
  heartbeat "/fail"
  printf '{"ok":false,"at":"%s","step":"%s"}\n' "$(date -Iseconds)" "$STEP" > "$BACKUP_DIR/last_status.json" 2>/dev/null
  rm -f "${TMP:-/nonexistent}"
  exit 1
}

mkdir -p "$BACKUP_DIR" || fail "papka yaratilmadi"
TS=$(date +%Y%m%dT%H%M)
NAME="istam_${TS}.dump"
TMP="$BACKUP_DIR/.${NAME}.part"
START=$(date +%s)

STEP="pg_dump"
log "Nusxa olinmoqda: $PGDATABASE -> $NAME"
pg_dump -Fc -Z 6 -f "$TMP" || fail "pg_dump xato qaytardi"

STEP="tekshirish"
# Fayl o'qilishini va jadvallar borligini tekshiramiz
pg_restore --list "$TMP" > "$TMP.list" 2>/dev/null || fail "nusxa fayli buzilgan"
TABLES=$(grep -c " TABLE DATA " "$TMP.list" || true)
rm -f "$TMP.list"
[ "$TABLES" -gt 0 ] || fail "nusxada jadval ma'lumoti yo'q"

FINAL="$BACKUP_DIR/$NAME"
if [ -n "${BACKUP_ENCRYPTION_KEY:-}" ]; then
  STEP="shifrlash"
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_ENCRYPTION_KEY -in "$TMP" -out "$TMP.enc" \
    || fail "shifrlab bo'lmadi"
  rm -f "$TMP"; TMP="$TMP.enc"; FINAL="$FINAL.enc"
else
  log "OGOHLANTIRISH: BACKUP_ENCRYPTION_KEY berilmagan — nusxa shifrlanmaydi"
fi
mv "$TMP" "$FINAL" || fail "faylni saqlab bo'lmadi"
SIZE=$(du -h "$FINAL" | cut -f1)
log "Saqlandi: $FINAL ($SIZE, $TABLES ta jadval)"

if s3_enabled; then
  STEP="S3 ga yuklash"
  BASE=$(basename "$FINAL")
  aws_s3 cp --only-show-errors "$FINAL" "$(s3_url "daily/$BASE")" || fail "S3 ga yuklanmadi"
  if [ "$(date +%d)" = "01" ]; then
    aws_s3 cp --only-show-errors "$FINAL" "$(s3_url "monthly/$BASE")" || fail "oylik nusxa S3 ga yuklanmadi"
  fi
  log "S3 ga yuklandi: $(s3_url "daily/$BASE")"
else
  log "OGOHLANTIRISH: S3_BUCKET berilmagan — nusxa faqat shu serverda. Server ishdan chiqsa nusxa ham yo'qoladi!"
fi

STEP="eskilarini o'chirish"
CUT=$(days_ago "$BACKUP_KEEP_LOCAL_DAYS")
for f in "$BACKUP_DIR"/istam_*.dump*; do
  [ -e "$f" ] || continue
  d=$(file_date "$(basename "$f")"); [ -n "$d" ] || continue
  if [ "$d" -lt "$CUT" ]; then rm -f "$f" && log "O'chirildi (lokal): $(basename "$f")"; fi
done
if s3_enabled; then
  prune_s3() { # prune_s3 <papka> <chegara YYYYMMDD>
    aws_s3 ls "$(s3_url "$1/")" 2>/dev/null | awk '{print $4}' | while read -r name; do
      d=$(file_date "$name"); [ -n "$d" ] || continue
      if [ "$d" -lt "$2" ]; then aws_s3 rm --only-show-errors "$(s3_url "$1/$name")" && log "O'chirildi (S3 $1): $name"; fi
    done
  }
  prune_s3 daily "$(days_ago "$BACKUP_KEEP_DAILY_DAYS")"
  prune_s3 monthly "$(days_ago $((BACKUP_KEEP_MONTHLY * 31)))"
fi

DUR=$(( $(date +%s) - START ))
printf '{"ok":true,"at":"%s","file":"%s","size":"%s","tables":%s,"seconds":%s}\n' \
  "$(date -Iseconds)" "$(basename "$FINAL")" "$SIZE" "$TABLES" "$DUR" > "$BACKUP_DIR/last_status.json"
heartbeat ""
[ "$NOTIFY_SUCCESS" = "true" ] && notify "✅ Zaxira nusxa olindi: $(basename "$FINAL"), $SIZE, ${DUR}s"
log "Tayyor (${DUR}s)"
