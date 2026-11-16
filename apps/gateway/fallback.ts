import { highRiskSemanticLoss } from '../../packages/conversion-core/fidelity-policy.ts';
import { isMatrixPair } from '../../packages/conversion-core/protocol-pairs.ts';
import { getLimits } from '../../src/config/timeouts.ts';
import type { IrProtocol } from '../../src/conversion/matrix/ir.ts';
import type { ConversionResult } from '../../src/conversion/result.ts';
import { ConversionError } from '../../src/conversion/validation.ts';
import { InferenceCenterUnavailable } from '../../src/inference/inference-client-request.ts';
import { getLogger } from '../../src/observability/logger.ts';
import type { ConversionContext, LoopContext } from '../../src/types/request.ts';
import type { RoutableRequest, TierMap } from '../../src/types/scheduler.ts';
import { buildBudgetExhaustedResponse, gatewayError } from './response/errors.ts';
import { computeTierCaps } from './scheduling/tier-policy.ts';
import { checkInferenceConversion } from './transport/inference-preflight-client.ts';
import { reuseRequestConversionPreflight } from './transport/request-conversion-cache.ts';

function routeToIrProtocol(route: string): IrProtocol | null {
  switch (route) {
    case 'openai_chat':
      return 'openai_chat';
    case 'openai_responses':
      return 'openai_responses';
    case 'anthropic_messages':
      return 'anthropic';
    default:
      return null;
  }
}

function fallbackToIrProtocol(fb: { protocol: string; surface: string }): IrProtocol | null {
  if (fb.protocol === 'openai' && fb.surface === 'chat_completions') return 'openai_chat';
  if (fb.protocol === 'openai' && fb.surface === 'responses') return 'openai_responses';
  if (fb.protocol === 'anthropic' && fb.surface === 'messages') return 'anthropic';
  return null;
}

type TierLoopRunner = (
  loopCtx: LoopContext,
  reqDescriptor: RoutableRequest,
  conversionContext: ConversionContext | null,
  overrideTierCaps: TierMap<number> | null,
) => Promise<Response | null>;

export async function runFallbackChain({
  loopCtx,
  route,
  requestedModel,
  runTierLoop,
}: {
  loopCtx: LoopContext;
  route: string;
  requestedModel: string;
  runTierLoop: TierLoopRunner;
}): Promise<Response | null> {
  const { env, requestId, exposeUpstreamInfo, request, state, policy, failoverBudgetMs, requestStartMs, tiers, bodyJson, knownModels, feasibility } =
    loopCtx;
  const fallbacks = feasibility?.fallbacks ?? [];
  const logger = getLogger(env);
  let conversionRejectedCount = 0;
  let convertedTargetCount = 0;
  const unsupportedRequestFields = new Set<string>();
  let hasOtherRejection = false;

  for (const fb of fallbacks) {
    if (state.logicalAttempts >= policy.maxAttempts || state.retryShed) break;
    const remainingBudgetMs = failoverBudgetMs - (Date.now() - requestStartMs);
    if (remainingBudgetMs <= 0) {
      state.conversionRejections = (state.conversionRejections ?? 0) + conversionRejectedCount;
      return buildBudgetExhaustedResponse(request, env, route, requestId, requestedModel, state, exposeUpstreamInfo);
    }
    const fbReqDescriptor: RoutableRequest = { model: requestedModel, protocol: fb.protocol, surface: fb.surface, bodyChars: loopCtx.bodyChars };
    let conversionResult: ConversionResult;
    const isNonstreamPreferred = getLimits(env).conversionPreferNonstream && bodyJson.stream !== true;
    try {
      const from = routeToIrProtocol(route);
      const to = fallbackToIrProtocol(fb);
      if (!from || !to || !isMatrixPair(from, to)) continue;
      conversionResult = await reuseRequestConversionPreflight(state, bodyJson, JSON.stringify([from, to, isNonstreamPreferred]), () =>
        checkInferenceConversion(env, {
          request,
          requestId,
          from,
          to,
          body: bodyJson,
          isNonstreamPreferred,
          deadlineMs: requestStartMs + failoverBudgetMs,
        }),
      );
    } catch (e) {
      if (e instanceof InferenceCenterUnavailable) {
        return gatewayError(
          request,
          env,
          route,
          503,
          'Private inference conversion preflight is unavailable.',
          requestId,
          undefined,
          undefined,
          'gateway_inference_preflight_unavailable',
        );
      }
      if (e instanceof ConversionError) {
        conversionRejectedCount++;
        if (e.requestField) unsupportedRequestFields.add(e.requestField);
        else hasOtherRejection = true;
        const reason = String(e.message || e.code || 'conversion_not_supported').slice(0, 300);
        logger.error(
          JSON.stringify({
            event: 'fallback_conversion_skipped',
            request_id: requestId,
            route,
            fallback_protocol: fb.protocol,
            fallback_surface: fb.surface,
            reason,
          }),
        );
        continue;
      }
      throw e;
    }

    logger.debug(
      JSON.stringify({
        event: 'fallback_conversion',
        request_id: requestId,
        route,
        fallback_protocol: fb.protocol,
        fallback_surface: fb.surface,
        fidelity: conversionResult.fidelity,
        diagnostic_count: conversionResult.diagnostics.length,
        diagnostics: conversionResult.diagnostics,
        ...(conversionResult.structuredOutput ? { structured_output_strategy: conversionResult.structuredOutput.strategy } : {}),
      }),
    );

    const highRiskLoss = highRiskSemanticLoss(conversionResult);
    if (highRiskLoss.length > 0) {
      conversionRejectedCount++;
      hasOtherRejection = true;
      logger.error(
        JSON.stringify({
          event: 'fallback_conversion_skipped',
          request_id: requestId,
          route,
          fallback_protocol: fb.protocol,
          fallback_surface: fb.surface,
          reason: 'high_risk_semantic_loss',
          features: highRiskLoss,
        }),
      );
      continue;
    }

    convertedTargetCount++;
    const fbTierCaps = computeTierCaps(
      tiers,
      fbReqDescriptor,
      state.attempted,
      policy,
      knownModels,
      policy.maxInFlight ?? null,
      state.tierAttemptsUsed,
    );
    const conversionContext: ConversionContext = {
      convertedBody: conversionResult.body,
      fallbackProtocol: fb.protocol,
      fallbackSurface: fb.surface,
      clientRoute: route,
      isNonstreamPreferred,
    };
    const fbResult = await runTierLoop(loopCtx, fbReqDescriptor, conversionContext, fbTierCaps);
    if (fbResult) return fbResult;
  }

  state.conversionRejections = (state.conversionRejections ?? 0) + conversionRejectedCount;
  if (conversionRejectedCount > 0 && convertedTargetCount === 0 && state.dispatches === 0) {
    if (!feasibility?.nativeSupported && !hasOtherRejection && unsupportedRequestFields.size > 0) {
      const fields = [...unsupportedRequestFields].map((field) => field.slice(0, 64));
      const names = fields.map((field) => `"${field}"`).join(', ');
      return gatewayError(
        request,
        env,
        route,
        400,
        `Request field ${names} is not supported: no upstream configured for this model can carry it. Remove it and retry.`,
        requestId,
        {
          requested_model: requestedModel,
          unsupported_fields: fields,
          failure_kind: 'unsupported_request_field',
        },
        undefined,
        'gateway_unsupported_request_field',
      );
    }
    return gatewayError(
      request,
      env,
      route,
      502,
      'Configured protocol fallback cannot represent this request.',
      requestId,
      {
        requested_model: requestedModel,
        attempts: state.logicalAttempts,
        dispatches: state.dispatches,
        hedges: state.hedges,
        failure_kind: 'conversion_not_supported',
      },
      undefined,
      'gateway_conversion_not_supported',
    );
  }

  return null;
}
