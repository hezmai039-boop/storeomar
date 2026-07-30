import { Link, useLocation } from "react-router-dom";
import { LogoLockup } from "../components/Logo";
import "./LandingPage.css";

// Public privacy policy + terms of service, rendered from one component.
//
// These pages are not decoration and not "nice to have before launch": Meta's
// Tech Provider / App Review submission is rejected without a *publicly
// reachable* privacy URL, and every Saudi payment gateway (Moyasar, Tap) asks
// for both URLs during merchant onboarding. "Publicly reachable" is the whole
// requirement — a reviewer's crawler has no account, so these routes are
// mounted outside RequireAuth in App.tsx and this component touches neither
// AuthContext nor the API.
//
// Styling reuses LandingPage.css rather than introducing a second visual
// language: everything is scoped under `.lp`, which already carries the RTL
// direction, the Arabic font stack and the dark palette, and shares nothing
// with the dashboard's tokens.css. Source of truth for the text is
// docs/20-privacy-policy-terms.md — edit both together.

// ⚠️ Fill these in before launch (see docs/28-launch-readiness.md). The
// company name and address are legally required in the policy; the support
// email is the channel a data-deletion request must arrive on. Left empty on
// purpose rather than filled with a plausible-looking placeholder — a wrong
// contact address in a published privacy policy is worse than a missing one,
// because a customer's deletion request would silently go nowhere.
const LEGAL_ENTITY = "";
const LEGAL_ADDRESS = "";
const SUPPORT_EMAIL = "";
// Same business line the landing page's CTA opens, so there is always at
// least one working contact channel on the page even before the rest is set.
const CONTACT_WHATSAPP = "966538165467";

const LAST_UPDATED = "٢٩ يوليو ٢٠٢٦";

type Block =
  | { kind: "p"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "table"; head: string[]; rows: string[][] };

interface Section {
  title: string;
  blocks: Block[];
}

interface LegalDoc {
  slug: string;
  title: string;
  intro: string;
  sections: Section[];
}

const PRIVACY: LegalDoc = {
  slug: "privacy",
  title: "سياسة الخصوصية",
  intro:
    "تحترم منصة ميسور («المنصة»، «نحن») خصوصية المتاجر التجارية («العميل» أو «المتجر») وعملائها النهائيين («المستخدم النهائي»). توضح هذه السياسة كيف نجمع بيانات المحادثات ونستخدمها ونحميها عند ربط قنوات تواصل مثل واتساب (WhatsApp Business Platform) بمنصتنا.",
  sections: [
    {
      title: "١. من نحن وماذا تفعل المنصة",
      blocks: [
        {
          kind: "p",
          text: "ميسور منصة SaaS متعددة المتاجر (Multi-Tenant) تتيح للمتاجر التجارية توحيد قنوات التواصل مع عملائهم (واتساب، إنستغرام، ماسنجر) في صندوق وارد واحد، مدعومة بوكيل ذكاء اصطناعي يجيب على استفسارات العملاء بالاعتماد على قاعدة معرفة خاصة بكل متجر.",
        },
      ],
    },
    {
      title: "٢. البيانات التي نجمعها",
      blocks: [
        {
          kind: "table",
          head: ["نوع البيانات", "المصدر", "الغرض"],
          rows: [
            ["رقم هاتف المستخدم النهائي (واتساب)", "Meta WhatsApp Business API", "توجيه الرسائل وربطها بمحادثة العميل"],
            [
              "نص الرسائل المتبادلة بين العميل والمستخدم النهائي",
              "القناة (واتساب/إنستغرام/ماسنجر)",
              "عرضها في صندوق الوارد، توليد ردود الذكاء الاصطناعي، الأرشفة",
            ],
            ["بيانات حساب المتجر (الاسم، البريد، الأدوار)", "تسجيل المتجر في المنصة", "إدارة الحسابات والصلاحيات"],
            ["رموز الوصول (Access Tokens) الخاصة بقنوات المتجر", "ربط المتجر لقناته الخاصة", "إرسال/استقبال الرسائل نيابة عن المتجر فقط"],
            ["ملفات قاعدة المعرفة التي يرفعها المتجر (PDF/Word/Excel)", "رفع مباشر من لوحة تحكم المتجر", "استخراج النص لتغذية وكيل الذكاء الاصطناعي، والاحتفاظ بالملف الأصلي للمتجر"],
            ["بيانات الاستخدام التقنية (سجلات الأخطاء، الطوابع الزمنية)", "تشغيل المنصة", "الصيانة، الأمان، تحسين الأداء"],
          ],
        },
        {
          kind: "p",
          text: "لا نجمع بيانات دفع أو بيانات مصرفية مباشرة على خوادمنا؛ أي مدفوعات تمر عبر مزودي دفع خارجيين معتمدين.",
        },
      ],
    },
    {
      title: "٣. كيف نستخدم البيانات",
      blocks: [
        {
          kind: "ul",
          items: [
            "توجيه رسائل واتساب والقنوات الأخرى بين المستخدم النهائي والمتجر المعني فقط.",
            "تشغيل وكيل الذكاء الاصطناعي للرد التلقائي بالاعتماد حصريًا على قاعدة معرفة المتجر نفسه.",
            "عزل بيانات كل متجر بالكامل عن باقي المتاجر (Row-Level Security) — لا يمكن لمتجر الوصول إلى بيانات متجر آخر تحت أي ظرف.",
            "إعداد تقارير أداء وتذاكر دعم للمتجر صاحب المحادثة.",
          ],
        },
      ],
    },
    {
      title: "٤. مشاركة البيانات مع أطراف ثالثة",
      blocks: [
        {
          kind: "ul",
          items: [
            "Meta (واتساب/إنستغرام/ماسنجر): إرسال واستقبال الرسائل حصرًا عبر الواجهات البرمجية الرسمية (WhatsApp Business Platform API).",
            "مزود نموذج الذكاء الاصطناعي (Anthropic — Claude API): يُرسَل نص سؤال العميل فقط لتوليد رد مبني على قاعدة معرفة المتجر؛ ولا تُستخدم هذه البيانات لتدريب النماذج ولا يُحتفظ بها بعد إتمام الطلب، وفق سياسة Anthropic للـ API.",
            "مزود تخزين ملفات متوافق مع S3: تُحفظ فيه ملفات قاعدة المعرفة التي يرفعها المتجر، مشفَّرة أثناء النقل والتخزين، ولا يُتاح الوصول إليها إلا عبر طلب موثَّق من المتجر صاحب الملف.",
            "لا نبيع ولا نؤجر بيانات المستخدمين النهائيين لأي طرف ثالث لأي غرض تسويقي.",
          ],
        },
      ],
    },
    {
      title: "٥. الاحتفاظ بالبيانات والحذف",
      blocks: [
        {
          kind: "ul",
          items: [
            "تُحفظ سجلات المحادثات طالما بقي حساب المتجر نشطًا على المنصة.",
            "يحق لأي متجر طلب تصدير أو حذف بيانات محادثاته عبر قنوات التواصل الموضّحة أدناه.",
            "عند إلغاء اشتراك المتجر، تُحذف بيانات اعتماد القنوات (Access Tokens) فورًا، وتُحذف بيانات المحادثات والملفات المرفوعة خلال ٣٠ يومًا ما لم يطلب المتجر خلاف ذلك.",
          ],
        },
      ],
    },
    {
      title: "٦. أمان البيانات",
      blocks: [
        {
          kind: "ul",
          items: [
            "تشفير بيانات اعتماد القنوات (رموز الوصول) أثناء التخزين.",
            "عزل بيانات كل متجر عبر سياسات RLS على مستوى قاعدة البيانات نفسها، لا على مستوى التطبيق وحده.",
            "التحقق من توقيع كل طلب وارد من واتساب (HMAC-SHA256) لمنع انتحال الطلبات.",
            "صلاحيات وصول مبنية على الأدوار (RBAC) داخل فريق كل متجر.",
            "نسخ احتياطية دورية لقاعدة البيانات مع اختبار استعادة فعلي، لا افتراض صلاحية النسخة.",
          ],
        },
      ],
    },
    {
      title: "٧. حقوق المستخدم النهائي",
      blocks: [
        {
          kind: "p",
          text: "يحق للمستخدم النهائي (عميل المتجر) التواصل مع المتجر مباشرة لطلب معرفة البيانات المحفوظة عنه أو حذفها، وسيحوّل المتجر الطلب إلينا لتنفيذه.",
        },
      ],
    },
  ],
};

const TERMS: LegalDoc = {
  slug: "terms",
  title: "شروط الاستخدام",
  intro:
    "باستخدام منصة ميسور، يوافق المتجر على هذه الشروط بالكامل. إن لم يوافق المتجر على أي بند منها، يجب عدم استخدام المنصة.",
  sections: [
    {
      title: "١. وصف الخدمة",
      blocks: [
        {
          kind: "p",
          text: "ميسور منصة تقنية (SaaS) تتيح للمتجر ربط قنوات تواصله (واتساب وغيرها) وإدارة محادثاته مع عملائه، مع خيار تفعيل وكيل ذكاء اصطناعي للرد التلقائي. ميسور ليست طرفًا في العلاقة التجارية بين المتجر وعملائه، ولا تتحمل مسؤولية محتوى المنتجات أو الخدمات التي يبيعها المتجر.",
        },
      ],
    },
    {
      title: "٢. التزامات المتجر",
      blocks: [
        {
          kind: "ul",
          items: [
            "تقديم معلومات صحيحة عند التسجيل وربط القنوات.",
            "عدم استخدام المنصة لإرسال رسائل غير مرغوب فيها (Spam) أو مخالفة لسياسات Meta لتجارة الأعمال (WhatsApp Business Policy).",
            "التأكد من صحة محتوى قاعدة المعرفة التي يزوّد بها وكيل الذكاء الاصطناعي؛ ميسور غير مسؤولة عن دقة إجابات مبنية على محتوى أدخله المتجر نفسه.",
            "الحصول على موافقة (Opt-in) عملائه قبل مراسلتهم عبر واتساب، وفق سياسات Meta.",
            "الحفاظ على سرية بيانات دخول فريقه، وإلغاء وصول أي موظف يغادر المتجر.",
          ],
        },
      ],
    },
    {
      title: "٣. حدود المسؤولية",
      blocks: [
        {
          kind: "ul",
          items: [
            "تُقدَّم الخدمة «كما هي» دون ضمان بعدم انقطاعها الكامل، نظرًا لاعتمادها على واجهات برمجية خارجية (Meta، ومزود نموذج الذكاء الاصطناعي).",
            "لا تتحمل ميسور مسؤولية أي أضرار تجارية غير مباشرة ناتجة عن رد آلي من وكيل الذكاء الاصطناعي؛ ويوفّر النظام آلية تصعيد للبشر (تذاكر) ومفتاح إيقاف طارئ للرد الآلي متاح للمتجر في أي وقت.",
          ],
        },
      ],
    },
    {
      title: "٤. الاشتراك والفوترة",
      blocks: [
        {
          kind: "ul",
          items: [
            "تُحدَّد قيمة الاشتراك وحدود الاستخدام حسب الباقة المختارة، وتظهر للمتجر في صفحة الفواتير داخل لوحة التحكم قبل أي التزام.",
            "يُصدَر للمتجر فاتورة بكل دورة اشتراك، ويُفعَّل الاشتراك بعد تأكيد استلام المبلغ.",
            "تجاوز حدود الباقة قد يوقف الرد الآلي مؤقتًا حتى ترقية الباقة، دون أن يؤثر ذلك على وصول المتجر إلى محادثاته وبياناته.",
          ],
        },
      ],
    },
    {
      title: "٥. إنهاء الخدمة",
      blocks: [
        {
          kind: "p",
          text: "يحق لأي طرف إنهاء الاشتراك في أي وقت. عند الإنهاء تُلغى صلاحية وصول المنصة لقنوات المتجر فورًا (ويُنصح المتجر أيضًا بإلغاء الرمز من إعدادات Meta Business مباشرة)، ويمكن للمتجر طلب نسخة من بياناته قبل حذفها وفق المدة الموضّحة في سياسة الخصوصية.",
        },
      ],
    },
    {
      title: "٦. القانون الحاكم",
      blocks: [{ kind: "p", text: "تخضع هذه الشروط لأنظمة المملكة العربية السعودية." }],
    },
  ],
};

function BlockView({ block }: { block: Block }) {
  if (block.kind === "p") {
    return <p style={{ margin: "0 0 14px", color: "var(--dim)", fontSize: 15.5 }}>{block.text}</p>;
  }
  if (block.kind === "ul") {
    return (
      <ul style={{ margin: "0 0 14px", paddingInlineStart: 22, color: "var(--dim)", fontSize: 15.5 }}>
        {block.items.map((item) => (
          <li key={item} style={{ marginBottom: 8 }}>
            {item}
          </li>
        ))}
      </ul>
    );
  }
  return (
    // A table is the only thing on the page that can be wider than the
    // column, so it scrolls inside itself instead of scrolling the document
    // sideways on a phone.
    <div style={{ overflowX: "auto", margin: "0 0 16px" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14, minWidth: 520 }}>
        <thead>
          <tr>
            {block.head.map((h) => (
              <th
                key={h}
                style={{
                  textAlign: "start",
                  padding: "10px 12px",
                  borderBottom: "1px solid var(--border-2)",
                  color: "var(--ink)",
                  fontWeight: 700,
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row) => (
            <tr key={row[0]}>
              {row.map((cell) => (
                <td
                  key={cell}
                  style={{
                    padding: "10px 12px",
                    borderBottom: "1px solid var(--border)",
                    color: "var(--dim)",
                    verticalAlign: "top",
                  }}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LegalPage() {
  // Route-driven rather than prop-driven so each route in App.tsx stays a
  // single line and the two documents can never drift into two components.
  const { pathname } = useLocation();
  const doc = pathname.startsWith("/terms") ? TERMS : PRIVACY;
  const other = doc.slug === "terms" ? PRIVACY : TERMS;

  return (
    <div className="lp">
      <div className="lp-orb a" aria-hidden="true"></div>

      <nav className="lp-nav">
        <Link to="/" className="lp-brand" style={{ textDecoration: "none", color: "inherit" }}>
          <LogoLockup size={38} tone="light" />
        </Link>
        <Link to={`/${other.slug}`} className="lp-btn lp-btn-ghost lp-btn-sm">
          {other.title}
        </Link>
      </nav>

      <main className="lp-section" style={{ maxWidth: 860, paddingBlock: "24px 40px" }}>
        <h1 style={{ fontSize: "clamp(26px, 5vw, 38px)", fontWeight: 800, margin: "0 0 10px" }}>{doc.title}</h1>
        <div style={{ color: "var(--faint)", fontSize: 13.5, marginBottom: 26 }}>آخر تحديث: {LAST_UPDATED}</div>

        <p style={{ color: "var(--dim)", fontSize: 16, margin: "0 0 32px" }}>{doc.intro}</p>

        {doc.sections.map((section) => (
          <section key={section.title} style={{ marginBottom: 30 }}>
            <h2 style={{ fontSize: 19, fontWeight: 800, margin: "0 0 12px", textAlign: "start" }}>{section.title}</h2>
            {section.blocks.map((block, i) => (
              <BlockView key={i} block={block} />
            ))}
          </section>
        ))}

        <section style={{ marginBottom: 30 }}>
          <h2 style={{ fontSize: 19, fontWeight: 800, margin: "0 0 12px", textAlign: "start" }}>التواصل معنا</h2>
          <p style={{ margin: "0 0 10px", color: "var(--dim)", fontSize: 15.5 }}>
            لأي استفسار متعلق بالخصوصية أو الشروط، أو لطلب تصدير بياناتك أو حذفها:
          </p>
          <ul style={{ margin: 0, paddingInlineStart: 22, color: "var(--dim)", fontSize: 15.5 }}>
            <li style={{ marginBottom: 8 }}>
              واتساب:{" "}
              <a href={`https://wa.me/${CONTACT_WHATSAPP}`} target="_blank" rel="noopener noreferrer" style={{ color: "var(--blue-soft)" }}>
                +{CONTACT_WHATSAPP}
              </a>
            </li>
            {SUPPORT_EMAIL && (
              <li style={{ marginBottom: 8 }}>
                البريد الإلكتروني:{" "}
                <a href={`mailto:${SUPPORT_EMAIL}`} style={{ color: "var(--blue-soft)" }}>
                  {SUPPORT_EMAIL}
                </a>
              </li>
            )}
            {LEGAL_ENTITY && <li style={{ marginBottom: 8 }}>{LEGAL_ENTITY}</li>}
            {LEGAL_ADDRESS && <li style={{ marginBottom: 8 }}>{LEGAL_ADDRESS}</li>}
          </ul>
        </section>
      </main>

      <footer className="lp-foot">
        <div className="lp-brand">
          <LogoLockup size={32} tone="light" />
        </div>
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          <Link to="/privacy" style={{ color: "var(--dim)", textDecoration: "none" }}>
            سياسة الخصوصية
          </Link>
          <Link to="/terms" style={{ color: "var(--dim)", textDecoration: "none" }}>
            شروط الاستخدام
          </Link>
          <span dir="ltr">maysoor.com</span>
          <span>© {new Date().getFullYear()} ميسور</span>
        </div>
      </footer>
    </div>
  );
}
