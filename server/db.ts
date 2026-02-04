import Database from "better-sqlite3";

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

const DB_PATH = process.env.SQLITE_PATH || "/app/data/bot.db";

let db: Database.Database | null = null;

function ensureDb(): Database.Database {
  if (db) return db;
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    create table if not exists groups (
      message_id text primary key,
      channel_id text not null,
      guild_id text not null,
      created_by_user_id text not null,
      completed integer not null,
      locked integer not null
    );

    create table if not exists slots (
      message_id text not null,
      slot_key text not null,
      user_id text,
      user_tag text,
      wow_class text,
      level integer,
      confirmed integer,
      primary key (message_id, slot_key)
    );
  `);
  return db;
}

export function initDb(): void {
  ensureDb();
}

export function saveGroup(state: GroupState): void {
  const database = ensureDb();
  const upsertGroup = database.prepare(
    `insert into groups (message_id, channel_id, guild_id, created_by_user_id, completed, locked)
     values (@messageId, @channelId, @guildId, @createdByUserId, @completed, @locked)
     on conflict(message_id) do update set
       channel_id=excluded.channel_id,
       guild_id=excluded.guild_id,
       created_by_user_id=excluded.created_by_user_id,
       completed=excluded.completed,
       locked=excluded.locked`,
  );

  upsertGroup.run({
    messageId: state.messageId,
    channelId: state.channelId,
    guildId: state.guildId,
    createdByUserId: state.createdByUserId,
    completed: state.completed ? 1 : 0,
    locked: state.locked ? 1 : 0,
  });

  const upsertSlot = database.prepare(
    `insert into slots (message_id, slot_key, user_id, user_tag, wow_class, level, confirmed)
     values (@messageId, @slotKey, @userId, @userTag, @wowClass, @level, @confirmed)
     on conflict(message_id, slot_key) do update set
       user_id=excluded.user_id,
       user_tag=excluded.user_tag,
       wow_class=excluded.wow_class,
       level=excluded.level,
       confirmed=excluded.confirmed`,
  );

  (Object.keys(state.slots) as SlotKey[]).forEach((slotKey) => {
    const assignment = state.slots[slotKey];
    upsertSlot.run({
      messageId: state.messageId,
      slotKey,
      userId: assignment?.userId ?? null,
      userTag: assignment?.userTag ?? null,
      wowClass: assignment?.wowClass ?? null,
      level: assignment?.level ?? null,
      confirmed: assignment?.confirmed ? 1 : 0,
    });
  });
}

export function deleteGroup(messageId: string): void {
  const database = ensureDb();
  database.prepare("delete from slots where message_id = ?").run(messageId);
  database.prepare("delete from groups where message_id = ?").run(messageId);
}

export function loadGroups(): GroupState[] {
  const database = ensureDb();
  const groupRows = database
    .prepare(
      "select message_id, channel_id, guild_id, created_by_user_id, completed, locked from groups",
    )
    .all() as Array<{
    message_id: string;
    channel_id: string;
    guild_id: string;
    created_by_user_id: string;
    completed: number;
    locked: number;
  }>;

  const slotRows = database
    .prepare(
      "select message_id, slot_key, user_id, user_tag, wow_class, level, confirmed from slots",
    )
    .all() as Array<{
    message_id: string;
    slot_key: SlotKey;
    user_id: string | null;
    user_tag: string | null;
    wow_class: string | null;
    level: number | null;
    confirmed: number | null;
  }>;

  const slotsByMessage = new Map<string, Record<SlotKey, SlotAssignment | null>>();

  slotRows.forEach((row) => {
    const slots = slotsByMessage.get(row.message_id) ?? {
      TANK: null,
      HEALER: null,
      DPS1: null,
      DPS2: null,
      DPS3: null,
    };

    if (row.user_id && row.user_tag && row.wow_class && row.level !== null) {
      slots[row.slot_key] = {
        userId: row.user_id,
        userTag: row.user_tag,
        wowClass: row.wow_class,
        level: row.level,
        confirmed: row.confirmed ? true : false,
      };
    } else {
      slots[row.slot_key] = null;
    }

    slotsByMessage.set(row.message_id, slots);
  });

  return groupRows.map((row) => {
    const slots = slotsByMessage.get(row.message_id) ?? {
      TANK: null,
      HEALER: null,
      DPS1: null,
      DPS2: null,
      DPS3: null,
    };

    return {
      messageId: row.message_id,
      channelId: row.channel_id,
      guildId: row.guild_id,
      createdByUserId: row.created_by_user_id,
      slots,
      completed: row.completed === 1,
      locked: row.locked === 1,
      pendingByUser: {},
    } satisfies GroupState;
  });
}
