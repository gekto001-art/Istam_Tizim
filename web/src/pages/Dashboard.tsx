import { useAuth } from '../auth';
import { PageHead } from '../components/ui';

type Stage = 'ready' | 'next' | 'plan';

/** Biznes jarayon bo'limlari (taqdimotdagi tartib) va tizimdagi holati. Har modul qo'shilganda shu yer yangilanadi. */
const MODULES: { name: string; what: string; stage: Stage }[] = [
  { name: 'Asos', what: 'Kirish, rollar, foydalanuvchilar, audit, zaxira nusxa', stage: 'ready' },
  { name: 'Innovatsion bo\'lim', what: 'Zakaz (partiya): razmer × rang, rang bo\'yicha xomashyo normasi, ish narxlari, tannarx', stage: 'ready' },
  { name: 'Zakaz & Tracking', what: 'Xomashyo zakazi, postavshik kelishuvi, status va yo\'lga chiqish', stage: 'next' },
  { name: 'Xomashyo skladi', what: 'Prixod, bichuvga peremesheniya, vozvrat', stage: 'plan' },
  { name: 'Bichuv (kroy)', what: 'Bichish, tsexga peremesheniya', stage: 'plan' },
  { name: 'Tsex', what: 'Kunlik ishlar, ishlab chiqarishni yakunlash (shim, ko\'ylak)', stage: 'plan' },
  { name: 'OTK', what: 'Sifat nazorati, brak', stage: 'plan' },
  { name: 'Tayyor mahsulot skladi', what: 'Tsexdan qabul, qoldiq', stage: 'plan' },
  { name: 'Sotuv va agentlar', what: 'Agentlar, mijozlar, sotuv otcheti, vozvrat', stage: 'plan' },
  { name: 'Kassa', what: 'Pul oqimlari', stage: 'plan' },
  { name: 'Oldi-berdi (DT-KT)', what: 'Kontragentlar bilan hisob-kitob (avto)', stage: 'plan' },
  { name: 'HR', what: 'Priyom, uvolneniya, ish hajmi bo\'yicha nachisleniya', stage: 'plan' },
  { name: 'Hisobotlar', what: 'P&L, Balans, Cash Flow (avto)', stage: 'plan' },
  { name: 'Analitika', what: 'Dashboard va grafiklar', stage: 'plan' },
];

const STAGE: Record<Stage, [string, string]> = {
  ready: ['Tayyor', 'good'],
  next: ['Navbatdagi', 'warn'],
  plan: ['Rejada', 'muted'],
};

export function DashboardPage() {
  const { me } = useAuth();
  const done = MODULES.filter((m) => m.stage === 'ready').length;
  return (
    <>
      <PageHead title="Dashboard" sub={`Xush kelibsiz, ${me?.full_name ?? ''}`} />
      <div className="card" style={{ marginBottom: 14 }}>
        <h2>Tizim holati</h2>
        <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={MODULES.length} aria-valuenow={done}>
          <span style={{ width: `${(done / MODULES.length) * 100}%` }} />
        </div>
        <p className="note">
          {MODULES.length} ta bo'limdan {done} tasi tayyor. Har bir bo'lim tayyor bo'lgach shu yerda belgilanadi va menyuda paydo bo'ladi.
        </p>
      </div>
      <div className="card">
        <h2>Ish jarayoni bo'limlari</h2>
        <div className="tw">
          <table>
            <thead>
              <tr>
                <th>№</th>
                <th>Bo'lim</th>
                <th>Nima qiladi</th>
                <th>Holat</th>
              </tr>
            </thead>
            <tbody>
              {MODULES.map((m, i) => (
                <tr key={m.name}>
                  <td className="mono">{i}</td>
                  <td>
                    <b>{m.name}</b>
                  </td>
                  <td>{m.what}</td>
                  <td>
                    <span className={`pill ${STAGE[m.stage][1]}`}>{STAGE[m.stage][0]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
