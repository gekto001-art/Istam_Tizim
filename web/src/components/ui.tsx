import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

// ---------- Toast ----------
const ToastCtx = createContext<(msg: string) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const t = useRef<number | undefined>(undefined);
  const show = useCallback((m: string) => {
    setMsg(m);
    clearTimeout(t.current);
    t.current = window.setTimeout(() => setMsg(null), 3000);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {msg && (
        <div className="toast" role="status">
          {msg}
        </div>
      )}
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ---------- Modal ----------
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

// ---------- Maydon ----------
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="f">
      {label}
      {children}
    </label>
  );
}

export function PageHead({ title, sub, children }: { title: string; sub?: string; children?: ReactNode }) {
  return (
    <div className="top">
      <div>
        <h1>{title}</h1>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {children && <div className="row">{children}</div>}
    </div>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="err">{error instanceof Error ? error.message : String(error)}</div>;
}

/** Vaqtinchalik parolni bir marta ko'rsatish oynasi */
export function SecretModal({ title, login, password, onClose }: { title: string; login: string; password: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Modal title={title} onClose={onClose}>
      <div>
        Login: <b className="mono">{login}</b>
      </div>
      <div className="secret">{password}</div>
      <p className="note">
        Bu parol faqat hozir ko'rsatiladi. Foydalanuvchiga yetkazing — birinchi kirishda u o'z parolini o'rnatadi.
      </p>
      <div className="actions">
        <button
          className="btn ghost"
          onClick={() =>
            navigator.clipboard
              ?.writeText(`${login} / ${password}`)
              .then(() => setCopied(true))
              .catch(() => setCopied(false))
          }
        >
          {copied ? 'Nusxa olindi' : 'Nusxa olish'}
        </button>
        <button className="btn" onClick={onClose}>
          Tayyor
        </button>
      </div>
    </Modal>
  );
}

export const fmtNum = (v: string | number | null | undefined, digits = 0) =>
  v == null || v === ''
    ? '—'
    : Number(v).toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: 3 }).replace(/,/g, '.');

export const fmtDate = (v: string | null | undefined) => (v ? new Date(v).toLocaleDateString('ru-RU') : '—');
export const fmtDateTime = (v: string | null | undefined) =>
  v ? new Date(v).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—';
