import { formatMoney } from '../../lib/format/money';

export function LoanRow({ loan }: { loan: { principal: number; currency: string } }) {
  return <td>{formatMoney(loan.principal, loan.currency)}</td>;
}
