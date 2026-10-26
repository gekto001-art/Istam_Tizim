#!/bin/sh
# Oxirgi nusxani vaqtinchalik bazaga tiklab ko'radi (asosiy bazaga tegmaydi) va natijani xabar qiladi.
# Har oy avtomatik ishlaydi: tekshirilmagan nusxa — ishonchsiz nusxa.
set -u
. "$(dirname "$0")/lib.sh"
CHECK_DB="istam_restore_check"
OUT=$("$(dirname "$0")/restore.sh" latest --target "$CHECK_DB" 2>&1)
CODE=$?
echo "$OUT"
if [ $CODE -eq 0 ]; then
  SUMMARY=$(echo "$OUT" | grep ' | ' | tr '\n' ';')
  notify "✅ Oylik tiklash sinovi muvaffaqiyatli. $SUMMARY"
else
  notify "❌ Oylik tiklash sinovi MUVAFFAQIYATSIZ. Nusxadan tiklab bo'lmadi — darhol tekshiring. $(echo "$OUT" | tail -n 2 | tr '\n' ' ')"
fi
psql -q -d postgres -c "DROP DATABASE IF EXISTS \"$CHECK_DB\"" >/dev/null 2>&1
exit $CODE
