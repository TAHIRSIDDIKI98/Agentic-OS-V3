import { describe, expect, it } from 'vitest';
import { InMemoryCapabilityGovernanceStore, SqlCapabilityGovernanceStore } from './capability-governance-store';
import type { SqlExecutor } from './sql-repositories';

const capability = {
  id: 'net.fetch', name: 'Fetch approved URL', source: 'native' as const, version: '1.0.0', owner: 'platform',
  inputSchema: { type: 'object' }, risk: 'medium' as const,
  scope: { projectIds: ['11111111-1111-4111-8111-111111111111'], agentIds: ['agent-a'] }, health: 'healthy' as const, enabled: true,
};
const policy = { version: 'policy-1', rules: [{ id: 'allow-fetch', capabilityId: capability.id, decision: 'allow' as const }] };

describe('capability governance stores', () => {
  it('persists capabilities and the one active policy in memory', async () => {
    const store = new InMemoryCapabilityGovernanceStore();
    await expect(store.saveCapability(capability)).resolves.toEqual(capability);
    await expect(store.getCapability(capability.id)).resolves.toEqual(capability);
    await expect(store.saveActivePolicy(policy)).resolves.toEqual(policy);
    await expect(store.getActivePolicy()).resolves.toEqual(policy);
  });

  it('uses parameterized SQL and normalizes JSON and SQLite/PostgreSQL boolean rows', async () => {
    const calls: Array<{ statement: string; parameters: readonly unknown[] }> = [];
    const sql: SqlExecutor = { query: async <T extends object>(statement: string, parameters: readonly unknown[] = []) => {
      calls.push({ statement, parameters });
      if (statement.startsWith('INSERT INTO r1_governed_capabilities')) {
        return [{ ...capability, inputSchema: JSON.stringify(capability.inputSchema), scope: JSON.stringify(capability.scope), enabled: 1 } as T];
      }
      return [];
    } };
    const store = new SqlCapabilityGovernanceStore(sql);
    await expect(store.saveCapability(capability)).resolves.toEqual(capability);
    expect(calls[0]?.statement).toContain('CASE WHEN $10::int = 1 THEN TRUE ELSE FALSE END');
    expect(calls[0]?.parameters).toContain(JSON.stringify(capability.scope));
    expect(calls[0]?.parameters).toContain(1);

    for (const enabled of [true, 1, 'true', 't', '1']) {
      const readSql: SqlExecutor = { query: async <T extends object>() => [{
        ...capability,
        inputSchema: capability.inputSchema,
        scope: capability.scope,
        enabled,
      } as T] };
      await expect(new SqlCapabilityGovernanceStore(readSql).getCapability(capability.id))
        .resolves.toMatchObject({ enabled: true });
    }
  });
});
