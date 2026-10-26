#!/bin/sh
# Nusxadan bazani tiklaydi.
#
#   restore.sh latest --yes                      # S3 (yoki lokal) dagi eng oxirgi nusxadan asosiy bazaga
#   restore.sh /backups/istam_20261023T0200.dump.enc --yes
#   restore.sh s3:daily/istam_20261023T0200.dump.enc --yes
#   restore.sh latest --target istam_check         # boshqa bazaga (asosiy bazaga tegmaydi)
#   restore.sh list                              # mavjud nusxalar ro'yxati
#
# Asosiy bazaga tiklashdan oldin API ni to'xtating:  docker compose stop api
# Tiklangandan keyin ishga tushiring:               docker compose start api   (huquqlar avtomatik tiklanadi)
set -u
. "$(dirname "$0")/lib.sh"

SRC="${1:-}"; shift 2>/dev/null || true
TARGET="$PGDATABASE"; YES=false
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    --yes) YES=true; shift ;;
    *) echo "Noma'lum parametr: $1"; exit 2 ;;
  esac
done
[ -n "$SRC" ] || { sed -n '2,12p' "$0"; exit 2; }

if [ "$SRC" = "list" ]; then
  echo "Lokal ($BACKUP_DIR):"; ls -1 "$BACKUP_DIR" 2>/dev/null | grep '^istam_' | sort
  if s3_enabled; then
    echo "S3 kunlik:"; aws_s3 ls "$(s3_url daily/)" | awk '{print "  s3:daily/" $4 "  (" $3 " bayt)"}'
    echo "S3 oylik:";  aws_s3 ls "$(s3_url monthly/)" | awk '{print "  s3:monthly/" $4 "  (" $3 " bayt)"}'
  fi
  exit 0
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# 1. Faylni topish
case "$SRC" in
  latest)
    if s3_enabled; then
      KEY=$(aws_s3 ls "$(s3_url daily/)" | awk '{print $4}' | grep '^istam_' | sort | tail -n 1)
      [ -n "$KEY" ] || { log "S3 da nusxa topilmadi"; exit 1; }
      SRC="s3:daily/$KEY"
    else
      SRC=$(ls -1 "$BACKUP_DIR"/istam_*.dump* 2>/dev/null | sort | tail -n 1)
      [ -n "$SRC" ] || { log "Lokal nusxa topilmadi"; exit 1; }
    fi ;;
esac
case "$SRC" in
  s3:*)
    NAME=$(basename "${SRC#s3:}")
    log "S3 dan yuklanmoqda: ${SRC#s3:}"
    aws_s3 cp --only-show-errors "$(s3_url "${SRC#s3:}")" "$WORK/$NAME" || { log "Yuklab bo'lmadi"; exit 1; }
    FILE="$WORK/$NAME" ;;
  *) FILE="$SRC"; [ -f "$FILE" ] || { log "Fayl yo'q: $FILE"; exit 1; } ;;
esac

# 2. Shifrni ochish va tekshirish
case "$FILE" in
  *.enc) decrypt "$FILE" "$WORK/db.dump" || { log "Shifrni ochib bo'lmadi (kalit noto'g'ri?)"; exit 1; }; DUMP="$WORK/db.dump" ;;
  *) DUMP="$FILE" ;;
esac
pg_restore --list "$DUMP" >/dev/null 2>&1 || { log "Nusxa fayli buzilgan"; exit 1; }
log "Nusxa: $(basename "$FILE") — to'g'ri"

# 3. Tasdiqlash
if [ "$TARGET" = "$PGDATABASE" ] && [ "$YES" != "true" ]; then
  echo "DIQQAT: \"$TARGET\" bazasidagi BARCHA joriy ma'lumot nusxa bilan almashtiriladi."
  echo "Davom etish uchun --yes qo'shing. API ni oldin to'xtating: docker compose stop api"
  exit 3
fi

# 4. Tiklash
if [ "$TARGET" = "$PGDATABASE" ]; then
  log "Asosiy baza tozalanmoqda: $TARGET"
  psql -v ON_ERROR_STOP=1 -q -d "$TARGET" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" || exit 1
else
  psql -v ON_ERROR_STOP=1 -q -d postgres -c "DROP DATABASE IF EXISTS \"$TARGET\"" -c "CREATE DATABASE \"$TARGET\"" || exit 1
fi
log "Tiklanmoqda: $TARGET"
pg_restore --no-owner --no-privileges --exit-on-error -d "$TARGET" "$DUMP" || { log "Tiklashda xato"; exit 1; }

# 5. Natija: asosiy jadvallar o'qilishini tekshiramiz (bo'lmasa tiklash muvaffaqiyatsiz hisoblanadi)
psql -v ON_ERROR_STOP=1 -q -d "$TARGET" -At -F ' | ' -c "
  SELECT 'Foydalanuvchilar', count(*)::text FROM users UNION ALL
  SELECT 'Audit yozuvlari', count(*)::text FROM audit_log UNION ALL
  SELECT 'Oxirgi migratsiya', max(name) FROM schema_migrations" || { log "Tiklangan bazani o'qib bo'lmadi"; exit 1; }
log "Tiklash tugadi: $TARGET"
[ "$TARGET" = "$PGDATABASE" ] && log "Endi API ni ishga tushiring: docker compose start api"
exit 0
