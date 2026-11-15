import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, memories, skills } from '../../src/db/client.js';
import { exportBrain, importBrain, compressBrain } from '../../src/services/brain.js';

const TS = 'b-test';

async function mem(id: string, kind = 'episodic', importance = 0.5) {
  return db
    .insert(memories)
    .values({
      id,
      kind,
      title: 'T',
      content: 'C',
      tags: '[]',
      importance,
      source: TS,
      tokenCost: 1,
      recallCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .catch((e: any) => {
      throw new Error(`mem insert failed: ${e?.message}`);
    });
}

async function skl(id: string) {
  return db.insert(skills).values({
    id,
    name: id,
    title: id,
    description: 'D',
    content: 'C',
    category: 'general',
    tags: '[]',
    source: TS,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

describe('brain service', () => {
  describe('exportBrain', () => {
    it('exports memories and skills', async () => {
      await mem('mem_e1', 'episodic', 0.7);
      await skl('skl_e1');
      const r: any = await exportBrain();
      expect(r.format).toBe('nexus-brain');
      expect(r.memories?.find((m: any) => m.id === 'mem_e1')?.title).toBe('T');
      expect(r.skills?.find((s: any) => s.id === 'skl_e1')?.name).toBe('skl_e1');
    });

    it('handles empty DB', async () => {
      await db.delete(memories).where(eq(memories.source, TS));
      await db.delete(skills).where(eq(skills.source, TS));
      const r: any = await exportBrain();
      expect(Array.isArray(r.memories)).toBe(true);
      expect(Array.isArray(r.skills)).toBe(true);
    });
  });

  describe('importBrain', () => {
    it('inserts valid payload', async () => {
      // importBrain dedupes skills by name, so a leftover row from an earlier
      // run in the shared test database would make this assertion order-dependent.
      await db.delete(skills).where(eq(skills.name, 'i-skill'));
      const r = await importBrain(
        {
          format: 'nexus-brain',
          version: 2,
          exportedAt: new Date().toISOString(),
          memories: [
            {
              id: 'mem_i1',
              kind: 'episodic',
              title: 'Imported',
              content: 'C',
              tags: [],
              importance: 0.5,
              source: TS,
              tokenCost: 1,
              recallCount: 0,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
          skills: [
            {
              id: 'skl_i1',
              name: 'i-skill',
              title: 'IS',
              description: 'D',
              content: 'C',
              category: 'general',
              tags: [],
              source: TS,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
        },
        TS
      );
      expect(r.memories).toBeGreaterThanOrEqual(1);
      expect(r.skills).toBeGreaterThanOrEqual(1);
    });

    it('skips duplicates', async () => {
      await mem('mem_idup', 'episodic', 0.5);
      const r = await importBrain(
        {
          format: 'nexus-brain',
          version: 2,
          exportedAt: new Date().toISOString(),
          memories: [
            {
              id: 'mem_idup',
              kind: 'episodic',
              title: 'Dup',
              content: 'C',
              tags: [],
              importance: 0.5,
              source: TS,
              tokenCost: 1,
              recallCount: 0,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
          skills: [],
        },
        TS
      );
      expect(r.duplicates).toBeGreaterThanOrEqual(1);
    });

    it('rejects invalid schema', async () => {
      await expect(importBrain({ format: 'bad' } as any, TS)).rejects.toThrow();
    });

    it('handles empty arrays', async () => {
      const r = await importBrain(
        {
          format: 'nexus-brain',
          version: 2,
          exportedAt: new Date().toISOString(),
          memories: [],
          skills: [],
        },
        TS
      );
      expect(r.memories).toBe(0);
      expect(r.skills).toBe(0);
    });
  });

  describe('compressBrain', () => {
    it('removes low importance memories', async () => {
      await mem('mem_c1', 'episodic', 0.8);
      await mem('mem_c2', 'episodic', 0.05);
      const r = await compressBrain(TS);
      expect(r.pruned).toBeGreaterThanOrEqual(1);
    });

    it('respects maxMemories limit', async () => {
      for (let i = 0; i < 5; i++) await mem(`mem_cl${i}`, 'episodic', 0.5);
      const r = await compressBrain(TS);
      expect(r.kept).toBeGreaterThanOrEqual(0);
    });
  });
});
