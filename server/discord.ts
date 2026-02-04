import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
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

type RoleKey = "TANK" | "HEALER" | "DPS";

type SlotKey = "TANK" | "HEALER" | "DPS1" | "DPS2" | "DPS3";

type SlotAssignment = {
  userId: string;
  userTag: string;
  wowClass: string;
};

type GroupState = {
  messageId: string;
  channelId: string;
  guildId: string;
  createdByUserId: string;
  slots: Record<SlotKey, SlotAssignment | null>;
  completed: boolean;
  pendingByUser: Record<
    string,
    {
      role: RoleKey;
      reservedSlot: SlotKey;
      createdAt: number;
    }
  >;
};

const GROUPS = new Map<string, GroupState>();

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
  Druid: "🐻",
  Priest: "✨",
  Shaman: "⚡",
  Rogue: "🗡️",
  Mage: "🪄",
  Warlock: "💀",
  Hunter: "🏹",
};

const PENDING_TTL_MS = 15 * 60 * 1000;

function getClassBaseName(name: string): string {
  return name.split(" ")[0];
}

function formatSlotValue(assignment: SlotAssignment | null): string {
  if (!assignment) return "Vacante";
  const base = getClassBaseName(assignment.wowClass);
  const emoji = CLASS_EMOJI[base] ? `${CLASS_EMOJI[base]} ` : "";
  return `${emoji}<@${assignment.userId}> — ${assignment.wowClass}`;
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
    : "⏳ Armándose";

  const creator = state.createdByUserId === "0"
    ? "—"
    : `<@${state.createdByUserId}>`;

  const embed = new EmbedBuilder()
    .setTitle("WoW TBC • Grupo de 5")
    .setColor(state.completed ? 0x22c55e : 0x6366f1)
    .setAuthor({ name: "By Dopita" })
    .setDescription(
      "Elegí tu rol con los botones y luego tu clase.\n" +
        "Un jugador por slot.\n",
    )
    .addFields(
      {
        name: ROLE_LABEL.TANK,
        value: formatSlotValue(state.slots.TANK),
        inline: true,
      },
      {
        name: ROLE_LABEL.HEALER,
        value: formatSlotValue(state.slots.HEALER),
        inline: true,
      },
      {
        name: ROLE_LABEL.DPS1,
        value: formatSlotValue(state.slots.DPS1),
        inline: true,
      },
      {
        name: ROLE_LABEL.DPS2,
        value: formatSlotValue(state.slots.DPS2),
        inline: true,
      },
      {
        name: ROLE_LABEL.DPS3,
        value: formatSlotValue(state.slots.DPS3),
        inline: true,
      },
      {
        name: "Cómo unirse",
        value: "1️⃣ Elegí rol\n2️⃣ Elegí clase\n3️⃣ Listo",
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

    await msg.edit({
      embeds: [buildEmbed(params.state)],
      components: [buildButtons(completed)],
    });
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

  const slotKey = pending.reservedSlot;

  // Re-check slot availability
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
    wowClass,
  };

  delete state.pendingByUser[userId];

  await interaction.update({
    content: "Listo. Quedaste anotado.",
    components: [],
  });

  await updateGroupMessage({ client, state });
}

function buildInitialGroupMessage(): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const fake: GroupState = {
    messageId: "0",
    channelId: "0",
    guildId: "0",
    createdByUserId: "0",
    slots: { TANK: null, HEALER: null, DPS1: null, DPS2: null, DPS3: null },
    completed: false,
    pendingByUser: {},
  };

  return {
    embeds: [buildEmbed(fake)],
    components: [buildButtons(false)],
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

  const payload = buildInitialGroupMessage();

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
}

async function registerSlashCommands(clientId: string) {
  const rest = new REST({ version: "10" }).setToken(
    process.env.DISCORD_BOT_TOKEN!,
  );

  const commands = [
    new SlashCommandBuilder()
      .setName("creategroup")
      .setDescription("Crea un grupo WoW TBC de 5 jugadores")
      .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages)
      .setDMPermission(false),
  ].map((c) => c.toJSON());

  await rest.put(Routes.applicationCommands(clientId), {
    body: commands,
  });
}

export async function startDiscordBot(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error("DISCORD_BOT_TOKEN must be set");
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  client.once(Events.ClientReady, async (readyClient) => {
    await registerSlashCommands(readyClient.user.id);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      await handleCreateGroupCommand(interaction);

      if (interaction.isButton()) {
        await handleRoleButton(interaction, client);
        return;
      }

      if (interaction.isStringSelectMenu()) {
        if (!isClassSelectId(interaction.customId)) return;
        await handleClassSelect(interaction, client);
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

  await client.login(token);
}
