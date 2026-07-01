import { Table, Model, Column, DataType, PrimaryKey } from 'sequelize-typescript';

// A Setting row is the OPERATOR INSTANCE CONFIG that used to live in data/settings.json.
//
// WHY one global row and NOT per-tenant: in the hosted model the OPERATOR (us) runs the shared
// SERP scraper account, the SMTP sender, and the service-account / Google Ads integrations. Those
// credentials and the scraper/notification settings are properties of the INSTANCE, changed only by
// the admin, never by a tenant. They are not tenant data, so they are stored as a single global row
// (id = 1) rather than scoped by owner. If per-tenant notification preferences are ever wanted, that
// is a SEPARATE future design (a tenant-scoped table), not this row.
//
// The `data` column holds the SAME encrypted JSON blob settings.json stored: sensitive fields
// (scaping_api, smtp_password, search_console_*, adwords_*) are cryptr-encrypted with SECRET exactly
// as before. The blob shape is unchanged; only the storage moved from a file to this row, so there
// is no fragile shared file on the data volume and the value is durable in Postgres.
//
// Column names BYTE-MATCH the create-setting-table migration (Postgres is case-sensitive): the PK
// column is the lowercase "id" (the fixed single row, always 1) and the blob is "data" (TEXT, never
// STRING: the JSON easily exceeds VARCHAR(255) and would truncate on Postgres while passing on SQLite).
@Table({
  timestamps: false,
  tableName: 'setting',
})

class Setting extends Model {
   // The DB column is the lowercase "id" (field override) to byte-match the migration's "id" column.
   // The ATTRIBUTE is "ID" (uppercase) on purpose: a lowercase "id" attribute collides with the base
   // sequelize Model's own "id" property (a TS "will overwrite the base property" error), exactly the
   // reason every other model here keys its PK attribute "ID". There is exactly ONE row, id = 1
   // (SINGLE_SETTING_ID); it is not autoIncremented because we findOrCreate on the fixed id.
   @PrimaryKey
   @Column({ type: DataType.INTEGER, allowNull: false, primaryKey: true, field: 'id' })
   ID!: number;

   // The full settings JSON blob, with sensitive fields cryptr-encrypted, exactly as settings.json
   // stored it. TEXT so the blob never truncates on Postgres.
   @Column({ type: DataType.TEXT, allowNull: false, defaultValue: '{}' })
   data!: string;
}

// The fixed primary key of the single global settings row.
export const SINGLE_SETTING_ID = 1;

export default Setting;
