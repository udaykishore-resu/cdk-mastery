/**
 * Step Functions task handler for the order saga. One function, dispatched on `action`,
 * keeps the example small; in production each step is usually its own function with its
 * own IAM role so the reserve step cannot charge cards.
 *
 * Transient failures are signalled with an error whose `name` matches the Retry policy in
 * saga-stack.ts (`ServiceUnavailable`); permanent failures use `PaymentDeclined`, which the
 * state machine catches and compensates.
 */
export interface SagaInput {
  readonly action: 'reserve' | 'charge' | 'release';
  readonly orderId: string;
  readonly total: number;
  /** Test hook: force a specific outcome without real downstreams. */
  readonly simulate?: 'declined' | 'unavailable';
}

export interface SagaOutput {
  readonly orderId: string;
  readonly action: SagaInput['action'];
  readonly ok: boolean;
  readonly reference: string;
}

class NamedError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

export async function handler(input: SagaInput): Promise<SagaOutput> {
  if (input.simulate === 'unavailable') throw new NamedError('ServiceUnavailable', `${input.action}: downstream unavailable`);
  if (input.action === 'charge' && (input.simulate === 'declined' || input.total <= 0)) {
    throw new NamedError('PaymentDeclined', `order ${input.orderId}: declined`);
  }
  return { orderId: input.orderId, action: input.action, ok: true, reference: `${input.action}-${input.orderId}` };
}
