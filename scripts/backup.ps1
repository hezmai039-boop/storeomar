# نسخة احتياطية من قاعدة بيانات ميسور — إصدار PowerShell (ويندوز).
#
# مكافئ scripts/backup.sh. موجود لأن سكربتات .sh لا تعمل في PowerShell
# أصلًا، ومطالبة مستخدم ويندوز بتثبيت Git Bash لأخذ نسخة احتياطية عائق
# في أسوأ لحظة ممكنة — لحظة ما قبل تعديل قاعدة الإنتاج.
#
# الاستخدام:
#   .\scripts\backup.ps1
#   .\scripts\backup.ps1 -DatabaseUrl "postgresql://..."
#
# ⚠️ الملف الناتج يحتوي كل بيانات عملائك، بما فيها بيانات اعتماد القنوات
# والتكاملات المشفّرة. عامله معاملة السر: لا ترفعه إلى Git ولا إلى تخزين عام.

[CmdletBinding()]
param(
  [string]$DatabaseUrl = $env:DATABASE_URL,
  [string]$BackupDir = "./backups"
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($DatabaseUrl)) {
  Write-Error @"
لم يُحدَّد عنوان قاعدة البيانات.
استخدم:  .\scripts\backup.ps1 -DatabaseUrl "postgresql://user:pass@host:5432/db"
أو عيّن:  `$env:DATABASE_URL = "postgresql://..."
"@
  exit 1
}

# pg_dump ليس مثبّتًا افتراضيًا على ويندوز. نتحقق مبكرًا برسالة تقول ماذا
# يُفعل، بدل ترك PowerShell يرمي "command not found" الغامض.
if (-not (Get-Command pg_dump -ErrorAction SilentlyContinue)) {
  Write-Error @"
الأمر pg_dump غير موجود في PATH.

أمامك ثلاثة حلول:
  1) ثبّت PostgreSQL على ويندوز (يتضمّن pg_dump)، أو أضف مجلده إلى PATH:
     مثال:  `$env:PATH += ";C:\Program Files\PostgreSQL\16\bin"
  2) استخدم Docker إن كان مثبّتًا:
     docker run --rm pgvector/pgvector:pg16 pg_dump "<DATABASE_URL>" -Fc > backup.dump
  3) خُذ النسخة من Shell في لوحة Render — pg_dump موجود هناك أصلًا.
"@
  exit 1
}

if (-not (Test-Path $BackupDir)) {
  New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
}

$stamp = Get-Date -Format "yyyy-MM-dd_HHmmss"
# نفس بادئة backup.sh — النسخ الجديدة باسم maysoor-*.dump. الملفات القديمة
# باسم atlas-*.dump تبقى صالحة، و restore-to-staging.sh يقبلها بلا تعديل.
$out = Join-Path $BackupDir "maysoor-$stamp.dump"

Write-Host "جارٍ أخذ النسخة الاحتياطية…"

# صيغة custom (-Fc) لا SQL نصيًا: مضغوطة، وتسمح باستعادة انتقائية
# لجداول بعينها، وتُستعاد بالتوازي.
& pg_dump $DatabaseUrl --format=custom --no-owner --no-privileges --file=$out

# pg_dump يُرجع رمز خروج غير صفري عند الفشل. ErrorActionPreference لا يمسك
# ذلك لأنه برنامج خارجي لا cmdlet — لذا نفحص $LASTEXITCODE يدويًا، وإلا
# انتهى السكربت برسالة نجاح على ملف فارغ أو ناقص.
if ($LASTEXITCODE -ne 0) {
  Write-Error "فشل pg_dump برمز الخروج $LASTEXITCODE — النسخة غير مكتملة."
  exit $LASTEXITCODE
}

$sizeMb = [math]::Round((Get-Item $out).Length / 1MB, 2)

Write-Host ""
Write-Host "✅ تمت: $out  ($sizeMb MB)" -ForegroundColor Green
Write-Host ""
Write-Host "⚠️  نسخة لم تُختبر استعادتها ليست نسخة احتياطية." -ForegroundColor Yellow
Write-Host "    اختبرها باستعادتها إلى قاعدة منفصلة قبل الاعتماد عليها."
