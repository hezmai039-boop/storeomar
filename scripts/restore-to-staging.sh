#!/usr/bin/env bash
#
# يستعيد نسخة احتياطية إلى قاعدة بيانات منفصلة للتجارب.
#
# هذا هو السكربت الذي يحوّل ملف النسخة إلى **نسخة احتياطية حقيقية**: ملف
# لم تُختبر استعادته مجرد ملف. وهو أيضًا ما يعطيك بيئة تجارب على بيانات
# واقعية بلا لمس الإنتاج — جرّب هجرة، أو ميزة، أو استعلامًا ثقيلًا، وإن
# انهار كل شيء فلا أحد يتأثر.
#
# الاستخدام:
#   ./scripts/restore-to-staging.sh ./backups/maysoor-2026-07-29.dump
#   ./scripts/restore-to-staging.sh ./backups/atlas-2026-07-12.dump   # نسخة قديمة
#   ./scripts/restore-to-staging.sh <ملف> <اسم_قاعدة> <عنوان_الخادم>
#
# ملاحظة عن الأسماء القديمة: كانت النسخ تُسمّى atlas-*.dump قبل إعادة التسمية
# إلى ميسور. السكربت **لا يفحص بادئة اسم الملف إطلاقًا** — يكفي أن يكون
# الملف موجودًا وبصيغة pg_dump المخصصة. أي نسخة قديمة تحتفظ بها تُستعاد
# بلا إعادة تسمية ولا أي خطوة إضافية، وهذا مقصود: النسخة الاحتياطية التي
# تحتاج طقسًا قبل استعادتها هي نسخة لن تُستعاد وقت الحاجة.
#
# ⚠️ يحذف قاعدة الهدف إن كانت موجودة. اسمها الافتراضي maysoor_staging —
# لن يقبل السكربت اسمًا لا يحتوي "staging" أو "test" حمايةً من تمرير
# قاعدة الإنتاج بالخطأ.
#
# إعادة تسمية قاعدة التجارب آمنة (بخلاف أدوار قاعدة البيانات atlas_app /
# atlas_resolver التي تبقى بأسمائها) لأن هذه القاعدة تُحذف وتُنشأ من الصفر
# في كل تشغيلة — لا شيء يعيش فيها بين مرة وأخرى.

set -euo pipefail

DUMP="${1:-}"
TARGET_DB="${2:-maysoor_staging}"
PG_HOST_URL="${3:-${PGSTAGING_URL:-postgresql://postgres@localhost:5432}}"

if [[ -z "$DUMP" ]]; then
  echo "خطأ: حدّد ملف النسخة الاحتياطية." >&2
  echo "استخدم:  ./scripts/restore-to-staging.sh ./backups/maysoor-....dump" >&2
  echo "(النسخ القديمة باسم atlas-*.dump مقبولة كما هي.)" >&2
  exit 1
fi

if [[ ! -f "$DUMP" ]]; then
  echo "خطأ: الملف غير موجود: $DUMP" >&2
  exit 1
fi

# حاجز الأمان: الاستعادة عملية حاذفة، وخطأ مطبعي في اسم القاعدة هنا يعني
# مسح الإنتاج. نشترط أن يحمل الاسم علامة صريحة على أنه ليس إنتاجًا.
if [[ "$TARGET_DB" != *staging* && "$TARGET_DB" != *test* ]]; then
  echo "خطأ: اسم القاعدة \"$TARGET_DB\" لا يحتوي staging أو test." >&2
  echo "هذا السكربت يحذف قاعدة الهدف — ولن يعمل على اسم قد يكون إنتاجًا." >&2
  exit 1
fi

# اسم القاعدة يُدرج قبل سلسلة الاستعلام لا بعدها. الإلحاق المباشر
# ("$BASE/$DB") ينتج عنوانًا فاسدًا متى احتوى الأساس على "?" — مثل
# "...:5432?host=/tmp" الذي يصبح "...?host=/tmp/postgres"، فيبحث psql
# عن مقبس في مسار غير موجود ويفشل برسالة مضلّلة عن خادم متوقف.
build_url() {
  local base="$1" db="$2" query=""
  if [[ "$base" == *\?* ]]; then
    query="?${base#*\?}"
    base="${base%%\?*}"
  fi
  echo "${base%/}/$db$query"
}

ADMIN_URL="$(build_url "$PG_HOST_URL" postgres)"
TARGET_URL="$(build_url "$PG_HOST_URL" "$TARGET_DB")"

echo "الهدف: $TARGET_DB"
echo "جارٍ حذف القاعدة القديمة إن وُجدت…"
psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS \"$TARGET_DB\";"
psql "$ADMIN_URL" -q -c "CREATE DATABASE \"$TARGET_DB\";"

# pgvector مطلوب قبل الاستعادة: المخطط يحتوي أعمدة من نوع vector،
# واستعادتها في قاعدة بلا الامتداد تفشل بـ "type vector does not exist".
psql "$TARGET_URL" -q -c "CREATE EXTENSION IF NOT EXISTS vector;"

echo "جارٍ الاستعادة…"
pg_restore --dbname="$TARGET_URL" --no-owner --no-privileges --jobs=4 "$DUMP" 2>&1 | grep -v "^pg_restore: warning" || true

echo
echo "=== التحقق: أعداد الصفوف ==="
psql "$TARGET_URL" -c "
SELECT 'organizations' AS جدول, count(*) FROM organizations
UNION ALL SELECT 'stores',          count(*) FROM stores
UNION ALL SELECT 'users',           count(*) FROM users
UNION ALL SELECT 'conversations',   count(*) FROM conversations
UNION ALL SELECT 'messages',        count(*) FROM messages
UNION ALL SELECT 'knowledge_chunks',count(*) FROM knowledge_chunks
UNION ALL SELECT 'invoices',        count(*) FROM invoices
UNION ALL SELECT 'subscriptions',   count(*) FROM subscriptions;"

echo
echo "✅ استُعيدت في: $TARGET_DB"
echo
echo "قارن الأعداد أعلاه بالإنتاج. تطابقها هو ما يثبت أن النسخة سليمة."
echo
echo "للتجارب على هذه النسخة:"
echo "  export DATABASE_URL=\"$TARGET_URL\""
echo "  cd backend && npm run dev"
