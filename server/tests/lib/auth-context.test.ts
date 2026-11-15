/**
 * lib/auth-context.test.ts — Unit tests for auth-context utilities.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import {
  resolvePrincipal,
  requireScope,
  safeJson,
  parse,
  fail,
} from '../../src/lib/auth-context.js';
import { ApiError } from '../../src/lib/errors.js';

vi.mock('../../src/lib/security.js', () => ({
  authenticate: vi.fn(),
  hasScope: (principal: { scopes: string[] } | null, scope: string): boolean => {
    if (!principal) return false;
    if (principal.scopes.includes(scope)) return true;
    for (const granted of principal.scopes) {
      if (granted.endsWith('.*') && scope.startsWith(granted.slice(0, -1))) return true;
    }
    return false;
  },
}));

vi.mock('../db/client.js', () => ({
  db: {},
}));

describe('auth-context', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const mockContext = (headers: Record<string, string>, getVals: Record<string, any> = {}) => {
    const store = new Map<string, any>(Object.entries(getVals));
    return {
      get: (key: string) => store.get(key),
      set: (key: string, val: any) => store.set(key, val),
      req: {
        header: (name: string) => headers[name.toLowerCase()],
        json: vi.fn(),
      },
      json: vi.fn((data, status) => ({ data, status })),
    } as any;
  };

  describe('resolvePrincipal', () => {
    it('should return cached principal if present', async () => {
      const { authenticate } = await import('../../src/lib/security.js');
      const principal = { id: 'p1', scopes: ['read'] };
      const c = mockContext({}, { principal });

      const res = await resolvePrincipal(c);
      expect(res).toBe(principal);
      expect(authenticate).not.toHaveBeenCalled();
    });

    it('should authenticate using Authorization header if no cache', async () => {
      const { authenticate } = await import('../../src/lib/security.js');
      const c = mockContext({ authorization: 'Bearer my-key-123' });
      (authenticate as any).mockResolvedValue({ id: 'p2', scopes: ['write'] });

      const res = await resolvePrincipal(c);
      expect(res).toEqual({ id: 'p2', scopes: ['write'] });
      expect(authenticate).toHaveBeenCalledWith(expect.any(Object), 'my-key-123');
    });

    it('should strip Bearer prefix case-insensitively', async () => {
      const { authenticate } = await import('../../src/lib/security.js');
      const c = mockContext({ authorization: 'bearer my-key-123' });
      (authenticate as any).mockResolvedValue({ id: 'p2', scopes: ['write'] });

      const res = await resolvePrincipal(c);
      expect(res).toEqual({ id: 'p2', scopes: ['write'] });
      expect(authenticate).toHaveBeenCalledWith(expect.any(Object), 'my-key-123');
    });

    it('should return null if no token header', async () => {
      const { authenticate } = await import('../../src/lib/security.js');
      const c = mockContext({});
      (authenticate as any).mockResolvedValue(null);

      const res = await resolvePrincipal(c);
      expect(res).toBeNull();
      expect(authenticate).toHaveBeenCalledWith(expect.any(Object), null);
    });

    it('should work with custom headers or malformed bearer token', async () => {
      const { authenticate } = await import('../../src/lib/security.js');
      const c = mockContext({ authorization: 'token123' });
      (authenticate as any).mockResolvedValue(null);

      const res = await resolvePrincipal(c);
      expect(res).toBeNull();
      expect(authenticate).toHaveBeenCalledWith(expect.any(Object), 'token123');
    });
  });

  describe('requireScope', () => {
    it('should throw ApiError UNAUTHORIZED if no principal resolved', async () => {
      const { authenticate } = await import('../../src/lib/security.js');
      const c = mockContext({});
      c.get = () => undefined;
      (authenticate as any).mockResolvedValue(null);

      await expect(requireScope(c, 'read' as any)).rejects.toThrowError(
        new ApiError('UNAUTHORIZED', 'Authentication required.')
      );
    });

    it('should throw ApiError FORBIDDEN if missing scope', async () => {
      const principal = { id: 'p1', scopes: ['read'] };
      const c = mockContext({}, { principal });

      await expect(requireScope(c, 'admin' as any)).rejects.toThrowError(
        new ApiError('FORBIDDEN', 'Missing required scope: admin')
      );
    });

    it('should succeed and return principal if scope is present', async () => {
      const principal = { id: 'p1', scopes: ['read', 'write'] };
      const c = mockContext({}, { principal });

      const res = await requireScope(c, 'write' as any);
      expect(res).toBe(principal);
    });

    it('should support checking scopes on principal with empty scopes array', async () => {
      const principal = { id: 'p1', scopes: [] };
      const c = mockContext({}, { principal });

      await expect(requireScope(c, 'read' as any)).rejects.toThrowError(
        new ApiError('FORBIDDEN', 'Missing required scope: read')
      );
    });
  });

  describe('safeJson', () => {
    it('should parse valid JSON', async () => {
      const c = mockContext({});
      c.req.json.mockResolvedValue({ key: 'val' });

      const res = await safeJson(c);
      expect(res).toEqual({ key: 'val' });
    });

    it('should throw ApiError VALIDATION_ERROR on invalid JSON', async () => {
      const c = mockContext({});
      c.req.json.mockRejectedValue(new Error('Invalid JSON'));

      await expect(safeJson(c)).rejects.toThrowError(
        new ApiError('VALIDATION_ERROR', 'Request body is not valid JSON.')
      );
    });
  });

  describe('parse (zod validation)', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number().min(18),
    });

    it('should validate and return correct data', () => {
      const data = { name: 'Alice', age: 25 };
      const result = parse(schema, data);
      expect(result).toEqual(data);
    });

    it('should throw ApiError on validation failure', () => {
      const data = { name: 'Alice', age: 15 };
      expect(() => parse(schema, data)).toThrowError(
        new ApiError('VALIDATION_ERROR', 'age: Too small: expected number to be >=18')
      );
    });

    it('should handle nested paths in schema validation error format', () => {
      const complexSchema = z.object({
        user: z.object({
          email: z.string().email(),
        }),
      });
      const data = { user: { email: 'bad-email' } };
      expect(() => parse(complexSchema, data)).toThrowError(
        new ApiError('VALIDATION_ERROR', 'user.email: Invalid email address')
      );
    });
  });

  describe('fail', () => {
    it('should handle ApiError and return correct status', () => {
      const c = mockContext({}, { requestId: 'req-id-1' });
      const error = new ApiError('FORBIDDEN', 'Access denied');

      fail(c, error);
      expect(c.json).toHaveBeenCalledWith(
        {
          ok: false,
          error: { code: 'FORBIDDEN', message: 'Access denied', status: 403 },
          traceId: 'req-id-1',
        },
        403
      );
    });

    it('should handle generic errors as INTERNAL_ERROR 500', () => {
      const c = mockContext({}, { requestId: 'req-id-2' });
      const error = new Error('Database crash');

      fail(c, error);
      expect(c.json).toHaveBeenCalledWith(
        {
          ok: false,
          error: { code: 'INTERNAL_ERROR', message: 'Database crash' },
          traceId: 'req-id-2',
        },
        500
      );
    });

    it('should handle string error throws safely', () => {
      const c = mockContext({}, { requestId: 'req-id-3' });

      fail(c, 'Some weird error string');
      expect(c.json).toHaveBeenCalledWith(
        {
          ok: false,
          error: { code: 'INTERNAL_ERROR', message: 'Internal error' },
          traceId: 'req-id-3',
        },
        500
      );
    });
  });
});
