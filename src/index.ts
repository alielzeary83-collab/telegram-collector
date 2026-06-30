import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage, NewMessageEvent } from "telegram/events";
import { Api } from "telegram/tl";
import * as input from "input";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";

dotenv.config();

// ─── Config ────────────────────────────────────────────────────────────────

const API_ID          = parseInt(process.env.API_ID || "0", 10);
const API_HASH        = process.env.API_HASH || "";
const PHONE_NUMBER    = process.env.PHONE_NUMBER || "";
const ADMIN           = process.env.ADMIN_USERNAME || "";
const AI_KEY   = process.env.GROQ_API_KEY || process.env.NVIDIA_API_KEY || process.env.OPENROUTER_API_KEY || "";
const AI_MODEL = process.env.AI_MODEL || "llama-3.3-70b-versatile";
const ENV_PATH        = path.resolve(__dirname, "../.env");

const PROXY_IP        = process.env.PROXY_IP || "";
const PROXY_PORT      = parseInt(process.env.PROXY_PORT || "0", 10);
const PROXY_TYPE      = process.env.PROXY_TYPE || "socks5";
const PROXY_SECRET    = process.env.PROXY_SECRET || "";
const BOT_TOKEN       = process.env.BOT_TOKEN || "";
const BOT_CHAT_ID     = process.env.BOT_CHAT_ID || ADMIN;

const SOURCE_GROUPS: string[] = (process.env.SOURCE_GROUPS || "")
  .split(",")
  .map((g) => g.trim())
  .filter(Boolean);

if (!API_ID || !API_HASH || !PHONE_NUMBER || !ADMIN || SOURCE_GROUPS.length === 0) {
  console.error("❌  Missing required env vars. Copy .env.example → .env and fill it in.");
  process.exit(1);
}
if (!AI_KEY) {
  console.error("❌  GROQ_API_KEY (or NVIDIA_API_KEY / OPENROUTER_API_KEY) is missing from .env");
  process.exit(1);
}

// ─── Session helpers ────────────────────────────────────────────────────────

function loadSession(): string {
  return process.env.SESSION_STRING || "";
}

function saveSession(sessionString: string): void {
  if (!fs.existsSync(ENV_PATH)) return;
  let content = fs.readFileSync(ENV_PATH, "utf-8");
  if (content.includes("SESSION_STRING=")) {
    content = content.replace(/SESSION_STRING=.*/m, `SESSION_STRING=${sessionString}`);
  } else {
    content += `\nSESSION_STRING=${sessionString}`;
  }
  fs.writeFileSync(ENV_PATH, content, "utf-8");
  console.log("✅  Session saved to .env — future starts won't need the OTP.");
}

// ─── Group resolution ───────────────────────────────────────────────────────

async function resolveGroups(
  client: TelegramClient
): Promise<Map<string, { id: bigint; title: string; link: string }>> {
  const map = new Map<string, { id: bigint; title: string; link: string }>();
  for (const raw of SOURCE_GROUPS) {
    try {
      const entity    = await client.getEntity(raw);
      const rawId     = BigInt((entity as any).id?.toString() ?? "0");
      const isChannel = entity instanceof Api.Channel;
      const id        = isChannel ? BigInt(`-100${rawId}`) : rawId;
      const title     = (entity as any).title || (entity as any).username || raw;
      const username  = (entity as any).username;
      const link      = username ? `https://t.me/${username}` : "";
      map.set(raw, { id, title, link });
      console.log(`✅  Watching: "${title}" (${id})`);
    } catch (err) {
      console.warn(`⚠️  Could not resolve group "${raw}": ${(err as Error).message}`);
    }
  }
  return map;
}

// ─── Admin entity ───────────────────────────────────────────────────────────

async function getAdminEntity(client: TelegramClient): Promise<any> {
  try {
    return await client.getEntity(ADMIN);
  } catch (err) {
    console.error(`❌  Could not resolve admin "${ADMIN}": ${(err as Error).message}`);
    process.exit(1);
  }
}

// ─── Message formatting ─────────────────────────────────────────────────────

function formatJobMessage(groupTitle: string, sender: string, text: string, date: Date): string {
  const time    = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const dateStr = date.toLocaleDateString("en-GB");
  return (
    `📋 *عرض عمل جديد*\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `🏠 *المجموعة:* ${groupTitle}\n` +
    `👤 *من:* ${sender}\n` +
    `🕐 *الوقت:* ${dateStr} ${time}\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `${text}`
  );
}

function formatProposal(proposal: string): string {
  return (
    `💬 *مقترح الرد المقترح:*\n` +
    `─────────────────────\n` +
    `${proposal}\n` +
    `─────────────────────`
  );
}

// ─── OpenRouter proposal generation ─────────────────────────────────────────

const SYSTEM_PROMPT = `أنت علي، مستقل مصري بتقدم على مشاريع على نافذلي وخمسات ومستقل.

مهمتك: اكتب عرضاً للمشروع اللي هيتبعتلك بالضبط زي ما يكتبه إنسان حقيقي، مش AI.

**أسلوب الكتابة:**
- اكتب بعربي عامي مصري خفيف مش فصحى رسمية جامدة
- الجمل قصيرة ومباشرة، زي كلام واتساب مش خطاب رسمي
- متبدأش بـ "أنا" في أول الجملة — ابدأ بالفعل أو بالتحية مباشرة
- متستخدمش كلمات AI زي: "يسعدني"، "بكل سرور"، "بناءً على ما سبق"، "لا تتردد"، "مع خالص التحيات"
- متكررش كلام من إعلان المشروع حرفياً
- خلي فيه طابع شخصي — كأنك بتكلم صاحبك مش بتكتب CV

**المحتوى:**
- افهم المشروع وبيّن إنك فاهمه بجملة واحدة مباشرة
- اذكر تجربة أو مشروع مشابه عملته فعلاً (حسب نوع المشروع)
- قول إيه اللي هتعمله بالظبط، مش بس "هقدر أساعدك"
- اذكر سعر أو وقت تسليم تقريبي لو المشروع واضح
- اختم بجملة واحدة بسيطة للتواصل

**مهاراتك (استخدم اللي يناسب المشروع بس):**
- باك إند: Node.js, NestJS, Express, MongoDB, Redis, Docker, AWS S3, Socket.IO, TypeScript — وعندك تجربة على نظام ERP حقيقي شغال عند عميل
- فيديو وجرافيك: مونتاج احترافي، موشن جرافيك، تصميم بوستات وهوية بصرية
- فرونت إند: HTML, CSS, JavaScript — لاندينج بيجز وصفحات بسيطة

**قاعدة اختيار المهارة:**
- مشروع برمجة أو API أو سيستم → الباك إند والتقني
- مشروع فيديو أو مونتاج أو موشن → الكريتيف
- مشروع تصميم أو هوية بصرية → الجرافيك
- مشروع موقع بسيط أو لاندينج → الفرونت إند
- مشروع مختلط → اجمع اللي يناسب بس، متذكرش كل حاجة

**الطول:** 4 إلى 6 جمل بالظبط — مش أقل ومش أكتر.

اكتب العرض فقط. بدون مقدمة، بدون شرح، بدون علامات markdown.`;
async function generateProposal(jobText: string): Promise<string> {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${AI_KEY}`,
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: `إعلان المشروع:\n${jobText}` },
      ],
      max_tokens: 1024,
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`AI API error ${response.status}: ${err}`);
  }

  const data = await response.json() as any;
  return data.choices?.[0]?.message?.content?.trim() || "⚠️ لم يتم توليد عرض.";
}

// ─── Send helper (Bot API if token available, else GramJS) ──────────────────

const BOT_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : null;

async function sendToAdmin(text: string, parseMode: "markdown" | "html" = "markdown", buttons?: { text: string; url: string }[]) {
  if (BOT_API) {
    const body: any = { chat_id: BOT_CHAT_ID, text, parse_mode: parseMode };
    if (buttons?.length) {
      body.reply_markup = { inline_keyboard: buttons.map((b) => [{ text: b.text, url: b.url }]) };
    }
    const res = await fetch(`${BOT_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Bot API error ${res.status}: ${err}`);
    }
    return;
  }
  // Fallback: use GramJS — adminEntity must be resolved before calling this
  if (!adminEntity) throw new Error("adminEntity not resolved");
  await client.sendMessage(adminEntity, { message: text, parseMode });
}

let client: TelegramClient;
let adminEntity: any;

// ─── Health server (required by PaaS web services) ─────────────────────────

const PORT = parseInt(process.env.PORT || "8080", 10);
http.createServer((_, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ok");
}).listen(PORT, () => {
  console.log(`❤️  Health server listening on port ${PORT}`);
});

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const sessionString = loadSession();
  const session       = new StringSession(sessionString);

  const proxy: any = PROXY_IP && PROXY_PORT
    ? PROXY_TYPE === "mtproto"
      ? { ip: PROXY_IP, port: PROXY_PORT, MTProxy: true, secret: PROXY_SECRET }
      : { ip: PROXY_IP, port: PROXY_PORT, socksType: PROXY_TYPE === "socks4" ? 4 : 5 }
    : undefined;

  client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 5,
    proxy,
  });

  if (proxy) console.log(`🔌  Using ${PROXY_TYPE === "mtproto" ? "MTProto" : "SOCKS" + (PROXY_TYPE === "socks4" ? "4" : "5")} proxy: ${PROXY_IP}:${PROXY_PORT}`);

  await client.start({
    phoneNumber: async () => PHONE_NUMBER,
    password:    async () => await input.text("2FA password (leave blank if none): "),
    phoneCode:   async () => await input.text("Enter the OTP Telegram sent you: "),
    onError:     (err) => console.error("Login error:", err),
  });

  console.log("\n🚀  Logged in successfully!");

  const currentSession = (client.session as StringSession).save();
  if (currentSession && currentSession !== sessionString) {
    saveSession(currentSession);
  }

  const groupMap = await resolveGroups(client);
  if (!BOT_API) {
    adminEntity = await getAdminEntity(client);
  }
  const watchedIds = new Set([...groupMap.values()].map((g) => g.id));

  console.log(`\n👀  Monitoring ${groupMap.size} group(s) → forwarding to ${ADMIN}`);
  console.log(`🤖  Proposals via Groq (${AI_MODEL})\n`);

  console.log(`👁️  Watched IDs: ${[...watchedIds].map(id => id.toString()).join(", ")}`);

  client.addEventHandler(async (event: NewMessageEvent) => {
    const message = event.message;
    const rawChatId = message.chatId?.toString() ?? "undefined";
    if (!message?.text) {
      console.log(`⏭️  Skipped (no text) — chatId=${rawChatId}`);
      return;
    }

    const chatId = BigInt(rawChatId);
    console.log(`📨  Message received — chatId=${rawChatId}, inWatchedSet=${watchedIds.has(chatId)}`);
    if (!watchedIds.has(chatId)) return;

    const groupEntry = [...groupMap.values()].find((g) => g.id === chatId);
    if (!groupEntry) return;

    // Get sender name
    let sender = "Unknown";
    try {
      const senderEntity = await client.getEntity(message.senderId!);
      const u = senderEntity as any;
      sender = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || u.title || "Unknown";
    } catch (_) {}

    const date = new Date((message.date ?? 0) * 1000);

    // 1. Send the job message
    const jobFormatted = formatJobMessage(groupEntry.title, sender, message.text, date);
    try {
      const buttons = groupEntry.link ? [{ text: "🔗 فتح في المجموعة", url: groupEntry.link }] : undefined;
      await sendToAdmin(jobFormatted, "markdown", buttons);
    } catch (err) {
      console.error("Failed to send job message:", (err as Error).message);
      return;
    }

    // 2. Generate and send proposal
    console.log(`⚙️  Generating proposal for message from "${groupEntry.title}"...`);
    try {
      const proposal          = await generateProposal(message.text);
      const proposalFormatted = formatProposal(proposal);
      await sendToAdmin(proposalFormatted);
      console.log(`✅  Proposal sent.`);
    } catch (err) {
      console.error("Failed to generate/send proposal:", (err as Error).message);
      await sendToAdmin("⚠️ *فشل توليد العرض* — تحقق من مفتاح API.");
    }
  }, new NewMessage({}));

  console.log("📡  Listening for new messages... (Ctrl+C to stop)\n");
  await new Promise(() => {});
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
