import { Table, Model, Column, DataType, PrimaryKey } from 'sequelize-typescript';

// A Goal is a NAMED conversion a marketer cares about, defined in plain terms and evaluated per
// anonymous session over the first-party pageview/event stream (s33k_event). Two kinds:
//   - 'page_reached': the session viewed a page whose path matches match_value (exact or, by
//     default, prefix). This is the "thank-you page" / destination conversion, e.g. "/demo/thanks".
//   - 'event': the session fired an autocaptured event of type match_value (e.g. 'form_submit'),
//     optionally constrained to a page via match_page (e.g. a form submit on '/contact').
//
// A goal is the unit behind conversion-rate questions: "conversion rate for <goal>, human-only",
// "of converters, which landing page", "how many AI referrals hit <goal>", "compare conversion
// rate by source". The rate is goal-completing sessions / sessions in the filtered set.
//
// Tenancy: owner_id mirrors the owning domain's owner so goals scope by scopeWhere like every
// other table. NULL owner_id == the legacy single-tenant admin account.
@Table({
  timestamps: false,
  tableName: 'goal',
})

class Goal extends Model {
   // Column is "ID" (matching the create-goal-table migration, which keys the column "ID"). Do NOT
   // add field: 'id': on Postgres "id" != "ID" (case-sensitive), so a lowercase mapping queries a
   // column that does not exist and every Goal read throws. SQLite hides this (case-insensitive).
   @PrimaryKey
   @Column({ type: DataType.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true })
   ID!: number;

   @Column({ type: DataType.STRING, allowNull: false })
   domain!: string;

   @Column({ type: DataType.INTEGER, allowNull: true })
   owner_id!: number;

   // The human-facing goal name used in questions, e.g. "Demo Booked", "Newsletter Signup".
   @Column({ type: DataType.STRING, allowNull: false })
   name!: string;

   // 'page_reached' | 'event'.
   @Column({ type: DataType.STRING, allowNull: false })
   kind!: string;

   // page_reached: the path (or path prefix) to match. event: the event type (e.g. 'form_submit').
   @Column({ type: DataType.TEXT, allowNull: false })
   match_value!: string;

   // event kind only: optional page the event must occur on. NULL = any page.
   @Column({ type: DataType.TEXT, allowNull: true, defaultValue: null })
   match_page!: string | null;

   // page_reached only: 'prefix' (default) or 'exact' path matching.
   @Column({ type: DataType.STRING, allowNull: false, defaultValue: 'prefix' })
   match_mode!: string;

   // Optional money worth of one completion of this goal (e.g. 250 for a Demo Booked). NULL = no
   // value set, in which case conversion reads omit revenue. When set, revenue = conversions * value.
   @Column({ type: DataType.FLOAT, allowNull: true, defaultValue: null })
   value!: number | null;

   @Column({ type: DataType.STRING, allowNull: false })
   created!: string;
}

export default Goal;
