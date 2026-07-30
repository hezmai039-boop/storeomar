#!/usr/bin/env bash
#
# نسخة احتياطية من قاعدة بيانات ميسور.
#
# الاستخدام:
#   ./scripts/backup.sh                          # يستخدم $DATABASE_URL
#   ./scripts/backup.sh "postgresql://..."       # أو عنوانًا صريحًا
#
# يُخرج ملفًا بصيغة custom (‎-Fc‎) لا SQL نصيًا: الصيغة المخصصة مضغوطة،
# وتسمح بالاستعادة الانتقائية لجداول بعينها، وتستعيد بالتوازي (‎-j‎).
#
# ⚠️ الملف الناتج يحتوي على كل بيانات عملائك — بما فيها بيانات اعتماد
# القنوات والتكاملات المشفّرة. عامله معاملة السر: لا ترفعه إلى Git ولا
# إلى تخزين عام.

set -euo pipefail

DB_URL="${1:-${DATABASE_URL:-}}"

if [[ -z "$DB_URL" ]]; then
  echo "خطأ: لم يُحدَّد عنوان قاعدة البيانات." >&2
  echo "استخدم:  ./scripts/backup.sh \"postgresql://user:pass@host:5432/db\"" >&2
  echo "أو صدّر:  export DATABASE_URL=\"postgresql://...\"" >&2
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-./backups}"
mkdir -p "$BACKUP_DIR"

STAMP="$(date +%Y-%m-%d_%H%M%S)"
# بادئة الاسم أصبحت maysoor- بعد إعادة التسمية. هذا يخصّ النسخ الجديدة فقط؛
# الملفات القديمة باسم atlas-*.dump تبقى صالحة تمامًا، و restore-to-staging.sh
# يقبلها كما هي — لا شيء في السكربتين يفحص بادئة اسم الملف.
OUT="$BACKUP_DIR/maysoor-$STAMP.dump"

echo "جارٍ أخذ النسخة الاحتياطية…"
pg_dump "$DB_URL" --format=custom --no-owner --no-privileges --file="$OUT"

SIZE="$(du -h "$OUT" | cut -f1)"
echo
echo "✅ تمت: $OUT  ($SIZE)"
echo
echo "⚠️  نسخة لم تُختبر استعادتها ليست نسخة احتياطية."
echo "    اختبرها الآن:  ./scripts/restore-to-staging.sh \"$OUT\""
