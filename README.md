# Telegram Group Collector (GramJS Userbot)

Monitors up to N Telegram groups using your own account and forwards every new message instantly to your private chat.

---

## Setup

### 1. Get API credentials
Go to https://my.telegram.org/apps → create an app → copy **API ID** and **API Hash**.

### 2. Configure environment
```bash
cp .env.example .env
```
Fill in `.env`:
| Variable | Description |
|---|---|
| `API_ID` | From my.telegram.org |
| `API_HASH` | From my.telegram.org |
| `PHONE_NUMBER` | Your number in international format, e.g. `+201234567890` |
| `SOURCE_GROUPS` | Comma-separated group usernames or numeric IDs |
| `ADMIN_USERNAME` | Your Telegram username (without @) or numeric user ID |
| `SESSION_STRING` | Leave blank — filled automatically after first login |

**Group IDs:** If a group has no username, forward any message from it to [@userinfobot](https://t.me/userinfobot) to get its numeric ID (e.g. `-1001234567890`).

### 3. Install dependencies
```bash
npm install
```

### 4. First run (OTP login)
```bash
npm start
```
Telegram will send an OTP to your account. Enter it in the terminal. The session string is saved to `.env` automatically — you won't need to enter it again.

---

## Running in production

### With Docker
```bash
docker-compose up -d
```
The `.env` file is mounted as a volume so the session string persists across container restarts.

### With PM2
```bash
npm run build
pm2 start dist/index.js --name telegram-collector
pm2 save
```

---

## How it works

1. Logs in as your Telegram user account via GramJS (MTProto).
2. Resolves all source groups on startup.
3. Attaches a `NewMessage` event handler that fires on every new message across all chats.
4. Filters to only the configured source groups.
5. Formats the message (group name, sender, timestamp, text) and sends it to your private chat instantly.

---

## Adding / removing groups

Edit `SOURCE_GROUPS` in `.env` and restart the process — no code changes needed.

---

## Notes
- The userbot reads messages **as your account** — make sure you're a member of all source groups.
- Forwarding is text-only by default. Media messages (photos, files) are silently skipped.
- The session string in `.env` is sensitive — keep it private and never commit it to git.
