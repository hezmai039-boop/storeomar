# ربط واتساب التلقائي — Meta Embedded Signup

هذه الوثيقة تشرح تدفق «ربط واتساب» بضغطة واحدة (نفس تجربة Respond.io/WATI):
المستخدم يضغط زرًا واحدًا، يكمل معالج ميتا الرسمي، ويعود والقناة محفوظة
والويبهوك مفعّل — **بلا أي Access Token أو Phone Number ID يُدخل يدويًا**.

الطريقة اليدوية القديمة (لصق التوكن) لم تُحذف: تبقى متاحة للقنوات الأخرى،
وتبقى واتساب اليدوية ممكنة عبر «تحديث بيانات الاعتماد» للقنوات المربوطة سابقًا.

## التدفق

```
SPA                    Backend                        Meta
 │ زر «ربط واتساب»       │                              │
 │ GET /channels/whatsapp/connect (Bearer)              │
 │←─ { url }             │ state + PKCE → oauth_states  │
 │ window.location = url ────────────────────────────→ │ معالج Embedded Signup
 │                        │←─ GET /v1/channels/whatsapp/oauth/callback?code&state
 │                        │ 1. claim state (ذري، مرة واحدة)
 │                        │ 2. exchange code (+ PKCE verifier)
 │                        │ 3. debug_token → scopes/WABA/user id/expiry
 │                        │ 4. token قصير؟ → استبدال بطويل الأمد
 │                        │ 5. لكل WABA: phone_numbers + owner_business_info
 │                        │ 6. POST /{WABA}/subscribed_apps (webhook تلقائي)
 │                        │ 7. upsert channel_accounts + audit
 │←─ redirect /settings?connected=whatsapp ─────────────│
```

## الإعداد (مرة واحدة لكل تثبيت)

1. في لوحة Meta for Developers أنشئ/افتح تطبيق Business وأضف منتج WhatsApp.
2. فعّل **Facebook Login for Business** وأنشئ Configuration من نوع
   WhatsApp Embedded Signup — خذ منه `WHATSAPP_ES_CONFIG_ID`.
3. سجّل رابط العودة في Valid OAuth Redirect URIs:
   `{OAUTH_REDIRECT_BASE}/v1/channels/whatsapp/oauth/callback`
4. اضبط في `.env`:
   `META_APP_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_ES_CONFIG_ID`.
5. رابط الويبهوك على مستوى التطبيق يبقى كما في docs/22:
   `POST {BASE_URL}/v1/webhooks/whatsapp` + `WHATSAPP_WEBHOOK_VERIFY_TOKEN`.
   الاشتراك لكل WABA (`subscribed_apps`) يتم الآن تلقائيًا في الخطوة 6.

## الأمان

- **State أحادي الاستخدام** في جدول `oauth_states` — يُدّعى بعبارة واحدة
  (`updateMany` بشرط `usedAt: null`) فلا يمكن تكراره (CSRF/replay).
- **PKCE (S256)** — الـ verifier يُخزَّن في صف الـ state على الخادم فقط.
- **التوكن مشفَّر** في `channel_accounts.credentials_encrypted` بنفس
  `ENCRYPTION_KEY` المستخدم لكل بيانات الاعتماد.
- **تجديد تلقائي** — حلقة كل ١٢ ساعة تستبدل التوكنات المنتهية قريبًا
  (`token_type = 'expiring'`) بتوكن طويل الأمد جديد. التوكن الدائم
  (`expires_at = 0`) لا يحتاج شيئًا.

## Multi-Tenant

كل متجر يشارك WABA ورقمه الخاصين عبر المعالج؛ التوجيه الوارد يبقى كما هو:
`phone_number_id` داخل حمولة الويبهوك → صف `channel_accounts` المطابق
(`external_account_id`) → متجر واحد فقط. لا تداخل بين المتاجر.

## الأعمدة الجديدة في channel_accounts

| العمود | المعنى |
|---|---|
| `waba_id` | حساب واتساب للأعمال المُشارك |
| `business_id` | Business Manager المالك |
| `phone_number_id` | مرآة صريحة لـ external_account_id |
| `app_scoped_user_id` | مستخدم ميتا الذي أجرى الربط |
| `token_type` | `permanent` أو `expiring` |
| `token_scopes` | الصلاحيات الممنوحة (JSON) |

## أكواد أخطاء العودة (?error=)

`access_denied`, `missing_code`, `invalid_state`, `exchange_failed`,
`no_waba_shared`, `no_phone_number`, `discovery_failed`, `persist_failed`,
`whatsapp_not_configured` — وكلها تُعرض بالعربية في صفحة الإعدادات.
