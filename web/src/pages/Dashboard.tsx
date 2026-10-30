import { Fragment } from 'react';
import { useAuth } from '../auth';
import { PageHead } from '../components/ui';

type Stage = 'ready' | 'next' | 'plan';

/** Ikki biznes (ishlab chiqarish → Sotuv bo'limi) va umumiy qism — menyudagi tartib bilan bir xil. */
const BIZ = ['Ishlab chiqarish', 'Sotuv bo\'limi', 'Umumiy'] as const;

/** Biznes jarayon bo'limlari va tizimdagi holati. Har modul qo'shilganda shu yer yangilanadi. */
const MODULES: { biz: (typeof BIZ)[number]; name: string; what: string; stage: Stage }[] = [
  { biz: 'Ishlab chiqarish', name: 'Innovatsion bo\'lim', what: 'Zakaz (partiya): razmer × rang, rang bo\'yicha xomashyo normasi, ish narxlari, tannarx, Sotuv bo\'limiga narx', stage: 'ready' },
  { biz: 'Ishlab chiqarish', name: 'Ta\'minot: zakaz va kelishuv', what: 'Xomashyo zakaz (avval mato) → Postavshik kelishuv (fakt, tasdiqlash / rad etish) → son qayta hisob → furnitura', stage: 'ready' },
  { biz: 'Ishlab chiqarish', name: 'Tracking', what: 'Status o\'zgartirish: buyurtma va to\'lov statusi, tracking, ETA, yo\'lga chiqqan miqdor va qoldiq', stage: 'ready' },
  { biz: 'Ishlab chiqarish', name: 'Xomashyo skladi', what: 'Prixod (ta\'minot orqali, kargo/bojxona bilan), rasxod (zayavka), sotuv, vozvrat, ostatka, nakladnoy', stage: 'ready' },
  { biz: 'Ishlab chiqarish', name: 'Bichuv (kroy)', what: 'Kroy (fakt + xomashyo sarfi), yarim tayyor, kroydan rasxod, yopilgan zakazlar', stage: 'ready' },
  { biz: 'Ishlab chiqarish', name: 'OTK (bichuv)', what: 'Sifat nazorati: 1 sort / brak; brak kroyda 1 sort, 2 sort, yaroqsiz (P&L)', stage: 'ready' },
  { biz: 'Ishlab chiqarish', name: 'Tsex', what: 'Kroydan prixod (tasdiqlash / rad etish), ishlab chiqarish fakti, furnitura sarfi, tsex ostatkasi', stage: 'ready' },
  { biz: 'Ishlab chiqarish', name: 'OTK (tayyor mahsulot)', what: '1 sort / 2 sort — skladga, yaroqsiz — spisaniya (P&L)', stage: 'ready' },
  { biz: 'Ishlab chiqarish', name: 'Tayyor mahsulot skladi', what: 'OTKdan kirim, qoldiq va tannarx; Sotuv bo\'limiga o\'tkazma (ichki narxda)', stage: 'ready' },
  { biz: 'Sotuv bo\'limi', name: 'Ishlab chiqarishdan prixod', what: 'O\'tkazmani qabul qilish / rad etish, ishlab chiqarishdan qarz va to\'lovlar (akt sverka)', stage: 'ready' },
  { biz: 'Sotuv bo\'limi', name: 'Do\'konlar (Billz)', what: 'Billz\'dan qoldiq va sotuvlar har 5 daqiqada', stage: 'ready' },
  { biz: 'Sotuv bo\'limi', name: 'Sotuv bo\'limi skladi', what: 'Ishlab chiqarishdan va boshqa postavshiklardan kelgan tovar, Billz bilan solishtirish', stage: 'next' },
  { biz: 'Sotuv bo\'limi', name: 'Agentlar va ulgurji', what: 'Agentlar (Abu Saxiy, Safo, G\'ulom), mijozlar, nakladnoy, nasiya, vozvrat', stage: 'plan' },
  { biz: 'Umumiy', name: 'Asos', what: 'Kirish, rollar, foydalanuvchilar, audit, zaxira nusxa', stage: 'ready' },
  { biz: 'Umumiy', name: 'Hisobotlar', what: 'ABC tahlil (marja, sotuv soni, summa) — tayyor; P&L har biznes uchun alohida, Balans, Cash Flow (avto)', stage: 'next' },
  { biz: 'Umumiy', name: 'Kassa', what: 'Hamyonlar (ko\'p valyutali), kirim / chiqim, ichki transfer, ayriboshlash, avans-hisobot, kassa hisobot', stage: 'ready' },
  { biz: 'Umumiy', name: 'Oldi-berdi (DT-KT)', what: 'Kontragentlar bilan hisob-kitob (avto)', stage: 'plan' },
  { biz: 'Umumiy', name: 'HR', what: 'Xodimlar (qabul / bo\'shatish), tabel, ish nazorati (ishbay) va narxlar, oylik, bonus, to\'lovlar, vedomost, akt sverka', stage: 'ready' },
  { biz: 'Umumiy', name: 'Analitika', what: 'Dashboard va grafiklar', stage: 'plan' },
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
              {BIZ.map((biz) => (
                <Fragment key={biz}>
                  <tr>
                    <th colSpan={4} scope="rowgroup">
                      {biz}
                    </th>
                  </tr>
                  {MODULES.filter((m) => m.biz === biz).map((m, i) => (
                    <tr key={m.name}>
                      <td className="mono">{i + 1}</td>
                      <td>
                        <b>{m.name}</b>
                      </td>
                      <td>{m.what}</td>
                      <td>
                        <span className={`pill ${STAGE[m.stage][1]}`}>{STAGE[m.stage][0]}</span>
                      </td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
