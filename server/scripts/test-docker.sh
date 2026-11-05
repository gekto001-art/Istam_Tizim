#!/bin/sh
# Server testlarini vaqtinchalik Docker konteynerlarida ishga tushirish — haqiqiy bazaga tegmaydi,
# tugagach konteyner va tarmoq o'chiriladi.  Repo ildizidan:  sh server/scripts/test-docker.sh [vitest argumentlari]
set -e
cd "$(dirname "$0")/../.."
NET="istam-test-$$"
PG="istam-test-pg-$$"
cleanup() {
  docker rm -f "$PG" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=istam_test postgres:16-alpine >/dev/null
# -h: boshlang'ich (init) server faqat soketda tinglaydi — TCP tayyor bo'lguncha kutamiz
until docker exec "$PG" pg_isready -h 127.0.0.1 -U postgres -d istam_test >/dev/null 2>&1; do sleep 1; done

docker run --rm --network "$NET" -v "$PWD":/app -w /app/server \
  -e TEST_DATABASE_URL="postgres://postgres@$PG:5432/istam_test" \
  -e TEST_APP_DATABASE_URL="postgres://istam_app:dev_app_pw_123@$PG:5432/istam_test" \
  node:22-alpine sh -c "npm ci --no-audit --no-fund --loglevel=error && npx vitest run $*"
