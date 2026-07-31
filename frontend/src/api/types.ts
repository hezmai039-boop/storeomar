export interface StoreSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
  roles: string[];
}

// The full store record returned by store-management endpoints (create,
// onboard, get). StoreSummary above is the lighter shape /me returns.
export interface Store {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  currency: string;
  status: string;
}

export interface Me {
  id: string;
  name: string;
  email: string;
  organizationId: string;
  isOwner: boolean;
  stores: StoreSummary[];
}

export interface Customer {
  id: string;
  name: string | null;
  phone: string | null;
  externalId: string;
}

export interface ChannelTypeRef {
  key: string;
  name: string;
}

export interface Conversation {
  id: string;
  status: string;
  aiConfidenceLevel: string | null;
  // Human takeover for this one customer. The narrowest of the three
  // reply-control levels (docs/34) — store, channel, conversation.
  aiPaused: boolean;
  aiPausedAt: string | null;
  lastMessageAt: string | null;
  customer: Customer;
  channelAccount: { id: string; displayName: string; channelType: ChannelTypeRef };
}

export interface Message {
  id: string;
  conversationId: string;
  senderType: "customer" | "ai" | "agent" | "system";
  content: string;
  createdAt: string;
}

export interface KnowledgeSuggestion {
  id: string;
  content: string;
  status: string;
  createdAt: string;
  conversationId: string | null;
}

export interface KnowledgeSource {
  id: string;
  type: string;
  title: string;
  status: string;
  _count?: { chunks: number };
}

export interface Ticket {
  id: string;
  status: string;
  priority: string;
  escalationReason: string | null;
  aiRecommendation: string | null;
  createdAt: string;
  customer: Customer;
  department: { id: string; name: string } | null;
}

export interface ChannelAccount {
  id: string;
  displayName: string;
  status: string;
  // Whether the AI answers on this channel. Separate from `status`:
  // `connected` is "we can send", this is "we should reply automatically".
  aiEnabled: boolean;
  channelType: ChannelTypeRef;
  // Why the channel is not working, encoded as `[reason] عربي` by the
  // backend (channelHealth.ts). Never Meta's raw body.
  lastError: string | null;
  lastErrorAt: string | null;
  tokenExpiresAt: string | null;
}

// «فحص القناة» — POST /channel-accounts/:id/diagnose
export interface DiagnosticCheck {
  key: string;
  label: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  fix?: string;
}

export interface ChannelDiagnosis {
  checkedAt: string;
  healthy: boolean;
  reason: string | null;
  checks: DiagnosticCheck[];
  number: {
    displayPhoneNumber: string | null;
    verifiedName: string | null;
    nameStatusAr: string | null;
    verificationAr: string | null;
    qualityAr: string | null;
  } | null;
  webhook: { callbackUrl: string; verifyTokenConfigured: boolean };
  tokenExpiresAt: string | null;
  // Platform staff only — absent for merchants.
  staffOnly?: { rawMetaError: string; httpStatus: number; code: number | null; subcode: number | null; fbtraceId: string | null };
}

export interface Integration {
  id: string;
  platform: string;
  status: string;
  lastSyncedAt: string | null;
}

export interface StoreOverview {
  id: string;
  name: string;
  totalConversations: number;
  aiResolvedRate: number;
  escalationRate: number;
  openTickets: number;
}

export interface ChannelHealthEntry {
  id: string;
  displayName: string;
  channelType: string;
  status: string;
  externalAccountId: string;
  connectedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  tokenExpiresAt: string | null;
}

export interface StoreChannelHealth {
  id: string;
  name: string;
  channels: ChannelHealthEntry[];
}

export interface PageMeta {
  next_cursor: string | null;
  has_more: boolean;
}

export interface AiAgent {
  id: string;
  name: string;
  confidenceThresholdHigh: string;
  confidenceThresholdLow: string;
  advancedIntelligenceEnabled: boolean;
  status: string;
}

export interface SimulationLink {
  id: string;
  token: string;
  label: string;
  isActive: boolean;
  createdAt: string;
}

/* ---------- billing ----------
   Money is always an INTEGER count of halalas (SAR × 100) so no float ever
   touches an amount; render it through formatSar() in BillingPage. A null on
   any quota limit means UNLIMITED, never zero. */

export interface Plan {
  id: string;
  // A plain string, not a union of the seeded keys. The catalogue is DATA —
  // prisma/seed-reference.ts now derives `basic_yearly` / `growth_yearly` /
  // `business_yearly` from their monthly twins, and a union here would have to
  // be edited every time a tier or a billing cycle is added, which makes this
  // file the thing that rejects a row the API happily returned. The `pro` →
  // `growth` + `business` restructure is exactly that edit, and it cost this
  // file nothing. Only "free" is special-cased anywhere, and that is enforced
  // in the backend.
  key: string;
  name: string;
  nameEn: string;
  priceHalalas: number;
  currency: string;
  interval: "monthly" | "yearly";
  maxStores: number | null;
  maxUsers: number | null;
  maxAiRepliesMonthly: number | null;
  features: string[];
  sortOrder: number;
}

export type SubscriptionStatus = "trialing" | "active" | "past_due" | "canceled";

export interface Subscription {
  id: string;
  status: SubscriptionStatus;
  currentPeriodEnd: string;
  trialEndsAt: string | null;
  provider: string;
}

export interface QuotaUsage {
  used: number;
  limit: number | null;
}

export interface BillingUsage {
  period: string;
  aiReplies: number;
  limit: number | null;
  remaining: number | null;
  percentUsed: number;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  stores: QuotaUsage;
  users: QuotaUsage;
}

export interface BillingOverview {
  subscription: Subscription | null;
  plan: Plan | null;
  usage: BillingUsage;
}

export type InvoiceStatus = "pending" | "awaiting_review" | "paid" | "rejected" | "void";

export interface Invoice {
  id: string;
  number: string;
  status: InvoiceStatus;
  subtotalHalalas: number;
  vatHalalas: number;
  totalHalalas: number;
  currency: string;
  periodStart: string;
  periodEnd: string;
  transferRef: string | null;
  reviewNote: string | null;
  createdAt: string;
}

/** Only the platform-staff admin listing carries the paying organization. */
export interface AdminInvoice extends Invoice {
  organization: { id: string; name: string; slug: string };
}

export interface TransferInstructions {
  bankName: string;
  accountName: string;
  iban: string;
  reference: string;
  note: string;
}

/**
 * The `contact` provider (the default): no bank details are published in
 * the product at all. The customer gets an invoice number to quote and a
 * way to reach a human, and the team arranges payment person to person.
 *
 * Mirrors ContactCheckout in backend/src/modules/billing/adapters/types.ts.
 */
export interface ContactInstructions {
  reference: string;
  /** Digits only, international format, no `+`. */
  whatsappNumber: string;
  whatsappUrl: string;
  note: string;
}

/**
 * Discriminated on `kind` — same union as the backend. Each variant carries
 * only its own fields, so a `contact` checkout has no `instructions` to
 * render an empty bank block from.
 */
export type CheckoutInstruction =
  | { kind: "offline_transfer"; instructions: TransferInstructions }
  | { kind: "contact"; contact: ContactInstructions }
  | { kind: "redirect"; redirectUrl: string };

export interface SubscribeResult {
  subscription: Subscription;
  invoice: Invoice | null;
  checkout: CheckoutInstruction | null;
}

// ---------------------------------------------------------------
// Landing-page plan requests (leads).
//
// PublicPlan is a NARROWER shape than Plan, on purpose: it mirrors the
// explicit `select` in the backend's GET /v1/public/plans. If a field is
// missing here that Plan has, that is the point — an anonymous visitor is
// not shown internal columns, and typing the public response as `Plan`
// would let a component read `id` or `isActive` that the API never sends.
// ---------------------------------------------------------------

export interface PublicPlan {
  key: string;
  name: string;
  nameEn: string;
  priceHalalas: number;
  currency: string;
  interval: string;
  maxStores: number | null;
  maxUsers: number | null;
  maxAiRepliesMonthly: number | null;
  features: string[];
  sortOrder: number;
}

export type PlanRequestStatus = "new" | "contacted" | "activated" | "rejected";

export interface PlanRequest {
  id: string;
  planKey: string;
  name: string;
  email: string;
  phone: string;
  storeName: string | null;
  note: string | null;
  status: PlanRequestStatus;
  source: string;
  ip: string | null;
  organizationId: string | null;
  handledAt: string | null;
  handleNote: string | null;
  createdAt: string;
  plan: { key: string; name: string; priceHalalas: number; currency: string; interval: string } | null;
  organization: { id: string; name: string; slug: string } | null;
}

/** The picker behind "activate a plan for…" — platform staff only. */
export interface AdminOrganization {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: string;
  subscription: {
    status: SubscriptionStatus;
    currentPeriodEnd: string;
    plan: { key: string; name: string };
  } | null;
}
