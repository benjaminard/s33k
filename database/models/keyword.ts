import { Table, Model, Column, DataType, PrimaryKey } from 'sequelize-typescript';

@Table({
  timestamps: false,
  tableName: 'keyword',
})

class Keyword extends Model {
   @PrimaryKey
   @Column({ type: DataType.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true })
   ID!: number;

   // TEXT not STRING: STRING maps to VARCHAR(255) on Postgres but unlimited TEXT on SQLite. A
   // keyword is a free-text user phrase and several columns below hold large JSON payloads
   // (history, url, tags, lastResult) that silently overflow VARCHAR(255) on Postgres while
   // passing on SQLite. The whole batch is TEXT to keep the two dialects consistent. Migration
   // 1750147200012 widens these on existing Postgres deploys.
   @Column({ type: DataType.TEXT, allowNull: false })
   keyword!: string;

   @Column({ type: DataType.STRING, allowNull: true, defaultValue: 'desktop' })
   device!: string;

   @Column({ type: DataType.STRING, allowNull: true, defaultValue: 'US' })
   country!: string;

   @Column({ type: DataType.STRING, allowNull: true, defaultValue: '' })
   city!: string;

   @Column({ type: DataType.STRING, allowNull: true, defaultValue: '' })
   latlong!: string;

   @Column({ type: DataType.TEXT, allowNull: false, defaultValue: '{}' })
   domain!: string;

   // @ForeignKey(() => Domain)
   // @Column({ allowNull: false })
   // domainID!: number;

   // @BelongsTo(() => Domain)
   // domain!: Domain;

   @Column({ type: DataType.STRING, allowNull: true })
   lastUpdated!: string;

   @Column({ type: DataType.STRING, allowNull: true })
   added!: string;

   @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
   position!: number;

   @Column({ type: DataType.TEXT, allowNull: true, defaultValue: JSON.stringify([]) })
   history!: string;

   @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
   volume!: number;

   @Column({ type: DataType.TEXT, allowNull: true, defaultValue: JSON.stringify([]) })
   url!: string;

   @Column({ type: DataType.TEXT, allowNull: true, defaultValue: '' })
   target_page!: string;

   @Column({ type: DataType.TEXT, allowNull: true, defaultValue: JSON.stringify([]) })
   tags!: string;

   @Column({ type: DataType.TEXT, allowNull: true, defaultValue: JSON.stringify([]) })
   lastResult!: string;

   @Column({ type: DataType.BOOLEAN, allowNull: true, defaultValue: true })
   sticky!: boolean;

   @Column({ type: DataType.BOOLEAN, allowNull: true, defaultValue: false })
   updating!: boolean;

   @Column({ type: DataType.TEXT, allowNull: true, defaultValue: 'false' })
   lastUpdateError!: string;

   @Column({ type: DataType.TEXT, allowNull: true })
   settings!: string;

   // Multi-tenant ownership, denormalized onto keyword to match the fork's existing
   // "join by domain string, no real FK" pattern, so keyword queries can scope
   // without a join. NULL == the legacy single-tenant admin account.
   @Column({ type: DataType.INTEGER, allowNull: true })
   owner_id!: number;
}

export default Keyword;
