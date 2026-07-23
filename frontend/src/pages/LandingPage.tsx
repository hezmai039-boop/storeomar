import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import "./LandingPage.css";

// The store owner / sales contact the "اطلب متجرك" buttons open — the real
// business WhatsApp line (international format, no +).
const CONTACT_WHATSAPP = "966538165467";
const contactHref = `https://wa.me/${CONTACT_WHATSAPP}?text=${encodeURIComponent("مرحبًا، أرغب في إنشاء متجر على منصة Atlas")}`;

const FEATURES = [
  { ic: "📥", t: "صندوق وارد موحّد", d: "واتساب وكل قنواتك في شاشة واحدة — لا تنقّل بين تطبيقات." },
  { ic: "🤖", t: "ردّ آلي ذكي", d: "يجيب عملاءك فورًا من معرفة متجرك أنت، بلا تخمين، ويصعّد للبشر عند الحاجة." },
  { ic: "🔒", t: "عزل كامل", d: "بيانات كل متجر معزولة تمامًا على مستوى قاعدة البيانات — خصوصية مطلقة." },
  { ic: "📱", t: "تطبيق جوال", d: "ثبّته على شاشتك الرئيسية وتابع محادثات متجرك من أي مكان." },
  { ic: "📚", t: "قاعدة معرفة", d: "غذِّ المساعد بأسئلتك ومنتجاتك وسياساتك — ويتعلّم منها فورًا." },
  { ic: "📊", t: "تقارير ولوحة تحكم", d: "نبض متجرك في نظرة: المحادثات، نسبة الرد الآلي، والتذاكر المفتوحة." },
];

const STEPS = [
  { k: "١", t: "اطلب متجرك", d: "ننشئ لك متجرك وحساب دخولك خلال دقائق — جاهز للعمل فورًا." },
  { k: "٢", t: "اربط واتساب", d: "رقم متجرك يتصل بالمنصة بخطوات بسيطة موجّهة، بلا تعقيد تقني." },
  { k: "٣", t: "ابدأ الردّ", d: "المساعد يجيب عملاءك تلقائيًا على مدار الساعة، وأنت مطمئن." },
];

const STATS = [
  { n: "+٣٠٠٠", l: "محادثة متزامنة بلا تعثّر" },
  { n: "ثوانٍ", l: "زمن الرد على العميل" },
  { n: "٢٤/٧", l: "لا ينام ولا يغيب" },
];

export function LandingPage() {
  const { me } = useAuth();
  const dashboardHref = me ? (me.isOwner ? "/overview" : "/inbox") : "/login";

  return (
    <div className="lp">
      <div className="lp-orb a" aria-hidden="true"></div>
      <div className="lp-orb b" aria-hidden="true"></div>

      <nav className="lp-nav">
        <div className="lp-brand">
          <div className="mark">A</div>
          <div className="name">
            Atlas
            <small>STORE OPS · AI</small>
          </div>
        </div>
        {me ? (
          <Link to={dashboardHref} className="lp-btn lp-btn-ghost lp-btn-sm">
            الدخول إلى لوحتي
          </Link>
        ) : (
          <Link to="/login" className="lp-btn lp-btn-ghost lp-btn-sm">
            تسجيل الدخول
          </Link>
        )}
      </nav>

      <header className="lp-hero">
        <div className="lp-eyebrow lp-reveal lp-d1">✦ منصة إدارة المتاجر والذكاء الاصطناعي</div>
        <h1 className="lp-reveal lp-d2">
          متجرك يردّ على عملائه فورًا — <span className="hl">حتى وأنت نائم</span>
        </h1>
        <p className="sub lp-reveal lp-d3">
          Atlas توحّد واتساب وقنواتك في صندوق واحد، مع مساعد ذكاء اصطناعي يجيب عملاءك بمعرفة متجرك، ويصعّد
          للفريق البشري عند الحاجة — تجربة خدمة عملاء لا تنقطع.
        </p>
        <div className="lp-hero-cta lp-reveal lp-d4">
          <a href={contactHref} target="_blank" rel="noopener noreferrer" className="lp-btn lp-btn-primary lp-btn-lg lp-cta-pulse">
            اطلب متجرك الآن
          </a>
          <Link to={me ? dashboardHref : "/login"} className="lp-btn lp-btn-ghost lp-btn-lg">
            {me ? "الدخول إلى لوحتي" : "تسجيل الدخول"}
          </Link>
        </div>
        <div className="lp-trust lp-reveal lp-d5">
          <span>✓ عزل كامل لكل متجر</span> · <span>✓ ردّ فوري بالذكاء</span> · <span>✓ تطبيق جوال</span>
        </div>
      </header>

      <section className="lp-section">
        <h2>كل ما يحتاجه متجرك ليتفوّق في خدمة عملائه</h2>
        <p className="lead">منصة واحدة متكاملة، مصمّمة لتزيل عنك عبء الرد اليدوي وتمنح عميلك تجربة راقية.</p>
        <div className="lp-grid">
          {FEATURES.map((f) => (
            <div key={f.t} className="lp-feat">
              <div className="ic" aria-hidden="true">{f.ic}</div>
              <h3>{f.t}</h3>
              <p>{f.d}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="lp-section" style={{ paddingBlockStart: 8 }}>
        <h2>تبدأ في ثلاث خطوات</h2>
        <p className="lead">من طلب متجرك إلى أول رد آلي على عميل حقيقي — بلا تعقيد.</p>
        <div className="lp-steps">
          {STEPS.map((s) => (
            <div key={s.k} className="lp-step">
              <div className="k">{s.k}</div>
              <h3>{s.t}</h3>
              <p>{s.d}</p>
            </div>
          ))}
        </div>
      </section>

      <div className="lp-stats">
        {STATS.map((s) => (
          <div key={s.l} className="lp-stat">
            <div className="n">{s.n}</div>
            <div className="l">{s.l}</div>
          </div>
        ))}
      </div>

      <section className="lp-section">
        <div className="lp-final">
          <h2>جاهز تنقل خدمة عملاء متجرك إلى مستوى آخر؟</h2>
          <p>انضم اليوم، ودع الذكاء الاصطناعي يتكفّل بردود عملائك بينما تركّز أنت على نموّ متجرك.</p>
          <a href={contactHref} target="_blank" rel="noopener noreferrer" className="lp-btn lp-btn-gold lp-btn-lg">
            اطلب متجرك الآن
          </a>
        </div>
      </section>

      <footer className="lp-foot">
        <div className="lp-brand">
          <div className="mark">A</div>
          <div className="name">Atlas</div>
        </div>
        <div>© {new Date().getFullYear()} Atlas — جميع الحقوق محفوظة</div>
      </footer>
    </div>
  );
}
