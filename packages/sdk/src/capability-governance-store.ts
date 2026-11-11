/** Persistent store for E4-S1 governed capability inventory and active policy. */
import type { SqlExecutor } from './sql-repositories.js';
import {
  CapabilityPolicySchema,
  GovernedCapabilitySchema,
  type CapabilityPolicy,
  type GovernedCapability,
} from './capability-policy.js';

export interface CapabilityGovernanceStore {
  getCapability(id: string): Promise<GovernedCapability | null>;
  listCapabilities(): Promise<readonly GovernedCapability[]>;
  saveCapability(capability: GovernedCapability): Promise<GovernedCapability>;
  getActivePolicy(): Promise<CapabilityPolicy | null>;
  saveActivePolicy(policy: CapabilityPolicy): Promise<CapabilityPolicy>;
}

type CapabilityRow = Omit<GovernedCapability, 'inputSchema' | 'scope' | 'enabled'> & {
  inputSchema: unknown;
  scope: unknown;
  enabled: unknown;
};
type PolicyRow = { version: string; rules: unknown };

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return JSON.parse(value) as unknown;
}

function capabilityFromRow(row: CapabilityRow): GovernedCapability {
  return GovernedCapabilitySchema.parse({
    ...row,
    inputSchema: parseJson(row.inputSchema),
    scope: parseJson(row.scope),
    // Drivers may expose PostgreSQL BOOLEAN as a bool or its textual wire form;
    // SQLite stores the same field as 0/1. Normalize only known true encodings.
    enabled: row.enabled === true || row.enabled === 1 || row.enabled === 'true' || row.enabled === 't' || row.enabled === '1',
  });
}

function policyFromRow(row: PolicyRow): CapabilityPolicy {
  return CapabilityPolicySchema.parse({ version: row.version, rules: parseJson(row.rules) });
}

const capabilityColumns = `id, name, source, version, owner, input_schema AS "inputSchema",
  risk, scope, health, enabled`;

export class SqlCapabilityGovernanceStore implements CapabilityGovernanceStore {
  constructor(private readonly sql: SqlExecutor) {}

  async getCapability(id: string): Promise<GovernedCapability | null> {
    const row = (await this.sql.query<CapabilityRow>(`SELECT ${capabilityColumns} FROM r1_governed_capabilities WHERE id=$1`, [id]))[0];
    return row ? capabilityFromRow(row) : null;
  }

  async listCapabilities(): Promise<readonly GovernedCapability[]> {
    return (await this.sql.query<CapabilityRow>(`SELECT ${capabilityColumns} FROM r1_governed_capabilities ORDER BY id`)).map(capabilityFromRow);
  }

  async saveCapability(candidate: GovernedCapability): Promise<GovernedCapability> {
    const capability = GovernedCapabilitySchema.parse(candidate);
    const row = (await this.sql.query<CapabilityRow>(`INSERT INTO r1_governed_capabilities
      (id,name,source,version,owner,input_schema,risk,scope,health,enabled)
      VALUES ($1,$2,$3,$4,$5,$6::text::jsonb,$7,$8::text::jsonb,$9,CASE WHEN $10::int = 1 THEN TRUE ELSE FALSE END)
      ON CONFLICT (id) DO UPDATE SET name=$2, source=$3, version=$4, owner=$5,
        input_schema=$6::text::jsonb, risk=$7, scope=$8::text::jsonb, health=$9,
        enabled=CASE WHEN $10::int = 1 THEN TRUE ELSE FALSE END
      RETURNING ${capabilityColumns}`,
      [capability.id, capability.name, capability.source, capability.version, capability.owner,
        JSON.stringify(capability.inputSchema), capability.risk, JSON.stringify(capability.scope),
        capability.health, capability.enabled ? 1 : 0]))[0];
    if (!row) throw new Error('Capability persistence did not return a row.');
    return capabilityFromRow(row);
  }

  async getActivePolicy(): Promise<CapabilityPolicy | null> {
    const row = (await this.sql.query<PolicyRow>(`SELECT version, rules FROM r1_capability_policies WHERE id='active'`))[0];
    return row ? policyFromRow(row) : null;
  }

  async saveActivePolicy(candidate: CapabilityPolicy): Promise<CapabilityPolicy> {
    const policy = CapabilityPolicySchema.parse(candidate);
    const row = (await this.sql.query<PolicyRow>(`INSERT INTO r1_capability_policies (id,version,rules)
      VALUES ('active',$1,$2) ON CONFLICT (id) DO UPDATE SET version=$1, rules=$2
      RETURNING version, rules`, [policy.version, JSON.stringify(policy.rules)]))[0];
    if (!row) throw new Error('Policy persistence did not return a row.');
    return policyFromRow(row);
  }
}

export class InMemoryCapabilityGovernanceStore implements CapabilityGovernanceStore {
  private readonly capabilities = new Map<string, GovernedCapability>();
  private policy: CapabilityPolicy | null = null;
  async getCapability(id: string): Promise<GovernedCapability | null> { return this.capabilities.get(id) ?? null; }
  async listCapabilities(): Promise<readonly GovernedCapability[]> { return [...this.capabilities.values()].sort((a, b) => a.id.localeCompare(b.id)); }
  async saveCapability(candidate: GovernedCapability): Promise<GovernedCapability> {
    const capability = GovernedCapabilitySchema.parse(candidate);
    this.capabilities.set(capability.id, capability);
    return capability;
  }
  async getActivePolicy(): Promise<CapabilityPolicy | null> { return this.policy; }
  async saveActivePolicy(candidate: CapabilityPolicy): Promise<CapabilityPolicy> {
    this.policy = CapabilityPolicySchema.parse(candidate);
    return this.policy;
  }
}
