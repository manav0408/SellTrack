/* ============================================================
   SellTrack — application logic
   Auth + routing + CRUD + charts + theme + admin
   Persistance : localStorage
   ============================================================ */

(() => {
  'use strict';

  // ============================================================
  //  UTILITIES
  // ============================================================
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const uid = () => 'id_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const todayISO = () => new Date().toISOString().slice(0, 10);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
  const initials = (name) => (name || '?').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';

  const fmtEUR = (n) => {
    const v = Number(n) || 0;
    return v.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 });
  };
  const fmtNum = (n) => (Number(n) || 0).toLocaleString('fr-FR');
  const fmtPct = (n) => `${(Number(n) || 0).toFixed(1)} %`;

  const daysAgo = (n) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  };

  const profitOf = (sale) => Number(sale.sellPrice || 0) - Number(sale.buyPrice || 0) - Number(sale.shipping || 0);
  const investmentOf = (sale) => Number(sale.buyPrice || 0) + Number(sale.shipping || 0);

  // Statut d'un article (rétro-compatible : sans status = 'sold')
  const statusOf = (sale) => sale.status || 'sold';
  const isSold = (sale) => statusOf(sale) === 'sold';
  const isListed = (sale) => statusOf(sale) === 'listed';
  const isStock = (sale) => statusOf(sale) === 'stock';
  // Seules les ventes réelles comptent dans le CA / les stats
  const soldSales = (sales) => sales.filter(isSold);
  const STATUS_LABELS = { stock: 'En stock', listed: 'En vente', sold: 'Vendu' };

  const hashPwd = (pwd) => {
    // Lightweight hash for local persistence (NOT production-grade).
    // For production you'd use bcrypt/argon2 server-side.
    let h = 5381;
    const s = 'st:' + (pwd || '');
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h) + s.charCodeAt(i);
    return 'h_' + (h >>> 0).toString(16) + '_' + s.length;
  };

  const downloadFile = (filename, content, type = 'application/json') => {
    const blob = new Blob([content], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  };

  const fileToDataURL = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });

  // ============================================================
  //  STORAGE LAYER
  // ============================================================
  const STORE_KEY = 'selltrack:store:v1';
  const SESSION_KEY = 'selltrack:session:v1';
  const THEME_KEY = 'selltrack:theme';

  const defaultStore = () => ({
    users: [
      {
        id: 'admin_seed',
        name: 'Administrateur',
        email: 'admin@selltrack.app',
        passwordHash: hashPwd('admin'),
        role: 'admin',
        status: 'active',
        createdAt: new Date().toISOString(),
      },
    ],
    sales: [], // { id, userId, name, brand, condition, buyPrice, sellPrice, shipping, soldAt, image, createdAt }
  });

  let store = null;

  const loadStore = () => {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) {
        store = defaultStore();
        saveStore();
      } else {
        store = JSON.parse(raw);
        if (!store.users || !store.sales) store = defaultStore();
      }
    } catch {
      store = defaultStore();
    }
  };

  const saveStore = () => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); }
    catch (e) { console.error('Storage save failed', e); }
  };

  // ============================================================
  //  CLOUD MODE DETECTOR
  // ============================================================
  // Si window.SellTrackCloud.enabled = true, on utilise Supabase
  // au lieu du localStorage. Sinon, tout reste local comme avant.
  const isCloud = () => !!(window.SellTrackCloud && window.SellTrackCloud.enabled);
  const Cloud = () => window.SellTrackCloud;

  // ============================================================
  //  AUTH
  // ============================================================
  let currentUser = null;

  const loadSession = () => {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const { userId } = JSON.parse(raw);
      return store.users.find(u => u.id === userId) || null;
    } catch { return null; }
  };

  const setSession = (user) => {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ userId: user.id }));
    currentUser = user;
  };

  const clearSession = () => {
    localStorage.removeItem(SESSION_KEY);
    currentUser = null;
  };

  const signup = ({ name, email, password }) => {
    email = email.trim().toLowerCase();
    if (!email || !password || !name) throw new Error('Tous les champs sont requis.');
    if (store.users.some(u => u.email === email)) throw new Error('Cet email est déjà utilisé.');
    if (password.length < 4) throw new Error('Le mot de passe doit faire au moins 4 caractères.');

    const user = {
      id: uid(),
      name: name.trim(),
      email,
      passwordHash: hashPwd(password),
      role: 'user',
      status: 'active',
      createdAt: new Date().toISOString(),
    };
    store.users.push(user);

    // Seed quelques articles d'exemple pour la démo
    seedSalesForUser(user.id);

    saveStore();
    setSession(user);
    return user;
  };

  const login = ({ email, password }) => {
    email = email.trim().toLowerCase();
    const user = store.users.find(u => u.email === email);
    if (!user) throw new Error('Aucun compte trouvé pour cet email.');
    if (user.passwordHash !== hashPwd(password)) throw new Error('Mot de passe incorrect.');
    if (user.status === 'banned') throw new Error('Ce compte a été suspendu.');
    setSession(user);
    return user;
  };

  const logout = () => {
    clearSession();
    location.hash = '';
    showAuth();
  };

  const seedSalesForUser = (userId) => {
    // Données d'exemple inspirées de la maquette
    const samples = [
      { name: 'The North Face Puffer', brand: 'The North Face', condition: 'Très bon état', buyPrice: 45, sellPrice: 90, shipping: 4.5, daysAgoSold: 2 },
      { name: 'Nike Air Max 90', brand: 'Nike', condition: 'Bon état', buyPrice: 60, sellPrice: 110, shipping: 5, daysAgoSold: 5 },
      { name: 'Carhartt Pants', brand: 'Carhartt', condition: 'Très bon état', buyPrice: 35, sellPrice: 70, shipping: 4.2, daysAgoSold: 9 },
      { name: 'Nike Tech Fleece', brand: 'Nike', condition: 'Très bon état', buyPrice: 65, sellPrice: 120, shipping: 5, daysAgoSold: 12 },
      { name: 'Carhartt Jacket', brand: 'Carhartt', condition: 'Bon état', buyPrice: 40, sellPrice: 55, shipping: 4.5, daysAgoSold: 18 },
      { name: 'Stone Island Tee', brand: 'Stone Island', condition: 'Très bon état', buyPrice: 30, sellPrice: 95, shipping: 3.5, daysAgoSold: 22 },
      { name: 'Adidas Samba OG', brand: 'Adidas', condition: 'Neuf sans étiquette', buyPrice: 70, sellPrice: 130, shipping: 5, daysAgoSold: 26 },
      { name: 'Levi\'s 501 Vintage', brand: 'Levi\'s', condition: 'Bon état', buyPrice: 20, sellPrice: 55, shipping: 4, daysAgoSold: 4 },
    ];
    samples.forEach(s => {
      store.sales.push({
        id: uid(),
        userId,
        name: s.name,
        brand: s.brand,
        condition: s.condition,
        buyPrice: s.buyPrice,
        sellPrice: s.sellPrice,
        shipping: s.shipping,
        soldAt: daysAgo(s.daysAgoSold),
        image: null,
        createdAt: new Date().toISOString(),
      });
    });
  };

  // ============================================================
  //  DATA HELPERS
  // ============================================================
  const userSales = (userId = currentUser?.id) =>
    store.sales.filter(s => s.userId === userId);

  const salesInPeriod = (sales, period) => {
    if (period === 'all') return sales.slice();
    const n = Number(period) || 30;
    const cutoff = daysAgo(n - 1);
    return sales.filter(s => s.soldAt >= cutoff);
  };

  const aggregate = (sales) => {
    const totals = sales.reduce((acc, s) => {
      const profit = profitOf(s);
      acc.revenue += Number(s.sellPrice || 0);
      acc.invested += investmentOf(s);
      acc.profit += profit;
      acc.count += 1;
      if (!acc.best || profit > profitOf(acc.best)) acc.best = s;
      return acc;
    }, { revenue: 0, invested: 0, profit: 0, count: 0, best: null });
    totals.avgMargin = totals.revenue > 0 ? (totals.profit / totals.revenue) * 100 : 0;
    totals.avgPerSale = totals.count > 0 ? totals.profit / totals.count : 0;
    return totals;
  };

  // Comparaison avec la période précédente pour les deltas
  const aggregateCompare = (allSales, period) => {
    const cur = salesInPeriod(allSales, period);
    if (period === 'all') return { cur: aggregate(cur), prev: null };
    const n = Number(period);
    const cutCur = daysAgo(n - 1);
    const cutPrev = daysAgo(2 * n - 1);
    const prev = allSales.filter(s => s.soldAt >= cutPrev && s.soldAt < cutCur);
    return { cur: aggregate(cur), prev: aggregate(prev) };
  };

  const deltaPct = (cur, prev) => {
    if (!prev || prev === 0) return cur > 0 ? 100 : 0;
    return ((cur - prev) / Math.abs(prev)) * 100;
  };

  const groupByDay = (sales, days) => {
    const map = new Map();
    for (let i = days - 1; i >= 0; i--) {
      const k = daysAgo(i);
      map.set(k, { date: k, sales: 0, investments: 0 });
    }
    sales.forEach(s => {
      if (!map.has(s.soldAt)) return;
      const row = map.get(s.soldAt);
      row.sales += Number(s.sellPrice || 0);
      row.investments += investmentOf(s);
    });
    return Array.from(map.values());
  };

  // ============================================================
  //  UI : TOAST + MODAL
  // ============================================================
  const toast = (message, type = 'info') => {
    const root = $('#toast-root');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    const iconName = type === 'success' ? 'check-circle-2' : type === 'error' ? 'x-circle' : 'info';
    el.innerHTML = `<i data-lucide="${iconName}"></i><span class="toast-text">${esc(message)}</span>`;
    root.appendChild(el);
    if (window.lucide) lucide.createIcons({ icons: lucide.icons });
    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(8px)'; }, 2600);
    setTimeout(() => el.remove(), 3000);
  };

  const modal = ({ title, body, actions }) => {
    const root = $('#modal-root');
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = body;
    const foot = $('#modal-foot');
    foot.innerHTML = '';
    (actions || []).forEach(a => {
      const btn = document.createElement('button');
      btn.className = `btn ${a.variant || 'btn-ghost'}`;
      btn.textContent = a.label;
      btn.addEventListener('click', () => {
        const result = a.onClick && a.onClick();
        if (result !== false) closeModal();
      });
      foot.appendChild(btn);
    });
    root.hidden = false;
  };

  const closeModal = () => { $('#modal-root').hidden = true; };

  $('#modal-root').addEventListener('click', (e) => {
    if (e.target.dataset.close === 'modal') closeModal();
  });

  // ============================================================
  //  THEME
  // ============================================================
  const setTheme = (theme) => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
    $$('.theme-option').forEach(b => b.classList.toggle('is-active', b.dataset.theme === theme));
    // Redessiner les graphs avec les bonnes couleurs
    if (currentUser) {
      const route = (location.hash || '#dashboard').replace('#', '');
      if (route === 'dashboard') renderDashboard();
      if (route === 'stats') renderStats();
    }
  };
  const initTheme = () => setTheme(localStorage.getItem(THEME_KEY) || 'light');

  // ============================================================
  //  AUTH UI
  // ============================================================
  const authShell = $('#auth-shell');
  const appShell = $('#app-shell');

  const showAuth = () => {
    appShell.hidden = true;
    authShell.hidden = false;
    if (window.lucide) lucide.createIcons({ icons: lucide.icons });
    // Réafficher le bouton install si le prompt est dispo
    if (window._sellTrackInstall && window._sellTrackInstall.hasPrompt()) {
      window._sellTrackInstall.show();
    }
  };

  const showApp = () => {
    authShell.hidden = true;
    appShell.hidden = false;
    refreshUserChrome();
    if (!location.hash) location.hash = '#dashboard';
    else handleRoute();
    if (window.lucide) lucide.createIcons({ icons: lucide.icons });
    // Cacher le bouton install une fois connecté
    if (window._sellTrackInstall) window._sellTrackInstall.hide();
  };

  $$('.auth-tab').forEach(btn => btn.addEventListener('click', () => {
    $$('.auth-tab').forEach(b => b.classList.toggle('is-active', b === btn));
    $$('.auth-form').forEach(f => f.hidden = f.dataset.form !== btn.dataset.tab);
  }));

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const submitBtn = e.currentTarget.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      if (isCloud()) {
        const user = await Cloud().auth.signIn({ email: fd.get('email'), password: fd.get('password') });
        currentUser = user;
        await loadCloudSales();
      } else {
        login({ email: fd.get('email'), password: fd.get('password') });
      }
      toast(`Bienvenue ${currentUser.name} 👋`, 'success');
      showApp();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      submitBtn.disabled = false;
    }
  });

  $('#signup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const submitBtn = e.currentTarget.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      if (isCloud()) {
        const user = await Cloud().auth.signUp({
          name: fd.get('name'), email: fd.get('email'), password: fd.get('password')
        });
        currentUser = user;
        // Seed cloud avec articles d'exemple (optionnel)
        await seedSalesForUserCloud(user.id);
        await loadCloudSales();
      } else {
        signup({ name: fd.get('name'), email: fd.get('email'), password: fd.get('password') });
      }
      toast(`Compte créé. Bienvenue ${currentUser.name} !`, 'success');
      showApp();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      submitBtn.disabled = false;
    }
  });

  $('#logout-btn').addEventListener('click', () => {
    modal({
      title: 'Se déconnecter ?',
      body: '<p>Vous serez ramené à l\'écran de connexion. Vos données restent enregistrées.</p>',
      actions: [
        { label: 'Annuler', variant: 'btn-ghost' },
        {
          label: 'Déconnexion', variant: 'btn-primary', onClick: async () => {
            if (isCloud()) await Cloud().auth.signOut();
            logout();
          }
        },
      ],
    });
  });

  // ============================================================
  //  CLOUD HELPERS
  // ============================================================
  // En mode cloud, on hydrate `store.sales` depuis Supabase après chaque login
  // pour que les renderers locaux continuent de fonctionner sans modification.
  async function loadCloudSales() {
    if (!isCloud()) return;
    try {
      const cloudSales = await Cloud().sales.list();
      // On remplace les sales du current user dans store par celles du cloud
      store.sales = store.sales.filter(s => s.userId !== currentUser.id);
      store.sales.push(...cloudSales);
    } catch (err) {
      console.error('Cloud sales load failed', err);
      toast('Erreur de chargement des ventes.', 'error');
    }
  }

  async function seedSalesForUserCloud(userId) {
    const samples = [
      { name: 'The North Face Puffer', brand: 'The North Face', condition: 'Très bon état', buyPrice: 45, sellPrice: 90, shipping: 4.5, daysAgoSold: 2 },
      { name: 'Nike Air Max 90', brand: 'Nike', condition: 'Bon état', buyPrice: 60, sellPrice: 110, shipping: 5, daysAgoSold: 5 },
      { name: 'Carhartt Pants', brand: 'Carhartt', condition: 'Très bon état', buyPrice: 35, sellPrice: 70, shipping: 4.2, daysAgoSold: 9 },
      { name: 'Nike Tech Fleece', brand: 'Nike', condition: 'Très bon état', buyPrice: 65, sellPrice: 120, shipping: 5, daysAgoSold: 12 },
    ];
    for (const s of samples) {
      try {
        await Cloud().sales.create({
          name: s.name, brand: s.brand, condition: s.condition,
          buyPrice: s.buyPrice, sellPrice: s.sellPrice, shipping: s.shipping,
          soldAt: daysAgo(s.daysAgoSold), image: null,
        });
      } catch (e) { /* silent */ }
    }
  }

  // ============================================================
  //  APP CHROME
  // ============================================================
  const refreshUserChrome = () => {
    if (!currentUser) return;
    $('#sidebar-user-name').textContent = currentUser.name;
    $('#sidebar-user-role').textContent = currentUser.role === 'admin' ? 'Administrateur' : 'Membre';
    $('#sidebar-user-avatar').textContent = initials(currentUser.name);
    $('#nav-admin').hidden = currentUser.role !== 'admin';
  };

  // Sidebar mobile
  const mobileMenuBtn = $('#mobile-menu-btn');
  const sidebar = $('#sidebar');
  let backdrop = $('.sidebar-backdrop');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.className = 'sidebar-backdrop';
    document.body.appendChild(backdrop);
  }
  mobileMenuBtn.addEventListener('click', () => {
    sidebar.classList.toggle('is-open');
    backdrop.classList.toggle('is-open');
  });
  backdrop.addEventListener('click', () => {
    sidebar.classList.remove('is-open');
    backdrop.classList.remove('is-open');
  });

  // ============================================================
  //  ROUTING
  // ============================================================
  const ROUTES = ['dashboard', 'stock', 'sales', 'add', 'stats', 'settings', 'admin'];

  const handleRoute = () => {
    if (!currentUser) { showAuth(); return; }
    let route = (location.hash || '#dashboard').replace('#', '').split('/')[0];
    if (!ROUTES.includes(route)) route = 'dashboard';
    if (route === 'admin' && currentUser.role !== 'admin') {
      toast('Accès réservé aux administrateurs.', 'error');
      route = 'dashboard';
      location.hash = '#dashboard';
      return;
    }

    $$('.nav-item').forEach(n => n.classList.toggle('is-active', n.dataset.route === route));
    $$('.view').forEach(v => v.hidden = v.dataset.view !== route);

    // Close mobile sidebar after nav
    sidebar.classList.remove('is-open');
    backdrop.classList.remove('is-open');

    if (route === 'dashboard') renderDashboard();
    if (route === 'stock') renderStock();
    if (route === 'sales') renderSales();
    if (route === 'add') prepareAddForm();
    if (route === 'stats') renderStats();
    if (route === 'settings') renderSettings();
    if (route === 'admin') renderAdmin();

    if (window.lucide) lucide.createIcons({ icons: lucide.icons });
    window.scrollTo({ top: 0, behavior: 'instant' });
  };

  window.addEventListener('hashchange', handleRoute);

  // Actions globales (data-action="...")
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    const a = t.dataset.action;
    if (a === 'goto-add') { addEditingId = null; addPresetStatus = null; location.hash = '#add'; }
    if (a === 'goto-add-stock') { addEditingId = null; addPresetStatus = 'stock'; location.hash = '#add'; }
    if (a === 'cancel-add') {
      addEditingId = null;
      addPresetStatus = null;
      location.hash = '#sales';
    }
  });

  // ============================================================
  //  CHARTS
  // ============================================================
  let chartDashboard = null;
  let chartStats = null;
  const sparkCharts = [];

  const chartColors = () => {
    const dark = document.documentElement.dataset.theme === 'dark';
    return {
      green: '#22c55e',
      greenFill: dark ? 'rgba(34,197,94,0.18)' : 'rgba(34,197,94,0.12)',
      red: '#ef4444',
      redFill: dark ? 'rgba(239,68,68,0.18)' : 'rgba(239,68,68,0.12)',
      grid: dark ? 'rgba(255,255,255,0.06)' : 'rgba(15,19,34,0.06)',
      text: dark ? '#b6bcd4' : '#828aa4',
    };
  };

  const baseChartOptions = () => {
    const c = chartColors();
    return {
      maintainAspectRatio: false,
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          labels: { color: c.text, usePointStyle: true, pointStyle: 'circle', boxWidth: 8, font: { family: 'Manrope', size: 12, weight: '600' } },
        },
        tooltip: {
          backgroundColor: '#0f1322',
          padding: 10,
          cornerRadius: 8,
          titleFont: { family: 'Manrope', weight: '700' },
          bodyFont: { family: 'Manrope' },
          callbacks: { label: (ctx) => `${ctx.dataset.label} : ${fmtEUR(ctx.parsed.y)}` },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: c.text, font: { family: 'Manrope', size: 11 } } },
        y: {
          grid: { color: c.grid, drawBorder: false },
          ticks: { color: c.text, font: { family: 'Manrope', size: 11 }, callback: (v) => `${v} €` },
          beginAtZero: true,
        },
      },
      elements: { line: { tension: 0.35, borderWidth: 2.2 }, point: { radius: 2.5, hoverRadius: 5 } },
    };
  };

  const drawTimeSeries = (ctx, data, opts = {}) => {
    if (!ctx) return null;
    const c = chartColors();
    const labels = data.map(d => {
      const dt = new Date(d.date);
      return dt.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
    });
    const cfg = {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Ventes',
            data: data.map(d => Number(d.sales.toFixed(2))),
            borderColor: c.green,
            backgroundColor: c.greenFill,
            fill: true,
            pointBackgroundColor: c.green,
          },
          {
            label: 'Investissements',
            data: data.map(d => Number(d.investments.toFixed(2))),
            borderColor: c.red,
            backgroundColor: c.redFill,
            fill: true,
            pointBackgroundColor: c.red,
          },
        ],
      },
      options: baseChartOptions(),
    };
    return new Chart(ctx, cfg);
  };

  const drawSparkline = (ctx, values, color) => {
    if (!ctx) return null;
    const cfg = {
      type: 'line',
      data: {
        labels: values.map((_, i) => i),
        datasets: [{
          data: values,
          borderColor: color,
          backgroundColor: 'transparent',
          borderWidth: 1.6,
          pointRadius: 0,
          tension: 0.35,
        }],
      },
      options: {
        maintainAspectRatio: false,
        responsive: true,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: { x: { display: false }, y: { display: false } },
        elements: { line: { borderJoinStyle: 'round' } },
      },
    };
    return new Chart(ctx, cfg);
  };

  // ============================================================
  //  VIEW : DASHBOARD
  // ============================================================
  const renderDashboard = () => {
    const period = $('#dashboard-period').value;
    const allRaw = userSales();
    const all = soldSales(allRaw);  // CA/stats = uniquement les articles vendus
    const { cur, prev } = aggregateCompare(all, period);
    const lastSale = [...all].filter(s => s.soldAt).sort((a, b) => b.soldAt.localeCompare(a.soldAt))[0];

    // KPIs
    const kpis = [
      {
        label: 'Revenu total',
        value: fmtEUR(cur.revenue),
        cls: 'kpi-green',
        delta: prev ? deltaPct(cur.revenue, prev.revenue) : null,
      },
      {
        label: 'Bénéfice total',
        value: fmtEUR(cur.profit),
        cls: 'kpi-green',
        delta: prev ? deltaPct(cur.profit, prev.profit) : null,
      },
      {
        label: 'Articles vendus',
        value: fmtNum(cur.count),
        cls: 'kpi-violet',
        delta: prev ? deltaPct(cur.count, prev.count) : null,
      },
      {
        label: 'Total investi',
        value: fmtEUR(cur.invested),
        cls: 'kpi-red',
        delta: prev ? deltaPct(cur.invested, prev.invested) : null,
      },
      {
        label: 'Marge moyenne',
        value: fmtPct(cur.avgMargin),
        cls: 'kpi-violet',
        delta: prev ? (cur.avgMargin - prev.avgMargin) : null,
        deltaIsPct: true,
      },
      {
        label: 'Meilleure vente',
        value: cur.best ? fmtEUR(profitOf(cur.best)) : '—',
        cls: 'kpi-neutral',
        sub: cur.best ? cur.best.name : 'Aucune vente sur la période',
      },
      {
        label: 'Valeur du stock',
        value: fmtEUR(allRaw.filter(s => isStock(s) || isListed(s)).reduce((sum, s) => sum + Number(s.buyPrice || 0), 0)),
        cls: 'kpi-blue',
        sub: `${allRaw.filter(s => isStock(s) || isListed(s)).length} article(s) non vendu(s)`,
      },
      {
        label: 'Bénéfice potentiel',
        value: fmtEUR(allRaw.filter(isListed).reduce((sum, s) => sum + profitOf(s), 0)),
        cls: 'kpi-yellow',
        sub: `Si tout le "en vente" se vend`,
      },
    ];

    $('#dashboard-kpis').innerHTML = kpis.map(k => {
      const delta = k.delta !== null && k.delta !== undefined
        ? `<span class="kpi-delta ${k.delta >= 0 ? 'up' : 'down'}">
             <i data-lucide="${k.delta >= 0 ? 'trending-up' : 'trending-down'}"></i>
             ${k.delta >= 0 ? '+' : ''}${k.delta.toFixed(1)}${k.deltaIsPct ? ' pts' : ' %'}
           </span>`
        : k.sub ? `<span class="kpi-sub">${esc(k.sub)}</span>` : '';
      return `
        <div class="kpi ${k.cls}">
          <span class="kpi-label">${esc(k.label)}</span>
          <span class="kpi-value">${esc(k.value)}</span>
          ${delta}
        </div>`;
    }).join('');

    // Chart
    const days = period === 'all' ? Math.max(30, Math.min(180, (() => {
      if (all.length === 0) return 30;
      const oldest = all.reduce((m, s) => s.soldAt < m ? s.soldAt : m, all[0].soldAt);
      const diff = Math.ceil((Date.now() - new Date(oldest).getTime()) / 86400000) + 1;
      return diff;
    })())) : Number(period);
    const series = groupByDay(all, days);
    const ctx = $('#chart-dashboard');
    if (chartDashboard) chartDashboard.destroy();
    chartDashboard = drawTimeSeries(ctx.getContext('2d'), series);

    // Summary card
    const monthAgg = monthlyAggregate(all);
    const bestMonth = monthAgg.sort((a, b) => b.profit - a.profit)[0];
    const trend = computeTrend(all);
    const summary = [
      lastSale && {
        label: 'Dernière vente',
        value: lastSale.name,
        meta: `Il y a ${diffDays(lastSale.soldAt)} jour${diffDays(lastSale.soldAt) > 1 ? 's' : ''}`,
        right: fmtEUR(profitOf(lastSale)),
        icon: 'shopping-bag',
        iconCls: 'summary-icon-violet',
      },
      bestMonth && {
        label: 'Meilleur mois',
        value: bestMonth.label,
        meta: '',
        right: `+${fmtEUR(bestMonth.profit)}`,
        rightCls: 'up',
        icon: 'calendar-check-2',
        iconCls: 'summary-icon-green',
      },
      {
        label: 'Tendance',
        value: trend.label,
        meta: trend.note,
        right: '',
        icon: trend.up ? 'trending-up' : 'trending-down',
        iconCls: trend.up ? 'summary-icon-green' : 'summary-icon-violet',
      },
    ].filter(Boolean);

    $('#dashboard-summary').innerHTML = summary.map(s => `
      <div class="summary-item">
        <div class="summary-icon ${s.iconCls}"><i data-lucide="${s.icon}"></i></div>
        <div class="summary-text">
          <div class="summary-label">${esc(s.label)}</div>
          <div class="summary-value">${esc(s.value)}</div>
          ${s.meta ? `<div class="summary-meta">${esc(s.meta)}</div>` : ''}
        </div>
        ${s.right ? `<div class="summary-right ${s.rightCls || ''}">${esc(s.right)}</div>` : ''}
      </div>
    `).join('');

    if (window.lucide) lucide.createIcons({ icons: lucide.icons });
  };

  const diffDays = (iso) => {
    const d = new Date(iso); d.setHours(0, 0, 0, 0);
    const now = new Date(); now.setHours(0, 0, 0, 0);
    return Math.max(0, Math.round((now - d) / 86400000));
  };

  const monthlyAggregate = (sales) => {
    const buckets = new Map();
    sales.forEach(s => {
      const key = s.soldAt.slice(0, 7); // YYYY-MM
      if (!buckets.has(key)) buckets.set(key, { key, profit: 0, count: 0 });
      const b = buckets.get(key);
      b.profit += profitOf(s);
      b.count += 1;
    });
    const monthNames = ['janv.', 'févr.', 'mars', 'avril', 'mai', 'juin', 'juill.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
    return Array.from(buckets.values()).map(b => {
      const [y, m] = b.key.split('-');
      b.label = `${monthNames[Number(m) - 1]} ${y}`;
      return b;
    });
  };

  const computeTrend = (sales) => {
    // Compare moyenne profit 7 derniers jours vs 7 jours précédents
    const last7 = sales.filter(s => s.soldAt >= daysAgo(6));
    const prev7 = sales.filter(s => s.soldAt >= daysAgo(13) && s.soldAt < daysAgo(6));
    const a = last7.reduce((sum, s) => sum + profitOf(s), 0);
    const b = prev7.reduce((sum, s) => sum + profitOf(s), 0);
    if (a === 0 && b === 0) return { up: true, label: 'Stable', note: 'Pas encore de tendance.' };
    if (a >= b) return { up: true, label: 'En hausse', note: 'Très bonne progression !' };
    return { up: false, label: 'En baisse', note: 'Surveillez vos investissements.' };
  };

  $('#dashboard-period').addEventListener('change', renderDashboard);

  // ============================================================
  //  VIEW : SALES (En vente + Vendus, avec statuts)
  // ============================================================
  let salesLayout = 'list';
  let salesStatusFilter = 'all'; // 'all' | 'listed' | 'sold'

  const renderSales = () => {
    // L'onglet Articles n'affiche QUE listed + sold (pas le stock)
    const all = userSales().filter(s => isListed(s) || isSold(s));
    const searchTerm = ($('#sales-search').value || '').trim().toLowerCase();
    const brandFilter = $('#sales-brand-filter').value;
    const condFilter = $('#sales-condition-filter').value;

    // Brand options
    const brands = Array.from(new Set(all.map(s => s.brand).filter(Boolean))).sort();
    $('#sales-brand-filter').innerHTML =
      `<option value="">Toutes les marques</option>` +
      brands.map(b => `<option ${b === brandFilter ? 'selected' : ''}>${esc(b)}</option>`).join('');

    const filtered = all.filter(s => {
      if (salesStatusFilter !== 'all' && statusOf(s) !== salesStatusFilter) return false;
      if (searchTerm && !s.name.toLowerCase().includes(searchTerm) && !(s.brand || '').toLowerCase().includes(searchTerm)) return false;
      if (brandFilter && s.brand !== brandFilter) return false;
      if (condFilter && s.condition !== condFilter) return false;
      return true;
    }).sort((a, b) => {
      const da = a.soldAt || a.listedAt || a.createdAt || '';
      const db = b.soldAt || b.listedAt || b.createdAt || '';
      return db.localeCompare(da);
    });

    const list = $('#sales-list');
    const empty = $('#sales-empty');
    list.classList.toggle('grid', salesLayout === 'grid');

    if (filtered.length === 0) {
      list.innerHTML = '';
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    list.innerHTML = filtered.map(s => {
      const listed = isListed(s);
      const profit = profitOf(s);
      const profitCls = profit >= 0 ? 'profit' : 'loss';
      const estCls = listed ? 'estimated' : '';
      const img = s.image
        ? `<img src="${esc(s.image)}" alt="" />`
        : `<i data-lucide="image"></i>`;
      const statusBadge = `<span class="status-badge status-badge-${statusOf(s)}">
        <span class="status-dot status-dot-${statusOf(s)}"></span>${STATUS_LABELS[statusOf(s)]}</span>`;
      const sellLabel = listed ? 'Demandé' : 'Vente';
      const profitLabel = listed ? 'Bénéf. estimé' : 'Bénéfice';
      // Toggle : en vente → bouton "marquer vendu" ; vendu → bouton "remettre en vente"
      const toggleBtn = listed
        ? `<button class="btn-icon" data-mark-sold="${s.id}" title="Marquer comme vendu"><i data-lucide="check-circle-2"></i></button>`
        : `<button class="btn-icon" data-mark-listed="${s.id}" title="Remettre en vente"><i data-lucide="rotate-ccw"></i></button>`;

      if (salesLayout === 'list') {
        return `
          <div class="sale-item" data-id="${s.id}" data-open-detail="${s.id}">
            <div class="sale-image">${img}</div>
            <div class="sale-name-block">
              <div class="sale-name">${esc(s.name)}</div>
              <div class="sale-brand">${esc(s.brand || '—')}</div>
              <div class="sale-status-badge">${statusBadge}</div>
            </div>
            <div><div class="sale-col-label">Achat</div><div class="sale-col-value">${fmtEUR(s.buyPrice)}</div></div>
            <div><div class="sale-col-label">${sellLabel}</div><div class="sale-col-value">${fmtEUR(s.sellPrice)}</div></div>
            <div><div class="sale-col-label">Frais de port</div><div class="sale-col-value">${fmtEUR(s.shipping)}</div></div>
            <div><div class="sale-col-label">${profitLabel}</div><div class="sale-col-value ${profitCls} ${estCls}">${fmtEUR(profit)}</div></div>
            <div class="sale-actions">
              ${toggleBtn}
              <button class="btn-icon" data-edit="${s.id}" title="Modifier"><i data-lucide="pencil"></i></button>
              <button class="btn-icon danger" data-delete="${s.id}" title="Supprimer"><i data-lucide="trash-2"></i></button>
            </div>
          </div>`;
      }
      // Grid
      return `
        <div class="sale-item" data-id="${s.id}" data-open-detail="${s.id}">
          <div class="sale-image">${img}</div>
          <div>
            <div class="sale-name">${esc(s.name)}</div>
            <div class="sale-brand">${esc(s.brand || '—')}</div>
            <div class="sale-status-badge">${statusBadge}</div>
          </div>
          <div class="sale-col"><span class="sale-col-label">Achat</span><span class="sale-col-value">${fmtEUR(s.buyPrice)}</span></div>
          <div class="sale-col"><span class="sale-col-label">${sellLabel}</span><span class="sale-col-value">${fmtEUR(s.sellPrice)}</span></div>
          <div class="sale-col"><span class="sale-col-label">Frais de port</span><span class="sale-col-value">${fmtEUR(s.shipping)}</span></div>
          <div class="sale-col"><span class="sale-col-label">${profitLabel}</span><span class="sale-col-value ${profitCls} ${estCls}">${fmtEUR(profit)}</span></div>
          <div class="sale-actions">
            ${toggleBtn}
            <button class="btn-icon" data-edit="${s.id}" title="Modifier"><i data-lucide="pencil"></i></button>
            <button class="btn-icon danger" data-delete="${s.id}" title="Supprimer"><i data-lucide="trash-2"></i></button>
          </div>
        </div>`;
    }).join('');

    if (window.lucide) lucide.createIcons({ icons: lucide.icons });
  };

  $('#sales-search').addEventListener('input', () => renderSales());
  $('#sales-brand-filter').addEventListener('change', () => renderSales());
  $('#sales-condition-filter').addEventListener('change', () => renderSales());
  $$('.view-toggle-btn').forEach(b => b.addEventListener('click', () => {
    $$('.view-toggle-btn').forEach(x => x.classList.toggle('is-active', x === b));
    salesLayout = b.dataset.layout;
    renderSales();
  }));
  // Onglets de statut
  $$('#sales-status-tabs .status-tab').forEach(t => t.addEventListener('click', () => {
    $$('#sales-status-tabs .status-tab').forEach(x => x.classList.toggle('is-active', x === t));
    salesStatusFilter = t.dataset.statusFilter;
    renderSales();
  }));

  // Edit/delete/statut/détail via delegation
  $('#sales-list').addEventListener('click', (e) => {
    const editBtn = e.target.closest('[data-edit]');
    const delBtn = e.target.closest('[data-delete]');
    const markSoldBtn = e.target.closest('[data-mark-sold]');
    const markListedBtn = e.target.closest('[data-mark-listed]');

    if (markSoldBtn) {
      e.stopPropagation();
      const s = store.sales.find(x => x.id === markSoldBtn.dataset.markSold);
      if (s) openMarkSoldModal(s);
      return;
    }
    if (markListedBtn) {
      e.stopPropagation();
      const s = store.sales.find(x => x.id === markListedBtn.dataset.markListed);
      if (s) markAsListed(s);
      return;
    }
    if (editBtn) {
      e.stopPropagation();
      addEditingId = editBtn.dataset.edit;
      location.hash = '#add';
      return;
    }
    if (delBtn) {
      e.stopPropagation();
      const id = delBtn.dataset.delete;
      const sale = store.sales.find(s => s.id === id);
      if (!sale) return;
      modal({
        title: 'Supprimer cet article ?',
        body: `<p>L'article <strong>${esc(sale.name)}</strong> sera définitivement supprimé.</p>`,
        actions: [
          { label: 'Annuler', variant: 'btn-ghost' },
          {
            label: 'Supprimer', variant: 'btn-danger', onClick: async () => {
              try {
                if (isCloud()) await Cloud().sales.delete(id);
                store.sales = store.sales.filter(s => s.id !== id);
                if (!isCloud()) saveStore();
                renderSales();
                toast('Article supprimé.', 'success');
              } catch (err) {
                toast(err.message || 'Suppression impossible.', 'error');
              }
            }
          },
        ],
      });
      return;
    }
    // Sinon : clic sur la ligne → ouvrir les détails
    const row = e.target.closest('[data-open-detail]');
    if (row) {
      const s = store.sales.find(x => x.id === row.dataset.openDetail);
      if (s) openDetailModal(s);
    }
  });

  // ---- Changement de statut ----
  async function persistSalePatch(sale, patch) {
    Object.assign(sale, patch);
    try {
      if (isCloud()) {
        await Cloud().sales.update(sale.id, sale);
      } else {
        saveStore();
      }
    } catch (err) {
      toast(err.message || 'Mise à jour impossible.', 'error');
    }
  }

  function openMarkSoldModal(s) {
    modal({
      title: 'Marquer comme vendu',
      body: `
        <p style="margin-bottom:12px;color:var(--text-3)">Renseignez le prix de vente réel et la date de vente pour <strong>${esc(s.name)}</strong>.</p>
        <label class="field"><span class="field-label">Prix de vente réel</span>
          <input type="number" step="0.01" id="ms-price" value="${s.sellPrice || ''}" placeholder="0,00 €" /></label>
        <label class="field"><span class="field-label">Date de vente</span>
          <input type="date" id="ms-date" value="${todayISO()}" /></label>
      `,
      actions: [
        { label: 'Annuler', variant: 'btn-ghost' },
        {
          label: 'Confirmer la vente', variant: 'btn-primary', onClick: async () => {
            const price = Number($('#ms-price').value);
            const date = $('#ms-date').value || todayISO();
            if (!price || price <= 0) { toast('Indiquez un prix de vente valide.', 'error'); return false; }
            await persistSalePatch(s, { status: 'sold', sellPrice: price, soldAt: date });
            toast('Article marqué comme vendu 🎉', 'success');
            renderSales();
          },
        },
      ],
    });
  }

  async function markAsListed(s) {
    await persistSalePatch(s, { status: 'listed', soldAt: null, listedAt: s.listedAt || todayISO() });
    toast('Article remis en vente.', 'success');
    renderSales();
  }

  // ---- Modale détails article ----
  function openDetailModal(s) {
    const listed = isListed(s);
    const stock = isStock(s);
    const profit = profitOf(s);
    const profitCls = profit >= 0 ? 'positive' : 'negative';
    const img = s.image
      ? `<img src="${esc(s.image)}" class="detail-modal-img" alt="" />`
      : '';
    const sellLabel = listed ? 'Prix demandé' : 'Prix de vente';
    const dateRow = stock
      ? (s.boughtAt ? `<div class="detail-row"><span class="detail-row-label">Date d'achat</span><span class="detail-row-value">${new Date(s.boughtAt).toLocaleDateString('fr-FR')}</span></div>` : '')
      : listed
        ? (s.listedAt ? `<div class="detail-row"><span class="detail-row-label">Mise en vente</span><span class="detail-row-value">${new Date(s.listedAt).toLocaleDateString('fr-FR')}</span></div>` : '')
        : (s.soldAt ? `<div class="detail-row"><span class="detail-row-label">Date de vente</span><span class="detail-row-value">${new Date(s.soldAt).toLocaleDateString('fr-FR')}</span></div>` : '');

    const priceRows = stock
      ? `<div class="detail-row"><span class="detail-row-label">Prix d'achat</span><span class="detail-row-value">${fmtEUR(s.buyPrice)}</span></div>`
      : `
        <div class="detail-row"><span class="detail-row-label">Prix d'achat</span><span class="detail-row-value">${fmtEUR(s.buyPrice)}</span></div>
        <div class="detail-row"><span class="detail-row-label">${sellLabel}</span><span class="detail-row-value">${fmtEUR(s.sellPrice)}</span></div>
        <div class="detail-row"><span class="detail-row-label">Frais de port</span><span class="detail-row-value">${fmtEUR(s.shipping)}</span></div>
        <div class="detail-row"><span class="detail-row-label">${listed ? 'Bénéfice estimé' : 'Bénéfice'}</span><span class="detail-row-value ${profitCls}">${fmtEUR(profit)}${listed ? ' ~' : ''}</span></div>
      `;

    modal({
      title: s.name,
      body: `
        ${img}
        <div class="detail-rows">
          <div class="detail-row"><span class="detail-row-label">Statut</span>
            <span class="detail-row-value"><span class="status-badge status-badge-${statusOf(s)}"><span class="status-dot status-dot-${statusOf(s)}"></span>${STATUS_LABELS[statusOf(s)]}</span></span></div>
          <div class="detail-row"><span class="detail-row-label">Marque</span><span class="detail-row-value">${esc(s.brand || '—')}</span></div>
          <div class="detail-row"><span class="detail-row-label">État</span><span class="detail-row-value">${esc(s.condition || '—')}</span></div>
          ${priceRows}
          ${dateRow}
        </div>
      `,
      actions: [
        { label: 'Fermer', variant: 'btn-ghost' },
        { label: 'Modifier', variant: 'btn-primary', onClick: () => { addEditingId = s.id; location.hash = '#add'; } },
      ],
    });
  }

  // ============================================================
  //  VIEW : ADD / EDIT (formulaire adaptatif par statut)
  // ============================================================
  let addEditingId = null;
  let addImageData = null;
  let addImageFile = null; // File brut, pour upload Supabase
  let addPresetStatus = null; // statut pré-sélectionné (ex depuis "Ajouter au stock")
  let addCurrentStatus = 'stock';

  const setAddFormStatus = (status) => {
    addCurrentStatus = status;
    $('#add-status').value = status;
    $$('#status-selector .status-choice').forEach(b =>
      b.classList.toggle('is-active', b.dataset.status === status));
    const form = $('#add-form');
    form.classList.remove('add-form-mode-stock', 'add-form-mode-listed', 'add-form-mode-sold');
    form.classList.add('add-form-mode-' + status);
    // Adapter les libellés
    $('#sell-price-label').textContent = status === 'listed' ? 'Prix demandé' : 'Prix de vente';
    $('#preview-sell-label').textContent = status === 'listed' ? 'Demandé' : 'Vente';
    $('#profit-label').textContent = status === 'listed' ? 'Bénéfice estimé' : 'Bénéfice';
    $('#preview-profit-label').textContent = status === 'listed' ? 'Bénéf. estimé' : 'Bénéfice';
    updatePreview();
  };

  $$('#status-selector .status-choice').forEach(b =>
    b.addEventListener('click', () => setAddFormStatus(b.dataset.status)));

  const prepareAddForm = () => {
    const form = $('#add-form');
    form.reset();
    addImageData = null;
    addImageFile = null;

    const isEdit = !!addEditingId;
    $('#add-title').textContent = isEdit ? 'Modifier l\'article' : 'Ajouter un article';
    $('#add-submit').textContent = isEdit ? 'Enregistrer' : 'Ajouter l\'article';

    if (isEdit) {
      const s = store.sales.find(x => x.id === addEditingId);
      if (s) {
        form.id.value = s.id;
        form.name.value = s.name;
        form.brand.value = s.brand || '';
        form.condition.value = s.condition || '';
        form.buyPrice.value = s.buyPrice;
        form.sellPrice.value = s.sellPrice || '';
        form.shipping.value = s.shipping || 0;
        if (form.soldAt) form.soldAt.value = s.soldAt || '';
        if (form.listedAt) form.listedAt.value = s.listedAt || '';
        if (form.boughtAt) form.boughtAt.value = s.boughtAt || '';
        addImageData = s.image || null;
        setAddFormStatus(statusOf(s));
      }
    } else {
      const initial = addPresetStatus || 'stock';
      if (form.boughtAt) form.boughtAt.value = todayISO();
      if (form.listedAt) form.listedAt.value = todayISO();
      if (form.soldAt) form.soldAt.value = todayISO();
      setAddFormStatus(initial);
    }

    updateDropzone();
    updatePreview();
  };

  const updateDropzone = () => {
    const img = $('#dropzone-preview');
    const ph = $('#dropzone-placeholder');
    if (addImageData) {
      img.src = addImageData;
      img.hidden = false;
      ph.hidden = true;
    } else {
      img.hidden = true;
      ph.hidden = false;
    }
  };

  const updatePreview = () => {
    const form = $('#add-form');
    const fd = new FormData(form);
    const buy = Number(fd.get('buyPrice')) || 0;
    const sell = Number(fd.get('sellPrice')) || 0;
    const ship = Number(fd.get('shipping')) || 0;
    const profit = sell - buy - ship;
    $('#profit-value').textContent = addCurrentStatus === 'stock' ? '—' : fmtEUR(profit);
    $('#profit-value').classList.toggle('up', profit > 0 && addCurrentStatus !== 'stock');
    $('#profit-value').classList.toggle('loss', profit < 0 && addCurrentStatus !== 'stock');
    $('#profit-note').textContent = addCurrentStatus === 'listed' ? 'Estimation si vendu au prix demandé'
      : addCurrentStatus === 'stock' ? 'Pas encore en vente' : 'Calculé automatiquement';

    $('#preview-name').textContent = fd.get('name') || 'Nom de l\'article';
    $('#preview-brand').textContent = fd.get('brand') || '—';
    const cond = fd.get('condition');
    const condEl = $('#preview-condition');
    if (cond) { condEl.textContent = cond; condEl.hidden = false; } else { condEl.hidden = true; }
    $('#preview-buy').textContent = fmtEUR(buy);
    $('#preview-sell').textContent = fmtEUR(sell);
    $('#preview-ship').textContent = fmtEUR(ship);
    const pTotal = $('#preview-profit');
    pTotal.textContent = fmtEUR(profit);
    pTotal.classList.toggle('loss', profit < 0);

    const pImg = $('#preview-image');
    const pPh = $('#preview-placeholder');
    if (addImageData) {
      pImg.src = addImageData;
      pImg.hidden = false;
      pPh.hidden = true;
    } else {
      pImg.hidden = true;
      pPh.hidden = false;
    }
  };

  $('#add-form').addEventListener('input', updatePreview);

  // Dropzone
  // Note : le <label> wrapper déclenche déjà l'input nativement, pas besoin
  // d'ajouter un click handler (sinon le sélecteur s'ouvre 2x).
  const dropzone = $('#dropzone');
  const imageInput = $('#image-input');
  imageInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast('Format d\'image non supporté.', 'error'); return; }
    addImageFile = file;
    addImageData = await fileToDataURL(file);
    updateDropzone();
    updatePreview();
  });
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('is-dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-dragover'));
  dropzone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropzone.classList.remove('is-dragover');
    const file = e.dataTransfer.files[0];
    if (!file || !file.type.startsWith('image/')) return;
    addImageFile = file;
    addImageData = await fileToDataURL(file);
    updateDropzone();
    updatePreview();
  });

  $('#add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const status = fd.get('status') || 'stock';
    const payload = {
      name: (fd.get('name') || '').trim(),
      brand: (fd.get('brand') || '').trim(),
      condition: fd.get('condition') || '',
      status,
      buyPrice: Number(fd.get('buyPrice')) || 0,
      sellPrice: status === 'stock' ? 0 : (Number(fd.get('sellPrice')) || 0),
      shipping: status === 'stock' ? 0 : (Number(fd.get('shipping')) || 0),
      soldAt: status === 'sold' ? (fd.get('soldAt') || todayISO()) : null,
      listedAt: status === 'listed' ? (fd.get('listedAt') || todayISO()) : null,
      boughtAt: status === 'stock' ? (fd.get('boughtAt') || todayISO()) : null,
      image: addImageData,
    };
    if (!payload.name) { toast('Le nom est requis.', 'error'); return; }
    if (!payload.condition) { toast('Sélectionnez un état.', 'error'); return; }
    if (status !== 'stock' && (!payload.sellPrice || payload.sellPrice <= 0)) {
      toast(status === 'listed' ? 'Indiquez le prix demandé.' : 'Indiquez le prix de vente.', 'error'); return;
    }

    const submitBtn = $('#add-submit');
    submitBtn.disabled = true;

    try {
      if (isCloud() && addImageFile) {
        try {
          const url = await Cloud().storage.uploadImage(addImageFile, currentUser.id);
          payload.image = url;
        } catch (err) {
          toast('Échec de l\'upload d\'image, l\'article sera enregistré sans.', 'error');
          payload.image = null;
        }
      }

      if (addEditingId) {
        if (isCloud()) {
          const updated = await Cloud().sales.update(addEditingId, payload);
          const s = store.sales.find(x => x.id === addEditingId);
          if (s) Object.assign(s, updated);
        } else {
          const s = store.sales.find(x => x.id === addEditingId);
          if (s) Object.assign(s, payload);
          saveStore();
        }
        toast('Article mis à jour.', 'success');
      } else {
        if (isCloud()) {
          const created = await Cloud().sales.create(payload);
          store.sales.push(created);
        } else {
          store.sales.push({
            id: uid(),
            userId: currentUser.id,
            createdAt: new Date().toISOString(),
            ...payload,
          });
          saveStore();
        }
        toast(status === 'stock' ? 'Article ajouté au stock.'
          : status === 'listed' ? 'Article mis en vente.' : 'Vente enregistrée.', 'success');
      }
      const goStatus = status;
      addEditingId = null;
      addImageFile = null;
      addPresetStatus = null;
      // Redirige vers le bon onglet selon le statut
      location.hash = goStatus === 'stock' ? '#stock' : '#sales';
    } catch (err) {
      toast(err.message || 'Erreur lors de l\'enregistrement.', 'error');
    } finally {
      submitBtn.disabled = false;
    }
  });

  // ============================================================
  //  VIEW : STATS
  // ============================================================
  const renderStats = () => {
    const period = $('#stats-period').value;
    const all = soldSales(userSales());  // stats = uniquement les ventes réelles
    const inRange = salesInPeriod(all, period);
    const days = period === 'all' ? (() => {
      if (all.length === 0) return 30;
      const oldest = all.reduce((m, s) => s.soldAt < m ? s.soldAt : m, all[0].soldAt);
      const diff = Math.ceil((Date.now() - new Date(oldest).getTime()) / 86400000) + 1;
      return Math.max(30, Math.min(180, diff));
    })() : Number(period);
    const series = groupByDay(all, days);

    const totals = aggregate(inRange);

    // Mini cards with sparklines
    const revenues = series.map(d => d.sales);
    const invs = series.map(d => d.investments);
    const profits = series.map(d => d.sales - d.investments);

    $('#stats-mini').innerHTML = `
      <div class="stats-mini-card">
        <div class="stats-mini-label tag-green">Revenu</div>
        <div class="stats-mini-value">${fmtEUR(totals.revenue)}</div>
        <div class="stats-mini-spark"><canvas data-color="green"></canvas></div>
      </div>
      <div class="stats-mini-card">
        <div class="stats-mini-label tag-red">Investissements</div>
        <div class="stats-mini-value">${fmtEUR(totals.invested)}</div>
        <div class="stats-mini-spark"><canvas data-color="red"></canvas></div>
      </div>
      <div class="stats-mini-card">
        <div class="stats-mini-label tag-violet">Bénéfice</div>
        <div class="stats-mini-value">${fmtEUR(totals.profit)}</div>
        <div class="stats-mini-spark"><canvas data-color="violet"></canvas></div>
      </div>
    `;

    // Destroy old sparklines
    sparkCharts.forEach(c => c && c.destroy());
    sparkCharts.length = 0;
    const sparks = $$('.stats-mini-spark canvas');
    sparkCharts.push(drawSparkline(sparks[0].getContext('2d'), revenues, '#22c55e'));
    sparkCharts.push(drawSparkline(sparks[1].getContext('2d'), invs, '#ef4444'));
    sparkCharts.push(drawSparkline(sparks[2].getContext('2d'), profits, '#7c5cff'));

    // Main chart
    const ctx = $('#chart-stats');
    if (chartStats) chartStats.destroy();
    chartStats = drawTimeSeries(ctx.getContext('2d'), series);

    // Analyses
    const best = bestPeriod(all, 7);
    const bestItem = [...inRange].sort((a, b) => profitOf(b) - profitOf(a))[0];
    const analysis = [
      {
        label: 'Meilleure période',
        value: best ? `${best.label}` : 'Aucune',
        meta: best ? `+${fmtEUR(best.profit)}` : '',
        metaCls: 'up',
      },
      {
        label: 'Article le plus rentable',
        value: bestItem ? bestItem.name : '—',
        meta: bestItem ? fmtEUR(profitOf(bestItem)) : '',
        metaCls: 'up',
      },
      {
        label: 'Moyenne par vente',
        value: fmtEUR(totals.avgPerSale),
        meta: `Sur ${totals.count} vente${totals.count > 1 ? 's' : ''}`,
        metaCls: '',
      },
    ];
    $('#stats-analysis').innerHTML = analysis.map(a => `
      <div class="analysis-card">
        <div class="analysis-label">${esc(a.label)}</div>
        <div class="analysis-value">${esc(a.value)}</div>
        ${a.meta ? `<div class="analysis-meta ${a.metaCls}">${esc(a.meta)}</div>` : ''}
      </div>
    `).join('');

    if (window.lucide) lucide.createIcons({ icons: lucide.icons });
  };

  const bestPeriod = (sales, windowDays = 7) => {
    if (sales.length === 0) return null;
    const sorted = sales.slice().sort((a, b) => a.soldAt.localeCompare(b.soldAt));
    const oldest = sorted[0].soldAt;
    const startDate = new Date(oldest);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    let best = null;
    for (let d = new Date(startDate); d <= today; d.setDate(d.getDate() + 1)) {
      const start = d.toISOString().slice(0, 10);
      const endD = new Date(d); endD.setDate(endD.getDate() + windowDays - 1);
      const end = endD.toISOString().slice(0, 10);
      const profit = sales.filter(s => s.soldAt >= start && s.soldAt <= end)
        .reduce((sum, s) => sum + profitOf(s), 0);
      if (!best || profit > best.profit) {
        best = { start, end, profit, label: `${frenchShort(start)} - ${frenchShort(end)}` };
      }
    }
    return best;
  };

  const frenchShort = (iso) => {
    const d = new Date(iso);
    return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  };

  $('#stats-period').addEventListener('change', renderStats);

  // ============================================================
  //  VIEW : STOCK (bulles draggables avec pan & zoom)
  // ============================================================
  const stockView = {
    scale: 1,
    tx: 0,
    ty: 0,
    dragging: false,
    startX: 0,
    startY: 0,
    startTx: 0,
    startTy: 0,
    moved: false,
    groups: [],
  };

  // Regroupe les articles "stock" par nom (insensible casse/espaces)
  function groupStockByName(items) {
    const map = new Map();
    items.forEach(s => {
      const key = (s.name || '').trim().toLowerCase();
      if (!map.has(key)) {
        map.set(key, { key, name: s.name, brand: s.brand, image: null, items: [] });
      }
      const g = map.get(key);
      g.items.push(s);
      if (!g.image && s.image) g.image = s.image;
      if (!g.brand && s.brand) g.brand = s.brand;
    });
    return Array.from(map.values()).sort((a, b) => b.items.length - a.items.length);
  }

  const renderStock = () => {
    const stockItems = userSales().filter(isStock);
    const groups = groupStockByName(stockItems);
    stockView.groups = groups;

    const canvas = $('#stock-canvas');
    const empty = $('#stock-empty');
    const hint = $('#stock-hint');

    // KPIs
    const totalItems = stockItems.length;
    const totalValue = stockItems.reduce((sum, s) => sum + Number(s.buyPrice || 0), 0);
    $('#stock-kpis').innerHTML = `
      <div class="stock-kpi"><span class="stock-kpi-value">${fmtNum(totalItems)}</span><span class="stock-kpi-label">articles</span></div>
      <div class="stock-kpi"><span class="stock-kpi-value">${fmtNum(groups.length)}</span><span class="stock-kpi-label">modèles</span></div>
      <div class="stock-kpi"><span class="stock-kpi-value">${fmtEUR(totalValue)}</span><span class="stock-kpi-label">valeur</span></div>
    `;

    if (groups.length === 0) {
      canvas.innerHTML = '';
      empty.hidden = false;
      hint.hidden = true;
      return;
    }
    empty.hidden = true;
    hint.hidden = false;

    const W = $('#stock-canvas-wrap').clientWidth || 900;
    const H = $('#stock-canvas-wrap').clientHeight || 600;
    const cx = W / 2;
    const cy = H / 2;

    const bubbleSize = (qty) => Math.min(150, 84 + qty * 8);

    const positions = [];
    const ringCapacity = [8, 14, 20];
    const ringRadius = [230, 380, 530];
    groups.forEach((g, i) => {
      let ring = 0, posInRing = i, acc = 0;
      for (let r = 0; r < ringCapacity.length; r++) {
        if (i < acc + ringCapacity[r]) { ring = r; posInRing = i - acc; break; }
        acc += ringCapacity[r];
        ring = r + 1;
      }
      const capacity = ringCapacity[ring] || 20;
      const radius = ringRadius[ring] || (530 + (ring - 2) * 160);
      const angle = (posInRing / capacity) * Math.PI * 2 - Math.PI / 2 + (ring * 0.4);
      const size = bubbleSize(g.items.length);
      positions.push({
        x: cx + Math.cos(angle) * radius - size / 2,
        y: cy + Math.sin(angle) * radius - size / 2,
        size,
        cxAbs: cx + Math.cos(angle) * radius,
        cyAbs: cy + Math.sin(angle) * radius,
      });
    });

    const links = positions.map(p =>
      `<line class="stock-link" x1="${cx}" y1="${cy}" x2="${p.cxAbs}" y2="${p.cyAbs}" />`
    ).join('');

    const bubbles = groups.map((g, i) => {
      const p = positions[i];
      const qty = g.items.length;
      const img = g.image
        ? `<img src="${esc(g.image)}" alt="" loading="lazy" />`
        : `<div class="stock-bubble-placeholder"><i data-lucide="package"></i></div>`;
      const qtyBadge = qty > 1 ? `<span class="stock-bubble-qty">×${qty}</span>` : '';
      return `
        <div class="stock-bubble" data-stock-group="${esc(g.key)}"
             style="left:${p.x}px; top:${p.y}px; width:${p.size}px; height:${p.size}px;">
          ${img}
          ${qtyBadge}
          <span class="stock-bubble-label">${esc(g.name)}</span>
        </div>`;
    }).join('');

    canvas.innerHTML = `
      <svg class="stock-links" width="${W}" height="${H}">${links}</svg>
      <div class="stock-hub" style="left:${cx - 75}px; top:${cy - 75}px;">Mon stock</div>
      ${bubbles}
    `;

    resetStockView();
    applyStockTransform();
    if (window.lucide) lucide.createIcons({ icons: lucide.icons });
  };

  function applyStockTransform() {
    const canvas = $('#stock-canvas');
    if (canvas) canvas.style.transform = `translate(${stockView.tx}px, ${stockView.ty}px) scale(${stockView.scale})`;
  }

  function resetStockView() {
    stockView.scale = 1;
    stockView.tx = 0;
    stockView.ty = 0;
    applyStockTransform();
  }

  const stockWrap = $('#stock-canvas-wrap');
  if (stockWrap) {
    const onDown = (clientX, clientY) => {
      stockView.dragging = true;
      stockView.moved = false;
      stockView.startX = clientX;
      stockView.startY = clientY;
      stockView.startTx = stockView.tx;
      stockView.startTy = stockView.ty;
      stockWrap.classList.add('is-grabbing');
    };
    const onMove = (clientX, clientY) => {
      if (!stockView.dragging) return;
      const dx = clientX - stockView.startX;
      const dy = clientY - stockView.startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) stockView.moved = true;
      stockView.tx = stockView.startTx + dx;
      stockView.ty = stockView.startTy + dy;
      applyStockTransform();
    };
    const onUp = () => {
      stockView.dragging = false;
      stockWrap.classList.remove('is-grabbing');
    };

    stockWrap.addEventListener('mousedown', (e) => onDown(e.clientX, e.clientY));
    window.addEventListener('mousemove', (e) => onMove(e.clientX, e.clientY));
    window.addEventListener('mouseup', onUp);

    stockWrap.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) onDown(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    stockWrap.addEventListener('touchmove', (e) => {
      if (e.touches.length === 1) onMove(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    stockWrap.addEventListener('touchend', onUp);

    stockWrap.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 1.12 : 0.89;
      const newScale = Math.min(2.5, Math.max(0.4, stockView.scale * delta));
      const rect = stockWrap.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      stockView.tx = mx - (mx - stockView.tx) * (newScale / stockView.scale);
      stockView.ty = my - (my - stockView.ty) * (newScale / stockView.scale);
      stockView.scale = newScale;
      applyStockTransform();
    }, { passive: false });

    stockWrap.addEventListener('click', (e) => {
      if (stockView.moved) return;
      const bubble = e.target.closest('[data-stock-group]');
      if (!bubble) return;
      const key = bubble.dataset.stockGroup;
      const group = stockView.groups.find(g => g.key === key);
      if (group) openStockGroupModal(group);
    });
  }

  $('#stock-reset-view').addEventListener('click', resetStockView);

  function openStockGroupModal(group) {
    const qty = group.items.length;
    const totalBuy = group.items.reduce((s, x) => s + Number(x.buyPrice || 0), 0);
    const avgBuy = qty > 0 ? totalBuy / qty : 0;
    const img = group.image
      ? `<img src="${esc(group.image)}" class="detail-modal-img" alt="" />`
      : '';

    modal({
      title: group.name,
      body: `
        ${img}
        <div class="detail-rows">
          <div class="detail-row"><span class="detail-row-label">Marque</span><span class="detail-row-value">${esc(group.brand || '—')}</span></div>
          <div class="detail-row"><span class="detail-row-label">En stock</span><span class="detail-row-value">${qty} exemplaire${qty > 1 ? 's' : ''}</span></div>
          <div class="detail-row"><span class="detail-row-label">Prix d'achat moyen</span><span class="detail-row-value">${fmtEUR(avgBuy)}</span></div>
          <div class="detail-row"><span class="detail-row-label">Valeur totale</span><span class="detail-row-value">${fmtEUR(totalBuy)}</span></div>
        </div>
        <p class="muted" style="margin-top:14px;font-size:12.5px">Mettre en vente agit sur un exemplaire à la fois.</p>
      `,
      actions: [
        { label: 'Fermer', variant: 'btn-ghost' },
        { label: 'Modifier', variant: 'btn-ghost-bordered', onClick: () => {
            addEditingId = group.items[0].id; location.hash = '#add';
          }
        },
        { label: 'Mettre en vente', variant: 'btn-primary', onClick: () => {
            setTimeout(() => openListItemModal(group.items[0]), 50);
          }
        },
      ],
    });
  }

  function openListItemModal(s) {
    modal({
      title: 'Mettre en vente',
      body: `
        <p style="margin-bottom:12px;color:var(--text-3)">Indiquez le prix demandé pour <strong>${esc(s.name)}</strong>.</p>
        <label class="field"><span class="field-label">Prix demandé</span>
          <input type="number" step="0.01" id="li-price" placeholder="0,00 €" /></label>
        <label class="field"><span class="field-label">Frais de port</span>
          <input type="number" step="0.01" id="li-ship" value="${s.shipping || ''}" placeholder="0,00 €" /></label>
        <label class="field"><span class="field-label">Date de mise en vente</span>
          <input type="date" id="li-date" value="${todayISO()}" /></label>
      `,
      actions: [
        { label: 'Annuler', variant: 'btn-ghost' },
        { label: 'Mettre en vente', variant: 'btn-primary', onClick: async () => {
            const price = Number($('#li-price').value);
            const ship = Number($('#li-ship').value) || 0;
            const date = $('#li-date').value || todayISO();
            if (!price || price <= 0) { toast('Indiquez un prix demandé valide.', 'error'); return false; }
            await persistSalePatch(s, { status: 'listed', sellPrice: price, shipping: ship, listedAt: date, soldAt: null });
            toast('Article mis en vente. Retrouvez-le dans Articles.', 'success');
            renderStock();
          }
        },
      ],
    });
  }

  // ============================================================
  //  VIEW : SETTINGS
  // ============================================================
  const renderSettings = () => {
    setTheme(document.documentElement.dataset.theme || 'light');
  };

  $$('.theme-option').forEach(b => b.addEventListener('click', () => setTheme(b.dataset.theme)));

  $('#export-btn').addEventListener('click', () => {
    const exportData = {
      exportedAt: new Date().toISOString(),
      version: '1.0.0',
      user: { name: currentUser.name, email: currentUser.email },
      sales: userSales(),
    };
    downloadFile(`selltrack-${todayISO()}.json`, JSON.stringify(exportData, null, 2));
    toast('Données exportées.', 'success');
  });

  $('#import-btn').addEventListener('click', () => $('#import-input').click());
  $('#import-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!Array.isArray(data.sales)) throw new Error('Format invalide');
      modal({
        title: 'Importer ces données ?',
        body: `<p>${data.sales.length} article(s) trouvé(s) dans le fichier. Ils seront ajoutés à votre stock actuel.</p>`,
        actions: [
          { label: 'Annuler', variant: 'btn-ghost' },
          {
            label: 'Importer', variant: 'btn-primary', onClick: () => {
              data.sales.forEach(s => {
                store.sales.push({
                  ...s,
                  id: uid(),
                  userId: currentUser.id,
                  createdAt: new Date().toISOString(),
                });
              });
              saveStore();
              toast(`${data.sales.length} article(s) importé(s).`, 'success');
            }
          },
        ],
      });
    } catch (err) {
      toast('Fichier invalide.', 'error');
    }
    e.target.value = '';
  });

  $('#reset-btn').addEventListener('click', () => {
    modal({
      title: 'Réinitialiser les données ?',
      body: `<p>Tous vos articles seront supprimés définitivement. Cette action est <strong>irréversible</strong>.</p>`,
      actions: [
        { label: 'Annuler', variant: 'btn-ghost' },
        {
          label: 'Réinitialiser', variant: 'btn-danger', onClick: async () => {
            try {
              if (isCloud()) await Cloud().sales.deleteAll(currentUser.id);
              store.sales = store.sales.filter(s => s.userId !== currentUser.id);
              if (!isCloud()) saveStore();
              toast('Toutes vos données ont été effacées.', 'success');
              if (location.hash === '#dashboard') renderDashboard();
            } catch (err) {
              toast(err.message || 'Erreur lors de la réinitialisation.', 'error');
            }
          }
        },
      ],
    });
  });

  // ============================================================
  //  VIEW : ADMIN (panneau premium multi-onglets)
  // ============================================================
  // État interne du panneau admin
  const adminState = {
    activeTab: 'overview',
    users: [],
    sales: [],
    images: [],
    stats: null,
    charts: {},  // instances Chart.js par id
    filters: {
      userSearch: '', userRole: '', userStatus: '',
      saleSearch: '', saleUser: '', saleBrand: '', saleCondition: '',
      imageSearch: '',
    },
    sqlLastResult: null,
  };

  const adminCloud = () => isCloud() ? Cloud() : null;

  // ---- Switching tabs ----
  function switchAdminTab(tab) {
    adminState.activeTab = tab;
    $$('.admin-tab').forEach(t => t.classList.toggle('is-active', t.dataset.adminTab === tab));
    $$('.admin-pane').forEach(p => p.hidden = p.dataset.adminPane !== tab);
    renderAdminPane(tab);
  }

  $$('.admin-tab').forEach(t => t.addEventListener('click', () => switchAdminTab(t.dataset.adminTab)));

  $('#admin-refresh-btn').addEventListener('click', () => {
    // Force reload du pane actif
    renderAdminPane(adminState.activeTab, true);
    toast('Données actualisées.', 'success');
  });

  // ---- Entry point appelé par handleRoute ----
  const renderAdmin = () => {
    if (currentUser.role !== 'admin') return;
    switchAdminTab(adminState.activeTab || 'overview');
  };

  // ---- Dispatcher par onglet ----
  async function renderAdminPane(tab, force = false) {
    try {
      if (tab === 'overview') await renderAdminOverview();
      else if (tab === 'users') await renderAdminUsers();
      else if (tab === 'sales') await renderAdminSales();
      else if (tab === 'images') await renderAdminImages();
      else if (tab === 'sql') renderAdminSQL();
      if (window.lucide) lucide.createIcons({ icons: lucide.icons });
    } catch (err) {
      console.error('Admin render error:', err);
      toast(err.message || 'Erreur dans le panneau admin.', 'error');
    }
  }

  // ============================================================
  //  ADMIN — OVERVIEW
  // ============================================================
  async function renderAdminOverview() {
    let stats;
    if (adminCloud()) {
      stats = await adminCloud().stats.global();
    } else {
      stats = {
        totalUsers: store.users.length,
        banned: store.users.filter(u => u.status === 'banned').length,
        totalSales: store.sales.length,
        totalRevenue: store.sales.reduce((s, x) => s + Number(x.sellPrice || 0), 0),
        totalProfit: store.sales.reduce((s, x) => s + profitOf(x), 0),
      };
    }
    adminState.stats = stats;

    const totalAdmins = adminCloud()
      ? (stats.profiles || []).filter(p => p.role === 'admin').length
      : store.users.filter(u => u.role === 'admin').length;

    $('#admin-kpis').innerHTML = [
      { label: 'Utilisateurs', value: fmtNum(stats.totalUsers), cls: 'kpi-violet', icon: 'users' },
      { label: 'Administrateurs', value: fmtNum(totalAdmins), cls: 'kpi-violet', icon: 'shield' },
      { label: 'Suspendus', value: fmtNum(stats.banned), cls: 'kpi-red', icon: 'shield-ban' },
      { label: 'Articles vendus', value: fmtNum(stats.totalSales), cls: 'kpi-blue', icon: 'package' },
      { label: 'CA global', value: fmtEUR(stats.totalRevenue), cls: 'kpi-green', icon: 'trending-up' },
      { label: 'Bénéfice global', value: fmtEUR(stats.totalProfit), cls: 'kpi-green', icon: 'wallet' },
    ].map(k => `
      <div class="kpi ${k.cls}">
        <span class="kpi-label">${esc(k.label)}</span>
        <span class="kpi-value">${esc(k.value)}</span>
      </div>
    `).join('');

    // Charts : seulement en mode cloud (les agrégations mois par mois nécessitent toutes les ventes)
    if (adminCloud()) {
      const [revByMonth, signupsByMonth, topSellers, topBrands, condBreak, recent] = await Promise.all([
        adminCloud().stats.revenueByMonth(),
        adminCloud().stats.signupsByMonth(),
        adminCloud().stats.topSellers(5),
        adminCloud().stats.topBrands(10),
        adminCloud().stats.conditionBreakdown(),
        adminCloud().stats.recentActivity(10),
      ]);

      drawAdminRevenueChart(revByMonth);
      drawAdminSignupsChart(signupsByMonth);
      drawAdminBrandsChart(topBrands);
      drawAdminConditionsChart(condBreak);
      renderTopSellers(topSellers);
      renderAdminActivity(recent);
    } else {
      // Mode local : on désactive les charts détaillés
      ['admin-chart-revenue', 'admin-chart-signups', 'admin-chart-brands', 'admin-chart-conditions']
        .forEach(id => {
          const wrap = $('#' + id)?.parentElement;
          if (wrap) wrap.innerHTML = '<div class="admin-empty">Disponible en mode cloud (Supabase) uniquement.</div>';
        });
      $('#admin-top-sellers').innerHTML = '<div class="admin-empty">Disponible en mode cloud.</div>';
      $('#admin-activity').innerHTML = '<div class="admin-empty">Disponible en mode cloud.</div>';
    }
  }

  function destroyChart(id) {
    if (adminState.charts[id]) { adminState.charts[id].destroy(); delete adminState.charts[id]; }
  }

  function drawAdminRevenueChart(data) {
    const ctx = $('#admin-chart-revenue')?.getContext('2d');
    if (!ctx) return;
    destroyChart('revenue');
    const c = chartColors();
    const labels = data.map(d => formatMonthLabel(d.key));
    adminState.charts.revenue = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'CA', data: data.map(d => Number(d.revenue.toFixed(2))), backgroundColor: c.greenFill, borderColor: c.green, borderWidth: 1.5, borderRadius: 6 },
          { label: 'Bénéfice', data: data.map(d => Number(d.profit.toFixed(2))), backgroundColor: 'rgba(124, 92, 255, 0.18)', borderColor: '#7c5cff', borderWidth: 1.5, borderRadius: 6 },
        ],
      },
      options: { ...baseChartOptions() },
    });
  }

  function drawAdminSignupsChart(data) {
    const ctx = $('#admin-chart-signups')?.getContext('2d');
    if (!ctx) return;
    destroyChart('signups');
    const c = chartColors();
    const labels = data.map(d => formatMonthLabel(d.key));
    adminState.charts.signups = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Inscriptions',
          data: data.map(d => d.count),
          borderColor: '#7c5cff',
          backgroundColor: 'rgba(124, 92, 255, 0.15)',
          fill: true,
          tension: 0.35,
          pointBackgroundColor: '#7c5cff',
        }],
      },
      options: {
        ...baseChartOptions(),
        scales: {
          x: { grid: { display: false }, ticks: { color: c.text } },
          y: {
            grid: { color: c.grid },
            ticks: { color: c.text, callback: (v) => Number.isInteger(v) ? v : '' },
            beginAtZero: true,
          },
        },
        plugins: { ...baseChartOptions().plugins, tooltip: { callbacks: { label: (ctx) => `${ctx.parsed.y} inscription(s)` } } },
      },
    });
  }

  function drawAdminBrandsChart(data) {
    const ctx = $('#admin-chart-brands')?.getContext('2d');
    if (!ctx) return;
    destroyChart('brands');
    const c = chartColors();
    adminState.charts.brands = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: data.map(d => d.brand),
        datasets: [{
          label: 'Ventes',
          data: data.map(d => d.count),
          backgroundColor: data.map((_, i) => `hsl(${260 + i * 12}, 70%, 60%)`),
          borderRadius: 6,
        }],
      },
      options: {
        ...baseChartOptions(),
        indexAxis: 'y',
        plugins: { legend: { display: false }, tooltip: baseChartOptions().plugins.tooltip },
        scales: {
          x: { grid: { color: c.grid }, ticks: { color: c.text } },
          y: { grid: { display: false }, ticks: { color: c.text, font: { family: 'Manrope', size: 11 } } },
        },
      },
    });
  }

  function drawAdminConditionsChart(data) {
    const ctx = $('#admin-chart-conditions')?.getContext('2d');
    if (!ctx) return;
    destroyChart('conditions');
    const c = chartColors();
    const palette = ['#22c55e', '#7c5cff', '#3b82f6', '#f59e0b', '#ef4444', '#94a3b8'];
    adminState.charts.conditions = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: data.map(d => d.condition),
        datasets: [{
          data: data.map(d => d.count),
          backgroundColor: data.map((_, i) => palette[i % palette.length]),
          borderColor: 'transparent',
          borderWidth: 2,
        }],
      },
      options: {
        maintainAspectRatio: false,
        responsive: true,
        cutout: '60%',
        plugins: {
          legend: { position: 'right', labels: { color: c.text, font: { family: 'Manrope', size: 12 }, boxWidth: 12 } },
          tooltip: baseChartOptions().plugins.tooltip,
        },
      },
    });
  }

  function renderTopSellers(items) {
    if (!items.length) { $('#admin-top-sellers').innerHTML = '<div class="admin-empty">Aucune vente pour l\'instant.</div>'; return; }
    $('#admin-top-sellers').innerHTML = items.map((s, i) => {
      const rankCls = i === 0 ? 'top-rank-1' : i === 1 ? 'top-rank-2' : i === 2 ? 'top-rank-3' : 'top-rank-other';
      return `
        <div class="top-item">
          <div class="top-rank ${rankCls}">${i + 1}</div>
          <div class="top-info">
            <div class="top-name">${esc(s.name)}</div>
            <div class="top-meta">${esc(s.email)} · ${s.count} vente${s.count > 1 ? 's' : ''}</div>
          </div>
          <div class="top-value">+${fmtEUR(s.profit)}</div>
        </div>
      `;
    }).join('');
  }

  function renderAdminActivity(items) {
    if (!items.length) { $('#admin-activity').innerHTML = '<div class="admin-empty">Pas d\'activité récente.</div>'; return; }
    $('#admin-activity').innerHTML = items.map(a => {
      const ago = timeAgo(a.when);
      const iconCls = a.type === 'signup' ? 'activity-icon-signup' : 'activity-icon-sale';
      const icon = a.type === 'signup' ? 'user-plus' : 'shopping-bag';
      return `
        <div class="activity-item">
          <div class="activity-icon ${iconCls}"><i data-lucide="${icon}"></i></div>
          <div class="activity-text">
            <div class="activity-label">${esc(a.label)}</div>
            <div class="activity-meta">${esc(a.meta || '')}</div>
          </div>
          <div class="activity-time">${ago}</div>
        </div>
      `;
    }).join('');
  }

  function formatMonthLabel(yyyyMm) {
    const [y, m] = yyyyMm.split('-');
    const months = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];
    return `${months[Number(m) - 1]} ${y.slice(2)}`;
  }

  function timeAgo(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const diffMs = Date.now() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'à l\'instant';
    if (diffMin < 60) return `il y a ${diffMin} min`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `il y a ${diffH}h`;
    const diffD = Math.floor(diffH / 24);
    if (diffD < 7) return `il y a ${diffD}j`;
    return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  }

  // ============================================================
  //  ADMIN — USERS
  // ============================================================
  async function renderAdminUsers() {
    if (adminCloud()) {
      adminState.users = await adminCloud().admin.listUsers();
    } else {
      adminState.users = store.users.map(u => ({
        ...u,
        salesCount: store.sales.filter(s => s.userId === u.id).length,
        revenue: store.sales.filter(s => s.userId === u.id).reduce((sum, s) => sum + Number(s.sellPrice || 0), 0),
        profit: store.sales.filter(s => s.userId === u.id).reduce((sum, s) => sum + profitOf(s), 0),
      }));
    }
    drawAdminUsersTable();
  }

  function drawAdminUsersTable() {
    const q = adminState.filters.userSearch.toLowerCase();
    const roleF = adminState.filters.userRole;
    const statusF = adminState.filters.userStatus;
    const list = adminState.users.filter(u => {
      if (q && !u.name.toLowerCase().includes(q) && !u.email.toLowerCase().includes(q)) return false;
      if (roleF && u.role !== roleF) return false;
      if (statusF && u.status !== statusF) return false;
      return true;
    });

    if (!list.length) {
      $('#admin-users-tbody').innerHTML = '<tr><td colspan="9"><div class="admin-empty">Aucun utilisateur ne correspond.</div></td></tr>';
      return;
    }

    $('#admin-users-tbody').innerHTML = list.map(u => {
      const isSelf = u.id === currentUser.id;
      const profitCls = u.profit > 0 ? 'positive' : u.profit < 0 ? 'negative' : '';
      return `
        <tr data-uid="${esc(u.id)}">
          <td>
            <div class="user-cell">
              <div class="user-avatar">${esc(initials(u.name))}</div>
              <span>${esc(u.name)}${isSelf ? ' <em style="color:var(--text-3)">(vous)</em>' : ''}</span>
            </div>
          </td>
          <td>${esc(u.email)}</td>
          <td><span class="badge ${u.role === 'admin' ? 'badge-admin' : 'badge-user'}">${u.role === 'admin' ? 'Admin' : 'User'}</span></td>
          <td class="text-right num">${fmtNum(u.salesCount)}</td>
          <td class="text-right num">${fmtEUR(u.revenue)}</td>
          <td class="text-right num ${profitCls}">${fmtEUR(u.profit)}</td>
          <td>${new Date(u.createdAt).toLocaleDateString('fr-FR')}</td>
          <td><span class="badge ${u.status === 'banned' ? 'badge-banned' : 'badge-active'}">${u.status === 'banned' ? 'Suspendu' : 'Actif'}</span></td>
          <td class="text-right">
            <button class="btn-icon" data-admin-view-user="${esc(u.id)}" title="Voir les ventes"><i data-lucide="eye"></i></button>
            <button class="btn-icon" data-admin-edit-user="${esc(u.id)}" title="Modifier"><i data-lucide="pencil"></i></button>
            ${isSelf ? '' : `
              <button class="btn-icon" data-admin-reset-pwd="${esc(u.id)}" title="Envoyer reset mot de passe"><i data-lucide="key"></i></button>
              <button class="btn-icon" data-admin-toggle-ban="${esc(u.id)}" title="${u.status === 'banned' ? 'Réactiver' : 'Suspendre'}">
                <i data-lucide="${u.status === 'banned' ? 'shield-check' : 'shield-ban'}"></i>
              </button>
              <button class="btn-icon" data-admin-toggle-role="${esc(u.id)}" title="${u.role === 'admin' ? 'Retirer admin' : 'Promouvoir admin'}">
                <i data-lucide="${u.role === 'admin' ? 'user' : 'crown'}"></i>
              </button>
              <button class="btn-icon danger" data-admin-delete-user="${esc(u.id)}" title="Supprimer"><i data-lucide="trash-2"></i></button>
            `}
          </td>
        </tr>
      `;
    }).join('');
    if (window.lucide) lucide.createIcons({ icons: lucide.icons });
  }

  // Filtres users
  $('#admin-users-search').addEventListener('input', (e) => { adminState.filters.userSearch = e.target.value; drawAdminUsersTable(); });
  $('#admin-users-role').addEventListener('change', (e) => { adminState.filters.userRole = e.target.value; drawAdminUsersTable(); });
  $('#admin-users-status').addEventListener('change', (e) => { adminState.filters.userStatus = e.target.value; drawAdminUsersTable(); });

  // Actions users (event delegation)
  $('#admin-users-tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-admin-view-user], button[data-admin-edit-user], button[data-admin-reset-pwd], button[data-admin-toggle-ban], button[data-admin-toggle-role], button[data-admin-delete-user]');
    if (!btn) return;
    const id = btn.dataset.adminViewUser || btn.dataset.adminEditUser || btn.dataset.adminResetPwd
      || btn.dataset.adminToggleBan || btn.dataset.adminToggleRole || btn.dataset.adminDeleteUser;
    const u = adminState.users.find(x => x.id === id);
    if (!u) return;

    if (btn.dataset.adminViewUser) return openUserSalesModal(u);
    if (btn.dataset.adminEditUser) return openEditUserModal(u);
    if (btn.dataset.adminResetPwd) return adminResetPassword(u);
    if (btn.dataset.adminToggleBan) return adminToggleBan(u);
    if (btn.dataset.adminToggleRole) return adminToggleRole(u);
    if (btn.dataset.adminDeleteUser) return adminDeleteUser(u);
  });

  async function openUserSalesModal(u) {
    let sales = [];
    try {
      sales = adminCloud()
        ? await adminCloud().admin.getUserSales(u.id)
        : store.sales.filter(s => s.userId === u.id);
    } catch (err) { toast(err.message, 'error'); return; }

    const rows = sales.slice(0, 50).map(s => `
      <tr>
        <td>${esc(s.name)}</td>
        <td>${esc(s.brand || '—')}</td>
        <td>${new Date(s.soldAt).toLocaleDateString('fr-FR')}</td>
        <td class="text-right num">${fmtEUR(s.sellPrice)}</td>
        <td class="text-right num ${profitOf(s) >= 0 ? 'positive' : 'negative'}">${fmtEUR(profitOf(s))}</td>
      </tr>
    `).join('');

    modal({
      title: `Ventes de ${u.name}`,
      body: `
        <p style="margin-bottom:12px;color:var(--text-3)">${sales.length} vente${sales.length > 1 ? 's' : ''} au total${sales.length > 50 ? ' (50 premières affichées)' : ''}.</p>
        ${sales.length === 0 ? '<div class="admin-empty">Cet utilisateur n\'a aucune vente.</div>' : `
          <div class="table-wrap" style="max-height:400px">
            <table class="data-table" style="font-size:12.5px">
              <thead><tr><th>Article</th><th>Marque</th><th>Date</th><th class="text-right">Vente</th><th class="text-right">Bénéfice</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        `}
      `,
      actions: [{ label: 'Fermer', variant: 'btn-ghost' }],
    });
  }

  function openEditUserModal(u) {
    modal({
      title: 'Modifier l\'utilisateur',
      body: `
        <label class="field">
          <span class="field-label">Nom</span>
          <input type="text" id="edit-user-name" value="${esc(u.name)}" />
        </label>
        <label class="field">
          <span class="field-label">Email</span>
          <input type="email" id="edit-user-email" value="${esc(u.email)}" />
        </label>
        <p class="muted" style="margin-top:4px;font-size:12px">Note : la modification d'email côté Supabase Auth se fait dans Supabase Studio.</p>
      `,
      actions: [
        { label: 'Annuler', variant: 'btn-ghost' },
        {
          label: 'Enregistrer', variant: 'btn-primary', onClick: async () => {
            const name = $('#edit-user-name').value.trim();
            const email = $('#edit-user-email').value.trim();
            if (!name) { toast('Nom requis.', 'error'); return false; }
            try {
              if (adminCloud()) await adminCloud().admin.updateUser(u.id, { name, email });
              else { u.name = name; u.email = email; saveStore(); }
              toast('Utilisateur mis à jour.', 'success');
              renderAdminUsers();
            } catch (err) { toast(err.message, 'error'); return false; }
          },
        },
      ],
    });
  }

  function adminResetPassword(u) {
    modal({
      title: 'Réinitialiser le mot de passe ?',
      body: `<p>Un email de réinitialisation sera envoyé à <strong>${esc(u.email)}</strong>.</p>`,
      actions: [
        { label: 'Annuler', variant: 'btn-ghost' },
        {
          label: 'Envoyer', variant: 'btn-primary', onClick: async () => {
            if (!adminCloud()) { toast('Disponible uniquement en mode cloud.', 'error'); return; }
            try {
              await adminCloud().admin.sendPasswordReset(u.email);
              toast(`Email envoyé à ${u.email}.`, 'success');
            } catch (err) { toast(err.message, 'error'); }
          },
        },
      ],
    });
  }

  async function adminToggleBan(u) {
    const newStatus = u.status === 'banned' ? 'active' : 'banned';
    try {
      if (adminCloud()) await adminCloud().admin.updateUser(u.id, { status: newStatus });
      else { u.status = newStatus; saveStore(); }
      toast(newStatus === 'banned' ? 'Utilisateur suspendu.' : 'Utilisateur réactivé.', 'success');
      renderAdminUsers();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function adminToggleRole(u) {
    const newRole = u.role === 'admin' ? 'user' : 'admin';
    try {
      if (adminCloud()) await adminCloud().admin.updateUser(u.id, { role: newRole });
      else { u.role = newRole; saveStore(); }
      toast(`Rôle modifié : ${newRole}.`, 'success');
      renderAdminUsers();
    } catch (err) { toast(err.message, 'error'); }
  }

  function adminDeleteUser(u) {
    modal({
      title: 'Supprimer cet utilisateur ?',
      body: `<p>L'utilisateur <strong>${esc(u.name)}</strong> et toutes ses ventes seront supprimés définitivement.</p>
             <p style="font-size:12px;color:var(--text-3);margin-top:8px">Note : le compte d'authentification Supabase devra être supprimé manuellement depuis Supabase Studio.</p>`,
      actions: [
        { label: 'Annuler', variant: 'btn-ghost' },
        {
          label: 'Supprimer', variant: 'btn-danger', onClick: async () => {
            try {
              if (adminCloud()) await adminCloud().admin.deleteUser(u.id);
              else {
                store.users = store.users.filter(x => x.id !== u.id);
                store.sales = store.sales.filter(s => s.userId !== u.id);
                saveStore();
              }
              toast('Utilisateur supprimé.', 'success');
              renderAdminUsers();
            } catch (err) { toast(err.message, 'error'); }
          },
        },
      ],
    });
  }

  // ============================================================
  //  ADMIN — ALL SALES
  // ============================================================
  async function renderAdminSales() {
    if (adminCloud()) {
      adminState.sales = await adminCloud().admin.listAllSales();
    } else {
      const usersById = Object.fromEntries(store.users.map(u => [u.id, u]));
      adminState.sales = store.sales.map(s => ({
        ...s,
        ownerName: usersById[s.userId]?.name || '—',
        ownerEmail: usersById[s.userId]?.email || '',
      }));
    }
    // Populate filters
    const users = [...new Set(adminState.sales.map(s => `${s.userId}::${s.ownerName}`))]
      .map(p => { const [id, name] = p.split('::'); return { id, name }; });
    $('#admin-sales-user').innerHTML = '<option value="">Tous les utilisateurs</option>'
      + users.map(u => `<option value="${esc(u.id)}">${esc(u.name)}</option>`).join('');
    const brands = [...new Set(adminState.sales.map(s => s.brand).filter(Boolean))].sort();
    $('#admin-sales-brand').innerHTML = '<option value="">Toutes les marques</option>'
      + brands.map(b => `<option>${esc(b)}</option>`).join('');

    drawAdminSalesTable();
  }

  function drawAdminSalesTable() {
    const q = adminState.filters.saleSearch.toLowerCase();
    const userF = adminState.filters.saleUser;
    const brandF = adminState.filters.saleBrand;
    const condF = adminState.filters.saleCondition;
    const list = adminState.sales.filter(s => {
      if (q && !s.name.toLowerCase().includes(q) && !(s.ownerName || '').toLowerCase().includes(q)) return false;
      if (userF && s.userId !== userF) return false;
      if (brandF && s.brand !== brandF) return false;
      if (condF && s.condition !== condF) return false;
      return true;
    });

    if (!list.length) {
      $('#admin-sales-tbody').innerHTML = '<tr><td colspan="10"><div class="admin-empty">Aucune vente ne correspond.</div></td></tr>';
      return;
    }

    $('#admin-sales-tbody').innerHTML = list.slice(0, 200).map(s => {
      const profit = profitOf(s);
      const thumb = s.image
        ? `<img src="${esc(s.image)}" class="sale-thumb" alt="" />`
        : `<div class="sale-thumb-placeholder"><i data-lucide="image"></i></div>`;
      return `
        <tr data-sid="${esc(s.id)}">
          <td>${thumb}</td>
          <td><strong>${esc(s.name)}</strong></td>
          <td><div class="user-cell"><div class="user-avatar" style="width:24px;height:24px;font-size:10px">${esc(initials(s.ownerName))}</div><span style="font-size:12.5px">${esc(s.ownerName)}</span></div></td>
          <td>${esc(s.brand || '—')}</td>
          <td><span class="sale-condition">${esc(s.condition || '—')}</span></td>
          <td class="text-right num">${fmtEUR(s.buyPrice)}</td>
          <td class="text-right num">${fmtEUR(s.sellPrice)}</td>
          <td class="text-right num ${profit >= 0 ? 'positive' : 'negative'}">${fmtEUR(profit)}</td>
          <td>${new Date(s.soldAt).toLocaleDateString('fr-FR')}</td>
          <td class="text-right">
            <button class="btn-icon" data-admin-edit-sale="${esc(s.id)}" title="Modifier"><i data-lucide="pencil"></i></button>
            <button class="btn-icon danger" data-admin-delete-sale="${esc(s.id)}" title="Supprimer"><i data-lucide="trash-2"></i></button>
          </td>
        </tr>
      `;
    }).join('') + (list.length > 200 ? `<tr><td colspan="10"><div class="admin-empty">Affichage des 200 premières ventes sur ${list.length}. Affinez les filtres.</div></td></tr>` : '');
    if (window.lucide) lucide.createIcons({ icons: lucide.icons });
  }

  $('#admin-sales-search').addEventListener('input', (e) => { adminState.filters.saleSearch = e.target.value; drawAdminSalesTable(); });
  $('#admin-sales-user').addEventListener('change', (e) => { adminState.filters.saleUser = e.target.value; drawAdminSalesTable(); });
  $('#admin-sales-brand').addEventListener('change', (e) => { adminState.filters.saleBrand = e.target.value; drawAdminSalesTable(); });
  $('#admin-sales-condition').addEventListener('change', (e) => { adminState.filters.saleCondition = e.target.value; drawAdminSalesTable(); });

  $('#admin-sales-tbody').addEventListener('click', async (e) => {
    const editBtn = e.target.closest('[data-admin-edit-sale]');
    const delBtn = e.target.closest('[data-admin-delete-sale]');
    if (editBtn) {
      const id = editBtn.dataset.adminEditSale;
      const s = adminState.sales.find(x => x.id === id);
      if (s) openEditSaleModal(s);
    }
    if (delBtn) {
      const id = delBtn.dataset.adminDeleteSale;
      const s = adminState.sales.find(x => x.id === id);
      if (!s) return;
      modal({
        title: 'Supprimer cette vente ?',
        body: `<p>L'article <strong>${esc(s.name)}</strong> de <strong>${esc(s.ownerName)}</strong> sera supprimé définitivement.</p>`,
        actions: [
          { label: 'Annuler', variant: 'btn-ghost' },
          { label: 'Supprimer', variant: 'btn-danger', onClick: async () => {
              try {
                if (adminCloud()) await adminCloud().admin.deleteSale(id);
                else { store.sales = store.sales.filter(x => x.id !== id); saveStore(); }
                toast('Vente supprimée.', 'success');
                renderAdminSales();
              } catch (err) { toast(err.message, 'error'); }
            }
          },
        ],
      });
    }
  });

  function openEditSaleModal(s) {
    modal({
      title: 'Modifier la vente',
      body: `
        <label class="field"><span class="field-label">Nom</span><input type="text" id="es-name" value="${esc(s.name)}" /></label>
        <label class="field"><span class="field-label">Marque</span><input type="text" id="es-brand" value="${esc(s.brand || '')}" /></label>
        <label class="field"><span class="field-label">État</span>
          <select id="es-cond">
            ${['Neuf avec étiquette', 'Neuf sans étiquette', 'Très bon état', 'Bon état', 'Satisfaisant']
              .map(c => `<option ${c === s.condition ? 'selected' : ''}>${c}</option>`).join('')}
          </select>
        </label>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
          <label class="field"><span class="field-label">Achat</span><input type="number" step="0.01" id="es-buy" value="${s.buyPrice}" /></label>
          <label class="field"><span class="field-label">Vente</span><input type="number" step="0.01" id="es-sell" value="${s.sellPrice}" /></label>
          <label class="field"><span class="field-label">Port</span><input type="number" step="0.01" id="es-ship" value="${s.shipping || 0}" /></label>
        </div>
        <label class="field"><span class="field-label">Date</span><input type="date" id="es-date" value="${s.soldAt}" /></label>
      `,
      actions: [
        { label: 'Annuler', variant: 'btn-ghost' },
        {
          label: 'Enregistrer', variant: 'btn-primary', onClick: async () => {
            const patch = {
              name: $('#es-name').value.trim(),
              brand: $('#es-brand').value.trim(),
              condition: $('#es-cond').value,
              buyPrice: Number($('#es-buy').value),
              sellPrice: Number($('#es-sell').value),
              shipping: Number($('#es-ship').value),
              soldAt: $('#es-date').value,
              image: s.image,
            };
            try {
              if (adminCloud()) await adminCloud().admin.updateSale(s.id, patch);
              else { Object.assign(s, patch); saveStore(); }
              toast('Vente mise à jour.', 'success');
              renderAdminSales();
            } catch (err) { toast(err.message, 'error'); return false; }
          },
        },
      ],
    });
  }

  // ============================================================
  //  ADMIN — IMAGES
  // ============================================================
  async function renderAdminImages() {
    if (!adminCloud()) {
      $('#admin-image-gallery').innerHTML = '<div class="admin-empty">Galerie d\'images disponible en mode cloud (Supabase) uniquement.</div>';
      $('#admin-images-stats span').textContent = '';
      return;
    }
    try {
      adminState.images = await adminCloud().admin.listAllImages();
    } catch (err) { toast(err.message, 'error'); adminState.images = []; }
    drawAdminImageGallery();
  }

  function drawAdminImageGallery() {
    const q = adminState.filters.imageSearch.toLowerCase();
    const usersById = Object.fromEntries(adminState.users.map(u => [u.id, u.name]));
    const filtered = adminState.images.filter(img => {
      if (!q) return true;
      const name = (usersById[img.userId] || '').toLowerCase();
      return name.includes(q) || img.userId.includes(q);
    });

    const totalSize = filtered.reduce((s, x) => s + (x.size || 0), 0);
    $('#admin-images-stats span').textContent = `${filtered.length} image${filtered.length > 1 ? 's' : ''} · ${fmtSize(totalSize)}`;

    $('#admin-images-empty').hidden = filtered.length > 0;
    if (filtered.length === 0) { $('#admin-image-gallery').innerHTML = ''; return; }

    $('#admin-image-gallery').innerHTML = filtered.map(img => {
      const ownerName = usersById[img.userId] || img.userId.slice(0, 8);
      return `
        <div class="image-tile" data-img-path="${esc(img.path)}">
          <img src="${esc(img.url)}" alt="" loading="lazy" />
          <button class="image-tile-delete" data-delete-image="${esc(img.path)}"><i data-lucide="trash-2"></i></button>
          <div class="image-tile-overlay">
            <span title="${esc(ownerName)}">${esc(ownerName.slice(0, 12))}${ownerName.length > 12 ? '…' : ''}</span>
            <span class="image-tile-size">${fmtSize(img.size)}</span>
          </div>
        </div>
      `;
    }).join('');
    if (window.lucide) lucide.createIcons({ icons: lucide.icons });
  }

  function fmtSize(bytes) {
    if (!bytes) return '0 Ko';
    if (bytes < 1024) return `${bytes} o`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} Mo`;
  }

  $('#admin-images-search').addEventListener('input', (e) => {
    adminState.filters.imageSearch = e.target.value;
    drawAdminImageGallery();
  });

  $('#admin-image-gallery').addEventListener('click', async (e) => {
    const delBtn = e.target.closest('[data-delete-image]');
    if (!delBtn) {
      // Clic sur la tuile : ouvrir en grand
      const tile = e.target.closest('.image-tile');
      if (tile) {
        const path = tile.dataset.imgPath;
        const img = adminState.images.find(i => i.path === path);
        if (img) {
          modal({
            title: 'Image',
            body: `<img src="${esc(img.url)}" style="max-width:100%;border-radius:12px" />
                   <p style="margin-top:10px;font-size:12px;color:var(--text-3)">Chemin : <code>${esc(img.path)}</code></p>`,
            actions: [{ label: 'Fermer', variant: 'btn-ghost' }],
          });
        }
      }
      return;
    }
    e.stopPropagation();
    const path = delBtn.dataset.deleteImage;
    modal({
      title: 'Supprimer cette image ?',
      body: `<p>L'image sera supprimée définitivement du stockage. Cette action est <strong>irréversible</strong>.</p>`,
      actions: [
        { label: 'Annuler', variant: 'btn-ghost' },
        { label: 'Supprimer', variant: 'btn-danger', onClick: async () => {
            try {
              await adminCloud().admin.deleteImage(path);
              toast('Image supprimée.', 'success');
              renderAdminImages();
            } catch (err) { toast(err.message, 'error'); }
          }
        },
      ],
    });
  });

  // ============================================================
  //  ADMIN — SQL EDITOR
  // ============================================================
  const SQL_TEMPLATES = [
    { label: 'Top 10 utilisateurs', sql: 'select p.name, p.email, count(s.id) as ventes, sum(s.sell_price) as ca\nfrom profiles p\nleft join sales s on s.user_id = p.id\ngroup by p.id, p.name, p.email\norder by ca desc nulls last\nlimit 10' },
    { label: 'CA par mois (12m)', sql: "select to_char(sold_at, 'YYYY-MM') as mois, count(*) as ventes,\n       sum(sell_price) as ca,\n       sum(sell_price - buy_price - shipping) as benefice\nfrom sales\nwhere sold_at >= current_date - interval '12 months'\ngroup by mois order by mois" },
    { label: 'Top marques', sql: 'select brand, count(*) as ventes, sum(sell_price) as ca,\n       round(avg(sell_price - buy_price - shipping)::numeric, 2) as benefice_moyen\nfrom sales\nwhere brand is not null\ngroup by brand\norder by ventes desc\nlimit 20' },
    { label: 'Ventes récentes', sql: 'select s.name, s.brand, s.sell_price, s.sold_at, p.name as vendeur\nfrom sales s\njoin profiles p on p.id = s.user_id\norder by s.created_at desc\nlimit 30' },
    { label: 'Utilisateurs inactifs', sql: 'select p.name, p.email, p.created_at\nfrom profiles p\nleft join sales s on s.user_id = p.id\nwhere s.id is null\norder by p.created_at desc' },
  ];

  function renderAdminSQL() {
    $('#sql-templates').innerHTML = SQL_TEMPLATES.map((t, i) =>
      `<button class="sql-template-btn" data-tpl="${i}">${esc(t.label)}</button>`
    ).join('');
    if (!$('#sql-input').value.trim()) {
      $('#sql-input').value = SQL_TEMPLATES[0].sql;
    }
  }

  $('#sql-templates').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tpl]');
    if (!btn) return;
    $('#sql-input').value = SQL_TEMPLATES[Number(btn.dataset.tpl)].sql;
  });

  $('#sql-clear-btn').addEventListener('click', () => {
    $('#sql-input').value = '';
    $('#sql-info').textContent = '';
    $('#sql-info').className = 'sql-info';
    $('#sql-results-card').hidden = true;
    adminState.sqlLastResult = null;
  });

  $('#sql-run-btn').addEventListener('click', async () => {
    const sql = $('#sql-input').value;
    const info = $('#sql-info');
    if (!adminCloud()) {
      info.textContent = 'Disponible en mode cloud uniquement.';
      info.className = 'sql-info error';
      return;
    }
    info.textContent = 'Exécution...';
    info.className = 'sql-info';
    const t0 = performance.now();
    try {
      const rows = await adminCloud().admin.runSelect(sql);
      const elapsed = Math.round(performance.now() - t0);
      info.textContent = `${rows.length} ligne${rows.length > 1 ? 's' : ''} · ${elapsed} ms`;
      info.className = 'sql-info success';
      adminState.sqlLastResult = rows;
      renderSQLResults(rows);
    } catch (err) {
      info.textContent = err.message || 'Erreur SQL';
      info.className = 'sql-info error';
      $('#sql-results-card').hidden = true;
    }
  });

  function renderSQLResults(rows) {
    const card = $('#sql-results-card');
    const table = $('#sql-results-table');
    if (!rows.length) {
      card.hidden = false;
      table.innerHTML = '<thead><tr><th>—</th></tr></thead><tbody><tr><td><div class="admin-empty">0 ligne</div></td></tr></tbody>';
      return;
    }
    const cols = Object.keys(rows[0]);
    table.innerHTML = `
      <thead><tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(r => `<tr>${cols.map(c => `<td>${formatSqlCell(r[c])}</td>`).join('')}</tr>`).join('')}</tbody>
    `;
    card.hidden = false;
  }

  function formatSqlCell(v) {
    if (v === null || v === undefined) return '<em style="color:var(--text-3)">null</em>';
    if (typeof v === 'object') return esc(JSON.stringify(v));
    return esc(String(v));
  }

  $('#sql-export-btn').addEventListener('click', () => {
    const rows = adminState.sqlLastResult;
    if (!rows || !rows.length) return;
    const cols = Object.keys(rows[0]);
    const csvEscape = (v) => {
      if (v === null || v === undefined) return '';
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [cols.join(',')]
      .concat(rows.map(r => cols.map(c => csvEscape(r[c])).join(',')))
      .join('\n');
    downloadFile(`sql-export-${todayISO()}.csv`, csv, 'text/csv');
    toast('Export CSV téléchargé.', 'success');
  });

  // ============================================================
  //  BOOTSTRAP
  // ============================================================
  loadStore();
  initTheme();
  if (window.lucide) lucide.createIcons({ icons: lucide.icons });

  (async () => {
    if (isCloud()) {
      // Mode cloud : on tente de restaurer la session Supabase
      try {
        const user = await Cloud().auth.getCurrentUser();
        if (user) {
          currentUser = user;
          await loadCloudSales();
          showApp();
        } else {
          showAuth();
        }
      } catch (err) {
        console.warn('Cloud session restore failed:', err);
        showAuth();
      }
      // Affiche un bandeau discret pour confirmer le mode cloud
      showCloudBadge();
    } else {
      // Mode local : restauration session localStorage classique
      currentUser = loadSession();
      if (currentUser) showApp();
      else showAuth();
    }
  })();

  function showCloudBadge() {
    if (document.getElementById('cloud-badge')) return;
    const b = document.createElement('div');
    b.id = 'cloud-badge';
    b.className = 'cloud-badge';
    b.innerHTML = '<i data-lucide="cloud-check"></i><span>Synchronisé</span>';
    document.body.appendChild(b);
    if (window.lucide) lucide.createIcons({ icons: lucide.icons });
    // Disparaît automatiquement après 3 secondes
    setTimeout(() => {
      b.classList.add('is-fading');
      setTimeout(() => b.remove(), 400);
    }, 3000);
  }

  // ============================================================
  //  PWA : Service Worker + Install prompt
  // ============================================================
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js')
        .then((reg) => {
          console.log('[SellTrack] SW enregistré, scope :', reg.scope);
          // Détection d'une nouvelle version
          reg.addEventListener('updatefound', () => {
            const nw = reg.installing;
            if (!nw) return;
            nw.addEventListener('statechange', () => {
              if (nw.state === 'installed' && navigator.serviceWorker.controller) {
                toast('Nouvelle version disponible. Rafraîchissez la page.', 'info');
              }
            });
          });
        })
        .catch((err) => console.warn('[SellTrack] SW échec :', err));
    });
  }

  // Capture du prompt d'installation (Chrome/Edge desktop & Android)
  let deferredInstallPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    // N'affiche le bouton que si on n'est pas connecté
    if (!currentUser) showInstallButton();
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    hideInstallButton();
    toast('SellTrack a été installé sur votre appareil 🎉', 'success');
  });

  function showInstallButton() {
    // Sécurité : pas d'affichage si l'utilisateur est connecté
    if (currentUser) return;
    if (document.getElementById('install-btn-floating')) return;
    const btn = document.createElement('button');
    btn.id = 'install-btn-floating';
    btn.className = 'install-btn-floating';
    btn.innerHTML = '<i data-lucide="download"></i><span>Installer l\'app</span>';
    btn.addEventListener('click', async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      const { outcome } = await deferredInstallPrompt.userChoice;
      if (outcome === 'accepted') hideInstallButton();
      deferredInstallPrompt = null;
    });
    document.body.appendChild(btn);
    if (window.lucide) lucide.createIcons({ icons: lucide.icons });
  }

  function hideInstallButton() {
    const btn = document.getElementById('install-btn-floating');
    if (btn) btn.remove();
  }

  // Expose pour pouvoir appeler depuis showApp/showAuth
  window._sellTrackInstall = {
    show: showInstallButton,
    hide: hideInstallButton,
    hasPrompt: () => !!deferredInstallPrompt,
  };
})();
