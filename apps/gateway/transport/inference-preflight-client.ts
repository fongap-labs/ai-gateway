// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// A private, bounded conversion check: no node selection or Provider attempt.
import {
  buildInferencePreflightHeaders,
  buildProtocolPreflightHeaders,
  type ConversionPreflightApproval,
  INFERENCE_PREFLIGHT_PATH,
  PROTOCOL_PREFLIGHT_PATH,
  isConversionPreflightResult,
} from '../../../packages/contracts/conversion-preflight.ts';
import type { GatewayEnv } from '../../../packages/contracts/runtime.ts';
import type { IrProtocol } from '../../../packages/conversion-core/ir.ts';
import type { ConversionResult } from '../../../packages/conversion-core/result.ts';
import { ConversionError } from '../../../packages/conversion-core/validation.ts';
import { readBodyTextBounded } from '../../../src/protocol/http.ts';
import { configuredInferenceService, InferenceCenterUnavailable } from './inference-client-request.ts';

const MAX_PREFLIGHT_WAIT_MS = 1_500;

export async function checkInferenceConversion(
  env: GatewayEnv,
  invocation: {
    request: Request;
    requestId: string;
    from: IrProtocol;
    to: IrProtocol;
    body: Record<string, unknown>;
    isNonstreamPreferred: boolean;
    deadlineMs: number;
  },
): Promise<ConversionResult> {
  // Only a completely absent Protocol binding uses the legacy Inference preflight.
  // An installed but misconfigured binding must fail closed, without silent bypass.
  const protocolService = env.AIG_PROTOCOL_SERVICE as { fetch?: (request: Request) => Promise<Response> } | undefined;
  const useProtocol = protocolService !== undefined;
  if (useProtocol && (typeof protocolService?.fetch !== 'function' || typeof env.AIG_PROTOCOL_AUTH_KEY !== 'string' || env.AIG_PROTOCOL_AUTH_KEY.length < 32)) {
    throw new InferenceCenterUnavailable();
  }
  const service = useProtocol ? (protocolService as { fetch: (request: Request) => Promise<Response> }) : configuredInferenceService(env);
  const now = Date.now();
  const deadlineMs = Math.min(invocation.deadlineMs, now + MAX_PREFLIGHT_WAIT_MS);
  if (deadlineMs <= now) throw new InferenceCenterUnavailable();
  const headers = useProtocol
    ? buildProtocolPreflightHeaders({ requestId: invocation.requestId, deadlineMs }, env.AIG_PROTOCOL_AUTH_KEY as string)
    : buildInferencePreflightHeaders({ requestId: invocation.requestId, deadlineMs }, env.AIG_INFERENCE_AUTH_KEY as string);
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), deadlineMs - now);
  const onAbort = () => controller.abort();
  if (invocation.request.signal.aborted) onAbort();
  else invocation.request.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const request = new Request(`https://${useProtocol ? 'protocol' : 'inference'}.internal${useProtocol ? PROTOCOL_PREFLIGHT_PATH : INFERENCE_PREFLIGHT_PATH}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        from: invocation.from,
        to: invocation.to,
        body: invocation.body,
        isNonstreamPreferred: invocation.isNonstreamPreferred,
      }),
      signal: controller.signal,
    });
    const response = await service.fetch(request);
    if (response.status !== 200 && response.status !== 422) throw new InferenceCenterUnavailable();
    const read = await readBodyTextBounded(response, 8192, deadlineMs);
    if (read.isTruncated) throw new InferenceCenterUnavailable();
    let parsed: unknown;
    try {
      parsed = JSON.parse(read.text);
    } catch {
      throw new InferenceCenterUnavailable();
    }
    if (!isConversionPreflightResult(parsed)) throw new InferenceCenterUnavailable();
    if (!parsed.ok) {
      throw new ConversionError('conversion_not_supported', undefined, parsed.requestField ? { requestField: parsed.requestField } : {});
    }
    if (response.status !== 200) throw new InferenceCenterUnavailable();
    const approved: ConversionPreflightApproval = parsed;
    return {
      body: invocation.body,
      fidelity: approved.fidelity,
      diagnostics: approved.diagnostics,
      ...(approved.structuredOutput ? { structuredOutput: approved.structuredOutput } : {}),
    };
  } catch (error) {
    if (error instanceof ConversionError) throw error;
    throw new InferenceCenterUnavailable();
  } finally {
    clearTimeout(timerId);
    invocation.request.signal.removeEventListener('abort', onAbort);
  }
}
