# ☢️ Berkayprof's Discord Nuke Bot

A Discord bot that wipes one or more servers and rebuilds them from scratch: channels, roles, emojis, stickers, soundboard sounds, automod rules, invites, scheduled events and integrations are deleted, after which a clean category with empty channels and spam messages is put back.

> **Disclaimer:** This bot modifies Discord servers into a unrestorable state. All channels, roles and more will be deleted. You may exclusivly use this bot on servers that you own or have explicit permission to use it on.
---

## What the bot does

Per target server, in this order:

1. **Precheck** — verifies its own membership and the four required permissions. If anything is missing, that server is skipped with an error.
2. **Harden its own role** — grants itself any missing permissions (including `ManageRoles`, `ManageChannels`, `ManageMessages`) so the run can't break halfway through.
3. **Server settings** — verification level to highest, explicit content filter to "all members", notifications to "mentions only", AFK channel, system channel and rules channel cleared, locale `en-US`.
4. **Cleanup** — invites, emojis, stickers, soundboard sounds, automod rules, scheduled events, and integrations belonging to other applications (its own integration is never deleted).
5. **Delete roles** — every deletable role, highest to lowest. Roles above the bot and managed roles (bot roles, boosts) remain.
6. **Delete channels** — all channels.
7. **Rebuild** — server name, icon and banner cleared, category `CATEGORY_NAME` created, `CHANNEL_COUNT` text channels inside it, first channel set as system channel.
8. **Spam** — `MESSAGES_PER_CHANNEL` messages per channel, with mentions enabled.
9. **Reset `@everyone`** to `ViewChannel` + `ReadMessageHistory`.
10. **Optional** — leave the server if `AUTO_LEAVE=true`.

Every step uses retries with exponential backoff on HTTP 429 and 5xx. Other errors are counted and logged but don't stop the run.

---

## Requirements

- **Node.js 18+** (20 LTS recommended)
- A Discord application with a bot token
- **Privileged intents** enabled in the Developer Portal:
  - `SERVER MEMBERS INTENT`
  - `MESSAGE CONTENT INTENT`
- The bot must have the **highest role** in every target server (or be the guild owner), otherwise top roles will be left behind
- DMs from server members must be open — the bot sends status updates to the owner

### Required permissions

```
Manage Roles
Manage Channels
Manage Emojis and Stickers
Manage Guild
View Channels
Send Messages
Read Message History
Manage Messages

```

Or just use `Administrator` (permission `8`) — that covers everything, including future steps.

---

## Installation

```bash
git clone https://github.com/berkayprof/nukebot.git
cd nukebot
npm install
cp .env.example .env
```

Fill in `.env` (see below) and start:

```bash
npm start
```

The bot logs in, registers the slash commands globally, and DMs the owner that it's online. If a `nuke-state.json` is found, that DM warns that an interrupted run is waiting.

---

## Configuration

All settings via `.env`. See `.env.example` for the full list with explanations.

| Variable | Default | Meaning |
|---|---|---|
| `DISCORD_TOKEN` | — | **Required.** Bot token. |
| `OWNER_ID` | `12345678912345679` | **Required in practice.** Discord user ID of the only person allowed to run commands and receive DMs. |
| `CATEGORY_NAME` | `Nuked Server` | Name of the new category. |
| `CHANNEL_BASE_NAME` | `nuked` | Prefix for new channels (`nuked-1`, `nuked-2`, …). |
| `CHANNEL_COUNT` | `50` | Channels per server. Discord caps a guild at 500 channels. |
| `MESSAGES_PER_CHANNEL` | `100` | Default spam messages per channel, clamped to 1–500. |
| `MESSAGE_TEXT` | nuke message | Content of every spam message. |
| `NEW_SERVER_NAME` | `This server has been nuked!` | New server name, truncated to 100 characters. |
| `SKIP_GUILDS` | empty | Comma-separated guild IDs to leave alone. |
| `SKIP_OTHER_BOT_INTEGRATIONS` | `true` | Skips integrations belonging to other bots. |
| `AUTO_LEAVE` | `false` | Leaves the server ~1.5 s after finishing. |
| `GUILD_CONCURRENCY` | `2` | Number of servers processed concurrently. |
| `CONFIRM_TTL_MS` | `300000` | Validity of the confirmation prompt (5 minutes). |
| `STATE_FILE` | `nuke-state.json` | Path to the progress file. |

Values are validated: invalid numbers fall back to the default, and `MESSAGES_PER_CHANNEL` is always clamped to 1–500.

---

## Usage

Only `OWNER_ID` gets through the check. Anyone else gets "Not for you." Everything the bot replies is ephemeral or sent via DM.

### Prefix commands

| Command | Effect |
|---|---|
| `!nuke help` | Overview of all commands. |
| `!nuke status` | Progress of a running job, or info about an interrupted run. |
| `!nuke` | Nukes the current server with the default message count. |
| `!nuke 250` | Same, with 250 messages per channel. |
| `!nuke all` | Starts the confirmation flow for all servers outside the blacklist. |
| `!confirm` | Confirms `!nuke all`. |
| `!abort` | Stops the run once the current servers finish. |
| `!nuke resume` | Resumes an interrupted run. |
| `!nuke force` | Clears a stuck state. |

### Slash commands

`/nuke server`, `/nuke all`, `/nuke status`, `/nuke abort`, `/nuke resume`, `/nuke force` — with an optional `messages` option (1–500).

### Confirmation

`!nuke all` and `/nuke all` don't nuke immediately. The bot shows the list of target servers and skipped servers plus two buttons (**Nuke all** / **Cancel**), and sends the same prompt via DM. Confirm via the button or with `!confirm`, within `CONFIRM_TTL_MS`. After that the buttons expire.

`!nuke` on a single server needs no confirmation.

---

## State and recovery

Progress is written to `STATE_FILE` after every server. After a crash, restart or `!abort`, that file stays behind and blocks new `!nuke` runs until you choose:

- `!nuke resume` — continues with the remaining servers
- `!nuke force` — throws the state away

After a fully successful run the file is deleted automatically. After an `!abort` it stays.

---

## Logging

To console and `logs/nuke.log`. At 5 MB the file rotates (`.1`, `.2`, `.3`; the oldest drops off). Logged events include: startup, per-server start/end, skipped roles, retries, rate limits, failed steps, and the bot being removed from a server (`guildDelete`).

Besides the log, the owner gets a final report via DM: success/failure counts, error totals per category, and the list of failed servers.

---

## Project structure

```
.
├── index.js          # entire bot
├── .env              # secrets (do not commit)
├── .env.example      # sample configuration
├── nuke-state.json   # only during/after an interrupted run
└── logs/nuke.log     # run log with rotation
```

---

## Limitations and pitfalls

- **No undo.** Back up your role and channel structure beforehand.
- Roles positioned above the bot role, and managed roles, are not deleted.
- Its own integration is never deleted — otherwise the bot would kick itself.
- At 500+ channels creation fails; keep an eye on `CHANNEL_COUNT` plus existing channels.
- Many messages × many channels × many servers can hit rate limits. Only raise `GUILD_CONCURRENCY` if you want to push the API limits harder.
- The bot uses global slash commands; those can take up to an hour to appear.
- With `AUTO_LEAVE=true` the bot is gone from the server after the run — handy for one-off cleanups, awkward if you want to stick around afterwards.

---

## License

MIT
