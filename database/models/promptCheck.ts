import { Table, Model, Column, DataType, PrimaryKey } from 'sequelize-typescript';

// A PromptCheck is ONE tracked buyer prompt for a domain and its LATEST recorded AI-citation result.
//
// The product question it answers: "are the AI engines (ChatGPT, Claude, Perplexity, Gemini) citing
// us when a buyer asks the prompts that matter, AND do the pages they cite actually convert?" That
// join (cited prompt -> cited page -> that page's conversion rate + AI-referral traffic) is the
// prompt_radar superpower no other tool can do, because only s33k holds the citation result next to
// owned conversion and referral data for the same domain.
//
// CRITICAL design rule (verified-true trust property, see CLAUDE.md / SECURITY.md): s33k has NO
// server-side LLM. s33k only STORES the prompt and STORES the result that the USER'S OWN LLM writes
// back after IT queries the engine. The s33k server NEVER calls an AI engine. So a fresh PromptCheck
// row is a tracked prompt with NO result yet (engine/cited/position/cited_url/checked_at all null);
// it is populated only when the user's assistant records what it found via prompt_record.
//
// Tenancy: owner_id mirrors the owning domain's owner so prompt checks scope by scopeWhere like every
// other table. NULL owner_id == the legacy single-tenant admin account. The domain is stored in its
// CANONICAL form (see utils/canonical-domain.ts) so it joins to the canonical Domain/Keyword/event
// rows for the radar's conversion + AI-referral join.
@Table({
  timestamps: false,
  tableName: 'prompt_check',
})

class PromptCheck extends Model {
   // Column is "ID" (matching the create-prompt-check-table migration, which keys the column "ID").
   // Do NOT add field: 'id': on Postgres "id" != "ID" (case-sensitive), so a lowercase mapping queries
   // a column that does not exist and every PromptCheck read throws. SQLite hides this (case-insensitive).
   // This mirrors the goal.ts PK mapping exactly; the pk-column-parity guard enforces the match.
   @PrimaryKey
   @Column({ type: DataType.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true })
   ID!: number;

   // The canonical domain this tracked prompt belongs to.
   @Column({ type: DataType.TEXT, allowNull: false })
   domain!: string;

   @Column({ type: DataType.INTEGER, allowNull: true })
   owner_id!: number | null;

   // The buyer prompt to watch, e.g. "best project management software for remote teams". Free text: TEXT.
   @Column({ type: DataType.TEXT, allowNull: false })
   prompt!: string;

   // The AI engine the latest result is for (chatgpt | claude | perplexity | gemini). NULL until the
   // user's LLM records a result via prompt_record.
   @Column({ type: DataType.TEXT, allowNull: true, defaultValue: null })
   engine!: string | null;

   // Whether this domain was cited in the engine's answer. NULL until recorded.
   @Column({ type: DataType.BOOLEAN, allowNull: true, defaultValue: null })
   cited!: boolean | null;

   // The citation position (1 = first cited source), when known. NULL until recorded or when uncited.
   @Column({ type: DataType.INTEGER, allowNull: true, defaultValue: null })
   position!: number | null;

   // The exact URL the engine cited for this domain, when given. The join key into per-page
   // conversion + AI-referral data. NULL until recorded or when uncited. URL -> TEXT (not STRING).
   @Column({ type: DataType.TEXT, allowNull: true, defaultValue: null })
   cited_url!: string | null;

   // When the latest result was recorded (ISO string). NULL until recorded.
   @Column({ type: DataType.DATE, allowNull: true, defaultValue: null })
   checked_at!: string | null;

   @Column({ type: DataType.DATE, allowNull: false })
   created!: string;
}

export default PromptCheck;
