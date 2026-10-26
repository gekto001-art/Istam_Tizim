import { useQuery } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { api } from '../api';
import { ErrorText, PageHead, fmtDateTime } from '../components/ui';

interface Entry {
  id: number;
  entity: string;
  entity_id: string | null;
  action: string;
  user_name: string | null;
  created_at: string;
  old_data: unknown;
  new_data: unknown;
}

const ENTITIES: Record<string, string> = {
  user: 'Foydalanuvchi',
};
const ACTIONS: Record<string, string> = {
  create: 'Yaratildi',
  update: 'O\'zgartirildi',
  delete: 'O\'chirildi',
  reset_password: 'Parol tiklandi',
};

export function AuditPage() {
  const [entity, setEntity] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const q = useQuery({ queryKey: ['audit', entity], queryFn: () => api<Entry[]>(`/audit?limit=200${entity ? `&entity=${entity}` : ''}`) });
  return (
    <>
      <PageHead title="Audit log" sub="Kim, qachon, nimani o'zgartirgani">
        <select aria-label="Obyekt turi" value={entity} onChange={(e) => setEntity(e.target.value)}>
          <option value="">Barchasi</option>
          {Object.entries(ENTITIES).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
      </PageHead>
      <ErrorText error={q.error} />
      <div className="card">
        <div className="tw">
          <table>
            <thead>
              <tr>
                <th>Vaqt</th>
                <th>Kim</th>
                <th>Obyekt</th>
                <th>Amal</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data?.map((a) => (
                <Fragment key={a.id}>
                  <tr>
                    <td className="mono">{fmtDateTime(a.created_at)}</td>
                    <td>{a.user_name ?? '—'}</td>
                    <td>
                      {ENTITIES[a.entity] ?? a.entity} #{a.entity_id}
                    </td>
                    <td>{ACTIONS[a.action] ?? a.action}</td>
                    <td>
                      <button className="btn ghost sm" onClick={() => setOpen(open === a.id ? null : a.id)}>
                        {open === a.id ? 'Yopish' : 'Batafsil'}
                      </button>
                    </td>
                  </tr>
                  {open === a.id && (
                    <tr>
                      <td colSpan={5}>
                        <div className="form">
                          <div>
                            <div className="note">Oldin</div>
                            <pre className="mono" style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{a.old_data ? JSON.stringify(a.old_data, null, 2) : '—'}</pre>
                          </div>
                          <div>
                            <div className="note">Keyin</div>
                            <pre className="mono" style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{a.new_data ? JSON.stringify(a.new_data, null, 2) : '—'}</pre>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
