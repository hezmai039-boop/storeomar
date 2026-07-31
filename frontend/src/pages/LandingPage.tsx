import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { api } from "../api/client";
import type { PublicPlan } from "../api/types";
import { PlanRequestDialog } from "./PlanRequestDialog";
import { LogoLockup } from "../components/Logo";
import "./LandingPage.css";

// The store owner / sales contact the "اطلب متجرك" buttons open — the real
// business WhatsApp line (international format, no +).
const CONTACT_WHATSAPP = "966538165467";
const contactHref = `https://wa.me/${CONTACT_WHATSAPP}?text=${encodeURIComponent("مرحبًا، أرغب في إنشاء متجر على منصة ميسور")}`;

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

// Prices arrive as integer halalas (SAR × 100). Latin numerals because the
// rest of the page's figures are, and because a price is copied into a bank
// transfer.
const SAR = new Intl.NumberFormat("ar-SA-u-nu-latn", { maximumFractionDigits: 0 });

/** null = unlimited on every quota field. Never render it as 0. */
function limitText(limit: number | null, unit: string): string {
  return limit === null ? `${unit} بلا حد` : `${SAR.format(limit)} ${unit}`;
}

type BillingInterval = "monthly" | "yearly";

/**
 * A tier and whichever of its two billing intervals exist.
 *
 * Pairing is by the key prefix ("basic" + "basic_yearly"), but which bucket a
 * plan lands in is decided by `interval`, never by the suffix: the suffix is a
 * naming convention and the column is the fact. A plan named `pro_yearly` that
 * the database says is monthly is a data problem, and it should surface as a
 * card in the wrong tab rather than as a price under the wrong heading.
 */
interface PlanGroup {
  base: string;
  monthly: PublicPlan | null;
  yearly: PublicPlan | null;
}

const YEARLY_SUFFIX = "_yearly";

/**
 * Which tier wears "الأكثر طلبًا".
 *
 * Deliberately a constant in the frontend and NOT a column on `Plan`. Which
 * tier we push is a marketing decision — it moves with a campaign, a
 * competitor's price change, or a week of conversion data — and a schema
 * migration is far too heavy a unit of change for something re-decided that
 * often. Storing it in the database would also make it a value someone has to
 * remember to un-set on the old tier when they set it on the new one.
 *
 * It replaces the previous "highlight whatever card is in the middle", which
 * was correct only for exactly three tiers: with four, the middle by position
 * is الأساسية — the cheapest paid tier — and the page would have recommended
 * the plan it least wants a visitor to stop at.
 *
 * Keyed by BASE key, so the same tier is recommended in both billing tabs
 * (`growth` and `growth_yearly` are one recommendation, not two). Nothing is
 * highlighted if no listed key is on the catalogue, which is the honest
 * degradation: no badge beats a badge on an arbitrary card.
 */
const RECOMMENDED_PLAN_KEYS: readonly string[] = ["growth"];

function baseKeyOf(key: string): string {
  return key.endsWith(YEARLY_SUFFIX) ? key.slice(0, -YEARLY_SUFFIX.length) : key;
}

/** Groups in the catalogue's own order (the API sorts by sortOrder). */
function groupPlans(plans: PublicPlan[]): PlanGroup[] {
  const groups: PlanGroup[] = [];
  const byBase = new Map<string, PlanGroup>();
  for (const plan of plans) {
    const base = baseKeyOf(plan.key);
    let group = byBase.get(base);
    if (!group) {
      group = { base, monthly: null, yearly: null };
      byBase.set(base, group);
      groups.push(group);
    }
    if (plan.interval === "yearly") group.yearly ??= plan;
    else group.monthly ??= plan;
  }
  return groups;
}

/**
 * The plan a tier shows for the selected interval.
 *
 * The fallback is the whole point: the free tier has no yearly twin, and a
 * tier that vanishes when the visitor flips to "سنوي" reads as a page bug, not
 * as "this one is not sold yearly". It renders in both tabs at its one price.
 */
function planFor(group: PlanGroup, interval: BillingInterval): PublicPlan | null {
  return interval === "yearly" ? (group.yearly ?? group.monthly) : (group.monthly ?? group.yearly);
}

/**
 * What a year on the yearly plan saves against twelve months of the monthly
 * one — computed, never asserted. Writing "شهران مجانًا" in the markup makes
 * the page lie the first day someone reprices a tier; this makes it wrong-proof
 * by construction. Returns null when there is nothing honest to claim.
 */
function yearlySaving(group: PlanGroup): { halalas: number; percent: number } | null {
  const { monthly, yearly } = group;
  if (!monthly || !yearly || monthly.priceHalalas <= 0) return null;
  const twelveMonths = monthly.priceHalalas * 12;
  const halalas = twelveMonths - yearly.priceHalalas;
  if (halalas <= 0) return null;
  return { halalas, percent: Math.round((halalas / twelveMonths) * 100) };
}

export function LandingPage() {
  const { me } = useAuth();
  const dashboardHref = me ? (me.isOwner ? "/overview" : "/inbox") : "/login";

  // The catalogue comes from the API, not a constant in this file: the whole
  // point of putting plans on the landing page is that the page and the
  // billing screen quote the same numbers. A hard-coded price here is a
  // price that goes stale the first time one is changed in the database.
  const [plans, setPlans] = useState<PublicPlan[] | null>(null);
  const [requested, setRequested] = useState<PublicPlan | null>(null);
  // Defaults to شهري: the smaller number is the one that has to survive first
  // contact. Yearly is the upsell, and an upsell shown before the price is
  // understood reads as the price.
  const [interval, setInterval] = useState<BillingInterval>("monthly");

  useEffect(() => {
    let alive = true;
    api
      .get<{ data: PublicPlan[] }>("/v1/public/plans")
      // An empty array on failure, not an error banner: this is a marketing
      // page, and a backend hiccup should cost the pricing section, not the
      // whole page. The WhatsApp contact button below still works.
      .then((resp) => alive && setPlans(resp.data))
      .catch(() => alive && setPlans([]));
    return () => {
      alive = false;
    };
  }, []);

  const groups = useMemo(() => groupPlans(plans ?? []), [plans]);
  // The toggle only exists if something is actually sold yearly. One tab with
  // nothing behind it is a control that punishes the visitor for using it.
  const hasYearly = groups.some((g) => g.yearly !== null);
  // The headline number on the toggle: the best real saving on offer, taken
  // from the rows. `حتى` because tiers can differ.
  const bestSavingPercent = groups.reduce((best, g) => Math.max(best, yearlySaving(g)?.percent ?? 0), 0);
  const shownPlans = groups
    .map((g) => ({ group: g, plan: planFor(g, hasYearly ? interval : "monthly") }))
    .filter((entry): entry is { group: PlanGroup; plan: PublicPlan } => entry.plan !== null);

  return (
    <div className="lp">
      <div className="lp-orb a" aria-hidden="true"></div>
      <div className="lp-orb b" aria-hidden="true"></div>

      <nav className="lp-nav">
        <div className="lp-brand">
          {/* tone="light" is the navy-background variant — white wordmark,
              orange descriptor. The mark itself lives in components/Logo. */}
          <LogoLockup size={38} tone="light" />
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
          ميسور توحّد واتساب وقنواتك في صندوق واحد، مع مساعد ذكاء اصطناعي يجيب عملاءك بمعرفة متجرك، ويصعّد
          للفريق البشري عند الحاجة — تجربة خدمة عملاء لا تنقطع.
        </p>
        <div className="lp-hero-cta lp-reveal lp-d4">
          {/* Orange is spent on exactly one thing per screen — the action that
              converts. Everything else on this page is blue or glass. */}
          <a href={contactHref} target="_blank" rel="noopener noreferrer" className="lp-btn lp-btn-accent lp-btn-lg lp-cta-pulse">
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

      {/* Pricing sits after "how it works" and before the stats band: the
          visitor has just been told what they get and in how many steps,
          which is the moment a price stops reading as a barrier. Rendered
          only once the catalogue actually loaded — an empty pricing section
          is worse than none. */}
      {plans && plans.length > 0 && (
        <section className="lp-section" id="plans">
          <h2>باقات تناسب متجرك</h2>
          <p className="lead">
            اختر باقتك واترك بياناتك — نتواصل معك للاتفاق على طريقة الدفع ونفعّل حسابك. لا حاجة لبطاقة، ولا يُخصم منك
            شيء الآن.
          </p>
          {hasYearly && (
            /* radiogroup, not two buttons: this is one choice with two states,
               and arrow keys / a single tab stop are what a screen reader user
               expects from a segmented control. The active state is the
               interaction blue — never the orange, which this page spends on
               the single conversion CTA and which cannot carry light text at
               2.87:1 anyway (docs/32-brand.md §2). */
            <div className="lp-cycle" role="radiogroup" aria-label="دورة الفوترة">
              <button
                type="button"
                role="radio"
                aria-checked={interval === "monthly"}
                className={interval === "monthly" ? "is-on" : ""}
                onClick={() => setInterval("monthly")}
              >
                شهري
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={interval === "yearly"}
                className={interval === "yearly" ? "is-on" : ""}
                onClick={() => setInterval("yearly")}
              >
                سنوي
                {bestSavingPercent > 0 && <span className="save">وفّر حتى {SAR.format(bestSavingPercent)}٪</span>}
              </button>
            </div>
          )}
          <div className="lp-plans">
            {shownPlans.map(({ group, plan: p }) => {
              const featured = RECOMMENDED_PLAN_KEYS.includes(group.base);
              const free = p.priceHalalas === 0;
              const yearly = p.interval === "yearly";
              // Only claimed on the card the visitor is actually looking at,
              // and only from the two rows behind it.
              const saving = yearly ? yearlySaving(group) : null;
              // What a year works out to per month. This, not the annual
              // figure, is the number a monthly price can be compared with.
              const perMonth = yearly ? p.priceHalalas / 12 : null;
              return (
                <div key={p.key} className={`lp-plan${featured ? " is-featured" : ""}`}>
                  {featured && <span className="tag">الأكثر طلبًا</span>}
                  <h3>{p.name}</h3>
                  <div className="price">
                    <span className="n">{free ? "مجانًا" : SAR.format(p.priceHalalas / 100)}</span>
                    {!free && <span className="per">ريال / {yearly ? "سنويًا" : "شهريًا"}</span>}
                  </div>
                  {perMonth !== null && (
                    <div className="lp-plan-sub">
                      ما يعادل {SAR.format(perMonth / 100)} ريال شهريًا
                      {saving && (
                        <>
                          {" · "}
                          <b>توفير {SAR.format(saving.halalas / 100)} ريال ({SAR.format(saving.percent)}٪)</b>
                        </>
                      )}
                    </div>
                  )}
                  {/* A paid tier with no yearly twin, shown in the yearly tab.
                      Said plainly rather than leaving the card looking like
                      the toggle failed to apply to it. The free tier needs no
                      such line — "مجانًا" already answers the question. */}
                  {!yearly && !free && interval === "yearly" && (
                    <div className="lp-plan-sub">بسعر واحد — شهريًا أو سنويًا</div>
                  )}
                  <ul>
                    <li>{limitText(p.maxAiRepliesMonthly, "رد ذكي شهريًا")}</li>
                    <li>{limitText(p.maxStores, "متجر")}</li>
                    <li>{limitText(p.maxUsers, "مستخدم")}</li>
                    {p.features.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    className={`lp-btn ${featured ? "lp-btn-accent" : "lp-btn-ghost"}`}
                    onClick={() => setRequested(p)}
                  >
                    اطلب باقة {p.name}
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <PlanRequestDialog plan={requested} onClose={() => setRequested(null)} />

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
          <a href={contactHref} target="_blank" rel="noopener noreferrer" className="lp-btn lp-btn-accent lp-btn-lg">
            اطلب متجرك الآن
          </a>
        </div>
      </section>

      <footer className="lp-foot">
        <div className="lp-brand">
          <LogoLockup size={32} tone="light" />
        </div>
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
          <Link to="/privacy">سياسة الخصوصية</Link>
          <Link to="/terms">شروط الاستخدام</Link>
          <span dir="ltr">maysoor.com</span>
          <span>© {new Date().getFullYear()} ميسور — جميع الحقوق محفوظة</span>
        </div>
      </footer>
    </div>
  );
}
