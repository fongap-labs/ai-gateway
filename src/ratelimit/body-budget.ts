import { createBodyAdmissionPool } from '../../packages/transport/body-admission.ts';

export { BODY_BYTES_IN_FLIGHT_BUDGET } from '../../packages/transport/body-admission.ts';

const gatewayBodyPool = createBodyAdmissionPool();

export function admitRequestBody(declaredBytes: number, worstCaseBytes: number): (() => void) | null {
  return gatewayBodyPool.admit(declaredBytes, worstCaseBytes);
}

export function admitMeteredRequestBody(
  declaredBytes: number,
  hasBody: boolean,
): { observe: (actualBytes: number) => boolean; release: () => void } | null {
  return gatewayBodyPool.admitGrowing(declaredBytes, hasBody);
}

export function __resetBodyBudgetForTests(): void {
  gatewayBodyPool.reset();
}
