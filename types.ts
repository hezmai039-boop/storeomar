export interface StoreSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
  roles: string[];
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
  channelType: ChannelTypeRef;
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
