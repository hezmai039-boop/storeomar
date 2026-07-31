/**
 * The ميسور mark, as one component so there is exactly one copy of the
 * geometry in the app. Every surface that shows the brand (sidebar, landing
 * nav and footer, login, install banner) renders this.
 *
 * `tone` selects the palette rather than the shape:
 *   "brand" — navy mark + orange accent, for light backgrounds
 *   "light" — white mark + orange accent, for the navy landing page
 *   "mono"  — inherits currentColor, for anywhere the mark must not compete
 *
 * It is the same geometry as public/icon.svg on purpose. If one changes, the
 * other has to change with it — a home-screen icon that does not match the
 * header is the most visible kind of brand inconsistency.
 */
export function LogoMark({
  size = 32,
  tone = "brand",
  title,
}: {
  size?: number;
  tone?: "brand" | "light" | "mono";
  title?: string;
}) {
  // The bubble is the mark's silhouette — lose it and the ‏م‏ floats loose and
  // the "customer service" idea goes with it. So each tone decides how the
  // bubble reads against ITS background, and the letter follows:
  //
  //   light — on navy. SOLID WHITE bubble with a NAVY ‏م‏ inside, exactly as
  //           public/icon.svg draws it. An earlier version filled the bubble
  //           navy here, which made it disappear into the page and left the
  //           letter hanging in space.
  //   brand — on white. OUTLINED navy bubble; a solid one would be a heavy
  //           navy blob at 32px.
  //   mono  — everything inherits currentColor, so the bubble has to be an
  //           outline (a solid fill would swallow the letter drawn in the
  //           same colour).
  const isLight = tone === "light";
  const isMono = tone === "mono";
  // "brand" consumes THEME TOKENS, not hex.
  //
  // It used to hard-code #0D2C4D, which made the wordmark and the ‏م‏ measure
  // 1.06:1 against the dark theme's navy sidebar — invisible, and shipped.
  // The mistake was treating "brand" as a palette when it is really a
  // context: "render me in whatever this surface's foreground is". The
  // tokens already flip correctly (docs/32), the component simply was not
  // asking them. Now: 13.77:1 on the light sidebar, 11.73:1 on the dark one.
  //
  // "light" stays hard-coded on purpose — the landing page is a fixed dark
  // world that does NOT follow prefers-color-scheme, so a token there would
  // recolour the mark for every visitor whose OS is in light mode.
  const shell = isLight ? "#0D2C4D" : isMono ? "currentColor" : "var(--text)";
  const bubbleStroke = isLight ? "none" : isMono ? "currentColor" : "var(--text)";
  const bubbleFill = isLight ? "#FFFFFF" : "none";
  const accent = isMono ? "currentColor" : isLight ? "#FF6A00" : "var(--accent)";
  const band = isLight ? "#E6ECF2" : isMono ? "currentColor" : "var(--primary)";

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      // aria-hidden when there is no title: the brand name is almost always
      // written next to the mark, and announcing it twice is noise.
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <path d="M136 250 A120 120 0 0 1 376 250" fill="none" stroke={band} strokeWidth={26} strokeLinecap="round" />
      <rect x="112" y="236" width="52" height="86" rx="26" fill={accent} />
      <rect x="348" y="236" width="52" height="86" rx="26" fill={band} />
      <path
        d="M186 196 H326 a34 34 0 0 1 34 34 v92 a34 34 0 0 1 -34 34 h-74
           l-46 40 v-40 h-20 a34 34 0 0 1 -34 -34 v-92 a34 34 0 0 1 34 -34 z"
        fill={bubbleFill}
        stroke={bubbleStroke}
        strokeWidth={isLight ? 0 : 22}
        strokeLinejoin="round"
      />
      {/* ‏م‏ — bowl then descender. Kept byte-for-byte in step with
          public/icon.svg; see the note in that file for why the descender
          drops before it curves. */}
      <circle cx="252" cy="246" r="31" fill="none" stroke={shell} strokeWidth={21} />
      <path
        d="M283 246 h14 a22 22 0 0 1 22 22 v52 a26 26 0 0 1 -26 26 h-18"
        fill="none"
        stroke={shell}
        strokeWidth={21}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Mark + wordmark. `subtitle` renders the descriptor line from the brand
 * board ("خدمة العملاء الذكية") — omitted in tight spots like the sidebar of a
 * collapsed layout, where a second line of 10px text is unreadable anyway.
 */
export function LogoLockup({
  size = 34,
  tone = "brand",
  subtitle = true,
}: {
  size?: number;
  tone?: "brand" | "light" | "mono";
  subtitle?: boolean;
}) {
  // Same rule as the mark: theme tokens for "brand", fixed hex only for the
  // landing page's fixed dark world. The descriptor uses --accent-text
  // rather than --accent because it is ~9px TEXT, and the raw brand orange
  // is 2.87:1 on a light surface (docs/32).
  const nameColor = tone === "light" ? "#FFFFFF" : tone === "mono" ? "currentColor" : "var(--text)";
  const subColor = tone === "light" ? "#FF6A00" : tone === "mono" ? "currentColor" : "var(--accent-text)";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <LogoMark size={size} tone={tone} />
      <span style={{ display: "grid", lineHeight: 1.15 }}>
        <b style={{ fontSize: size * 0.56, fontWeight: 800, color: nameColor, letterSpacing: "0.2px" }}>ميسور</b>
        {subtitle && (
          <small style={{ fontSize: size * 0.27, fontWeight: 700, color: subColor }}>خدمة العملاء الذكية</small>
        )}
      </span>
    </span>
  );
}
