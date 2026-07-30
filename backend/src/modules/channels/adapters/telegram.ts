import { ChannelAdapter, NormalizedInboundMessage } from "./types";
import { timingSafeStringEqual } from "../../../lib/timingSafeEqual";

// Telegram Bot API — https://core.telegram.org/bots/api
//
// Why this channel matters commercially (docs/27-telegram-setup.md): it is
// the only channel a merchant can connect in minutes — a BotFather token,
// no Meta business verification, no WABA, no per-message fee. It is how a
// new signup proves Maysoor works on their own traffic before committing to
// the WhatsApp onboarding described in docs/22-whatsapp-store-onboarding-manual.md.
// So it is a first-class adapter, held to the same isolation/security bar
// as whatsapp.ts, not a demo path like mock.ts.

const TELEGRAM_API_BASE = "https://api.telegram.org";

// Only the fields we actually consume. Telegram's Update is a large union
// (20+ optional members) and grows with every Bot API release; typing the
// whole thing would be dead weight that rots, so we type the one branch we
// handle and let `parseWebhook` drop everything else.
interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type?: string;
  first_name?: string;
  last_name?: string;
  username?: string;
  title?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat?: TelegramChat;
  date?: number;
  text?: string;
}

interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
}

/**
 * The bot id is the part of the BotFather token before the colon
 * (`123456789:AAH...`). Public, non-secret, and permanently bound to the
 * bot, which is exactly what `channel_accounts.external_account_id` needs:
 * a stable identifier the merchant can be shown and that survives a token
 * rotation (revoking a token via BotFather changes only the hash after the
 * colon, never the id before it) — so rotating credentials through
 * PATCH /channel-accounts/:id/credentials keeps the same account row and
 * the same webhook URL.
 *
 * Verified against the payload this adapter actually parses: a Telegram
 * `Update` carries NO bot identifier anywhere — `message.from` is the
 * customer, `message.chat` is the conversation, and nothing names the
 * receiving bot. So unlike the app-level WhatsApp route (which digs
 * `phone_number_id` out of the body to find the store), Telegram cannot
 * resolve a store from the body, and must not try. It doesn't need to:
 * `setWebhook` is per-bot, so each account gets its own callback URL
 * (/v1/webhooks/channels/telegram/:channelAccountId) and the store is
 * resolved from the URL — which sidesteps the multi-tenant misrouting bug
 * documented in webhook.ts entirely, since two stores can never share a
 * Telegram callback URL the way they share a Meta App's.
 *
 * The bot id therefore earns its place as `external_account_id` for
 * identity and uniqueness (the @@unique([storeId, channelTypeId,
 * externalAccountId]) guard stops the same bot being connected twice to
 * one store) rather than for routing.
 *
 * Throws rather than returning a partial value: a malformed token would
 * otherwise be stored, and the failure would only surface much later as a
 * 404 from Telegram on the first outbound reply.
 */
export function telegramBotIdFromToken(botToken: string): string {
  const botId = botToken.split(":")[0];
  if (!botId || !/^\d+$/.test(botId) || !botToken.includes(":")) {
    throw new Error("Invalid Telegram bot token format — expected `<botId>:<authHash>` from BotFather");
  }
  return botId;
}

/**
 * Telegram has no HMAC over the body — nothing in the request proves it
 * came from Telegram. What it offers instead is `secret_token`, a value we
 * choose at `setWebhook` time and that Telegram echoes back verbatim in the
 * `X-Telegram-Bot-Api-Secret-Token` header on every delivery.
 *
 * This is the ONLY thing standing between a store's inbox and anyone who
 * learns (or guesses) the webhook URL: without it, a stranger could POST a
 * hand-written Update and inject a message that Maysoor would persist as a
 * real customer message, answer with the store's AI agent, and bill against
 * the org's AI reply quota. So verification here is mandatory, and it fails
 * closed — an account with no `webhookVerifyToken` configured rejects every
 * delivery rather than accepting unauthenticated ones.
 *
 * Constant-time comparison for the same reason the Meta adapters use it
 * (see lib/timingSafeEqual.ts): a `===` on a shared secret leaks its bytes
 * to an attacker who can time our responses.
 */
export function verifyTelegramSecretToken(headerValue: string | undefined, expectedSecret: string): boolean {
  if (!headerValue || !expectedSecret) return false;
  // utf8, not hex: the secret is an opaque string (Telegram allows
  // A-Z a-z 0-9 _ -), and hex-decoding it would silently collapse
  // distinct secrets that share a hex-parsable prefix.
  return timingSafeStringEqual(expectedSecret, headerValue, "utf8");
}

export const telegramAdapter: ChannelAdapter = {
  key: "telegram",

  // `signatureHeader` here is X-Telegram-Bot-Api-Secret-Token and
  // `appSecret` is this channel account's `webhook_verify_token` — not an
  // app-wide secret like the Meta adapters get. Telegram's secret is
  // necessarily per-bot because it is registered per-bot by setWebhook, and
  // `webhook_verify_token` is already a per-account column minted at
  // connect time (channels/routes.ts), so no schema change is needed.
  verifyWebhookSignature(_rawBody, signatureHeader, appSecret) {
    return verifyTelegramSecretToken(signatureHeader, appSecret);
  },

  parseWebhook(payload) {
    const update = payload as TelegramUpdate | null | undefined;
    const out: NormalizedInboundMessage[] = [];

    // One Update = at most one message; Telegram never batches (unlike
    // Meta's entry[]/changes[] fan-out), so there is no loop here.
    const msg = update?.message;

    // Everything that is not a plain text message from a human is dropped
    // silently — edited_message, callback_query, my_chat_member, photos,
    // stickers, service messages for joins/leaves, channel_post. Returning
    // [] instead of throwing is a hard requirement, not politeness:
    // Telegram retries any non-2xx delivery, and it re-sends the SAME
    // update, so one unhandled update type would turn into an infinite
    // retry loop hammering the webhook and stalling that bot's queue
    // behind it. New Bot API update types must therefore be ignorable by
    // default rather than an error.
    if (!msg || typeof msg.text !== "string" || msg.text.length === 0) return out;
    if (msg.from?.is_bot) return out; // bot-to-bot chatter is never a customer
    if (!msg.chat?.id) return out;

    // chat.id, not from.id: `chat_id` is what sendMessage requires, and the
    // pipeline replies with `customer.externalId` as `toExternalId`
    // (webhook.ts phase 5). In a private chat the two are equal anyway, but
    // storing chat.id keeps the reply address correct if a bot is ever
    // added to a group.
    const chatId = String(msg.chat.id);

    const fullName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ").trim();

    out.push({
      externalCustomerId: chatId,
      // Fall back to @username, then the group title — anything is better
      // than an empty name in the unified inbox, and Telegram users are
      // free to hide their real name.
      customerName: fullName || msg.from?.username || msg.chat.title || undefined,
      // Deliberately absent: Telegram never exposes a phone number unless
      // the user explicitly shares a contact, so writing anything here
      // would fabricate customer PII (docs/15 §2.1, PDPL).
      customerPhone: undefined,
      text: msg.text,
      // message_id is only unique within a chat, so it must be qualified —
      // an unqualified id would collide across customers and make
      // `messages.external_message_id` useless for deduplication.
      externalMessageId: `${chatId}:${msg.message_id}`,
    });

    return out;
  },

  async sendMessage(credentials, message) {
    const { botToken } = credentials as { botToken: string };
    const resp = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: message.toExternalId, text: message.text }),
    });

    // Telegram signals application errors two ways: a non-2xx status, and
    // `ok: false` in a 200 body. Checking only resp.ok would let a failed
    // send be recorded as delivered, so both are checked.
    const json = (await resp.json().catch(() => null)) as
      | { ok?: boolean; description?: string; result?: { message_id?: number } }
      | null;
    if (!resp.ok || !json?.ok) {
      throw new Error(`Telegram send failed: ${resp.status} ${json?.description ?? "unknown error"}`);
    }

    // Same chat-qualified id format as inbound, so both directions of a
    // conversation carry comparable external ids.
    return { externalMessageId: `${message.toExternalId}:${json.result?.message_id ?? ""}` };
  },
};

/**
 * Registers the inbound webhook with Telegram. Not part of ChannelAdapter
 * (no other channel can self-register — Meta requires a human in the App
 * dashboard), which is exactly the advantage worth exposing: Telegram
 * onboarding can be fully automated from the token alone, so connecting a
 * store is "paste token, done" instead of a Meta review cycle.
 *
 * `secretToken` must be the account's `webhook_verify_token` — the same
 * value verifyWebhookSignature checks — otherwise every delivery is
 * rejected as unauthenticated.
 */
export async function setTelegramWebhook(params: {
  botToken: string;
  webhookUrl: string;
  secretToken: string;
}): Promise<void> {
  const resp = await fetch(`${TELEGRAM_API_BASE}/bot${params.botToken}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: params.webhookUrl,
      secret_token: params.secretToken,
      // Ask Telegram not to send update types we drop anyway — cuts
      // useless webhook traffic and, more importantly, means a future Bot
      // API update type does not start arriving unannounced.
      allowed_updates: ["message"],
      // Old queued updates from a previous owner of this bot must not be
      // replayed into a customer's live inbox on connect.
      drop_pending_updates: true,
    }),
  });
  const json = (await resp.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
  if (!resp.ok || !json?.ok) {
    throw new Error(`Telegram setWebhook failed: ${resp.status} ${json?.description ?? "unknown error"}`);
  }
}
