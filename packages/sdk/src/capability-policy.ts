/**
 * Governed capability inventory and deterministic policy evaluator (E4-S1).
 *
 * This module deliberately accepts only application-owned policy inputs. Model
 * text, tool annotations, and plugin-provided metadata cannot affect a policy
 * decision: callers must translate those untrusted values into a validated
 * CapabilityRequest first.
 */
import { z } from 'zod';

export const CapabilityHealthSchema = z.enum(['healthy', 'degraded', 'unavailable']);
export type CapabilityHealth = z.infer<typeof CapabilityHealthSchema>;

export const CapabilityScopeSchema = z.object({
  projectIds: z.array(z.string().uuid()).max(1_000),
  agentIds: z.array(z.string().min(1).max(255)).max(1_000),
});
export type CapabilityScope = z.infer<typeof CapabilityScopeSchema>;

export const GovernedCapabilitySchema = z.object({
  id: z.string().min(1).max(255),
  name: z.string().min(1).max(255),
  source: z.enum(['native', 'mcp', 'a2a', 'provider', 'skill']),
  version: z.string().min(1).max(100),
  owner: z.string().min(1).max(255),
  inputSchema: z.record(z.string(), z.unknown()),
  risk: z.enum(['low', 'medium', 'high']),
  scope: CapabilityScopeSchema,
  health: CapabilityHealthSchema,
  enabled: z.boolean(),
});
export type GovernedCapability = z.infer<typeof GovernedCapabilitySchema>;

export const CapabilityRequestSchema = z.object({
  projectId: z.string().uuid(),
  agentId: z.string().min(1).max(255),
  capabilityId: z.string().min(1).max(255),
});
export type CapabilityRequest = z.infer<typeof CapabilityRequestSchema>;

export const CapabilityPolicyRuleSchema = z.object({
  id: z.string().min(1).max(255),
  capabilityId: z.string().min(1).max(255).optional(),
  projectId: z.string().uuid().optional(),
  agentId: z.string().min(1).max(255).optional(),
  decision: z.enum(['allow', 'deny', 'require_approval']),
});
export type CapabilityPolicyRule = z.infer<typeof CapabilityPolicyRuleSchema>;

export const CapabilityPolicySchema = z.object({
  version: z.string().min(1).max(100),
  rules: z.array(CapabilityPolicyRuleSchema).max(10_000),
});
export type CapabilityPolicy = z.infer<typeof CapabilityPolicySchema>;

export interface PolicyEvaluation {
  readonly decision: 'allow' | 'deny' | 'require_approval';
  readonly policyVersion: string;
  readonly ruleId: string;
  readonly reason: string;
}

const DEFAULT_DENY_RULE = 'default-deny';

/**
 * Application-owned capability inventory. Duplicate registration replaces the
 * current registration for that stable id, enabling explicit health updates
 * without silently widening scope.
 */
export class CapabilityInventory {
  private readonly values = new Map<string, GovernedCapability>();

  register(candidate: unknown): GovernedCapability {
    const capability = GovernedCapabilitySchema.parse(candidate);
    this.values.set(capability.id, capability);
    return capability;
  }

  get(id: string): GovernedCapability | null {
    return this.values.get(id) ?? null;
  }

  listForScope(projectId: string, agentId: string): readonly GovernedCapability[] {
    return [...this.values.values()].filter((capability) => isInCapabilityScope(capability, projectId, agentId));
  }
}

function isInCapabilityScope(capability: GovernedCapability, projectId: string, agentId: string): boolean {
  return capability.enabled
    && capability.health === 'healthy'
    && capability.scope.projectIds.includes(projectId)
    && capability.scope.agentIds.includes(agentId);
}

function matches(rule: CapabilityPolicyRule, request: CapabilityRequest): boolean {
  return (rule.capabilityId === undefined || rule.capabilityId === request.capabilityId)
    && (rule.projectId === undefined || rule.projectId === request.projectId)
    && (rule.agentId === undefined || rule.agentId === request.agentId);
}

/**
 * Evaluate the most-specific matching policy rule after capability scope and
 * health checks. A tie is deliberately deny-biased. No unknown/untrusted input
 * can override this result because the request schema has no free-form policy
 * or annotation fields.
 */
export function evaluateCapabilityPolicy(
  inventory: CapabilityInventory,
  policyCandidate: unknown,
  requestCandidate: unknown,
): PolicyEvaluation {
  const policy = CapabilityPolicySchema.parse(policyCandidate);
  const request = CapabilityRequestSchema.parse(requestCandidate);
  const capability = inventory.get(request.capabilityId);
  if (!capability) {
    return { decision: 'deny', policyVersion: policy.version, ruleId: DEFAULT_DENY_RULE, reason: 'Capability is not registered.' };
  }
  if (!capability.enabled || capability.health !== 'healthy') {
    return { decision: 'deny', policyVersion: policy.version, ruleId: DEFAULT_DENY_RULE, reason: 'Capability is disabled or unhealthy.' };
  }
  if (!isInCapabilityScope(capability, request.projectId, request.agentId)) {
    return { decision: 'deny', policyVersion: policy.version, ruleId: DEFAULT_DENY_RULE, reason: 'Capability is outside the project or agent scope.' };
  }

  const matchesBySpecificity = policy.rules
    .filter((rule) => matches(rule, request))
    .map((rule) => ({ rule, specificity: Number(rule.capabilityId !== undefined) + Number(rule.projectId !== undefined) + Number(rule.agentId !== undefined) }))
    .sort((left, right) => right.specificity - left.specificity || left.rule.id.localeCompare(right.rule.id));
  const match = matchesBySpecificity[0]?.rule;
  if (!match) {
    return { decision: 'deny', policyVersion: policy.version, ruleId: DEFAULT_DENY_RULE, reason: 'No policy rule grants this capability.' };
  }
  return { decision: match.decision, policyVersion: policy.version, ruleId: match.id, reason: 'Matched application policy rule.' };
}
