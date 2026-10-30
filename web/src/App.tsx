import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { can, type Role } from './types';
import { LoginPage, ChangePasswordPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { UsersPage } from './pages/Users';
import { AuditPage } from './pages/Audit';
import { CatalogPage } from './pages/Catalog';
import { OrdersPage } from './pages/Orders';
import { OrderPage } from './pages/Order';
import { SupplyOrderPage, SupplyPage } from './pages/Supply';
import { PurchasesPage } from './pages/Purchases';
import { TrackingPage } from './pages/Tracking';
import { PrixodPage, PrixodTaminotPage } from './pages/StockIn';
import { RasxodPage, SotuvPage, ZayavkaPage } from './pages/StockOut';
import { NakladnoyPage, OstatkaPage } from './pages/StockReports';
import { KroyPage } from './pages/Kroy';
import { BrakPage, KroyClosedPage, KroyRasxodPage, OtkPage, SemiPage } from './pages/KroyOtk';
import { TsexOstatkaPage, TsexPrixodPage, TsexProductionPage, TsexXaPage } from './pages/Tsex';
import { OtkFinalPage, SpisaniyaPage, TayyorPage } from './pages/OtkFinal';
import { BillzSalesPage, BillzSettingsPage, BillzStockPage } from './pages/Billz';
import { AbcPage } from './pages/Reports';
import { SalesLedgerPage, SalesPrixodPage, TransferPage } from './pages/Sales';
import { HrEmployeePage, HrEmployeesPage } from './pages/Hr';
import { CashAvansPage, CashInputPage, CashJournalPage, CashReportPage, CashSettingsPage } from './pages/Cash';
import { HrMoneyPage, HrPayrollPage, HrTabelInputPage, HrTabelPage, HrWorkPage, HrWorkTypesPage } from './pages/HrWork';

interface NavItem {
  to: string;
  label: string;
  show: (r: Role) => boolean;
}
type NavGroup = [string, NavItem[]];
/** Menyu: ikki biznes (ishlab chiqarish → Sotuv bo'limi) jarayon tartibida, keyin umumiy bo'limlar. Biznes ichidagi guruhlar raqamlanadi. */
const NAV: { biz: string | null; numbered: boolean; groups: NavGroup[] }[] = [
  { biz: null, numbered: false, groups: [['Asosiy', [{ to: '/', label: 'Dashboard', show: () => true }]]] },
  {
    biz: 'Ishlab chiqarish',
    numbered: true,
    groups: [
      ["Innovatsion bo'lim",[{ to: '/orders', label: 'Zakazlar', show: (r) => can.ordersRead(r) }]],
      [
        "Ta'minot",
        [
          { to: '/supply', label: 'Xomashyo zakaz', show: (r) => can.purchaseRead(r) },
          { to: '/purchases', label: 'Postavshik kelishuv', show: (r) => can.purchaseRead(r) },
          { to: '/tracking', label: "Status o'zgartirish", show: (r) => can.purchaseRead(r) },
        ],
      ],
      [
        'Xomashyo skladi',
        [
          { to: '/stock/prixod-taminot', label: "Prixod (Ta'minot orqali)", show: (r) => can.stockRead(r) },
          { to: '/stock/prixod', label: 'Prixod', show: (r) => can.stockRead(r) },
          { to: '/stock/zayavka', label: 'Rasxod (Zayavka)', show: (r) => can.stockRead(r) },
          { to: '/stock/rasxod', label: 'Rasxod', show: (r) => can.stockRead(r) },
          { to: '/stock/sotuv', label: 'Sotuv', show: (r) => can.stockRead(r) },
          { to: '/stock/ostatka', label: 'Ostatka', show: (r) => can.stockRead(r) },
          { to: '/stock/nakladnoy', label: 'Nakladnoy', show: (r) => can.stockRead(r) },
        ],
      ],
      [
        'Bichuv (kroy)',
        [
          { to: '/kroy', label: 'Kroy', show: (r) => can.kroyRead(r) },
          { to: '/kroy/otk', label: 'Sifat nazorati', show: (r) => can.kroyRead(r) },
          { to: '/kroy/brak', label: 'OTK Brak', show: (r) => can.kroyRead(r) },
          { to: '/kroy/yarim-tayyor', label: 'Kroyda yarim tayyor', show: (r) => can.kroyRead(r) },
          { to: '/kroy/rasxod', label: 'Kroydan rasxod', show: (r) => can.kroyRead(r) },
          { to: '/kroy/yopilgan', label: 'Yopilgan zakazlar', show: (r) => can.kroyRead(r) },
        ],
      ],
      [
        'Tsex',
        [
          { to: '/tsex/prixod', label: 'Prixod (kroydan)', show: (r) => can.tsexRead(r) },
          { to: '/tsex', label: 'Ishlab chiqarish', show: (r) => can.tsexRead(r) },
          { to: '/tsex/ostatka', label: 'Ostatka', show: (r) => can.tsexRead(r) },
          { to: '/tsex/xa', label: 'Ish/Chiq Xa', show: (r) => can.tsexRead(r) },
        ],
      ],
      [
        'OTK va tayyor mahsulot',
        [
          { to: '/otk', label: 'OTK (tayyor mahsulot)', show: (r) => can.fgRead(r) },
          { to: '/spisaniya', label: 'Spisaniya (P&L)', show: (r) => can.fgRead(r) },
          { to: '/tayyor', label: 'Tayyor mahsulot skladi', show: (r) => can.fgRead(r) },
          { to: '/sotuvga', label: "Sotuv bo'limiga o'tkazma", show: (r) => can.salesRead(r) },
        ],
      ],
    ],
  },
  {
    biz: "Sotuv bo'limi",
    numbered: true,
    groups: [
      [
        'Ishlab chiqarishdan',
        [
          { to: '/sotuv/prixod', label: 'Prixod (qabul qilish)', show: (r) => can.salesRead(r) },
          { to: '/sotuv/hisob', label: 'Ishlab chiqarish bilan hisob', show: (r) => can.salesRead(r) },
        ],
      ],
      [
        "Do'konlar (Billz)",
        [
          { to: '/billz/qoldiq', label: 'Billz qoldiq', show: (r) => can.billzRead(r) },
          { to: '/billz/sotuv', label: 'Billz sotuv', show: (r) => can.billzRead(r) },
        ],
      ],
    ],
  },
  {
    biz: 'Umumiy',
    numbered: false,
    groups: [
      [
        'Kassa',
        [
          { to: '/kassa/kiritish', label: 'Kassa kiritish', show: (r) => can.cashRead(r) },
          { to: '/kassa/jurnal', label: 'Kassa jurnali', show: (r) => can.cashRead(r) },
          { to: '/kassa/hisobot', label: 'Kassa hisobot', show: (r) => can.cashRead(r) },
          { to: '/kassa/avans', label: 'Avans-hisobot', show: (r) => can.cashRead(r) },
          { to: '/kassa/sozlamalar', label: 'Hamyonlar va elementlar', show: (r) => can.cashRead(r) },
        ],
      ],
      [
        'HR',
        [
          { to: '/hr/xodimlar', label: 'Xodimlar', show: (r) => can.hrRead(r) },
          { to: '/hr/tabel-kiritish', label: 'Tabel kiritish', show: (r) => can.hrRead(r) },
          { to: '/hr/tabel', label: 'Tabel', show: (r) => can.hrRead(r) },
          { to: '/hr/ish-nazorati', label: 'Ish nazorati', show: (r) => can.hrRead(r) || can.hrWork(r) },
          { to: '/hr/ish-turlari', label: 'Ish turlari va narxlar', show: (r) => can.hrRead(r) || can.hrWork(r) },
          { to: '/hr/bonus-tolov', label: "Bonus va to'lovlar", show: (r) => can.hrRead(r) },
          { to: '/hr/vedomost', label: 'Vedomost', show: (r) => can.hrRead(r) },
        ],
      ],
      ['Hisobotlar', [{ to: '/hisobot/abc', label: 'ABC tahlil', show: (r) => can.reportsRead(r) }]],
      ["Ma'lumotnomalar",[{ to: '/catalog', label: 'Ranglar, xomashyo...', show: () => true }]],
      [
        'Tizim',
        [
          { to: '/users', label: 'Foydalanuvchilar', show: (r) => can.users(r) },
          { to: '/audit', label: 'Audit log', show: (r) => can.audit(r) },
          { to: '/billz/sozlamalar', label: 'Billz sozlamalari', show: (r) => can.billzManage(r) },
        ],
      ],
    ],
  },
];

const END = ['/', '/kroy', '/tsex'];
const isActive = (to: string, path: string) => (END.includes(to) ? path === to : path === to || path.startsWith(`${to}/`));

/** Menyuda ochiq bo'limlar (biznes va guruh) — shu brauzerda eslab qolinadi */
const OPEN_KEY = 'istam.nav.open';
function loadOpen(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

function Layout({ children }: { children: React.ReactNode }) {
  const { me, logout } = useAuth();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(loadOpen);
  // ochilgan sahifaning biznesi va guruhi doim ochiq
  useEffect(() => {
    const add: Record<string, boolean> = {};
    for (const { biz, groups } of NAV) {
      for (const [g, items] of groups) {
        if (biz && items.some((i) => isActive(i.to, pathname))) Object.assign(add, { [biz]: true, [`${biz}/${g}`]: true });
      }
    }
    setOpen((o) => (Object.keys(add).every((k) => o[k]) ? o : { ...o, ...add }));
  }, [pathname]);
  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify(open));
    } catch {
      /* saqlanmasa ham menyu ishlaydi */
    }
  }, [open]);
  if (!me) return null;
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  return (
    <div className="app">
      <aside>
        <div className="logo">
          ISTAM
          <small>Bolalar kiyimlari · boshqaruv tizimi</small>
        </div>
        <nav aria-label="Asosiy menyu" style={{ display: 'contents' }}>
          {NAV.map(({ biz, numbered, groups }) => {
            const vis = groups
              .map(([g, items], i) => ({ key: `${biz}/${g}`, label: numbered ? `${i + 1}. ${g}` : g, items: items.filter((x) => x.show(me.role)) }))
              .filter((g) => g.items.length);
            if (!vis.length) return null;
            const bizOpen = !biz || !!open[biz];
            return (
              <div key={biz ?? ''} style={{ display: 'contents' }}>
                {biz && (
                  <button className="nb" aria-expanded={bizOpen} onClick={() => toggle(biz)}>
                    {biz}
                  </button>
                )}
                {vis.map((g) => {
                  const grOpen = !biz || !!open[g.key];
                  return (
                    <div key={g.key} style={{ display: 'contents' }}>
                      {biz ? (
                        <button className={`ng${bizOpen ? '' : ' shut'}`} aria-expanded={grOpen} onClick={() => toggle(g.key)}>
                          {g.label}
                        </button>
                      ) : (
                        <div className="ng">{g.label}</div>
                      )}
                      {g.items.map((i) => (
                        <NavLink key={i.to} className={`nav${bizOpen && grOpen ? '' : ' shut'}`} to={i.to} end={END.includes(i.to)}>
                          {i.label}
                        </NavLink>
                      ))}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </nav>
        <div className="side-foot">
          <span className="who">
            {me.full_name} · {me.role_label}
          </span>
          <NavLink className="nav" to="/password" style={{ padding: 0 }}>
            Parolni almashtirish
          </NavLink>
          <button onClick={() => logout()}>Chiqish</button>
        </div>
      </aside>
      <main>{children}</main>
    </div>
  );
}

export function App() {
  const { me, loading } = useAuth();
  if (loading) return <div className="login-wrap" aria-busy="true" />;
  if (!me) return <LoginPage />;
  if (me.must_change_password) return <ChangePasswordPage forced />;
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        {can.ordersRead(me.role) && <Route path="/orders" element={<OrdersPage />} />}
        {can.ordersRead(me.role) && <Route path="/orders/:id" element={<OrderPage />} />}
        {can.purchaseRead(me.role) && <Route path="/supply" element={<SupplyPage />} />}
        {can.purchaseRead(me.role) && <Route path="/supply/:orderId" element={<SupplyOrderPage />} />}
        {can.purchaseRead(me.role) && <Route path="/purchases" element={<PurchasesPage />} />}
        {can.purchaseRead(me.role) && <Route path="/tracking" element={<TrackingPage />} />}
        {can.purchaseRead(me.role) && <Route path="/tracking/:orderId" element={<TrackingPage />} />}
        {can.stockRead(me.role) && <Route path="/stock/prixod-taminot" element={<PrixodTaminotPage />} />}
        {can.stockRead(me.role) && <Route path="/stock/prixod" element={<PrixodPage />} />}
        {can.stockRead(me.role) && <Route path="/stock/zayavka" element={<ZayavkaPage />} />}
        {can.stockRead(me.role) && <Route path="/stock/rasxod" element={<RasxodPage />} />}
        {can.stockRead(me.role) && <Route path="/stock/sotuv" element={<SotuvPage />} />}
        {can.stockRead(me.role) && <Route path="/stock/ostatka" element={<OstatkaPage />} />}
        {can.stockRead(me.role) && <Route path="/stock/nakladnoy" element={<NakladnoyPage />} />}
        {can.kroyRead(me.role) && <Route path="/kroy" element={<KroyPage />} />}
        {can.kroyRead(me.role) && <Route path="/kroy/otk" element={<OtkPage />} />}
        {can.kroyRead(me.role) && <Route path="/kroy/brak" element={<BrakPage />} />}
        {can.kroyRead(me.role) && <Route path="/kroy/yarim-tayyor" element={<SemiPage />} />}
        {can.kroyRead(me.role) && <Route path="/kroy/rasxod" element={<KroyRasxodPage />} />}
        {can.kroyRead(me.role) && <Route path="/kroy/yopilgan" element={<KroyClosedPage />} />}
        {can.tsexRead(me.role) && <Route path="/tsex" element={<TsexProductionPage />} />}
        {can.tsexRead(me.role) && <Route path="/tsex/prixod" element={<TsexPrixodPage />} />}
        {can.tsexRead(me.role) && <Route path="/tsex/ostatka" element={<TsexOstatkaPage />} />}
        {can.tsexRead(me.role) && <Route path="/tsex/xa" element={<TsexXaPage />} />}
        {can.fgRead(me.role) && <Route path="/otk" element={<OtkFinalPage />} />}
        {can.fgRead(me.role) && <Route path="/tayyor" element={<TayyorPage />} />}
        {can.fgRead(me.role) && <Route path="/spisaniya" element={<SpisaniyaPage />} />}
        {can.salesRead(me.role) && <Route path="/sotuvga" element={<TransferPage />} />}
        {can.salesRead(me.role) && <Route path="/sotuv/prixod" element={<SalesPrixodPage />} />}
        {can.salesRead(me.role) && <Route path="/sotuv/hisob" element={<SalesLedgerPage />} />}
        {can.billzRead(me.role) && <Route path="/billz/qoldiq" element={<BillzStockPage />} />}
        {can.billzRead(me.role) && <Route path="/billz/sotuv" element={<BillzSalesPage />} />}
        {can.billzRead(me.role) && <Route path="/billz/sozlamalar" element={<BillzSettingsPage />} />}
        {can.reportsRead(me.role) && <Route path="/hisobot/abc" element={<AbcPage />} />}
        {can.cashRead(me.role) && <Route path="/kassa/kiritish" element={<CashInputPage />} />}
        {can.cashRead(me.role) && <Route path="/kassa/jurnal" element={<CashJournalPage />} />}
        {can.cashRead(me.role) && <Route path="/kassa/hisobot" element={<CashReportPage />} />}
        {can.cashRead(me.role) && <Route path="/kassa/avans" element={<CashAvansPage />} />}
        {can.cashRead(me.role) && <Route path="/kassa/sozlamalar" element={<CashSettingsPage />} />}
        {can.hrRead(me.role) && <Route path="/hr/xodimlar" element={<HrEmployeesPage />} />}
        {can.hrRead(me.role) && <Route path="/hr/xodim/:id" element={<HrEmployeePage />} />}
        {can.hrRead(me.role) && <Route path="/hr/tabel-kiritish" element={<HrTabelInputPage />} />}
        {can.hrRead(me.role) && <Route path="/hr/tabel" element={<HrTabelPage />} />}
        {(can.hrRead(me.role) || can.hrWork(me.role)) && <Route path="/hr/ish-nazorati" element={<HrWorkPage />} />}
        {(can.hrRead(me.role) || can.hrWork(me.role)) && <Route path="/hr/ish-turlari" element={<HrWorkTypesPage />} />}
        {can.hrRead(me.role) && <Route path="/hr/bonus-tolov" element={<HrMoneyPage />} />}
        {can.hrRead(me.role) && <Route path="/hr/vedomost" element={<HrPayrollPage />} />}
        <Route path="/catalog" element={<CatalogPage />} />
        {can.users(me.role) && <Route path="/users" element={<UsersPage />} />}
        {can.audit(me.role) && <Route path="/audit" element={<AuditPage />} />}
        <Route path="/password" element={<ChangePasswordPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
