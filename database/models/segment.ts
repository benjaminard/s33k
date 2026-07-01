import { Table, Model, Column, DataType, PrimaryKey } from 'sequelize-typescript';

// A Segment is a NAMED, reusable filter set a marketer defines once and applies by name, instead of
// re-specifying the same channel/device/country/humanOnly/landingPage/engagement filters on every
// analytics call. The stored `filters` is a JSON STRING of the same SegmentFilters spec that
// parseSegmentFilters (utils/sessionize.ts) understands, so segment-analytics applies it through the
// exact same engine as human-analytics and goal-analytics. The filter vocabulary never diverges.
//
// Example: a segment named "AI human converters" stored as {"channel":"ai","humanOnly":true} lets a
// user ask for that cut by name forever after.
//
// Tenancy: owner_id mirrors the owning domain's owner so segments scope by scopeWhere like every
// other table. NULL owner_id == the legacy single-tenant admin account.
@Table({
  timestamps: false,
  tableName: 'segment',
})

class Segment extends Model {
   // Column is "ID" (byte-matching the create-segment-table migration, which keys the column "ID").
   // Do NOT add field: 'id': on Postgres "id" != "ID" (case-sensitive), so a lowercase mapping would
   // query a column that does not exist and every Segment read would throw. SQLite hides this
   // (case-insensitive). This is the documented column-name footgun from CLAUDE.md section B.
   @PrimaryKey
   @Column({ type: DataType.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true })
   ID!: number;

   @Column({ type: DataType.STRING, allowNull: false })
   domain!: string;

   @Column({ type: DataType.INTEGER, allowNull: true })
   owner_id!: number;

   // The human-facing segment name used in questions, e.g. "AI human converters", "Mobile organic".
   @Column({ type: DataType.STRING, allowNull: false })
   name!: string;

   // A JSON STRING of the SegmentFilters spec (channel, device, country, humanOnly, landingPage,
   // page, engagement). TEXT so a large filter set never overflows VARCHAR(255) on Postgres (the
   // documented TEXT-vs-STRING gotcha from CLAUDE.md section A).
   @Column({ type: DataType.TEXT, allowNull: false })
   filters!: string;

   @Column({ type: DataType.STRING, allowNull: false })
   created!: string;
}

export default Segment;
