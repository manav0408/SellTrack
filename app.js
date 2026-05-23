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
  const ROUTES = ['dashboard', 'sales', 'add', 'stats', 'settings', 'admin'];

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
    if (a === 'goto-add') { addEditingId = null; location.hash = '#add'; }
    if (a === 'cancel-add') {
      addEditingId = null;
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
    const all = userSales();
    const { cur, prev } = aggregateCompare(all, period);
    const lastSale = [...all].sort((a, b) => b.soldAt.localeCompare(a.soldAt))[0];

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
  //  VIEW : SALES
  // ============================================================
  let salesLayout = 'list';
  const renderSales = () => {
    const all = userSales();
    const searchTerm = ($('#sales-search').value || '').trim().toLowerCase();
    const brandFilter = $('#sales-brand-filter').value;
    const condFilter = $('#sales-condition-filter').value;

    // Brand options
    const brands = Array.from(new Set(all.map(s => s.brand).filter(Boolean))).sort();
    $('#sales-brand-filter').innerHTML =
      `<option value="">Toutes les marques</option>` +
      brands.map(b => `<option ${b === brandFilter ? 'selected' : ''}>${esc(b)}</option>`).join('');

    const filtered = all.filter(s => {
      if (searchTerm && !s.name.toLowerCase().includes(searchTerm) && !(s.brand || '').toLowerCase().includes(searchTerm)) return false;
      if (brandFilter && s.brand !== brandFilter) return false;
      if (condFilter && s.condition !== condFilter) return false;
      return true;
    }).sort((a, b) => b.soldAt.localeCompare(a.soldAt));

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
      const profit = profitOf(s);
      const profitCls = profit >= 0 ? 'profit' : 'loss';
      const img = s.image
        ? `<img src="${s.image}" alt="" />`
        : `<i data-lucide="image"></i>`;
      if (salesLayout === 'list') {
        return `
          <div class="sale-item" data-id="${s.id}">
            <div class="sale-image">${img}</div>
            <div class="sale-name-block">
              <div class="sale-name">${esc(s.name)}</div>
              <div class="sale-brand">${esc(s.brand || '—')}</div>
              <span class="sale-condition">${esc(s.condition || '')}</span>
            </div>
            <div><div class="sale-col-label">Achat</div><div class="sale-col-value">${fmtEUR(s.buyPrice)}</div></div>
            <div><div class="sale-col-label">Vente</div><div class="sale-col-value">${fmtEUR(s.sellPrice)}</div></div>
            <div><div class="sale-col-label">Frais de port</div><div class="sale-col-value">${fmtEUR(s.shipping)}</div></div>
            <div><div class="sale-col-label">Bénéfice</div><div class="sale-col-value ${profitCls}">${fmtEUR(profit)}</div></div>
            <div class="sale-actions">
              <button class="btn-icon" data-edit="${s.id}" title="Modifier"><i data-lucide="pencil"></i></button>
              <button class="btn-icon danger" data-delete="${s.id}" title="Supprimer"><i data-lucide="trash-2"></i></button>
            </div>
          </div>`;
      }
      // Grid
      return `
        <div class="sale-item" data-id="${s.id}">
          <div class="sale-image">${img}</div>
          <div>
            <div class="sale-name">${esc(s.name)}</div>
            <div class="sale-brand">${esc(s.brand || '—')}</div>
            <span class="sale-condition">${esc(s.condition || '')}</span>
          </div>
          <div class="sale-col"><span class="sale-col-label">Achat</span><span class="sale-col-value">${fmtEUR(s.buyPrice)}</span></div>
          <div class="sale-col"><span class="sale-col-label">Vente</span><span class="sale-col-value">${fmtEUR(s.sellPrice)}</span></div>
          <div class="sale-col"><span class="sale-col-label">Frais de port</span><span class="sale-col-value">${fmtEUR(s.shipping)}</span></div>
          <div class="sale-col"><span class="sale-col-label">Bénéfice</span><span class="sale-col-value ${profitCls}">${fmtEUR(profit)}</span></div>
          <div class="sale-actions">
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

  // Edit/delete via delegation
  $('#sales-list').addEventListener('click', (e) => {
    const editBtn = e.target.closest('[data-edit]');
    const delBtn = e.target.closest('[data-delete]');
    if (editBtn) {
      addEditingId = editBtn.dataset.edit;
      location.hash = '#add';
    }
    if (delBtn) {
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
    }
  });

  // ============================================================
  //  VIEW : ADD / EDIT
  // ============================================================
  let addEditingId = null;
  let addImageData = null;
  let addImageFile = null; // File brut, pour upload Supabase

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
        form.soldAt.value = s.soldAt;
        form.buyPrice.value = s.buyPrice;
        form.sellPrice.value = s.sellPrice;
        form.shipping.value = s.shipping || 0;
        addImageData = s.image || null;
      }
    } else {
      form.soldAt.value = todayISO();
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
    $('#profit-value').textContent = fmtEUR(profit);
    $('#profit-value').classList.toggle('up', profit > 0);
    $('#profit-value').classList.toggle('loss', profit < 0);

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
    const payload = {
      name: (fd.get('name') || '').trim(),
      brand: (fd.get('brand') || '').trim(),
      condition: fd.get('condition') || '',
      soldAt: fd.get('soldAt') || todayISO(),
      buyPrice: Number(fd.get('buyPrice')) || 0,
      sellPrice: Number(fd.get('sellPrice')) || 0,
      shipping: Number(fd.get('shipping')) || 0,
      image: addImageData,
    };
    if (!payload.name) { toast('Le nom est requis.', 'error'); return; }
    if (!payload.condition) { toast('Sélectionnez un état.', 'error'); return; }

    const submitBtn = $('#add-submit');
    submitBtn.disabled = true;

    try {
      // En mode cloud, si une nouvelle image a été sélectionnée (File),
      // on l'upload sur Supabase Storage et on stocke l'URL résultante.
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
        toast('Article ajouté à votre stock.', 'success');
      }
      addEditingId = null;
      addImageFile = null;
      location.hash = '#sales';
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
    const all = userSales();
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
  //  VIEW : ADMIN
  // ============================================================
  const renderAdmin = () => {
    if (currentUser.role !== 'admin') return;

    const totalUsers = store.users.length;
    const totalSales = store.sales.length;
    const totalRevenue = store.sales.reduce((s, x) => s + Number(x.sellPrice || 0), 0);
    const totalProfit = store.sales.reduce((s, x) => s + profitOf(x), 0);
    const banned = store.users.filter(u => u.status === 'banned').length;

    $('#admin-kpis').innerHTML = [
      { label: 'Utilisateurs', value: fmtNum(totalUsers), cls: 'kpi-violet' },
      { label: 'Comptes suspendus', value: fmtNum(banned), cls: 'kpi-red' },
      { label: 'Articles vendus (global)', value: fmtNum(totalSales), cls: 'kpi-blue' },
      { label: 'Chiffre d\'affaires (global)', value: fmtEUR(totalRevenue), cls: 'kpi-green' },
      { label: 'Bénéfice (global)', value: fmtEUR(totalProfit), cls: 'kpi-green' },
    ].map(k => `
      <div class="kpi ${k.cls}">
        <span class="kpi-label">${esc(k.label)}</span>
        <span class="kpi-value">${esc(k.value)}</span>
      </div>
    `).join('');

    const tbody = $('#admin-users');
    tbody.innerHTML = store.users.map(u => {
      const sales = store.sales.filter(s => s.userId === u.id).length;
      const isSelf = u.id === currentUser.id;
      return `
        <tr data-uid="${u.id}">
          <td>
            <div class="user-cell">
              <div class="user-avatar">${esc(initials(u.name))}</div>
              <span>${esc(u.name)}${isSelf ? ' <em style="color:var(--text-3)">(vous)</em>' : ''}</span>
            </div>
          </td>
          <td>${esc(u.email)}</td>
          <td><span class="badge ${u.role === 'admin' ? 'badge-admin' : 'badge-user'}">${u.role === 'admin' ? 'Admin' : 'User'}</span></td>
          <td>${fmtNum(sales)}</td>
          <td>${new Date(u.createdAt).toLocaleDateString('fr-FR')}</td>
          <td><span class="badge ${u.status === 'banned' ? 'badge-banned' : 'badge-active'}">${u.status === 'banned' ? 'Suspendu' : 'Actif'}</span></td>
          <td class="text-right">
            ${isSelf ? '<span style="color:var(--text-3);font-size:12px">—</span>' :
              `<button class="btn-icon" data-admin-toggle-ban="${u.id}" title="${u.status === 'banned' ? 'Réactiver' : 'Suspendre'}">
                 <i data-lucide="${u.status === 'banned' ? 'shield-check' : 'shield-ban'}"></i>
               </button>
               <button class="btn-icon" data-admin-toggle-role="${u.id}" title="${u.role === 'admin' ? 'Retirer admin' : 'Promouvoir admin'}">
                 <i data-lucide="${u.role === 'admin' ? 'user' : 'crown'}"></i>
               </button>
               <button class="btn-icon danger" data-admin-delete="${u.id}" title="Supprimer">
                 <i data-lucide="trash-2"></i>
               </button>`
            }
          </td>
        </tr>
      `;
    }).join('');

    if (window.lucide) lucide.createIcons({ icons: lucide.icons });
  };

  $('#admin-users').addEventListener('click', (e) => {
    const banBtn = e.target.closest('[data-admin-toggle-ban]');
    const roleBtn = e.target.closest('[data-admin-toggle-role]');
    const delBtn = e.target.closest('[data-admin-delete]');

    if (banBtn) {
      const id = banBtn.dataset.adminToggleBan;
      const u = store.users.find(x => x.id === id);
      if (!u) return;
      u.status = u.status === 'banned' ? 'active' : 'banned';
      saveStore();
      toast(u.status === 'banned' ? 'Utilisateur suspendu.' : 'Utilisateur réactivé.', 'success');
      renderAdmin();
    }
    if (roleBtn) {
      const id = roleBtn.dataset.adminToggleRole;
      const u = store.users.find(x => x.id === id);
      if (!u) return;
      u.role = u.role === 'admin' ? 'user' : 'admin';
      saveStore();
      toast(`Rôle modifié : ${u.role}.`, 'success');
      renderAdmin();
    }
    if (delBtn) {
      const id = delBtn.dataset.adminDelete;
      const u = store.users.find(x => x.id === id);
      if (!u) return;
      modal({
        title: 'Supprimer cet utilisateur ?',
        body: `<p>L'utilisateur <strong>${esc(u.name)}</strong> et toutes ses ventes seront supprimés définitivement.</p>`,
        actions: [
          { label: 'Annuler', variant: 'btn-ghost' },
          {
            label: 'Supprimer', variant: 'btn-danger', onClick: () => {
              store.users = store.users.filter(x => x.id !== id);
              store.sales = store.sales.filter(s => s.userId !== id);
              saveStore();
              toast('Utilisateur supprimé.', 'success');
              renderAdmin();
            }
          },
        ],
      });
    }
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
