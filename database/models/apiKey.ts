import { Table, Model, Column, DataType, PrimaryKey } from 'sequelize-typescript';

// ApiKey is a per-account Bearer key for the hosted, multi-tenant version of s33k.
// One account can have many keys (rotation, separate keys per MCP client); a key maps
// to exactly one account.
//
// The full key (format `s33k_<random>`) is shown ONCE at creation and never stored in
// clear. We persist only key_prefix (first ~8 chars, for lookup + display) and
// key_hash (SHA-256 of the full key). A leaked DB dump therefore does not leak usable
// keys. The legacy global process.env.APIKEY is separate and continues to resolve to
// the admin account; this table is only consulted for non-legacy keys when
// MULTI_TENANT is on.
@Table({
  timestamps: true,
  tableName: 'api_key',
})

class ApiKey extends Model {
   @PrimaryKey
   @Column({ type: DataType.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true })
   ID!: number;

   @Column({ type: DataType.INTEGER, allowNull: false })
   account_id!: number;

   @Column({ type: DataType.STRING, allowNull: true, defaultValue: '' })
   name!: string;

   @Column({ type: DataType.STRING, allowNull: false })
   key_prefix!: string;

   @Column({ type: DataType.STRING, allowNull: false })
   key_hash!: string;

   @Column({ type: DataType.DATE, allowNull: true })
   last_used_at!: Date;

   @Column({ type: DataType.DATE, allowNull: true })
   revoked_at!: Date;

   // 'admin' (full access, the account owner / legacy keys) or 'member' (read-only seat,
   // created by an internal invite). A member key may only make GET requests; writes are
   // rejected by authorize(). Defaults to 'admin' so every existing key keeps full access.
   // Only meaningful with MULTI_TENANT on (members only exist there).
   @Column({ type: DataType.STRING, allowNull: true, defaultValue: 'admin' })
   role!: string;

   // When set, this key is a per-domain SHARE key: read-only and limited to exactly ONE
   // domain (the value here). It is minted on the domain OWNER's account, so scopeWhere(owner)
   // and every pillar query work unchanged; authorize() applies the only new enforcement,
   // denying any non-GET and any request whose `domain` param is not this exact value. A
   // normal key has this null and is unrestricted (subject to its role). Nullable so every
   // existing key keeps null and is unaffected. Only meaningful with MULTI_TENANT on.
   // TEXT (not the default VARCHAR(255)) per the prod Postgres widen-to-TEXT convention.
   @Column({ type: DataType.TEXT, allowNull: true })
   scoped_domain!: string | null;
}

export default ApiKey;
