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
const AI_KEY   = process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || "";
const AI_MODEL = process.env.AI_MODEL || "gpt-4o-mini";
const AI_URL   = process.env.AI_API_URL || "";
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
if (!AI_KEY && !process.env.GROQ_API_KEY && !process.env.OPENROUTER_API_KEY && !process.env.CEREBRAS_API_KEY) {
  console.warn("⚠️  No AI key — proposals will be skipped. Set GEMINI_API_KEY / OPENAI_API_KEY / GROQ_API_KEY in .env");
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
- متستخدمش كلمات AI زي: "يسعدني"، "بكل سرور"، "بناءً على ما سبق"، "لا تتردد"، "مع خالص التحيات"، "يشرفني"
- متكررش كلام من إعلان المشروع حرفياً
- خلي فيه طابع شخصي — كأنك بتكلم صاحبك مش بتكتب CV
- اكتب بالعربي فقط — ممنوع أي حرف من لغة تانية

**المحتوى (الزم الترتيب ده):**
1. افهم المشروع وبيّن إنك فاهمه بجملة واحدة تُظهر إنك قرأت التفاصيل فعلاً
2. اذكر تجربة أو مشروع مشابه عملته وإيه النتيجة اللي وصلتلها — مش بس "عملت مشروع مشابه"
3. وضّح خطتك بالظبط — هتعمل إيه وإزاي، مش بس "هساعدك"
4. ابرز مهارة أو نقطة قوة محددة تخليك أحسن من غيرك في المشروع ده
5. اذكر وقت التسليم والسعر بالدولار ($) لو المشروع واضح — لو مش واضح قول "السعر يتحدد بعد معرفة التفاصيل"
6. اختم بجملة تحفّز صاحب المشروع يردّ عليك — مش مجرد "تواصل معي"

**مهاراتك (استخدم اللي يناسب المشروع بس):**
- باك إند: Node.js, NestJS, Express, MongoDB, Redis, Docker, AWS S3, Socket.IO, TypeScript — وعندك تجربة على نظام ERP شغال عند عميل فعلي
- فيديو وجرافيك: مونتاج احترافي، موشن جرافيك، تصميم بوستات وهوية بصرية
- فرونت إند: HTML, CSS, JavaScript — لاندينج بيجز وصفحات بسيطة

**قاعدة اختيار المهارة:**
- مشروع برمجة أو API أو سيستم → الباك إند والتقني
- مشروع فيديو أو مونتاج أو موشن → الكريتيف
- مشروع تصميم أو هوية بصرية → الجرافيك
- مشروع موقع بسيط أو لاندينج → الفرونت إند
- مشروع مختلط → اجمع اللي يناسب بس، متذكرش كل حاجة

**ممنوع:**
- تنهيش العرض بجملة واحدة بدون تفاصيل
- تكتب "جاهز أساعدك" أو "مستعد أتواصل" بدون ما تقول هتعمل إيه بالظبط
- تبدأ كل جملة بـ "و" أو "كمان"
- تكرر نفس فكرة في جملتين مختلفتين
- الأسعار بالجنيه — دايماً بالدولار ($)
- تستخدم "أسعارنا" أو "نبدأ" — أنت مستقل مش شركة

**الطول:** 6 إلى 9 جمل بالظبط — مش أقل ومش أكتر.

اكتب العرض فقط. بدون مقدمة، بدون شرح، بدون علامات markdown.`;
// ─── AI provider fallback chain ──────────────────────────────────────────────

interface AiProvider {
  name: string;
  key: string;
  model: string;
  url: string;
  isGemini: boolean;
}

function buildProviders(): AiProvider[] {
  const list: AiProvider[] = [];

  // Primary key (GEMINI_API_KEY or OPENAI_API_KEY) — tried first
  if (AI_KEY) {
    const isGemini = AI_KEY.startsWith("AIza");
    list.push({
      name: isGemini ? "Gemini" : "OpenAI",
      key: AI_KEY,
      model: AI_MODEL,
      url: AI_URL || (isGemini
        ? `https://generativelanguage.googleapis.com/v1beta/models/${AI_MODEL}:generateContent?key=${AI_KEY}`
        : "https://api.openai.com/v1/chat/completions"),
      isGemini,
    });
  }

  // Fallback providers (each with independent rate limits)
  const fallbacks: { name: string; key: string; model: string; url: string }[] = [
    { name: "Groq",      key: process.env.GROQ_API_KEY || "",      model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",  url: process.env.GROQ_URL || "https://api.groq.com/openai/v1/chat/completions" },
    { name: "OpenRouter",key: process.env.OPENROUTER_API_KEY || "", model: process.env.OPENROUTER_MODEL || "qwen/qwq-32b",      url: process.env.OPENROUTER_URL || "https://openrouter.ai/api/v1/chat/completions" },
    { name: "Cerebras",  key: process.env.CEREBRAS_API_KEY || "",   model: process.env.CEREBRAS_MODEL || "llama3.1-8b",         url: process.env.CEREBRAS_URL || "https://api.cerebras.ai/v1/chat/completions" },
  ];

  for (const fb of fallbacks) {
    if (!fb.key) continue;
    if (fb.key === AI_KEY) continue; // skip if same key as primary
    list.push({ ...fb, isGemini: false });
  }

  return list;
}

async function callProvider(p: AiProvider, jobText: string): Promise<string> {
  const headers: any = { "Content-Type": "application/json" };
  if (!p.isGemini) headers["Authorization"] = `Bearer ${p.key}`;

  const body = p.isGemini
    ? {
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ parts: [{ text: `إعلان المشروع:\n${jobText}` }] }],
        generationConfig: { maxOutputTokens: 1024, temperature: 0.7 },
      }
    : {
        model: p.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `إعلان المشروع:\n${jobText}` },
        ],
        max_tokens: 1024,
        temperature: 0.7,
      };

  const res = await fetch(p.url, { method: "POST", headers, body: JSON.stringify(body) });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`${p.name} error ${res.status}: ${err}`);
  }

  const data = await res.json() as any;
  if (p.isGemini) {
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "⚠️ لم يتم توليد عرض.";
  }
  return data.choices?.[0]?.message?.content?.trim() || "⚠️ لم يتم توليد عرض.";
}

async function generateProposal(jobText: string): Promise<string> {
  const providers = buildProviders();
  if (providers.length === 0) return "";

  for (const p of providers) {
    try {
      const result = await callProvider(p, jobText);
      console.log(`✅  Proposal from ${p.name} (${p.model})`);
      return result;
    } catch (err) {
      console.warn(`⚠️  ${p.name} failed → ${(err as Error).message}`);
    }
  }

  return "⚠️ جميع مزودي AI فشلوا.";
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
  const providers = buildProviders();
  const providerList = providers.map(p => p.name).join(" → ");
  console.log(`🤖  AI providers: ${providerList}\n`);

  console.log(`👁️  Watched IDs: ${[...watchedIds].map(id => id.toString()).join(", ")}`);

  // ─── Track last seen message ID per group (dedup) ────────────────────

  const lastMsgId = new Map<string, number>();
  for (const entry of groupMap.values()) {
    try {
      const msgs = await client.getMessages(entry.id.toString(), { limit: 1 });
      if (msgs.length > 0) lastMsgId.set(entry.id.toString(), msgs[0].id);
    } catch (_) {}
  }

  async function handleMessage(text: string, chatId: bigint, msgId: number, source: string) {
    const key = chatId.toString();
    const entry = [...groupMap.values()].find((g) => g.id === chatId);
    if (!entry) return;
    if (msgId <= (lastMsgId.get(key) ?? 0)) return;
    lastMsgId.set(key, msgId);

    console.log(`📨  [${source}] ${entry.title}`);

    let sender = "Unknown";
    try {
      const e = await client.getEntity(key);
      sender = (e as any).title || (e as any).username || "Unknown";
    } catch (_) {}

    const jobMsg = formatJobMessage(entry.title, sender, text, new Date());
    const buttons = entry.link ? [{ text: "🔗 فتح في المجموعة", url: entry.link }] : undefined;
    try {
      await sendToAdmin(jobMsg, "markdown", buttons);
    } catch (err) {
      console.error("Send failed:", (err as Error).message);
      return;
    }

    if (providers.length > 0) {
      console.log(`⚙️  Generating proposal...`);
      try {
        const p = await generateProposal(text);
        if (p) await sendToAdmin(formatProposal(p));
      } catch (err) {
        console.error("Proposal failed:", (err as Error).message);
        await sendToAdmin("⚠️ *فشل توليد العرض*");
      }
    }
  }

  // ─── Event handler (catches supergroups where updates arrive) ────────

  client.addEventHandler(async (event: NewMessageEvent) => {
    const msg = event.message;
    if (!msg?.text) return;
    const chatId = BigInt(msg.chatId?.toString() ?? "0");
    if (!watchedIds.has(chatId)) return;
    await handleMessage(msg.text, chatId, msg.id, "Event");
  }, new NewMessage({}));

  // ─── Polling (catches broadcast channels where updates are silent) ────

  setInterval(async () => {
    for (const entry of groupMap.values()) {
      try {
        const msgs = await client.getMessages(entry.id.toString(), { limit: 3 });
        for (const msg of msgs) {
          if (!msg?.text) continue;
          await handleMessage(msg.text, entry.id, msg.id, "Poll");
        }
      } catch (_) {}
    }
  }, 30_000);

  console.log("📡  Listening + polling every 30s... (Ctrl+C to stop)\n");
  await new Promise(() => {});
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
