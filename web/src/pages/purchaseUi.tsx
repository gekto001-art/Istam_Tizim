import { fmtNum } from '../components/ui';
import { CURRENCIES, type PaymentStatus, type PurchaseStatus } from '../types';

/** Ta'minot sahifalari uchun umumiy yorliqlar (Sheets "Zakaz&Tracking" dagi nomlar) */
export const PURCHASE_STATUS: Record<PurchaseStatus, [string, string]> = {
  negotiation: ['Kelishuvda', 'warn'],
  rejected: ['Rad etildi', 'bad'],
  preparing: ['Tayyorlanmoqda', 'good'],
  in_transit: ["Yo'lda", 'good'],
  arrived: ['Yetib keldi', 'good'],
  closed: ['Yopildi', 'muted'],
  cancelled: ['Bekor qilindi', 'muted'],
};
export const PAYMENT_STATUS: Record<PaymentStatus, string> = {
  unpaid: "To'lanmagan",
  advance: "Avans to'langan",
  partial: "Qisman to'langan",
  paid: "To'liq to'langan",
};
/** Tracking uchun tez tanlanadigan qiymatlar (Sheets'dagidek) */
export const TRACKING_SUGGEST = ['Bojxona', 'Abu Saxiy'];

export const money = (v: string | number | null | undefined) => (v == null || v === '' ? '—' : fmtNum(Math.round(Number(v) * 100) / 100, 2));
export const plain = (v: string | number | null | undefined) => (v == null || v === '' ? '' : String(Number(v)));
/** "1 046,5" → 1046.5; bo'sh → NaN */
export const num = (s: string) => (s.trim() === '' ? NaN : Number(s.replace(/\s/g, '').replace(',', '.')));
export const cur = (c: string) => CURRENCIES[c] ?? c;

export function StatusPill({ status }: { status: PurchaseStatus | null }) {
  if (!status) return <span className="pill muted">yuborilmagan</span>;
  const [label, tone] = PURCHASE_STATUS[status];
  return <span className={`pill ${tone}`}>{label}</span>;
}
