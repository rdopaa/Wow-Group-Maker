import process from "node:process";
import {
  deleteGroup,
  deleteStatsPanel,
  initDb,
  loadGroups,
  loadStatsPanels,
  saveGroup,
  saveStatsPanel,
} from "./db";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Interaction,
  Message,
  PermissionFlagsBits,
  REST,
  Routes,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  SlashCommandBuilder,
} from "discord.js";

import type { GroupState, RoleKey, SlotAssignment, SlotKey, StatsPanel } from "./db";

const GROUPS = new Map<string, GroupState>();
const STATS_PANELS = new Map<string, StatsPanel>();
const STATS_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const STATS_REFRESH_DEBOUNCE_MS = 5 * 1000;
const statsRefreshTimers = new Map<string, NodeJS.Timeout>();

const ROLE_LABEL: Record<SlotKey, string> = {
  TANK: "🛡️ TANK",
  HEALER: "💚 HEALER",
  DPS1: "⚔️ DPS 1",
  DPS2: "⚔️ DPS 2",
  DPS3: "⚔️ DPS 3",
};

const ROLE_DISPLAY: Record<RoleKey, string> = {
  TANK: "Tank",
  HEALER: "Healer",
  DPS: "DPS",
};

const CLASS_OPTIONS: Record<RoleKey, string[]> = {
  TANK: [
    "Warrior (Protection)",
    "Paladin (Protection)",
    "Druid (Feral)",
  ],
  HEALER: [
    "Priest (Holy/Discipline)",
    "Paladin (Holy)",
    "Druid (Restoration)",
    "Shaman (Restoration)",
  ],
  DPS: [
    "Warrior (Arms/Fury)",
    "Rogue",
    "Mage",
    "Warlock",
    "Hunter",
    "Shaman (Enhancement/Elemental)",
    "Druid (Balance/Feral)",
    "Paladin (Retribution)",
    "Priest (Shadow)",
  ],
};

const CLASS_EMOJI: Record<string, string> = {
  Warrior: "⚔️",
  Paladin: "🛡️",
  Druid: "🌙",
  Priest: "🌟",
  Shaman: "⚡",
  Rogue: "🗡️",
  Mage: "🌀",
  Warlock: "👹",
  Hunter: "🏹",
};

const LEVEL_OPTIONS = Array.from({ length: 21 }, (_, i) => 50 + i);

const CLASS_ROLES: Array<{ id: string; label: string }> = [
  { id: "1468348908173529334", label: "Chaman" },
  { id: "1468348908039311370", label: "Cazador" },
  { id: "1468348906466185495", label: "Picaro" },
  { id: "1468348905556148235", label: "Mago" },
  { id: "1468348905304363141", label: "Paladin" },
  { id: "1468348904406782060", label: "Sacerdote" },
  { id: "1468348903727562784", label: "Brujo" },
  { id: "1468348902745833524", label: "Druida" },
  { id: "1468348896492388453", label: "Guerrero" },
];

const PROFESSION_ROLES: Array<{ id: string; label: string }> = [
  { id: "1468348910807547934", label: "Herreria" },
  { id: "1468350036411945113", label: "Sastreria" },
  { id: "1468350037716111635", label: "Encantamiento" },
  { id: "1468350038785790054", label: "Herboristeria" },
  { id: "1468350039439966350", label: "Joyeria" },
  { id: "1468350040232825126", label: "Alquimia" },
  { id: "1468350040790536242", label: "Ingenieria" },
  { id: "1468350416302375075", label: "Desuello" },
  { id: "1468350416545779805", label: "Mineria" },
  { id: "1468350417401413795", label: "Pesca" },
  { id: "1468350418139484365", label: "Cocina" },
  { id: "1468350627707879537", label: "Inscripcion" },
  { id: "1468350641536630856", label: "Peleteria" },
];

const PENDING_TTL_MS = 15 * 60 * 1000;

function getClassBaseName(name: string): string {
  return name.split(" ")[0];
}

function formatSlotValue(assignment: SlotAssignment | null): string {
  if (!assignment) return "Vacante";
  const base = getClassBaseName(assignment.wowClass);
  const emoji = CLASS_EMOJI[base] ? `${CLASS_EMOJI[base]} ` : "";
  const statusEmoji = assignment.confirmed ? "🟢" : "🔴";
  return `${statusEmoji} ${emoji}<@${assignment.userId}> — ${assignment.wowClass} • Nivel ${assignment.level}`;
}

function getState(messageId: string): GroupState | undefined {
  return GROUPS.get(messageId);
}

function createEmptyState(params: {
  messageId: string;
  channelId: string;
  guildId: string;
  createdByUserId: string;
}): GroupState {
  return {
    messageId: params.messageId,
    channelId: params.channelId,
    guildId: params.guildId,
    createdByUserId: params.createdByUserId,
    slots: {
      TANK: null,
      HEALER: null,
      DPS1: null,
      DPS2: null,
      DPS3: null,
    },
    completed: false,
    locked: false,
    pendingByUser: {},
  };
}

function isUserAlreadyInGroup(state: GroupState, userId: string): boolean {
  return Object.values(state.slots).some((s) => s?.userId === userId);
}

function isGroupComplete(state: GroupState): boolean {
  return (
    state.slots.TANK !== null &&
    state.slots.HEALER !== null &&
    state.slots.DPS1 !== null &&
    state.slots.DPS2 !== null &&
    state.slots.DPS3 !== null
  );
}

function getNextFreeSlot(state: GroupState, role: RoleKey): SlotKey | null {
  if (role === "TANK") return state.slots.TANK ? null : "TANK";
  if (role === "HEALER") return state.slots.HEALER ? null : "HEALER";

  const order: SlotKey[] = ["DPS1", "DPS2", "DPS3"];
  for (const key of order) {
    if (!state.slots[key]) return key;
  }
  return null;
}

function buildEmbed(state: GroupState): EmbedBuilder {
  const status = state.completed
    ? "✅ Grupo completo"
    : state.locked
      ? "🔒 Grupo bloqueado"
      : "⏳ Armándose";

  const filledCount = Object.values(state.slots).filter((slot) => slot).length;

  const creator = state.createdByUserId === "0"
    ? "—"
    : `<@${state.createdByUserId}>`;

  const embed = new EmbedBuilder()
    .setTitle("WoW TBC • Grupo de 5")
    .setColor(state.completed ? 0x22c55e : 0x6366f1)
    .setAuthor({ name: "By Dopita" })
    .setThumbnail("https://imgur.com/pi7ZGF1.png")
    .setDescription(
      "Elegí tu rol con los botones y luego tu clase.\n" +
        "Un jugador por slot.\n",
    )
    .addFields(
      {
        name: ROLE_LABEL.TANK,
        value: formatSlotValue(state.slots.TANK),
        inline: false,
      },
      {
        name: ROLE_LABEL.HEALER,
        value: formatSlotValue(state.slots.HEALER),
        inline: false,
      },
      {
        name: ROLE_LABEL.DPS1,
        value: formatSlotValue(state.slots.DPS1),
        inline: false,
      },
      {
        name: ROLE_LABEL.DPS2,
        value: formatSlotValue(state.slots.DPS2),
        inline: false,
      },
      {
        name: ROLE_LABEL.DPS3,
        value: formatSlotValue(state.slots.DPS3),
        inline: false,
      },
      {
        name: "Creador",
        value: creator,
        inline: true,
      },
      {
        name: "Estado",
        value: status,
        inline: false,
      },
      {
        name: "Jugadores",
        value: `${filledCount}/5`,
        inline: true,
      },
    )
    .setFooter({ text: "World of Warcraft • TBC" })
    .setTimestamp(new Date());

  return embed;
}

function buildButtons(disabled: boolean): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("tbcgrp:role:TANK")
      .setLabel("Tank")
      .setEmoji("🛡️")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId("tbcgrp:role:HEALER")
      .setLabel("Healer")
      .setEmoji("💚")
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId("tbcgrp:role:DPS")
      .setLabel("DPS")
      .setEmoji("⚔️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
  );
}

function buildActionButtons(state: GroupState): ActionRowBuilder<ButtonBuilder> {
  const lockButton = state.locked
    ? new ButtonBuilder()
        .setCustomId("tbcgrp:action:unlock")
        .setLabel("Desbloquear")
        .setEmoji("🔓")
        .setStyle(ButtonStyle.Secondary)
    : new ButtonBuilder()
        .setCustomId("tbcgrp:action:lock")
        .setLabel("Bloquear")
        .setEmoji("🔒")
        .setStyle(ButtonStyle.Secondary);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("tbcgrp:action:leave")
      .setLabel("Salir")
      .setEmoji("🚪")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("tbcgrp:action:confirm")
      .setLabel("Confirmar")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success),
    lockButton,
    new ButtonBuilder()
      .setCustomId("tbcgrp:action:kick")
      .setLabel("Expulsar")
      .setEmoji("🧹")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("tbcgrp:action:delete")
      .setLabel("Borrar grupo")
      .setEmoji("🗑️")
      .setStyle(ButtonStyle.Danger),
  );
}

function buildCreateGroupButton(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("tbcgrp:action:create")
      .setLabel("Crear Grupo")
      .setEmoji("⚔️")
      .setStyle(ButtonStyle.Success),
  );
}

function buildClassSelect(params: {
  messageId: string;
  role: RoleKey;
  disabled: boolean;
}): ActionRowBuilder<StringSelectMenuBuilder> {
  const classes = CLASS_OPTIONS[params.role];

  const select = new StringSelectMenuBuilder()
    .setCustomId(`tbcgrp:class:${params.messageId}:${params.role}`)
    .setPlaceholder(`Elegí tu clase para ${ROLE_DISPLAY[params.role]}`)
    .setMinValues(1)
    .setMaxValues(1)
    .setDisabled(params.disabled)
    .addOptions(
      classes.map((c) => ({
        emoji: CLASS_EMOJI[getClassBaseName(c)],
        label: c,
        value: c,
      })),
    );

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

function buildLevelSelect(params: {
  messageId: string;
  disabled: boolean;
}): ActionRowBuilder<StringSelectMenuBuilder> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`tbcgrp:level:${params.messageId}`)
    .setPlaceholder("Elegí tu nivel (50-70)")
    .setMinValues(1)
    .setMaxValues(1)
    .setDisabled(params.disabled)
    .addOptions(
      LEVEL_OPTIONS.map((level) => ({
        label: `Nivel ${level}`,
        value: String(level),
      })),
    );

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

function buildKickSelect(state: GroupState): ActionRowBuilder<StringSelectMenuBuilder> {
  const options = (Object.keys(state.slots) as SlotKey[])
    .filter((slotKey) => state.slots[slotKey])
    .map((slotKey) => {
      const assignment = state.slots[slotKey]!;
      return {
        label: `${ROLE_LABEL[slotKey]} — ${assignment.userTag}`,
        value: slotKey,
      };
    });

  const select = new StringSelectMenuBuilder()
    .setCustomId(`tbcgrp:kick:${state.messageId}`)
    .setPlaceholder("Elegí a quién expulsar")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options);

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

function buildChannelSelect(userId: string): ActionRowBuilder<ChannelSelectMenuBuilder> {
  const select = new ChannelSelectMenuBuilder()
    .setCustomId(`tbcgrp:channel:${userId}`)
    .setPlaceholder("Elegí el canal para publicar")
    .setMinValues(1)
    .setMaxValues(1)
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

  return new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(select);
}

function buildStatsChannelSelect(userId: string): ActionRowBuilder<ChannelSelectMenuBuilder> {
  const select = new ChannelSelectMenuBuilder()
    .setCustomId(`rolestats:channel:${userId}`)
    .setPlaceholder("Elegí el canal para publicar las estadísticas")
    .setMinValues(1)
    .setMaxValues(1)
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

  return new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(select);
}

async function updateGroupMessage(params: {
  client: Client;
  state: GroupState;
}): Promise<void> {
  try {
    const channel = await params.client.channels.fetch(
      params.state.channelId,
    );
    if (!channel || !channel.isTextBased()) return;

    const msg = await channel.messages.fetch(params.state.messageId);

    const completed = isGroupComplete(params.state);
    params.state.completed = completed;

    const disableJoin = completed || params.state.locked;

    await msg.edit({
      embeds: [buildEmbed(params.state)],
      components: [buildButtons(disableJoin), buildActionButtons(params.state)],
    });
    await saveGroup(params.state);
  } catch {
    // ignore update errors (message deleted or missing permissions)
  }
}

function parseRoleButtonId(customId: string): RoleKey | null {
  const parts = customId.split(":");
  if (parts.length !== 3) return null;
  if (parts[0] !== "tbcgrp" || parts[1] !== "role") return null;
  const role = parts[2] as RoleKey;
  if (role !== "TANK" && role !== "HEALER" && role !== "DPS") return null;
  return role;
}

function isClassSelectId(customId: string): boolean {
  return customId.startsWith("tbcgrp:class:");
}

function isLevelSelectId(customId: string): boolean {
  return customId.startsWith("tbcgrp:level:");
}

function isKickSelectId(customId: string): boolean {
  return customId.startsWith("tbcgrp:kick:");
}

function isChannelSelectId(customId: string): boolean {
  return customId.startsWith("tbcgrp:channel:");
}

function parseClassSelectId(customId: string): {
  messageId: string;
  role: RoleKey;
} | null {
  const parts = customId.split(":");
  if (parts.length !== 4) return null;
  if (parts[0] !== "tbcgrp" || parts[1] !== "class") return null;
  const messageId = parts[2];
  const role = parts[3] as RoleKey;
  if (role !== "TANK" && role !== "HEALER" && role !== "DPS") return null;
  return { messageId, role };
}

function parseLevelSelectId(customId: string): {
  messageId: string;
} | null {
  const parts = customId.split(":");
  if (parts.length !== 3) return null;
  if (parts[0] !== "tbcgrp" || parts[1] !== "level") return null;
  return { messageId: parts[2] };
}

function parseKickSelectId(customId: string): {
  messageId: string;
} | null {
  const parts = customId.split(":");
  if (parts.length !== 3) return null;
  if (parts[0] !== "tbcgrp" || parts[1] !== "kick") return null;
  return { messageId: parts[2] };
}

function parseChannelSelectId(customId: string): {
  userId: string;
} | null {
  const parts = customId.split(":");
  if (parts.length !== 3) return null;
  if (parts[0] !== "tbcgrp" || parts[1] !== "channel") return null;
  return { userId: parts[2] };
}

function parseStatsChannelSelectId(customId: string): {
  userId: string;
} | null {
  const parts = customId.split(":");
  if (parts.length !== 3) return null;
  if (parts[0] !== "rolestats" || parts[1] !== "channel") return null;
  return { userId: parts[2] };
}

async function buildRoleStatsEmbed(guildId: string, client: Client): Promise<EmbedBuilder> {
  const guild = await client.guilds.fetch(guildId);
  try {
    await guild.members.fetch({ withPresences: false, force: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    throw new Error(`members_fetch_failed:${message}`);
  }

  const classCounts: Record<string, number> = {};
  const professionCounts: Record<string, number> = {};

  for (const role of CLASS_ROLES) classCounts[role.id] = 0;
  for (const role of PROFESSION_ROLES) professionCounts[role.id] = 0;

  let classTotal = 0;

  for (const member of guild.members.cache.values()) {
    if (member.user.bot) continue;

    let hasClass = false;
    for (const role of CLASS_ROLES) {
      if (member.roles.cache.has(role.id)) {
        classCounts[role.id] += 1;
        hasClass = true;
      }
    }
    if (hasClass) classTotal += 1;

    for (const role of PROFESSION_ROLES) {
      if (member.roles.cache.has(role.id)) {
        professionCounts[role.id] += 1;
      }
    }
  }

  const classLines = CLASS_ROLES
    .map((role) => `• ${role.label} — **${classCounts[role.id] ?? 0}**`)
    .join("\n");

  const professionLines = PROFESSION_ROLES
    .map((role) => `• ${role.label} — **${professionCounts[role.id] ?? 0}**`)
    .join("\n");

  return new EmbedBuilder()
    .setTitle("WoW • Estadísticas de Roles")
    .setColor(0x38bdf8)
    .setDescription("Conteo en tiempo real de clases y profesiones registradas.")
    .addFields(
      {
        name: "Total de Personajes con Clases",
        value: `**${classTotal}**`,
        inline: false,
      },
      {
        name: "Clases",
        value: classLines || "Sin datos",
        inline: false,
      },
      {
        name: "Profesiones",
        value: professionLines || "Sin datos",
        inline: false,
      },
    )
    .setFooter({ text: "World of Warcraft • Estadísticas" })
    .setTimestamp(new Date());
}

async function refreshStatsPanelsForGuild(
  client: Client,
  guildId: string,
): Promise<void> {
  const panels = Array.from(STATS_PANELS.values()).filter(
    (panel) => panel.guildId === guildId,
  );
  if (!panels.length) return;

  const embed = await buildRoleStatsEmbed(guildId, client);

  for (const panel of panels) {
    try {
      const channel = await client.channels.fetch(panel.channelId);
      if (!channel || !channel.isTextBased()) continue;
      const msg = await channel.messages.fetch(panel.messageId);
      await msg.edit({ embeds: [embed] });
    } catch {
      STATS_PANELS.delete(panel.messageId);
      await deleteStatsPanel(panel.messageId);
    }
  }
}

function scheduleStatsRefresh(client: Client, guildId: string): void {
  if (statsRefreshTimers.has(guildId)) return;
  const timer = setTimeout(async () => {
    statsRefreshTimers.delete(guildId);
    await refreshStatsPanelsForGuild(client, guildId);
  }, STATS_REFRESH_DEBOUNCE_MS);
  statsRefreshTimers.set(guildId, timer);
}

async function handleRoleButton(interaction: Interaction, client: Client) {
  if (!interaction.isButton()) return;
  if (!interaction.message) return;
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: "Este comando solo funciona dentro de un servidor.",
      ephemeral: true,
    });
    return;
  }

  const role = parseRoleButtonId(interaction.customId);
  if (!role) return;

  const state = getState(interaction.message.id);
  if (!state) {
    await interaction.reply({
      content: "Este grupo ya no está disponible.",
      ephemeral: true,
    });
    return;
  }

  if (state.locked) {
    await interaction.reply({
      content: "Este grupo está bloqueado.",
      ephemeral: true,
    });
    return;
  }

  if (state.completed) {
    await interaction.reply({
      content: "Este grupo ya está completo.",
      ephemeral: true,
    });
    return;
  }

  const userId = interaction.user.id;

  if (isUserAlreadyInGroup(state, userId)) {
    await interaction.reply({
      content: "Ya estás anotado en este grupo.",
      ephemeral: true,
    });
    return;
  }

  const freeSlot = getNextFreeSlot(state, role);
  if (!freeSlot) {
    await interaction.reply({
      content: "Ese rol ya está completo en este grupo.",
      ephemeral: true,
    });
    return;
  }

  state.pendingByUser[userId] = {
    role,
    reservedSlot: freeSlot,
    createdAt: Date.now(),
    step: "CLASS",
  };

  await interaction.reply({
    content: "Elegí tu clase:",
    components: [buildClassSelect({ messageId: state.messageId, role, disabled: false })],
    ephemeral: true,
  });

  // Best-effort cleanup of pending if user never selects (15 min)
  setTimeout(() => {
    const s = getState(state.messageId);
    const p = s?.pendingByUser[userId];
    if (s && p && p.createdAt === state.pendingByUser[userId]?.createdAt) {
      delete s.pendingByUser[userId];
    }
  }, PENDING_TTL_MS);

  // no message update yet; only after class selection
  void client;
}

async function handleActionButton(interaction: Interaction, client: Client) {
  if (!interaction.isButton()) return;
  if (!interaction.message) return;

  const parts = interaction.customId.split(":");
  if (parts.length !== 3) return;
  if (parts[0] !== "tbcgrp" || parts[1] !== "action") return;

  const action = parts[2];
  if (action === "create") {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: "Este botón solo funciona dentro de un servidor.",
        ephemeral: true,
      });
      return;
    }

    const channel = await client.channels.fetch(interaction.channelId);
    if (!channel || !channel.isTextBased()) {
      await interaction.reply({
        content: "No se pudo encontrar el canal.",
        ephemeral: true,
      });
      return;
    }

    const payload = buildInitialGroupMessage(interaction.user.id);
    const message = await channel.send(payload);

    const state = createEmptyState({
      messageId: message.id,
      channelId: message.channelId,
      guildId: message.guildId ?? interaction.guildId!,
      createdByUserId: interaction.user.id,
    });

    GROUPS.set(message.id, state);
    await saveGroup(state);

    await interaction.reply({
      content: "Grupo creado.",
      ephemeral: true,
    });
    return;
  }

  const state = getState(interaction.message.id);
  if (!state) {
    await interaction.reply({
      content: "Este grupo ya no está disponible.",
      ephemeral: true,
    });
    return;
  }

  const userId = interaction.user.id;

  if (action === "leave") {
    const slotEntry = (Object.keys(state.slots) as SlotKey[]).find(
      (key) => state.slots[key]?.userId === userId,
    );

    if (!slotEntry) {
      await interaction.reply({
        content: "No estás anotado en este grupo.",
        ephemeral: true,
      });
      return;
    }

    if (state.createdByUserId === userId) {
      try {
        await interaction.message.delete();
      } catch {
        // ignore delete errors
      }
      GROUPS.delete(state.messageId);
      await deleteGroup(state.messageId);
      await interaction.reply({
        content: "Grupo borrado.",
        ephemeral: true,
      });
      return;
    }

    state.slots[slotEntry] = null;
    delete state.pendingByUser[userId];

    await interaction.reply({
      content: "Saliste del grupo.",
      ephemeral: true,
    });

    await updateGroupMessage({ client, state });
    return;
  }

  if (action === "confirm") {
    const slotEntry = (Object.keys(state.slots) as SlotKey[]).find(
      (key) => state.slots[key]?.userId === userId,
    );

    if (!slotEntry) {
      await interaction.reply({
        content: "No estás anotado en este grupo.",
        ephemeral: true,
      });
      return;
    }

    const assignment = state.slots[slotEntry];
    if (!assignment) {
      await interaction.reply({
        content: "No estás anotado en este grupo.",
        ephemeral: true,
      });
      return;
    }

    if (assignment.confirmed) {
      await interaction.reply({
        content: "Ya estás confirmado.",
        ephemeral: true,
      });
      return;
    }

    assignment.confirmed = true;

    await interaction.reply({
      content: "Confirmado. ✅",
      ephemeral: true,
    });

    await updateGroupMessage({ client, state });
    return;
  }

  const isCreator = state.createdByUserId === userId;
  const isAdmin =
    !!interaction.member &&
    typeof interaction.member === "object" &&
    "permissions" in interaction.member &&
    (interaction.member.permissions as any)?.has(PermissionFlagsBits.Administrator);

  if (!isCreator && !isAdmin) {
    await interaction.reply({
      content: "Solo el creador puede usar esta acción.",
      ephemeral: true,
    });
    return;
  }

  if (action === "lock" || action === "unlock") {
    await interaction.deferReply({ ephemeral: true });
    state.locked = action === "lock";
    await updateGroupMessage({ client, state });
    await interaction.editReply({
      content: action === "lock" ? "Grupo bloqueado." : "Grupo desbloqueado.",
    });
    return;
  }

  if (action === "kick") {
    const hasMembers = Object.values(state.slots).some((s) => s);
    if (!hasMembers) {
      await interaction.reply({
        content: "No hay miembros para expulsar.",
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      content: "Elegí a quién expulsar:",
      components: [buildKickSelect(state)],
      ephemeral: true,
    });
    return;
  }

  if (action === "delete") {
    try {
      await interaction.message.delete();
    } catch {
      // ignore delete errors
    }
    GROUPS.delete(state.messageId);
    await deleteGroup(state.messageId);
    await interaction.reply({
      content: "Grupo borrado.",
      ephemeral: true,
    });
    return;
  }
}

async function handleChannelSelect(
  interaction: Interaction,
  client: Client,
) {
  if (!interaction.isChannelSelectMenu()) return;
  const parsed = parseChannelSelectId(interaction.customId);
  if (!parsed) return;

  if (interaction.user.id !== parsed.userId) {
    await interaction.reply({
      content: "Solo quien ejecutó el comando puede elegir el canal.",
      ephemeral: true,
    });
    return;
  }

  const channelId = interaction.values?.[0];
  if (!channelId) {
    await interaction.reply({
      content: "No se pudo leer el canal.",
      ephemeral: true,
    });
    return;
  }

  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) {
    await interaction.reply({
      content: "Canal inválido.",
      ephemeral: true,
    });
    return;
  }

  const infoEmbed = new EmbedBuilder()
    .setTitle("Sistema de LFG • Sons of Liberty")
    .setColor(0x6366f1)
    .setAuthor({ name: "By Dopita" })
    .setImage("https://imgur.com/pi7ZGF1.png")
    .setDescription(
      "Bienvenido al Sistema de LFG de Sons of Liberty.\n" +
        "Para crear grupo para la apertura de TBC o grupo temporal selecciona abajo Crear grupo.",
    );

  await channel.send({
    embeds: [infoEmbed],
    components: [buildCreateGroupButton()],
  });

  await interaction.update({
    content: "Panel de LFG publicado.",
    components: [],
  });
}

async function handleChannelStatsCommand(interaction: Interaction) {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "channelstats") return;

  if (!interaction.inGuild()) {
    await interaction.reply({
      content: "Este comando solo funciona dentro de un servidor.",
      ephemeral: true,
    });
    return;
  }

  const member = interaction.member;
  const isAdmin =
    !!member &&
    typeof member === "object" &&
    "permissions" in member &&
    (member.permissions as any)?.has(PermissionFlagsBits.Administrator);

  if (!isAdmin) {
    await interaction.reply({
      content: "Solo administradores pueden usar este comando.",
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    content: "Seleccioná el canal donde publicar el panel de estadísticas:",
    components: [buildStatsChannelSelect(interaction.user.id)],
    ephemeral: true,
  });
}

async function handleStatsCommand(interaction: Interaction, client: Client) {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "stats") return;

  if (!interaction.inGuild()) {
    await interaction.reply({
      content: "Este comando solo funciona dentro de un servidor.",
      ephemeral: true,
    });
    return;
  }

  const member = interaction.member;
  const isAdmin =
    !!member &&
    typeof member === "object" &&
    "permissions" in member &&
    (member.permissions as any)?.has(PermissionFlagsBits.Administrator);

  if (!isAdmin) {
    await interaction.reply({
      content: "Solo administradores pueden usar este comando.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const embed = await buildRoleStatsEmbed(interaction.guildId!, client);
    const channel = interaction.channel;
    if (!channel || !channel.isTextBased()) {
      await interaction.editReply("No pude acceder a este canal.");
      return;
    }
    const message = await channel.send({ embeds: [embed] });
    const panel: StatsPanel = {
      messageId: message.id,
      channelId: message.channelId,
      guildId: message.guildId ?? interaction.guildId!,
      createdByUserId: interaction.user.id,
    };
    STATS_PANELS.set(message.id, panel);
    await saveStatsPanel(panel);
    await interaction.editReply("Panel de estadísticas publicado.");
  } catch (err) {
    const details = err instanceof Error ? err.message : "Unknown error";
    await interaction.editReply(
      `No pude obtener los miembros. Verificá que el bot tenga el intent de miembros habilitado y reiniciá el bot. (${details})`,
    );
  }
}

async function handleStatsChannelSelect(
  interaction: Interaction,
  client: Client,
) {
  if (!interaction.isChannelSelectMenu()) return;

  const parsed = parseStatsChannelSelectId(interaction.customId);
  if (!parsed) return;

  if (interaction.user.id !== parsed.userId) {
    await interaction.reply({
      content: "Solo el autor puede usar este selector.",
      ephemeral: true,
    });
    return;
  }

  const channelId = interaction.values[0];
  await interaction.deferUpdate();

  try {
    const channel = await interaction.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      await interaction.followUp({
        content: "No pude acceder al canal seleccionado.",
        ephemeral: true,
      });
      return;
    }

    const embed = await buildRoleStatsEmbed(interaction.guildId!, client);
    const message = await channel.send({ embeds: [embed] });
    const panel: StatsPanel = {
      messageId: message.id,
      channelId: message.channelId,
      guildId: message.guildId ?? interaction.guildId!,
      createdByUserId: interaction.user.id,
    };
    STATS_PANELS.set(message.id, panel);
    await saveStatsPanel(panel);

    await interaction.editReply({
      content: "Panel de estadísticas publicado.",
      components: [],
    });
  } catch (err) {
    const details = err instanceof Error ? err.message : "Unknown error";
    await interaction.followUp({
      content:
        `No pude obtener los miembros. Verificá que el bot tenga el intent de miembros habilitado y reiniciá el bot. (${details})`,
      ephemeral: true,
    });
  }
}

async function handleClassSelect(
  interaction: StringSelectMenuInteraction,
  client: Client,
) {
  const parsed = parseClassSelectId(interaction.customId);
  if (!parsed) return;

  const state = getState(parsed.messageId);
  if (!state) {
    await interaction.reply({
      content: "Este grupo ya no está disponible.",
      ephemeral: true,
    });
    return;
  }

  if (state.completed) {
    await interaction.reply({
      content: "Este grupo ya está completo.",
      ephemeral: true,
    });
    return;
  }

  if (state.locked) {
    await interaction.reply({
      content: "Este grupo está bloqueado.",
      ephemeral: true,
    });
    return;
  }

  const userId = interaction.user.id;
  if (isUserAlreadyInGroup(state, userId)) {
    await interaction.reply({
      content: "Ya estás anotado en este grupo.",
      ephemeral: true,
    });
    return;
  }

  const pending = state.pendingByUser[userId];
  if (!pending) {
    await interaction.reply({
      content: "Tu selección expiró. Volvé a elegir un rol con los botones.",
      ephemeral: true,
    });
    return;
  }

  if (pending.step !== "CLASS") {
    await interaction.reply({
      content: "Tu selección expiró. Volvé a elegir un rol con los botones.",
      ephemeral: true,
    });
    return;
  }

  if (pending.role !== parsed.role) {
    await interaction.reply({
      content: "Esa selección no coincide con el rol elegido. Volvé a intentarlo.",
      ephemeral: true,
    });
    return;
  }

  const wowClass = interaction.values?.[0];
  if (!wowClass) {
    await interaction.reply({
      content: "No se pudo leer tu clase. Volvé a intentarlo.",
      ephemeral: true,
    });
    return;
  }

  const allowed = CLASS_OPTIONS[pending.role]?.includes(wowClass);
  if (!allowed) {
    await interaction.reply({
      content: "Clase inválida para ese rol.",
      ephemeral: true,
    });
    return;
  }

  pending.wowClass = wowClass;
  pending.step = "LEVEL";

  await interaction.update({
    content: "Elegí tu nivel (50-70):",
    components: [buildLevelSelect({ messageId: state.messageId, disabled: false })],
  });
}

async function handleLevelSelect(
  interaction: StringSelectMenuInteraction,
  client: Client,
) {
  const parsed = parseLevelSelectId(interaction.customId);
  if (!parsed) return;

  const state = getState(parsed.messageId);
  if (!state) {
    await interaction.reply({
      content: "Este grupo ya no está disponible.",
      ephemeral: true,
    });
    return;
  }

  if (state.locked) {
    await interaction.reply({
      content: "Este grupo está bloqueado.",
      ephemeral: true,
    });
    return;
  }

  const userId = interaction.user.id;
  if (isUserAlreadyInGroup(state, userId)) {
    await interaction.reply({
      content: "Ya estás anotado en este grupo.",
      ephemeral: true,
    });
    return;
  }

  const pending = state.pendingByUser[userId];
  if (!pending || pending.step !== "LEVEL" || !pending.wowClass) {
    await interaction.reply({
      content: "Tu selección expiró. Volvé a elegir un rol.",
      ephemeral: true,
    });
    return;
  }

  const levelValue = interaction.values?.[0];
  const level = Number(levelValue);
  if (!levelValue || Number.isNaN(level) || level < 50 || level > 70) {
    await interaction.reply({
      content: "Nivel inválido. Elegí un nivel entre 50 y 70.",
      ephemeral: true,
    });
    return;
  }

  const slotKey = pending.reservedSlot;

  if (state.slots[slotKey]) {
    delete state.pendingByUser[userId];
    await interaction.reply({
      content: "Ese slot ya fue tomado. Elegí de nuevo.",
      ephemeral: true,
    });
    return;
  }

  state.slots[slotKey] = {
    userId,
    userTag: interaction.user.tag,
    wowClass: pending.wowClass,
    level,
    confirmed: false,
  };

  delete state.pendingByUser[userId];

  await interaction.update({
    content: "Listo. Quedaste anotado.",
    components: [],
  });

  await updateGroupMessage({ client, state });
}

async function handleKickSelect(
  interaction: StringSelectMenuInteraction,
  client: Client,
) {
  const parsed = parseKickSelectId(interaction.customId);
  if (!parsed) return;

  const state = getState(parsed.messageId);
  if (!state) {
    await interaction.reply({
      content: "Este grupo ya no está disponible.",
      ephemeral: true,
    });
    return;
  }

  const userId = interaction.user.id;
  if (state.createdByUserId !== userId) {
    await interaction.reply({
      content: "Solo el creador puede expulsar.",
      ephemeral: true,
    });
    return;
  }

  const slotKey = interaction.values?.[0] as SlotKey | undefined;
  if (!slotKey || !state.slots[slotKey]) {
    await interaction.reply({
      content: "Selección inválida.",
      ephemeral: true,
    });
    return;
  }

  const kickedUserId = state.slots[slotKey]?.userId;
  state.slots[slotKey] = null;
  if (kickedUserId) {
    delete state.pendingByUser[kickedUserId];
  }

  await interaction.update({
    content: "Jugador expulsado.",
    components: [],
  });

  await updateGroupMessage({ client, state });
}

function buildInitialGroupMessage(createdByUserId: string): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const fake: GroupState = {
    messageId: "0",
    channelId: "0",
    guildId: "0",
    createdByUserId,
    slots: { TANK: null, HEALER: null, DPS1: null, DPS2: null, DPS3: null },
    completed: false,
    locked: false,
    pendingByUser: {},
  };

  return {
    embeds: [buildEmbed(fake)],
    components: [buildButtons(false), buildActionButtons(fake)],
  };
}

async function handleCreateGroupCommand(interaction: Interaction) {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "creategroup") return;

  if (!interaction.inGuild()) {
    await interaction.reply({
      content: "Este comando solo funciona dentro de un servidor.",
      ephemeral: true,
    });
    return;
  }

  // Only members with Administrator permission may use it
  const member = interaction.member;
  const isAdmin =
    !!member &&
    typeof member === "object" &&
    "permissions" in member &&
    (member.permissions as any)?.has(PermissionFlagsBits.Administrator);

  if (!isAdmin) {
    await interaction.reply({
      content: "Solo usuarios con permiso de Administrador pueden usar este comando.",
      ephemeral: true,
    });
    return;
  }

  const payload = buildInitialGroupMessage(interaction.user.id);

  const reply = await interaction.reply({
    ...payload,
    fetchReply: true,
  });

  const message = reply as Message;

  const state = createEmptyState({
    messageId: message.id,
    channelId: message.channelId,
    guildId: message.guildId ?? interaction.guildId!,
    createdByUserId: interaction.user.id,
  });

  GROUPS.set(message.id, state);
  await saveGroup(state);
}

async function handleChannelGroupCommand(interaction: Interaction) {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "channelgroup") return;

  if (!interaction.inGuild()) {
    await interaction.reply({
      content: "Este comando solo funciona dentro de un servidor.",
      ephemeral: true,
    });
    return;
  }

  const member = interaction.member;
  const isAdmin =
    !!member &&
    typeof member === "object" &&
    "permissions" in member &&
    (member.permissions as any)?.has(PermissionFlagsBits.Administrator);

  if (!isAdmin) {
    await interaction.reply({
      content: "Solo administradores pueden usar este comando.",
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    content: "Seleccioná el canal donde publicar el panel de LFG:",
    components: [buildChannelSelect(interaction.user.id)],
    ephemeral: true,
  });
}

async function registerSlashCommands(clientId: string) {
  const rest = new REST({ version: "10" }).setToken(
    process.env.DISCORD_BOT_TOKEN!,
  );

  const guildId = process.env.DISCORD_GUILD_ID;

  const commands = [
    new SlashCommandBuilder()
      .setName("creategroup")
      .setDescription("Crea un grupo WoW TBC de 5 jugadores")
      .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages)
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName("channelgroup")
      .setDescription("Publica el panel de LFG en un canal")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName("stats")
      .setDescription("Publica el panel de estadísticas en este canal")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName("channelstats")
      .setDescription("Publica el panel de estadísticas en un canal")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .setDMPermission(false),
  ].map((c) => c.toJSON());

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
      body: commands,
    });
  } else {
    await rest.put(Routes.applicationCommands(clientId), {
      body: commands,
    });
  }
}

export async function startDiscordBot(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error("DISCORD_BOT_TOKEN must be set");
  }

  await initDb();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });

  client.once(Events.ClientReady, async (readyClient: Client<true>) => {
    await registerSlashCommands(readyClient.user.id);
    const persisted = await loadGroups();
    persisted.forEach((state) => {
      GROUPS.set(state.messageId, state);
    });
    for (const state of persisted) {
      await updateGroupMessage({ client, state });
    }

    const statsPanels = await loadStatsPanels();
    statsPanels.forEach((panel) => {
      STATS_PANELS.set(panel.messageId, panel);
    });

    setInterval(async () => {
      const guildIds = new Set(
        Array.from(STATS_PANELS.values()).map((panel) => panel.guildId),
      );
      for (const guildId of guildIds) {
        await refreshStatsPanelsForGuild(client, guildId);
      }
    }, STATS_REFRESH_INTERVAL_MS);
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    try {
      await handleCreateGroupCommand(interaction);
      await handleChannelGroupCommand(interaction);
      await handleStatsCommand(interaction, client);
      await handleChannelStatsCommand(interaction);

      if (interaction.isButton()) {
        await handleActionButton(interaction, client);
        await handleRoleButton(interaction, client);
        return;
      }

      if (interaction.isChannelSelectMenu()) {
        await handleChannelSelect(interaction, client);
        await handleStatsChannelSelect(interaction, client);
        return;
      }

      if (interaction.isStringSelectMenu()) {
        if (isClassSelectId(interaction.customId)) {
          await handleClassSelect(interaction, client);
          return;
        }
        if (isLevelSelectId(interaction.customId)) {
          await handleLevelSelect(interaction, client);
          return;
        }
        if (isKickSelectId(interaction.customId)) {
          await handleKickSelect(interaction, client);
          return;
        }
        return;
      }
    } catch (err) {
      try {
        if (interaction.isRepliable()) {
          const msg = "Ocurrió un error. Probá de nuevo.";
          if (interaction.deferred || interaction.replied) {
            await interaction.followUp({ content: msg, ephemeral: true });
          } else {
            await interaction.reply({ content: msg, ephemeral: true });
          }
        }
      } catch {
        // ignore
      }
      throw err;
    }
  });

  client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
    if (oldMember.guild.id !== newMember.guild.id) return;
    scheduleStatsRefresh(client, newMember.guild.id);
  });

  client.on(Events.GuildMemberRemove, async (member) => {
    scheduleStatsRefresh(client, member.guild.id);
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    scheduleStatsRefresh(client, member.guild.id);
  });

  await client.login(token);
}
