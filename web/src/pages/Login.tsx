import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, setAccessToken } from '../api';
import { useAuth } from '../auth';
import { ErrorText, Field, PageHead, useToast } from '../components/ui';

export function LoginPage() {
  const { login } = useAuth();
  const [form, setForm] = useState({ login: '', password: '' });
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await login(form.login, form.password);
    } catch (x) {
      setErr(x);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login-wrap">
      <form className="card login" onSubmit={submit}>
        <div>
          <h1>Istam boshqaruv tizimi</h1>
          <div className="sub">Tizimga kirish</div>
        </div>
        <Field label="Login">
          <input id="login" autoComplete="username" value={form.login} onChange={(e) => setForm({ ...form, login: e.target.value })} required />
        </Field>
        <Field label="Parol">
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            required
          />
        </Field>
        <ErrorText error={err} />
        <button className="btn" disabled={busy}>
          {busy ? 'Kirilmoqda…' : 'Kirish'}
        </button>
      </form>
    </div>
  );
}

export function ChangePasswordPage({ forced = false }: { forced?: boolean }) {
  const { reload, logout } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const [f, setF] = useState({ current: '', next: '', repeat: '' });
  const [err, setErr] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (f.next !== f.repeat) return setErr('Yangi parollar bir xil emas');
    try {
      const r = await api<{ accessToken: string }>('/auth/password', { method: 'POST', body: { current: f.current, next: f.next } });
      setAccessToken(r.accessToken);
      await reload();
      toast('Parol almashtirildi');
      nav('/');
    } catch (x) {
      setErr(x);
    }
  };
  const form = (
    <form className="card login" onSubmit={submit}>
      {forced && (
        <div>
          <h1>Yangi parol o'rnating</h1>
          <div className="sub">Vaqtinchalik parol bilan kirdingiz. Davom etish uchun o'z parolingizni o'rnating.</div>
        </div>
      )}
      <Field label="Joriy parol">
        <input type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} required />
      </Field>
      <Field label="Yangi parol (kamida 8 belgi, harf va raqam)">
        <input type="password" autoComplete="new-password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} required />
      </Field>
      <Field label="Yangi parolni takrorlang">
        <input type="password" autoComplete="new-password" value={f.repeat} onChange={(e) => setF({ ...f, repeat: e.target.value })} required />
      </Field>
      <ErrorText error={err} />
      <div className="row">
        <button className="btn">Saqlash</button>
        {forced && (
          <button type="button" className="btn ghost" onClick={() => logout()}>
            Chiqish
          </button>
        )}
      </div>
    </form>
  );
  if (forced) return <div className="login-wrap">{form}</div>;
  return (
    <>
      <PageHead title="Parolni almashtirish" sub="Boshqa qurilmalardagi sessiyalar yopiladi" />
      {form}
    </>
  );
}
