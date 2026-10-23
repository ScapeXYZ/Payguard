// Synthetic, sanitized model of the independently verified 1 USDC payment:
// exact 1_000_000 base units, agent -> guard pay -> token ft_transfer, with
// terminal native system gas refunds. These IDs are test placeholders, not
// historical on-chain evidence. Nothing here is published into the app feed.
export const ids = {
  hash: '1'.repeat(44), guardReceipt: '2'.repeat(44), ftReceipt: '3'.repeat(44),
  ftRefund: '4'.repeat(44), guardRefund: '5'.repeat(44), continuation: '6'.repeat(44),
};
export const guard = 'guard.testnet', agent = 'agent.testnet', token = 'token.testnet', merchant = 'merchant.testnet';
export const payment = { request_id: 'sanitized-one-usdc', token_id: token, recipient_id: merchant, amount: '1000000' };
const args = value => Buffer.from(JSON.stringify(value)).toString('base64');
const outcome = (id, executor, status, children = []) => ({ id, block_hash: '7'.repeat(44), outcome: {
  executor_id: executor, status, receipt_ids: children, logs: [], gas_burnt: 100,
} });
const refund = id => ({ receipt_id: id, predecessor_id: 'system', receiver_id: agent,
  receipt: { Action: { gas_price: '0', actions: [{ Transfer: { deposit: '123' } }] } } });
export function transaction() {
  return {
    final_execution_status: 'FINAL', status: { SuccessValue: '' },
    transaction: { hash: ids.hash, signer_id: agent, receiver_id: guard, actions: [
      { FunctionCall: { method_name: 'pay', args: args(payment), deposit: '0', gas: 100000000000000 } },
    ] },
    transaction_outcome: outcome(ids.hash, agent, { SuccessReceiptId: ids.guardReceipt }, [ids.guardReceipt]),
    receipts_outcome: [
      outcome(ids.guardReceipt, guard, { SuccessReceiptId: ids.ftReceipt }, [ids.ftReceipt, ids.guardRefund]),
      outcome(ids.ftReceipt, token, { SuccessValue: '' }, [ids.ftRefund]),
      outcome(ids.ftRefund, agent, { SuccessValue: '' }),
      outcome(ids.guardRefund, agent, { SuccessValue: '' }),
    ],
    receipts: [
      { receipt_id: ids.ftReceipt, predecessor_id: guard, receiver_id: token, receipt: { Action: {
        gas_price: '100000000', actions: [{ FunctionCall: { method_name: 'ft_transfer',
          args: args({ receiver_id: merchant, amount: payment.amount }), deposit: '1', gas: 30000000000000 } }],
      } } }, refund(ids.ftRefund), refund(ids.guardRefund),
    ],
  };
}
export function entry(tx = transaction()) {
  return { version: 1, state: 'succeeded', transaction_hash: ids.hash,
    intent: { network: 'testnet', guard, agent, payment: { ...payment } },
    events: [{ type: 'receipt_verification', at: '2026-10-23T10:00:00.000Z', data: tx }] };
}
export function envelope(records, source = 'runner_journal') {
  return { schema: 'payguard.evidence.v2', network: 'testnet', guard_id: guard,
    generated_at: '2026-10-23T10:01:00.000Z', source, records };
}
