import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import { Pool } from "pg";
import { groups, groupSlots, statsPanels } from "@shared/schema";
import type { InferSelectModel } from "drizzle-orm";

export type RoleKey = "TANK" | "HEALER" | "DPS";

export type SlotKey = "TANK" | "HEALER" | "DPS1" | "DPS2" | "DPS3";

export type SlotAssignment = {
  userId: string;
  userTag: string;
  wowClass: string;
  level: number;
  confirmed: boolean;
};

export type GroupState = {
  messageId: string;
  channelId: string;
  guildId: string;
  createdByUserId: string;
  slots: Record<SlotKey, SlotAssignment | null>;
  completed: boolean;
  locked: boolean;
  pendingByUser: Record<
    string,
    {
      role: RoleKey;
      reservedSlot: SlotKey;
      createdAt: number;
      wowClass?: string;
      step: "CLASS" | "LEVEL";
    }
  >;
};

export type StatsPanel = {
  messageId: string;
  channelId: string;
  guildId: string;
  createdByUserId: string;
};

type StatsPanelRow = InferSelectModel<typeof statsPanels>;
type GroupRow = InferSelectModel<typeof groups>;
type GroupSlotRow = InferSelectModel<typeof groupSlots>;

type DrizzleDb = ReturnType<typeof drizzle>;

let db: DrizzleDb | null = null;

function ensureDb() {
  if (db) return db;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL must be set for PostgreSQL");
  }

  const pool = new Pool({
    connectionString: url,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
  });

  db = drizzle(pool);
  return db;
}

export async function initDb(): Promise<void> {
  const database = ensureDb();
  await database.execute(sql`
    create table if not exists groups (
      message_id text primary key,
      channel_id text not null,
      guild_id text not null,
      created_by_user_id text not null,
      completed boolean not null default false,
      locked boolean not null default false,
      created_at timestamptz not null default now()
    );
  `);

  await database.execute(sql`
    create table if not exists group_slots (
      message_id text not null,
      slot_key text not null,
      user_id text,
      user_tag text,
      wow_class text,
      level integer,
      confirmed boolean not null default false,
      primary key (message_id, slot_key)
    );
  `);

  await database.execute(sql`
    create table if not exists stats_panels (
      message_id text primary key,
      channel_id text not null,
      guild_id text not null,
      created_by_user_id text not null,
      created_at timestamptz not null default now()
    );
  `);
}

export async function saveGroup(state: GroupState): Promise<void> {
  const database = ensureDb();

  await database.transaction(async (tx: DrizzleDb) => {
    await tx
      .insert(groups)
      .values({
        messageId: state.messageId,
        channelId: state.channelId,
        guildId: state.guildId,
        createdByUserId: state.createdByUserId,
        completed: state.completed,
        locked: state.locked,
      })
      .onConflictDoUpdate({
        target: groups.messageId,
        set: {
          channelId: state.channelId,
          guildId: state.guildId,
          createdByUserId: state.createdByUserId,
          completed: state.completed,
          locked: state.locked,
        },
      });

    for (const slotKey of Object.keys(state.slots) as SlotKey[]) {
      const assignment = state.slots[slotKey];
      await tx
        .insert(groupSlots)
        .values({
          messageId: state.messageId,
          slotKey,
          userId: assignment?.userId ?? null,
          userTag: assignment?.userTag ?? null,
          wowClass: assignment?.wowClass ?? null,
          level: assignment?.level ?? null,
          confirmed: assignment?.confirmed ?? false,
        })
        .onConflictDoUpdate({
          target: [groupSlots.messageId, groupSlots.slotKey],
          set: {
            userId: assignment?.userId ?? null,
            userTag: assignment?.userTag ?? null,
            wowClass: assignment?.wowClass ?? null,
            level: assignment?.level ?? null,
            confirmed: assignment?.confirmed ?? false,
          },
        });
    }
  });
}

export async function deleteGroup(messageId: string): Promise<void> {
  const database = ensureDb();
  await database.delete(groupSlots).where(eq(groupSlots.messageId, messageId));
  await database.delete(groups).where(eq(groups.messageId, messageId));
}

export async function saveStatsPanel(panel: StatsPanel): Promise<void> {
  const database = ensureDb();
  await database
    .insert(statsPanels)
    .values({
      messageId: panel.messageId,
      channelId: panel.channelId,
      guildId: panel.guildId,
      createdByUserId: panel.createdByUserId,
    })
    .onConflictDoUpdate({
      target: statsPanels.messageId,
      set: {
        channelId: panel.channelId,
        guildId: panel.guildId,
        createdByUserId: panel.createdByUserId,
      },
    });
}

export async function deleteStatsPanel(messageId: string): Promise<void> {
  const database = ensureDb();
  await database.delete(statsPanels).where(eq(statsPanels.messageId, messageId));
}

export async function loadStatsPanels(): Promise<StatsPanel[]> {
  const database = ensureDb();
  const rows = await database.select().from(statsPanels);
  return rows.map((row: StatsPanelRow) => ({
    messageId: row.messageId,
    channelId: row.channelId,
    guildId: row.guildId,
    createdByUserId: row.createdByUserId,
  }));
}

export async function loadGroups(): Promise<GroupState[]> {
  const database = ensureDb();
  const groupRows = await database.select().from(groups);
  const slotRows = await database.select().from(groupSlots);

  const slotsByMessage = new Map<string, Record<SlotKey, SlotAssignment | null>>();

  slotRows.forEach((row: GroupSlotRow) => {
    const slots = slotsByMessage.get(row.messageId) ?? {
      TANK: null,
      HEALER: null,
      DPS1: null,
      DPS2: null,
      DPS3: null,
    };

    if (row.userId && row.userTag && row.wowClass && row.level !== null) {
      slots[row.slotKey as SlotKey] = {
        userId: row.userId,
        userTag: row.userTag,
        wowClass: row.wowClass,
        level: row.level,
        confirmed: row.confirmed ?? false,
      };
    } else {
      slots[row.slotKey as SlotKey] = null;
    }

    slotsByMessage.set(row.messageId, slots);
  });

  return groupRows.map((row: GroupRow) => {
    const slots = slotsByMessage.get(row.messageId) ?? {
      TANK: null,
      HEALER: null,
      DPS1: null,
      DPS2: null,
      DPS3: null,
    };

    return {
      messageId: row.messageId,
      channelId: row.channelId,
      guildId: row.guildId,
      createdByUserId: row.createdByUserId,
      slots,
      completed: row.completed,
      locked: row.locked,
      pendingByUser: {},
    } satisfies GroupState;
  });
}
