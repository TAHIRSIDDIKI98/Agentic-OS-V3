/**
 * E9 Serena Parity — Semantic Code Intelligence for CLI Agents
 * Implements MCP tools: find_symbols, get_symbol_info, list_references, semantic_search, read_symbol, diagnostics, project_map, index_project, edit_at_symbol, rename_symbol, extract_function
 *
 * Requirements:
 * - All tools scoped to project + agent identity
 * - Edits go through approval + receipt + audit
 * - Project indexing + cache
 */

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const SymbolKindSchema = z.enum(['function', 'class', 'variable', 'type', 'interface', 'method', 'property', 'constant', 'enum', 'module']);
export type SymbolKind = z.infer<typeof SymbolKindSchema>;

export const CodeSymbolSchema = z.object({
  name: z.string().min(1),
  kind: SymbolKindSchema,
  file: z.string().min(1),
  line: z.number().int().nonnegative(),
  column: z.number().int().nonnegative(),
  signature: z.string().optional(),
  documentation: z.string().optional(),
  containerName: z.string().optional(),
});
export type CodeSymbol = z.infer<typeof CodeSymbolSchema>;

export const FindSymbolsQuerySchema = z.object({
  projectId: z.string().uuid(),
  query: z.string().min(1).max(500),
  kind: SymbolKindSchema.optional(),
  fileFilter: z.string().optional(),
  limit: z.number().int().min(1).max(1000).default(100),
});
export type FindSymbolsQuery = z.infer<typeof FindSymbolsQuerySchema>;

export const GetSymbolInfoQuerySchema = z.object({
  projectId: z.string().uuid(),
  symbolId: z.string().min(1).optional(),
  file: z.string().min(1),
  line: z.number().int().nonnegative(),
  column: z.number().int().nonnegative().optional(),
});
export type GetSymbolInfoQuery = z.infer<typeof GetSymbolInfoQuerySchema>;

export const ReferenceSchema = z.object({
  file: z.string(),
  line: z.number().int().nonnegative(),
  column: z.number().int().nonnegative(),
  preview: z.string().max(500).optional(),
});
export type Reference = z.infer<typeof ReferenceSchema>;

export interface ProjectIndex {
  readonly symbols: readonly CodeSymbol[];
  readonly files: readonly string[];
  readonly map: Record<string, readonly CodeSymbol[]>;
  readonly indexedAt: string;
}

export interface SerenaOptions {
  readonly now?: () => string;
  readonly fileSystem?: { readFile: (p: string) => Promise<string>; glob: (pattern: string, root: string) => Promise<string[]> };
  readonly symbolProvider?: (file: string, content: string) => Promise<readonly CodeSymbol[]>;
}

/**
 * Simple regex-based symbol extractor for TS/JS/Rust/MD
 * Not full LSP but provides useful parity for tests.
 * Real LSP integration would be in server package.
 */
async function defaultSymbolProvider(file: string, content: string): Promise<readonly CodeSymbol[]> {
  const symbols: CodeSymbol[] = [];
  const lines = content.split('\n');
  const push = (m: RegExpMatchArray, kind: SymbolKind, lineIdx: number, col: number, sig?: string) => {
    const name = m[1] ?? m[2] ?? 'unknown';
    symbols.push({
      name,
      kind,
      file,
      line: lineIdx,
      column: col,
      signature: sig ?? m[0]?.slice(0, 200),
    });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // TS/JS function
    let match: RegExpMatchArray | null;
    if ((match = line.match(/\bfunction\s+([A-Za-z0-9_]+)/))) push(match, 'function', i, match.index ?? 0);
    if ((match = line.match(/\bclass\s+([A-Za-z0-9_]+)/))) push(match, 'class', i, match.index ?? 0);
    if ((match = line.match(/\binterface\s+([A-Za-z0-9_]+)/))) push(match, 'interface', i, match.index ?? 0);
    if ((match = line.match(/\btype\s+([A-Za-z0-9_]+)\s*=/))) push(match, 'type', i, match.index ?? 0);
    if ((match = line.match(/\bconst\s+([A-Za-z0-9_]+)\s*=\s*\(/))) push(match, 'constant', i, match.index ?? 0);
    if ((match = line.match(/\blet\s+([A-Za-z0-9_]+)/))) push(match, 'variable', i, match.index ?? 0);
    if ((match = line.match(/\benum\s+([A-Za-z0-9_]+)/))) push(match, 'enum', i, match.index ?? 0);
    // Rust
    if ((match = line.match(/\bfn\s+([A-Za-z0-9_]+)/))) push(match, 'function', i, match.index ?? 0);
    if ((match = line.match(/\bstruct\s+([A-Za-z0-9_]+)/))) push(match, 'class', i, match.index ?? 0);
  }
  return symbols;
}

/**
 * Normalize separators so index keys and lookups agree on Windows and POSIX.
 * Windows returns backslash paths from glob; a caller may query with either
 * `src/math.ts` or `/tmp/project/src/math.ts`.
 */
function canonicalPath(p: string): string {
  return p.replace(/\\/g, '/');
}

export class SerenaCodeIntelligence {
  private readonly now: () => string;
  private readonly cache = new Map<string, ProjectIndex>();
  private readonly symbolProvider: (file: string, content: string) => Promise<readonly CodeSymbol[]>;
  private readonly fsRead: (p: string) => Promise<string>;
  private readonly fsGlob: (pattern: string, root: string) => Promise<string[]>;

  constructor(options: SerenaOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.symbolProvider = options.symbolProvider ?? defaultSymbolProvider;
    this.fsRead = options.fileSystem?.readFile ?? (async (p: string) => fs.readFile(p, 'utf8'));
    this.fsGlob = options.fileSystem?.glob ?? (async (pattern: string, root: string) => {
      // naive glob for **/*.{ts,js,rs,md}
      async function walk(dir: string, out: string[]): Promise<void> {
        try {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const e of entries) {
            if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'target' || e.name === 'dist') continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) await walk(full, out);
            else {
              if (/\.(ts|js|tsx|jsx|rs|md)$/.test(e.name)) out.push(full);
            }
          }
        } catch {}
      }
      const out: string[] = [];
      await walk(root, out);
      return out;
    });
  }

  async indexProject(projectId: string, projectRoot: string): Promise<ProjectIndex> {
    const files = await this.fsGlob('**/*', projectRoot);
    const symbols: CodeSymbol[] = [];
    const map: Record<string, CodeSymbol[]> = {};
    for (const file of files) {
      try {
        const content = await this.fsRead(file);
        const syms = await this.symbolProvider(file, content);
        symbols.push(...syms);
        // Key by absolute path AND project-relative path so both query forms hit.
        const canonicalFile = canonicalPath(file);
        map[canonicalFile] = [...syms];
        const relativeFile = canonicalPath(path.relative(projectRoot, file));
        if (relativeFile && relativeFile !== canonicalFile) {
          map[relativeFile] = [...syms];
        }
      } catch {}
    }
    const index: ProjectIndex = { symbols, files, map, indexedAt: this.now() };
    this.cache.set(projectId, index);
    return index;
  }

  getProjectMap(projectId: string): ProjectIndex | null {
    return this.cache.get(projectId) ?? null;
  }

  async findSymbols(query: FindSymbolsQuery): Promise<readonly CodeSymbol[]> {
    const parsed = FindSymbolsQuerySchema.parse(query);
    const index = this.cache.get(parsed.projectId);
    if (!index) throw new Error('Project not indexed, call indexProject first');
    const q = parsed.query.toLowerCase();
    let result = index.symbols.filter((s) => s.name.toLowerCase().includes(q));
    if (parsed.kind) result = result.filter((s) => s.kind === parsed.kind);
    if (parsed.fileFilter) result = result.filter((s) => s.file.includes(parsed.fileFilter!));
    return result.slice(0, parsed.limit);
  }

  async getSymbolInfo(query: GetSymbolInfoQuery, projectRoot: string): Promise<CodeSymbol & { content: string; diagnostics?: string[] }> {
    const parsed = GetSymbolInfoQuerySchema.parse(query);
    const index = this.cache.get(parsed.projectId);
    if (!index) throw new Error('Project not indexed');
    // join (not resolve) keeps root-relative POSIX roots portable on Windows:
    // resolve would inject the current drive letter, which the caller did not
    // supply and which breaks POSIX-style project roots.
    const fullPath = path.isAbsolute(parsed.file)
      ? parsed.file
      : path.join(projectRoot, parsed.file);
    const canonicalLookup = canonicalPath(parsed.file);
    const content = await this.fsRead(fullPath);
    const lines = content.split('\n');
    const lineContent = lines[parsed.line] ?? '';
    // Find closest symbol
    const candidates = (
      index.map[canonicalLookup] ??
      index.map[canonicalPath(fullPath)] ??
      index.symbols.filter(
        (s) =>
          canonicalPath(s.file) === canonicalLookup ||
          canonicalPath(s.file) === canonicalPath(fullPath)
      )
    ).filter((s) => Math.abs(s.line - parsed.line) <= 3);
    const symbol = candidates[0] ?? { name: 'unknown', kind: 'variable' as const, file: parsed.file, line: parsed.line, column: parsed.column ?? 0, signature: lineContent.slice(0, 200) };

    // Extract read-only symbol region (10 lines context)
    const start = Math.max(0, parsed.line - 5);
    const end = Math.min(lines.length, parsed.line + 6);
    const snippet = lines.slice(start, end).join('\n');

    return { ...symbol, content: snippet, diagnostics: [] };
  }

  async listReferences(projectId: string, symbolName: string): Promise<readonly Reference[]> {
    const index = this.cache.get(projectId);
    if (!index) throw new Error('Project not indexed');
    // Naive search for references
    const refs: Reference[] = [];
    for (const file of index.files) {
      try {
        const content = await this.fsRead(file);
        const re = new RegExp(`\\b${symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
        let match: RegExpExecArray | null;
        while ((match = re.exec(content))) {
          const before = content.slice(0, match.index);
          const line = before.split('\n').length - 1;
          const col = before.split('\n').pop()!.length;
          refs.push({ file, line, column: col, preview: content.slice(Math.max(0, match.index - 20), match.index + 80).replace(/\n/g, ' ') });
          if (refs.length >= 200) break;
        }
      } catch {}
      if (refs.length >= 200) break;
    }
    return refs;
  }

  async semanticSearch(projectId: string, query: string, limit = 20): Promise<readonly { symbol: CodeSymbol; score: number }[]> {
    const index = this.cache.get(projectId);
    if (!index) throw new Error('Project not indexed');
    const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const scored = index.symbols.map((sym) => {
      const text = `${sym.name} ${sym.signature ?? ''} ${sym.documentation ?? ''}`.toLowerCase();
      let score = 0;
      for (const t of terms) if (text.includes(t)) score += 1;
      score += sym.name.toLowerCase() === query.toLowerCase() ? 2 : 0;
      return { symbol: sym, score };
    }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
    return scored;
  }

  async readSymbol(projectId: string, file: string, symbolName: string, projectRoot: string): Promise<{ content: string; symbol: CodeSymbol | null }> {
    const fullPath = path.isAbsolute(file) ? file : path.join(projectRoot, file);
    const content = await this.fsRead(fullPath);
    const index = this.cache.get(projectId);
    const symbol = index?.symbols.find((s) => (s.file === file || s.file === fullPath) && s.name === symbolName) ?? null;
    if (!symbol) {
      // fallback: extract 15 lines around first occurrence
      const idx = content.indexOf(symbolName);
      if (idx === -1) return { content: '', symbol: null };
      const before = content.slice(0, idx);
      const line = before.split('\n').length - 1;
      const lines = content.split('\n');
      const snippet = lines.slice(Math.max(0, line - 5), line + 10).join('\n');
      return { content: snippet, symbol: null };
    }
    const lines = content.split('\n');
    const snippet = lines.slice(Math.max(0, symbol.line - 2), symbol.line + 15).join('\n');
    return { content: snippet, symbol };
  }

  async getDiagnostics(projectId: string): Promise<readonly { file: string; line: number; message: string; severity: 'error' | 'warning' }[]> {
    // In real implementation, would query LSP diagnostics. Here return empty unless index missing.
    const index = this.cache.get(projectId);
    if (!index) return [{ file: '', line: 0, message: 'Project not indexed', severity: 'warning' }];
    return [];
  }

  // Governed edits — must go through approval + receipt + audit
  // For SDK we just structure the edit payload; server will enforce governance.

  async editAtSymbol(input: { projectId: string; file: string; symbolName: string; newContent: string; approvalId?: string; projectRoot: string }): Promise<{ diff: string; file: string; approved: boolean }> {
    // This would be guarded by approval system in server
    const fullPath = path.isAbsolute(input.file) ? input.file : path.join(input.projectRoot, input.file);
    const old = await this.fsRead(fullPath);
    // naive replace: replace symbol block
    // For demo, we just append comment with newContent at top and return diff
    const diff = `--- ${fullPath}\n+++ ${fullPath}\n@@ -0,0 +1,1 @@\n+// EDIT at symbol ${input.symbolName}\n+${input.newContent.slice(0, 200)}\n`;
    return { diff, file: fullPath, approved: !!input.approvalId };
  }

  async renameSymbol(input: { projectId: string; oldName: string; newName: string; projectRoot: string }): Promise<{ changedFiles: number; preview: string }> {
    const refs = await this.listReferences(input.projectId, input.oldName);
    return { changedFiles: new Set(refs.map((r) => r.file)).size, preview: `Rename ${input.oldName} -> ${input.newName} affects ${refs.length} locations` };
  }

  async extractFunction(input: { projectId: string; file: string; startLine: number; endLine: number; functionName: string; projectRoot: string }): Promise<{ newFunction: string; callSite: string }> {
    const fullPath = path.isAbsolute(input.file) ? input.file : path.join(input.projectRoot, input.file);
    const content = await this.fsRead(fullPath);
    const lines = content.split('\n');
    const extracted = lines.slice(input.startLine, input.endLine + 1).join('\n');
    const newFunction = `function ${input.functionName}() {\n${extracted}\n}`;
    const callSite = `${input.functionName}();`;
    return { newFunction, callSite };
  }
}
