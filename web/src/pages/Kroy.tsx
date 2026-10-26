import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorText, PageHead, fmtDate, fmtDateTime, fmtNum, useToast } from '../components/ui';
import { can, type KroyCell, type KroyItem, type KroyOrder, type KroyOrderHead } from '../types';
import { num } from './purchaseUi';
import { SubmitBar, itemKey, itemRef, today, useStockInvalidate } from './stockUi';

/** Bichuv so'rovlari ['stock', 'kroy', ...] kalitida — kroy kroydagi xomashyo qoldig'iga ta'sir qiladi, birga yangilanadi */
export const useKroyInvalidate = useStockInvalidate;

const cellKey = (c: { color_id: number; size_id: number }) => `${c.color_id}:${c.size_id}`;

/**
 * Sheets "Kroy": ustunlar — zakaz kataklari (rang × razmer, reja soni), "Fakt" qatori — kesilgan son;
 * qatorlar — kroydagi xomashyo (Ostatka) va har katakka sarf; Natija: fakt va sarf birga bo'lishi kerak.
 */
export function KroyPage() {
  const { me } = useAuth();
  const toast = useToast();
  const inv = useKroyInvalidate();
  const [orderId, setOrderId] = useState('');
  const [cutDate, setCutDate] = useState(today());
  const [recut, setRecut] = useState(false);
  const [fact, setFact] = useState<Record<string, string>>({});
  const [use, setUse] = useState<Record<string, string>>({}); // `${materialKey}#${cellKey}`
  const [msg, setMsg] = useState<string | null>(null);
  const [warn, setWarn] = useState<string[]>([]);
  const orders = useQuery({ queryKey: ['stock', 'kroy', 'orders'], queryFn: () => api<KroyOrderHead[]>('/kroy/orders') });
  const d = useQuery({ queryKey: ['stock', 'kroy', 'order', orderId], queryFn: () => api<KroyOrder>(`/kroy/orders/${orderId}`), enabled: !!orderId });
  useEffect(() => {
    setFact({});
    setUse({});
    setMsg(null);
  }, [orderId]);
  const save = useMutation({
    mutationFn: (body: object) => api<KroyOrder & { id: number; warnings: string[] }>('/kroy/cuts', { method: 'POST', body }),
    onSuccess: (r) => {
      inv();
      setFact({});
      setUse({});
      setWarn(r.warnings);
      toast(`Kroy №${r.id} saqlandi`);
    },
  });
  if (!me) return null;
  const write = can.kroyWrite(me.role);
  const cells = d.data?.cells ?? [];
  const mats = d.data?.materials ?? [];
  const f = (c: KroyCell) => num(fact[cellKey(c)] ?? '');
  const u = (mk: string, c: KroyCell) => num(use[`${mk}#${cellKey(c)}`] ?? '');
  const hasUse = (c: KroyCell) => mats.some((m) => u(itemKey(m), c) > 0);
  const colBad = (c: KroyCell) => f(c) > 0 !== hasUse(c);
  const rowUsed = (mk: string) => cells.reduce((a, c) => a + (u(mk, c) || 0), 0);

  const submit = () => {
    setMsg(null);
    setWarn([]);
    if (!cutDate) return setMsg('Sanani kiriting');
    if (!orderId) return setMsg('Zakaz raqamini kiriting');
    for (const c of cells) {
      const s = fact[cellKey(c)];
      if (s && !(Number.isInteger(f(c)) && f(c) > 0)) return setMsg(`${c.color_name} ${c.size_name}: fakt butun son bo'lishi kerak`);
    }
    if (cells.some(colBad)) return setMsg("Ma'lumotni to'g'ri kiriting: fakt kiritilgan katakda xomashyo sarfi ham bo'lishi kerak (va aksincha)");
    const outCells = cells.filter((c) => f(c) > 0);
    if (!outCells.length) return setMsg('Fakt kiriting');
    const materials = mats
      .map((m) => ({ ...itemRef(m), uses: cells.filter((c) => u(itemKey(m), c) > 0).map((c) => ({ color_id: c.color_id, size_id: c.size_id, qty: u(itemKey(m), c) })) }))
      .filter((m) => m.uses.length);
    save.mutate({ order_id: Number(orderId), cut_date: cutDate, is_recut: recut, cells: outCells.map((c) => ({ color_id: c.color_id, size_id: c.size_id, fact_qty: f(c) })), materials });
  };

  const o = d.data?.order;
  return (
    <>
      <PageHead title="Kroy" sub="Partiya kataklari bo'yicha kesilgan son va xomashyo sarfi (Sheets «Kroy»)" />
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="form">
          <label className="f">
            Sana
            <input type="date" value={cutDate} disabled={!write} onChange={(e) => setCutDate(e.target.value)} />
          </label>
          <label className="f">
            Zakaz raqami
            <select value={orderId} onChange={(e) => setOrderId(e.target.value)}>
              <option value="">— tanlang —</option>
              {orders.data?.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.partiya_no} · {x.product_type_name}
                </option>
              ))}
            </select>
          </label>
          <label className="f">
            PereKroymi
            <select value={recut ? 'ha' : 'yoq'} disabled={!write} onChange={(e) => setRecut(e.target.value === 'ha')}>
              <option value="yoq">Yo'q</option>
              <option value="ha">Ha</option>
            </select>
          </label>
          {o && (
            <div className="f">
              Tovar nomi · artikul · model
              <b>{[o.product_type_name, o.artikul, o.model].filter(Boolean).join(' · ')}</b>
            </div>
          )}
        </div>
        {orders.data && !orders.data.length && (
          <p className="note" style={{ marginTop: 8 }}>
            Kroy uchun ochiq zakaz yo'q. Sklad «Rasxod (Zayavka)»da xomashyoni «Kroy»ga bergach shu yerda chiqadi.
          </p>
        )}
      </div>

      {orderId && d.data && (
        <div className="card" style={{ marginBottom: 14 }}>
          <ErrorText error={d.error} />
          <div className="sheet-wrap">
            <table className="sheet" style={{ minWidth: 520 + cells.length * 96 }}>
              <thead>
                <tr>
                  <th rowSpan={2}>Xomashyo</th>
                  <th className="n" rowSpan={2}>
                    Ostatka
                  </th>
                  {cells.map((c) => (
                    <th key={cellKey(c)} className="n">
                      {c.color_name}
                    </th>
                  ))}
                  <th className="n" rowSpan={2}>
                    Ostatka (keyin)
                  </th>
                </tr>
                <tr>
                  {cells.map((c) => (
                    <th key={cellKey(c)} className="n" style={{ top: 30 }}>
                      {c.size_name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td colSpan={2} className="note">
                    Soni (reja)
                  </td>
                  {cells.map((c) => (
                    <td key={cellKey(c)} className="n">
                      {fmtNum(c.plan_qty)}
                    </td>
                  ))}
                  <td />
                </tr>
                <tr>
                  <td colSpan={2} className="note">
                    Oldin kesilgan
                  </td>
                  {cells.map((c) => (
                    <td key={cellKey(c)} className="n">
                      {c.cut_qty ? fmtNum(c.cut_qty) : ''}
                    </td>
                  ))}
                  <td />
                </tr>
                <tr className="sel-row">
                  <td colSpan={2}>
                    <b>Fakt</b>
                  </td>
                  {cells.map((c) => (
                    <td key={cellKey(c)} className="n">
                      <input
                        className="cell num"
                        inputMode="numeric"
                        value={fact[cellKey(c)] ?? ''}
                        disabled={!write}
                        onChange={(e) => setFact((x) => ({ ...x, [cellKey(c)]: e.target.value }))}
                        aria-label={`Fakt ${c.color_name} ${c.size_name}`}
                      />
                    </td>
                  ))}
                  <td />
                </tr>
                <tr>
                  <td colSpan={2} className="note">
                    Farq (oldin + fakt − reja)
                  </td>
                  {cells.map((c) => {
                    const v = c.cut_qty + (f(c) || 0) - c.plan_qty;
                    return (
                      <td key={cellKey(c)} className="n">
                        {f(c) > 0 || c.cut_qty ? fmtNum(v) : ''}
                      </td>
                    );
                  })}
                  <td />
                </tr>
                {mats.map((m) => {
                  const mk = itemKey(m);
                  const after = Number(m.left_qty) - rowUsed(mk);
                  return (
                    <tr key={mk}>
                      <td>
                        <b>{m.material_name}</b>
                        <div className="note">{[m.material_code, m.material_color_name, m.color_code && `kod ${m.color_code}`, m.material_size].filter(Boolean).join(' · ')}</div>
                      </td>
                      <td className="n">
                        {fmtNum(m.left_qty)} <span className="note">{m.unit}</span>
                      </td>
                      {cells.map((c) => (
                        <td key={cellKey(c)} className="n">
                          <input
                            className="cell num"
                            inputMode="decimal"
                            value={use[`${mk}#${cellKey(c)}`] ?? ''}
                            disabled={!write}
                            onChange={(e) => setUse((x) => ({ ...x, [`${mk}#${cellKey(c)}`]: e.target.value }))}
                            aria-label={`Sarf ${m.material_name} ${c.color_name} ${c.size_name}`}
                          />
                        </td>
                      ))}
                      <td className="n">{rowUsed(mk) ? <b className={after < 0 ? 'err' : ''}>{fmtNum(Math.round(after * 1000) / 1000)}</b> : ''}</td>
                    </tr>
                  );
                })}
                <tr>
                  <td colSpan={2} className="note">
                    Natija
                  </td>
                  {cells.map((c) => (
                    <td key={cellKey(c)} className="n">
                      {colBad(c) ? <span className="pill bad">X</span> : ''}
                    </td>
                  ))}
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
          {!mats.length && <p className="note">Bu partiya uchun kroyga xomashyo berilmagan.</p>}
          {warn.length > 0 && (
            <div className="banner" style={{ marginTop: 10 }}>
              Kroyda minusga kirdi: {warn.join('; ')}
            </div>
          )}
          {write && (
            <SubmitBar msg={msg} error={save.error} pending={save.isPending} onSubmit={submit}>
              Har bir fakt kiritilgan katakda xomashyo sarfi bo'lishi kerak. Ostatka minusga kirsa saqlanadi, lekin «Yopilgan zakazlar»da ko'rinadi.
            </SubmitBar>
          )}
        </div>
      )}

      <KroyBaza orderId={orderId} />
    </>
  );
}

/** Kroy TM baza */
function KroyBaza({ orderId }: { orderId: string }) {
  const { me } = useAuth();
  const toast = useToast();
  const inv = useKroyInvalidate();
  const q = useQuery({
    queryKey: ['stock', 'kroy', 'items', orderId],
    queryFn: () => api<KroyItem[]>(`/kroy/items?limit=500${orderId ? `&order_id=${orderId}` : ''}`),
  });
  const del = useMutation({
    mutationFn: (id: number) => api(`/kroy/cuts/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      inv();
      toast("Kroy o'chirildi");
    },
    onError: (e) => toast(e instanceof Error ? e.message : String(e)),
  });
  const write = !!me && can.kroyWrite(me.role);
  let last = 0;
  return (
    <div className="card">
      <h2>Kiritilgan kroylar (baza)</h2>
      <ErrorText error={q.error} />
      {!q.data?.length ? (
        <p className="note">Hali kroy yo'q.</p>
      ) : (
        <div className="sheet-wrap">
          <table className="sheet" style={{ minWidth: 1400 }}>
            <thead>
              <tr>
                <th>Kiritilgan sana</th>
                <th>Sana</th>
                <th>Tartib raqam</th>
                <th>ID</th>
                <th>Razmer</th>
                <th>Rang</th>
                <th className="n">Plan</th>
                <th className="n">Fakt</th>
                <th>Partiya raqam</th>
                <th>Tovar nomi</th>
                <th>Artikul</th>
                <th>Model</th>
                <th className="n">OTK 1 sort</th>
                <th className="n">OTK brak</th>
                <th>OTK sana</th>
                <th>Kiritdi</th>
                {write && <th />}
              </tr>
            </thead>
            <tbody>
              {q.data.map((i) => {
                const first = i.cut_id !== last;
                last = i.cut_id;
                return (
                  <tr key={i.id}>
                    <td className="mono">{fmtDateTime(i.created_at)}</td>
                    <td className="mono">{fmtDate(i.cut_date)}</td>
                    <td className="mono">
                      {i.cut_id}
                      {i.is_recut && <span className="pill warn"> perekroy</span>}
                    </td>
                    <td className="mono">{i.id}</td>
                    <td className="mono">{i.size_name}</td>
                    <td>{i.color_name}</td>
                    <td className="n">{fmtNum(i.plan_qty)}</td>
                    <td className="n">
                      <b>{fmtNum(i.fact_qty)}</b>
                    </td>
                    <td className="mono">{i.partiya_no}</td>
                    <td>{i.product_type_name}</td>
                    <td>{i.artikul ?? ''}</td>
                    <td>{i.model ?? ''}</td>
                    <td className="n">{i.otk_first ?? ''}</td>
                    <td className="n">{i.otk_brak ? <span className="pill bad">{i.otk_brak}</span> : i.otk_brak ?? ''}</td>
                    <td className="mono">{i.otk_date ? fmtDate(i.otk_date) : <span className="pill warn">kutilmoqda</span>}</td>
                    <td>{i.created_by_name ?? ''}</td>
                    {write && (
                      <td>
                        {first && !q.data!.some((x) => x.cut_id === i.cut_id && x.otk_date) && (
                          <button className="x" aria-label={`Kroy ${i.cut_id} ni o'chirish`} disabled={del.isPending} onClick={() => confirm(`Kroy №${i.cut_id} o'chirilsinmi?`) && del.mutate(i.cut_id)}>
                            ✕
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
