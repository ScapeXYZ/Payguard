const matches = (v, re) => typeof v === 'string' && re.exec(v)?.[0] === v;
const success = s => s && (Object.hasOwn(s, 'SuccessValue') || Object.hasOwn(s, 'SuccessReceiptId'));

// A successful FT call may produce protocol gas refunds. Verify their bodies
// and terminal outcomes explicitly; arbitrary contract continuations stay unverified.
function onlyRefundChildren(ft, data, agent) {
  return Array.isArray(ft?.outcome?.receipt_ids) && ft.outcome.receipt_ids.every(child => {
    const bodies = (data.receipts ?? []).filter(r => r?.receipt_id === child);
    const outcome = data.receipts_outcome.find(o => o.id === child)?.outcome;
    if (bodies.length !== 1) return false;
    const r = bodies[0], action = r.receipt?.Action;
    const transfer = action?.actions?.[0]?.Transfer;
    return r.predecessor_id === 'system' && r.receiver_id === agent &&
      action.gas_price === '0' && action.actions.length === 1 &&
      matches(transfer?.deposit, /^[1-9][0-9]*$/) &&
      outcome?.executor_id === agent && Object.hasOwn(outcome.status ?? {}, 'SuccessValue') &&
      Array.isArray(outcome.receipt_ids) && outcome.receipt_ids.length === 0;
  });
}

export function findMatchingPaymentTransfer(data, { guard, token, recipient, amount }) {
  const outcomes = Array.isArray(data?.receipts_outcome) ? data.receipts_outcome : [];
  const roots = data?.transaction_outcome?.outcome?.receipt_ids ?? [];
  const guardOutcome = outcomes.find(o => roots.includes(o.id) && o.outcome?.executor_id === guard);
  if (!guardOutcome || !success(guardOutcome.outcome?.status)) return null;

  return (data.receipts ?? []).find(receipt => {
    if (!guardOutcome.outcome.receipt_ids?.includes(receipt.receipt_id) ||
        receipt.predecessor_id !== guard || receipt.receiver_id !== token) return false;
    const actions = receipt.receipt?.Action?.actions;
    if (!Array.isArray(actions) || actions.length !== 1) return false;
    const call = actions[0]?.FunctionCall;
    if (call?.method_name !== 'ft_transfer') return false;
    try {
      const args = JSON.parse(Buffer.from(call.args, 'base64').toString('utf8'));
      return args.receiver_id === recipient && args.amount === amount;
    } catch { return false; }
  });
}

export function verifyPaymentTransfer(data, { guard, agent, token, recipient, amount }) {
  const transfer = findMatchingPaymentTransfer(data, { guard, token, recipient, amount });
  if (!transfer) return 'unverified';

  const outcomes = Array.isArray(data?.receipts_outcome) ? data.receipts_outcome : [];
  const ft = outcomes.find(o => o.id === transfer.receipt_id && o.outcome?.executor_id === token);
  if (Object.hasOwn(ft?.outcome?.status ?? {}, 'Failure')) return 'failed';
  return Object.hasOwn(ft?.outcome?.status ?? {}, 'SuccessValue') && onlyRefundChildren(ft, data, agent)
    ? 'succeeded' : 'matched';
}
