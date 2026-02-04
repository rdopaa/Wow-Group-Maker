import { sql } from "drizzle-orm";
import {
  boolean,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export const groups = pgTable("groups", {
  messageId: text("message_id").primaryKey(),
  channelId: text("channel_id").notNull(),
  guildId: text("guild_id").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  completed: boolean("completed").notNull().default(false),
  locked: boolean("locked").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const groupSlots = pgTable(
  "group_slots",
  {
    messageId: text("message_id").notNull(),
    slotKey: text("slot_key").notNull(),
    userId: text("user_id"),
    userTag: text("user_tag"),
    wowClass: text("wow_class"),
    level: integer("level"),
    confirmed: boolean("confirmed").notNull().default(false),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.messageId, table.slotKey] }),
  }),
);

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
