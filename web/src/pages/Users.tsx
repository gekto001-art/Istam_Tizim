import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorText, Field, Modal, PageHead, SecretModal, fmtDateTime, useToast } from '../components/ui';
import { ROLE_LABELS, ROLES, type Role } from '../types';

interface User {
  id: number;
  login: string;
  full_name: string;
  role: Role;
  is_active: boolean;
  must_change_password: boolean;
  last_login_at: string | null;
  phone: string | null;
}

export function UsersPage() {
  const { me } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<User[]>('/users') });
  const [edit, setEdit] = useState<User | 'new' | null>(null);
  const [secret, setSecret] = useState<{ login: string; password: string } | null>(null);
  const reset = useMutation({
    mutationFn: (u: User) => api<{ temp_password: string }>(`/users/${u.id}/reset-password`, { method: 'POST' }).then((r) => ({ u, r })),
    onSuccess: ({ u, r }) => setSecret({ login: u.login, password: r.temp_password }),
  });

  return (
    <>
      <PageHead title="Foydalanuvchilar" sub="Xodimlar, rollar va kirish">
        <button className="btn" onClick={() => setEdit('new')}>
          Foydalanuvchi qo'shish
        </button>
      </PageHead>
      <ErrorText error={users.error || reset.error} />
      <div className="card">
        <div className="tw">
          <table>
            <thead>
              <tr>
                <th>F.I.Sh.</th>
                <th>Login</th>
                <th>Rol</th>
                <th>Telefon</th>
                <th>Oxirgi kirish</th>
                <th>Holat</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.data?.map((u) => (
                <tr key={u.id} style={{ opacity: u.is_active ? 1 : 0.55 }}>
                  <td>{u.full_name}</td>
                  <td className="mono">{u.login}</td>
                  <td>{ROLE_LABELS[u.role]}</td>
                  <td className="mono">{u.phone ?? '—'}</td>
                  <td>{fmtDateTime(u.last_login_at)}</td>
                  <td>
                    {!u.is_active ? (
                      <span className="pill muted">O'chirilgan</span>
                    ) : u.must_change_password ? (
                      <span className="pill warn">Parol o'rnatilmagan</span>
                    ) : (
                      <span className="pill good">Faol</span>
                    )}
                  </td>
                  <td>
                    <div className="row">
                      <button className="btn ghost sm" onClick={() => setEdit(u)}>
                        Tahrirlash
                      </button>
                      {u.id !== me?.id && (
                        <button className="btn ghost sm" onClick={() => reset.mutate(u)}>
                          Parolni tiklash
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {edit && (
        <UserModal
          user={edit === 'new' ? null : edit}
          self={edit !== 'new' && edit.id === me?.id}
          onClose={() => setEdit(null)}
          onDone={(created) => {
            qc.invalidateQueries({ queryKey: ['users'] });
            setEdit(null);
            if (created) setSecret(created);
            else toast('Saqlandi');
          }}
        />
      )}
      {secret && <SecretModal title="Vaqtinchalik parol" login={secret.login} password={secret.password} onClose={() => setSecret(null)} />}
    </>
  );
}

function UserModal({
  user,
  self,
  onClose,
  onDone,
}: {
  user: User | null;
  self: boolean;
  onClose: () => void;
  onDone: (created?: { login: string; password: string }) => void;
}) {
  const [f, setF] = useState({
    login: user?.login ?? '',
    full_name: user?.full_name ?? '',
    role: user?.role ?? ('sklad' as Role),
    phone: user?.phone ?? '',
    is_active: user?.is_active ?? true,
  });
  const m = useMutation({
    mutationFn: async () => {
      if (user) {
        await api(`/users/${user.id}`, {
          method: 'PATCH',
          body: { full_name: f.full_name, role: f.role, phone: f.phone, is_active: f.is_active },
        });
        return undefined;
      }
      const r = await api<{ temp_password: string }>('/users', {
        method: 'POST',
        body: { login: f.login, full_name: f.full_name, role: f.role, phone: f.phone },
      });
      return { login: f.login, password: r.temp_password };
    },
    onSuccess: onDone,
  });
  return (
    <Modal title={user ? 'Foydalanuvchini tahrirlash' : 'Yangi foydalanuvchi'} onClose={onClose}>
      <form
        className="grid"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <div className="form">
          <Field label="Login">
            <input value={f.login} disabled={!!user} onChange={(e) => setF({ ...f, login: e.target.value })} required pattern="[a-zA-Z0-9._\-]{3,60}" />
          </Field>
          <Field label="F.I.Sh.">
            <input value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} required />
          </Field>
          <Field label="Rol">
            <select value={f.role} disabled={self} onChange={(e) => setF({ ...f, role: e.target.value as Role })}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Telefon">
            <input value={f.phone} inputMode="tel" onChange={(e) => setF({ ...f, phone: e.target.value })} />
          </Field>
        </div>
        {user && !self && (
          <label className="chk">
            <input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> Faol
          </label>
        )}
        {!user && <p className="note">Saqlangandan keyin vaqtinchalik parol bir marta ko'rsatiladi.</p>}
        <ErrorText error={m.error} />
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Bekor qilish
          </button>
          <button className="btn" disabled={m.isPending}>
            Saqlash
          </button>
        </div>
      </form>
    </Modal>
  );
}
