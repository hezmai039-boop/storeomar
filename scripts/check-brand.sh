#!/usr/bin/env bash
# فحص اتساق الهوية — يمنع عودة الاسم القديم إلى واجهة يراها عميل.
#
# A rebrand is not done when the obvious files change; it is done when the
# next person cannot silently undo it. This runs over the whole repo and
# fails if the retired name reaches a customer-visible surface.
#
# It deliberately does NOT flag the technical identifiers that keep the old
# name on purpose (Redis channels, database roles, the storage directory,
# the seed slug). Those are live in production and renaming them breaks
# running systems — docs/32-brand.md §"ما بقي باسم أطلس" explains each one.
# They are listed as exceptions here so this script stays a real signal
# rather than something people learn to ignore.
#
#   ./scripts/check-brand.sh
#
# Exit 0 = clean. Exit 1 = a leak, printed with file:line.

set -uo pipefail
cd "$(dirname "$0")/.."

# Identifiers that are ALLOWED to still say atlas. Anchored to the exact
# token so that, say, "atlas-storage" passing does not also let "Atlas" pass
# on the same line.
ALLOW='atlas:realtime|atlas:cache:invalidate|atlas_app|atlas_resolver|atlas-storage|atlas-owner|LEGACY_INVOICE_PREFIXES|ATL-|atlas_token|check-brand'

# Where a customer or a search engine can actually see text.
SEARCH_PATHS=(frontend/src frontend/public frontend/index.html backend/src backend/prisma docs scripts promo README.md)

fail=0

echo "── الاسم القديم في أسطح مرئية ─────────────────────────────"
hits=$(grep -rniE 'atlas|أطلس' "${SEARCH_PATHS[@]}" 2>/dev/null \
  | grep -vE "$ALLOW" \
  | grep -v 'node_modules' || true)
if [ -n "$hits" ]; then
  echo "$hits"
  fail=1
else
  echo "✓ لا شيء"
fi

echo
echo "── ألوان الهوية القديمة ───────────────────────────────────"
# The violet system. Hex only — the words "violet"/"purple" appear in
# legitimate prose about the old brand inside docs/32-brand.md itself.
old=$(grep -rniE '#7c3aed|#a463f7|#5b21b6|#5622c9|#9d5cf5|#c3a0fb|#b884fa|#0f766e|#e7c874|#8b5cf6|#6d28d9' \
  frontend/src frontend/public frontend/index.html backend/src 2>/dev/null | grep -v node_modules || true)
if [ -n "$old" ]; then
  echo "$old"
  fail=1
else
  echo "✓ لا شيء"
fi

echo
echo "── قاعدة التباين: نص أبيض على برتقالي ──────────────────────"
# #FF6A00 with white text is 2.87:1 and fails WCAG AA. The rule is that an
# orange fill always carries NAVY text. This catches the most likely way
# someone breaks it: putting #fff next to the brand orange on one line.
bad=$(grep -rniE '(ff6a00|var\(--accent\)|var\(--brand-orange\)).*(#fff|#ffffff|white)|(#fff|#ffffff|color: *white).*(ff6a00|var\(--accent\)|var\(--brand-orange\))' \
  frontend/src 2>/dev/null | grep -viE 'accent-ink|NEVER|never|قاعدة|2\.87' || true)
if [ -n "$bad" ]; then
  echo "⚠ راجع هذه — النص الأبيض على البرتقالي يسقط في اختبار التباين:"
  echo "$bad"
  fail=1
else
  echo "✓ لا شيء"
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "✅ الهوية متسقة."
else
  echo "❌ رواسب من الهوية القديمة — راجع ما فوق."
fi
exit "$fail"
