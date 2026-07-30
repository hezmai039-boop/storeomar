import { test } from "node:test";
import assert from "node:assert/strict";
import { telegramAdapter, telegramBotIdFromToken, verifyTelegramSecretToken } from "../adapters/telegram";
import { getAdapter } from "../adapters/registry";

// A real-shaped Telegram Update, copied from an actual private-chat
// delivery (ids/hashes replaced). Kept verbatim rather than minimized so
// the test fails if we ever start depending on a field Telegram does not
// actually send.
function textUpdate(overrides: Record<string, unknown> = {}) {
  return {
    update_id: 913_845_221,
    message: {
      message_id: 47,
      from: {
        id: 611_223_344,
        is_bot: false,
        first_name: "سارة",
        last_name: "العتيبي",
        username: "sara_o",
        language_code: "ar",
      },
      chat: {
        id: 611_223_344,
        first_name: "سارة",
        last_name: "العتيبي",
        username: "sara_o",
        type: "private",
      },
      date: 1_769_000_000,
      text: "كم تكلفة الشحن داخل السعودية؟",
      ...overrides,
    },
  };
}

test("normalizes a real-shaped Telegram Update into one NormalizedInboundMessage", () => {
  const [msg, ...rest] = telegramAdapter.parseWebhook(textUpdate());
  assert.equal(rest.length, 0, "an Update carries at most one message — no batching");
  assert.equal(msg.text, "كم تكلفة الشحن داخل السعودية؟");
  // chat.id, because it is what sendMessage's chat_id needs and the
  // pipeline replies with customer.externalId.
  assert.equal(msg.externalCustomerId, "611223344");
  assert.equal(msg.customerName, "سارة العتيبي");
  // Telegram never exposes a phone number unless the user shares a contact.
  assert.equal(msg.customerPhone, undefined);
  // message_id is unique per chat only, so it must be chat-qualified.
  assert.equal(msg.externalMessageId, "611223344:47");
});

test("falls back to @username when the customer has no first/last name", () => {
  const [msg] = telegramAdapter.parseWebhook(
    textUpdate({ from: { id: 611_223_344, is_bot: false, username: "sara_o" } })
  );
  assert.equal(msg.customerName, "sara_o");
});

test("non-text updates yield no message instead of throwing", () => {
  // Every one of these is a real Telegram update type that will hit a live
  // bot. Throwing on any of them would return non-2xx, and Telegram retries
  // the SAME update forever — stalling that bot's whole update queue.
  const unhandled: unknown[] = [
    { update_id: 1, edited_message: { message_id: 47, chat: { id: 9 }, text: "معدّلة" } },
    { update_id: 2, callback_query: { id: "cb1", from: { id: 9 }, data: "confirm" } },
    { update_id: 3, message: { message_id: 48, chat: { id: 9 }, new_chat_members: [{ id: 42, is_bot: true }] } },
    { update_id: 4, message: { message_id: 49, chat: { id: 9 }, photo: [{ file_id: "abc" }] } },
    { update_id: 5, my_chat_member: { chat: { id: 9 }, new_chat_member: { status: "kicked" } } },
    { update_id: 6, channel_post: { message_id: 50, chat: { id: -100 }, text: "إعلان" } },
    { update_id: 7, message: { message_id: 51, chat: { id: 9 }, text: "" } }, // empty text is not a message
    { update_id: 8, message: { message_id: 52, text: "بلا محادثة" } }, // malformed: no chat
    {},
    null,
  ];
  for (const payload of unhandled) {
    assert.doesNotThrow(() => telegramAdapter.parseWebhook(payload));
    assert.deepEqual(telegramAdapter.parseWebhook(payload), [], `expected no message for ${JSON.stringify(payload)}`);
  }
});

test("a message from another bot is not treated as a customer", () => {
  const update = textUpdate({
    from: { id: 700, is_bot: true, first_name: "SomeBot" },
  });
  assert.deepEqual(telegramAdapter.parseWebhook(update), []);
});

test("secret-token check accepts the configured token and rejects anything else", () => {
  const secret = "b3f1c0d9e8a74b2f9c1d0e5a6b7c8d9e";
  const rawBody = Buffer.from(JSON.stringify(textUpdate()), "utf8");

  assert.equal(telegramAdapter.verifyWebhookSignature(rawBody, secret, secret), true);
  assert.equal(telegramAdapter.verifyWebhookSignature(rawBody, "b3f1c0d9e8a74b2f9c1d0e5a6b7c8d9f", secret), false);
  // Different length must not throw (timingSafeEqual needs equal buffers).
  assert.equal(telegramAdapter.verifyWebhookSignature(rawBody, "short", secret), false);
  // No header at all — the case an attacker who only knows the URL hits.
  assert.equal(telegramAdapter.verifyWebhookSignature(rawBody, undefined, secret), false);
  // Fail closed: an account with no secret configured accepts nothing,
  // rather than accepting every unauthenticated delivery.
  assert.equal(telegramAdapter.verifyWebhookSignature(rawBody, "", ""), false);
  assert.equal(telegramAdapter.verifyWebhookSignature(rawBody, "anything", ""), false);
});

test("verifyTelegramSecretToken handles non-hex secrets without silently truncating them", () => {
  // Telegram allows A-Z a-z 0-9 _ - in secret_token. Comparing as hex would
  // decode "zz..." to an empty buffer and make unrelated secrets match.
  assert.equal(verifyTelegramSecretToken("maysoor_secret-XYZ", "maysoor_secret-XYZ"), true);
  // Differs from the line above in exactly one character (Z vs q) — that is
  // what makes this assert the comparison, and not just "two unlike strings".
  assert.equal(verifyTelegramSecretToken("maysoor_secret-XYZ", "maysoor_secret-XYq"), false);
});

test("externalAccountId is the bot id — the digits before the colon in the BotFather token", () => {
  assert.equal(telegramBotIdFromToken("7583991204:AAHk9pQz-Lm3xVn0RtYc2Wd4Bf6Gh8Jk1Lm"), "7583991204");
  // A token rotation from BotFather changes only the hash, so the account's
  // externalAccountId (and therefore its webhook URL) stays stable.
  assert.equal(
    telegramBotIdFromToken("7583991204:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    telegramBotIdFromToken("7583991204:AAHk9pQz-Lm3xVn0RtYc2Wd4Bf6Gh8Jk1Lm")
  );
});

test("a malformed bot token is rejected at connect time rather than stored", () => {
  for (const bad of ["", "no-colon-here", ":AAHk9pQz", "abc:AAHk9pQz", "7583991204"]) {
    assert.throws(() => telegramBotIdFromToken(bad), /Invalid Telegram bot token/);
  }
});

test("the adapter is registered under the adapterKey the telegram channel_types row seeds", () => {
  // prisma/seed.ts upserts { key: "telegram", adapterKey: "telegram" };
  // a mismatch here would only surface as a 500 on the first live webhook.
  assert.equal(getAdapter("telegram"), telegramAdapter);
  assert.equal(telegramAdapter.key, "telegram");
});
