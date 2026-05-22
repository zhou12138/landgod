import type { ToolBinding } from './mcp-tool-registry';
import type { ManagedClientRuntimeConfig } from './types';
import { isDemoMode } from './config';

const REDACTED_VALUE = '***REDACTED***';

type ManagedClientResponseMode = ManagedClientToolResponseDefenseContext['responseMode'];

interface ResponseInspectionLimit {
  maxChars: number;
  maxLines: number;
}

interface RedactionRule {
  code: string;
  category: ManagedClientDefenseFindingCategory;
  severity: ManagedClientDefenseSeverity;
  pattern: RegExp;
  replacement?: string | ((substring: string, ...args: any[]) => string);
  message: string;
  block?: boolean;
}

const COMPUTER_USE_TOOL_NAMES = new Set([
  'computer_screenshot',
  'computer_click',
  'computer_type',
  'computer_scroll',
]);

const RESPONSE_LIMITS: Record<ManagedClientResponseMode, ResponseInspectionLimit> = {
  'status-only': { maxChars: 1024, maxLines: 20 },
  handle: { maxChars: 4096, maxLines: 80 },
  full: { maxChars: 16 * 1024, maxLines: 250 },
  error: { maxChars: 6 * 1024, maxLines: 120 },
};

const RESPONSE_REDACTION_RULES: RedactionRule[] = [
  {
    code: 'private-key-material',
    category: 'response',
    severity: 'critical',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/gi,
    replacement: REDACTED_VALUE,
    message: 'Response contained private key material',
    block: true,
  },
  {
    code: 'connection-string',
    category: 'response',
    severity: 'high',
    pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|mssql):\/\/[^\s"'<>]+/gi,
    replacement: REDACTED_VALUE,
    message: 'Response contained a credential-bearing connection string',
  },
  {
    code: 'aws-access-key',
    category: 'response',
    severity: 'high',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: REDACTED_VALUE,
    message: 'Response contained an AWS access key',
  },
  {
    code: 'github-token',
    category: 'response',
    severity: 'high',
    pattern: /\bgh(?:p|o|u|s|r)_[A-Za-z0-9_]{20,}\b/g,
    replacement: REDACTED_VALUE,
    message: 'Response contained a GitHub token',
  },
  {
    code: 'bearer-token',
    category: 'response',
    severity: 'high',
    pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
    replacement: `Bearer ${REDACTED_VALUE}`,
    message: 'Response contained a bearer token',
  },
  {
    code: 'jwt-token',
    category: 'response',
    severity: 'medium',
    pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9._-]+\.[A-Za-z0-9_-]{6,}\b/g,
    replacement: REDACTED_VALUE,
    message: 'Response contained a JWT-like token',
  },
  {
    code: 'dotenv-secret',
    category: 'response',
    severity: 'high',
    pattern: /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|CLIENT_SECRET)[A-Z0-9_]*)\s*=\s*([^\r\n]+)/gi,
    replacement: (_substring: string, key: string) => `${key}=${REDACTED_VALUE}`,
    message: 'Response contained dotenv-style secret material',
  },
  {
    code: 'generic-secret-assignment',
    category: 'response',
    severity: 'medium',
    pattern: /\b(token|secret|password|passwd|api[_-]?key)\b\s*[:=]\s*(["'])?([^\s,;]+)\2?/gi,
    replacement: (_substring: string, key: string) => `${key}=${REDACTED_VALUE}`,
    message: 'Response contained a generic secret assignment',
  },
];

function getEffectiveResponseLimit(context: ManagedClientToolResponseDefenseContext): ResponseInspectionLimit {
  // Computer-use tools return binary image data — never truncate.
  if (COMPUTER_USE_TOOL_NAMES.has(context.toolName)) {
    return { maxChars: Infinity, maxLines: Infinity };
  }

  const baseLimit = RESPONSE_LIMITS[context.responseMode];
  let maxChars = baseLimit.maxChars;
  let maxLines = baseLimit.maxLines;

  if (context.binding.source === 'external') {
    maxChars = Math.min(maxChars, context.responseMode === 'full' ? 8 * 1024 : maxChars);
    maxLines = Math.min(maxLines, context.responseMode === 'full' ? 120 : maxLines);
  }

  if (context.toolName.startsWith('session_')) {
    maxChars = Math.min(maxChars, 8 * 1024);
    maxLines = Math.min(maxLines, 120);
  }

  return { maxChars, maxLines };
}

function countLines(value: string): number {
  if (!value) {
    return 0;
  }

  return value.split(/\r?\n/).length;
}

function truncateLines(value: string, maxLines: number): { value: string; truncated: boolean; lineCount: number } {
  const lines = value.split(/\r?\n/);
  if (lines.length <= maxLines) {
    return {
      value,
      truncated: false,
      lineCount: lines.length,
    };
  }

  return {
    value: `${lines.slice(0, maxLines).join('\n')}\n...[truncated ${lines.length - maxLines} lines]`,
    truncated: true,
    lineCount: lines.length,
  };
}

function truncateChars(value: string, maxChars: number): { value: string; truncated: boolean; originalLength: number } {
  if (value.length <= maxChars) {
    return {
      value,
      truncated: false,
      originalLength: value.length,
    };
  }

  return {
    value: `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`,
    truncated: true,
    originalLength: value.length,
  };
}

function redactSensitiveContent(value: string): {
  redactedText: string;
  findings: ManagedClientDefenseFinding[];
  blocked: boolean;
} {
  let redactedText = value;
  const findings: ManagedClientDefenseFinding[] = [];
  let blocked = false;

  for (const rule of RESPONSE_REDACTION_RULES) {
    const matches = Array.from(redactedText.matchAll(rule.pattern));
    if (matches.length === 0) {
      continue;
    }

    redactedText = typeof rule.replacement === 'function'
      ? redactedText.replace(rule.pattern, rule.replacement)
      : redactedText.replace(rule.pattern, rule.replacement ?? REDACTED_VALUE);
    findings.push({
      category: rule.category,
      severity: rule.severity,
      code: rule.code,
      message: rule.message,
      metadata: {
        matchCount: matches.length,
      },
    });
    blocked = blocked || Boolean(rule.block);
  }

  return {
    redactedText,
    findings,
    blocked,
  };
}

function buildPolicyFinding(
  severity: ManagedClientDefenseSeverity,
  code: string,
  message: string,
  metadata?: Record<string, unknown>,
): ManagedClientDefenseFinding {
  return {
    category: 'policy',
    severity,
    code,
    message,
    metadata,
  };
}

export type ManagedClientDefenseFindingCategory = 'identity' | 'instruction' | 'prompt' | 'tool' | 'response' | 'policy';
export type ManagedClientDefenseSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface ManagedClientDefenseFinding {
  category: ManagedClientDefenseFindingCategory;
  severity: ManagedClientDefenseSeverity;
  code: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface ManagedClientToolCallDefenseContext {
  requestId: string;
  connectionId: string | null;
  toolName: string;
  argumentsPayload: Record<string, unknown>;
  rawPayload: Record<string, unknown>;
  binding: ToolBinding;
  runtimeConfig: Pick<ManagedClientRuntimeConfig, 'baseUrl' | 'clientId' | 'clientName' | 'mode'>;
}

export interface ManagedClientToolResponseDefenseContext {
  requestId: string;
  connectionId: string | null;
  toolName: string;
  binding: ToolBinding;
  success: boolean;
  responseText: string;
  responseMode: 'full' | 'handle' | 'status-only' | 'error';
  rawResult?: Record<string, unknown>;
  runtimeConfig: Pick<ManagedClientRuntimeConfig, 'baseUrl' | 'clientId' | 'clientName' | 'mode'>;
}

export interface ManagedClientToolCallDefenseResult {
  allowed: boolean;
  argumentsPayload: Record<string, unknown>;
  findings: ManagedClientDefenseFinding[];
  code?: string;
  message?: string;
}

export interface ManagedClientToolResponseDefenseResult {
  allowed: boolean;
  responseText: string;
  findings: ManagedClientDefenseFinding[];
  code?: string;
  message?: string;
}

export interface ManagedClientDefenseLayer {
  inspectToolCall(context: ManagedClientToolCallDefenseContext): Promise<ManagedClientToolCallDefenseResult>;
  inspectToolResponse(context: ManagedClientToolResponseDefenseContext): Promise<ManagedClientToolResponseDefenseResult>;
}

class NoopManagedClientDefenseLayer implements ManagedClientDefenseLayer {
  async inspectToolCall(context: ManagedClientToolCallDefenseContext): Promise<ManagedClientToolCallDefenseResult> {
    return {
      allowed: true,
      argumentsPayload: context.argumentsPayload,
      findings: [],
    };
  }

  async inspectToolResponse(context: ManagedClientToolResponseDefenseContext): Promise<ManagedClientToolResponseDefenseResult> {
    // Demo mode: skip all redaction, truncation, and size limits.
    if (isDemoMode()) {
      return {
        allowed: true,
        responseText: context.responseText,
        findings: [],
      };
    }

    const findings: ManagedClientDefenseFinding[] = [];
    const normalizedResponse = context.responseText.replace(/\r\n/g, '\n');
    const effectiveLimit = getEffectiveResponseLimit(context);
    const redactionResult = redactSensitiveContent(normalizedResponse);

    findings.push(...redactionResult.findings);

    if (redactionResult.blocked) {
      return {
        allowed: false,
        responseText: '',
        findings,
        code: 'sensitive_response_blocked',
        message: `Desktop tool response blocked for ${context.toolName}: sensitive material detected`,
      };
    }

    let safeResponseText = redactionResult.redactedText;

    if (context.responseMode === 'status-only' && safeResponseText.length > effectiveLimit.maxChars) {
      findings.push(buildPolicyFinding(
        'medium',
        'status-only-downgraded',
        'Status-only response exceeded the outbound size limit and was replaced with a minimal status payload',
        {
          originalLength: safeResponseText.length,
          maxChars: effectiveLimit.maxChars,
        },
      ));
      safeResponseText = JSON.stringify({ success: context.success });
    }

    const lineTruncation = truncateLines(safeResponseText, effectiveLimit.maxLines);
    safeResponseText = lineTruncation.value;
    if (lineTruncation.truncated) {
      findings.push(buildPolicyFinding(
        'medium',
        'response-line-truncated',
        'Response exceeded the maximum outbound line count and was truncated',
        {
          lineCount: lineTruncation.lineCount,
          maxLines: effectiveLimit.maxLines,
        },
      ));
    }

    const charTruncation = truncateChars(safeResponseText, effectiveLimit.maxChars);
    safeResponseText = charTruncation.value;
    if (charTruncation.truncated) {
      findings.push(buildPolicyFinding(
        'medium',
        'response-char-truncated',
        'Response exceeded the maximum outbound size and was truncated',
        {
          originalLength: charTruncation.originalLength,
          maxChars: effectiveLimit.maxChars,
        },
      ));
    }

    if (!safeResponseText.trim()) {
      safeResponseText = context.success ? '(no output)' : 'Tool execution failed';
    }

    return {
      allowed: true,
      responseText: safeResponseText,
      findings,
    };
  }
}

export function createManagedClientDefenseLayer(_config: ManagedClientRuntimeConfig): ManagedClientDefenseLayer {
  return new NoopManagedClientDefenseLayer();
}