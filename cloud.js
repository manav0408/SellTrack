/* ============================================================
   SellTrack — Couche cloud (Supabase)
   ============================================================
   Cette couche fournit la même API que la couche locale, mais
   sauvegarde tout dans Supabase au lieu de localStorage.
   
   Exposée via window.SellTrackCloud :
     - enabled  : boolean (vrai si config Supabase présente)
     - init()   : initialise le client
     - auth.signUp({name, email, password})
     - auth.signIn({email, password})
     - auth.signOut()
     - auth.getCurrentUser()  → {id, name, email, role, status}
     - auth.onAuthChange(cb)
     - sales.list()           → [sale, ...]
     - sales.create(sale)     → sale créé
     - sales.update(id, sale) → sale màj
     - sales.delete(id)       → void
     - storage.uploadImage(file, userId) → URL publique
     - admin.listUsers()
     - admin.updateUser(id, patch)
     - admin.deleteUser(id)
   ============================================================ */

(() => {
  'use strict';

  const cfg = window.SELLTRACK_CONFIG || {};
  const enabled = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY);

  if (!enabled) {
    window.SellTrackCloud = { enabled: false };
    return;
  }

  // Le SDK Supabase est chargé en CDN dans index.html
  const supabase = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
  });

  // =============== Auth ===============
  const auth = {
    async signUp({ name, email, password }) {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { name } },
      });
      if (error) throw new Error(error.message);
      // Le trigger Postgres crée le profile automatiquement.
      // Récupération du profile complet (peut nécessiter un retry après le trigger)
      const profile = await waitForProfile(data.user.id);
      return mapProfile(profile);
    },

    async signIn({ email, password }) {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw new Error(error.message);
      const profile = await fetchProfile(data.user.id);
      if (profile.status === 'banned') {
        await supabase.auth.signOut();
        throw new Error('Ce compte a été suspendu.');
      }
      return mapProfile(profile);
    },

    async signOut() {
      await supabase.auth.signOut();
    },

    async getCurrentUser() {
      const { data } = await supabase.auth.getUser();
      if (!data.user) return null;
      try {
        const profile = await fetchProfile(data.user.id);
        return mapProfile(profile);
      } catch {
        return null;
      }
    },

    onAuthChange(callback) {
      return supabase.auth.onAuthStateChange(async (event, session) => {
        if (session?.user) {
          try {
            const profile = await fetchProfile(session.user.id);
            callback(mapProfile(profile), event);
          } catch {
            callback(null, event);
          }
        } else {
          callback(null, event);
        }
      });
    },
  };

  async function fetchProfile(userId) {
    const { data, error } = await supabase
      .from('profiles').select('*').eq('id', userId).single();
    if (error) throw new Error(error.message);
    return data;
  }

  async function waitForProfile(userId, retries = 5) {
    // Le trigger Postgres a un léger délai. On retry quelques fois.
    for (let i = 0; i < retries; i++) {
      try { return await fetchProfile(userId); }
      catch (e) { await new Promise(r => setTimeout(r, 300)); }
    }
    throw new Error('Profil utilisateur introuvable.');
  }

  function mapProfile(p) {
    return {
      id: p.id,
      name: p.name,
      email: p.email,
      role: p.role,
      status: p.status,
      createdAt: p.created_at,
    };
  }

  function mapSale(s) {
    return {
      id: s.id,
      userId: s.user_id,
      name: s.name,
      brand: s.brand,
      condition: s.condition,
      buyPrice: Number(s.buy_price),
      sellPrice: Number(s.sell_price),
      shipping: Number(s.shipping),
      soldAt: s.sold_at,
      listedAt: s.listed_at,
      boughtAt: s.bought_at,
      status: s.status || 'sold',
      image: s.image_url,
      createdAt: s.created_at,
    };
  }

  function unmapSale(s) {
    const out = {
      name: s.name,
      brand: s.brand || null,
      condition: s.condition || null,
      buy_price: Number(s.buyPrice) || 0,
      sell_price: Number(s.sellPrice) || 0,
      shipping: Number(s.shipping) || 0,
      sold_at: s.soldAt || null,
      listed_at: s.listedAt || null,
      bought_at: s.boughtAt || null,
      status: s.status || 'sold',
      image_url: s.image || null,
    };
    return out;
  }

  // =============== Sales ===============
  const sales = {
    async list() {
      const { data, error } = await supabase
        .from('sales').select('*').order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      return data.map(mapSale);
    },

    async create(sale) {
      const { data: userData } = await supabase.auth.getUser();
      const payload = { ...unmapSale(sale), user_id: userData.user.id };
      const { data, error } = await supabase
        .from('sales').insert(payload).select().single();
      if (error) throw new Error(error.message);
      return mapSale(data);
    },

    async update(id, sale) {
      const { data, error } = await supabase
        .from('sales').update(unmapSale(sale)).eq('id', id).select().single();
      if (error) throw new Error(error.message);
      return mapSale(data);
    },

    async delete(id) {
      const { error } = await supabase.from('sales').delete().eq('id', id);
      if (error) throw new Error(error.message);
    },

    async deleteAll(userId) {
      const { error } = await supabase.from('sales').delete().eq('user_id', userId);
      if (error) throw new Error(error.message);
    },
  };

  // =============== Storage : images ===============
  const storage = {
    async uploadImage(file, userId) {
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
      const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const { error } = await supabase.storage
        .from('sale-images').upload(path, file, { cacheControl: '3600', upsert: false });
      if (error) throw new Error(error.message);
      const { data } = supabase.storage.from('sale-images').getPublicUrl(path);
      return data.publicUrl;
    },
  };

  // =============== Admin ===============
  const admin = {
    async listUsers() {
      const { data, error } = await supabase
        .from('profiles').select('*').order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      // On compte les ventes via une seconde requête (groupé en JS pour rester simple)
      // Seules les ventes réellement "sold" comptent dans CA/bénéfice.
      const { data: allSales, error: e2 } = await supabase
        .from('sales').select('user_id, sell_price, buy_price, shipping, status');
      if (e2) throw new Error(e2.message);
      const stats = {};
      (allSales || []).forEach(s => {
        if ((s.status || 'sold') !== 'sold') return;
        if (!stats[s.user_id]) stats[s.user_id] = { count: 0, revenue: 0, profit: 0 };
        stats[s.user_id].count += 1;
        stats[s.user_id].revenue += Number(s.sell_price);
        stats[s.user_id].profit += Number(s.sell_price) - Number(s.buy_price) - Number(s.shipping);
      });
      return data.map(p => ({
        ...mapProfile(p),
        salesCount: stats[p.id]?.count || 0,
        revenue: stats[p.id]?.revenue || 0,
        profit: stats[p.id]?.profit || 0,
      }));
    },

    async updateUser(id, patch) {
      // patch = { role?, status?, name?, email? }
      const { error } = await supabase.from('profiles').update(patch).eq('id', id);
      if (error) throw new Error(error.message);
    },

    async deleteUser(id) {
      // Suppression complète : ventes + profile (auth.users orphelin à nettoyer manuellement)
      await supabase.from('sales').delete().eq('user_id', id);
      const { error } = await supabase.from('profiles').delete().eq('id', id);
      if (error) throw new Error(error.message);
    },

    async getUserSales(userId) {
      const { data, error } = await supabase
        .from('sales').select('*').eq('user_id', userId).order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      return data.map(mapSale);
    },

    async sendPasswordReset(email) {
      // Envoie un email de récupération de mot de passe Supabase
      const redirectUrl = window.location.origin + window.location.pathname;
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: redirectUrl,
      });
      if (error) throw new Error(error.message);
    },

    // =============== Toutes les ventes (cross-users) ===============
    async listAllSales() {
      // Récupère toutes les ventes + le profile owner joint
      const { data, error } = await supabase
        .from('sales')
        .select('*, profiles(id, name, email)')
        .order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      return (data || []).map(s => ({
        ...mapSale(s),
        ownerName: s.profiles?.name || '—',
        ownerEmail: s.profiles?.email || '',
      }));
    },

    async updateSale(id, sale) {
      const { error } = await supabase.from('sales').update(unmapSale(sale)).eq('id', id);
      if (error) throw new Error(error.message);
    },

    async deleteSale(id) {
      const { error } = await supabase.from('sales').delete().eq('id', id);
      if (error) throw new Error(error.message);
    },

    // =============== Storage (images) ===============
    async listAllImages() {
      // Liste les fichiers de tous les sous-dossiers (chaque user a son dossier UUID)
      const { data: folders, error } = await supabase.storage
        .from('sale-images').list('', { limit: 1000 });
      if (error) throw new Error(error.message);
      const userFolders = (folders || []).filter(f => f.id === null); // dossiers
      const allFiles = [];
      for (const folder of userFolders) {
        const { data: files } = await supabase.storage
          .from('sale-images').list(folder.name, { limit: 1000 });
        (files || []).forEach(f => {
          const path = `${folder.name}/${f.name}`;
          const { data: urlData } = supabase.storage.from('sale-images').getPublicUrl(path);
          allFiles.push({
            path,
            name: f.name,
            userId: folder.name,
            size: f.metadata?.size || 0,
            createdAt: f.created_at,
            url: urlData.publicUrl,
          });
        });
      }
      return allFiles.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    },

    async deleteImage(path) {
      const { error } = await supabase.storage.from('sale-images').remove([path]);
      if (error) throw new Error(error.message);
    },

    // =============== SQL Editor (lecture seule SELECT) ===============
    async runSelect(sql) {
      // Sécurité côté client : on bloque tout sauf SELECT
      const cleaned = String(sql || '').trim().replace(/;+\s*$/, '');
      if (!cleaned) throw new Error('Requête vide.');
      const upper = cleaned.toUpperCase();
      if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) {
        throw new Error('Seules les requêtes SELECT (ou WITH ... SELECT) sont autorisées.');
      }
      const forbidden = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'TRUNCATE', 'ALTER', 'CREATE', 'GRANT', 'REVOKE'];
      for (const verb of forbidden) {
        const re = new RegExp(`\\b${verb}\\b`, 'i');
        if (re.test(cleaned)) throw new Error(`Verbe SQL interdit détecté : ${verb}.`);
      }
      // Appel via la fonction RPC custom "admin_select" (créée dans le schema SQL)
      const { data, error } = await supabase.rpc('admin_select', { query_text: cleaned });
      if (error) throw new Error(error.message);
      return data || [];
    },
  };

  // =============== Stats globales (admin) ===============
  const stats = {
    async global() {
      const [{ data: profiles }, { data: allSalesRaw }] = await Promise.all([
        supabase.from('profiles').select('id, status, created_at, role'),
        supabase.from('sales').select('sell_price, buy_price, shipping, sold_at, brand, condition, status'),
      ]);
      const totalUsers = profiles?.length || 0;
      const banned = profiles?.filter(p => p.status === 'banned').length || 0;
      // Seules les ventes "sold" comptent dans le CA
      const sold = (allSalesRaw || []).filter(x => (x.status || 'sold') === 'sold');
      const totalSales = sold.length;
      const totalRevenue = sold.reduce((s, x) => s + Number(x.sell_price), 0);
      const totalProfit = sold.reduce(
        (s, x) => s + Number(x.sell_price) - Number(x.buy_price) - Number(x.shipping), 0
      );
      return {
        totalUsers, banned, totalSales, totalRevenue, totalProfit,
        profiles: profiles || [],
        sales: sold,
      };
    },

    async signupsByMonth() {
      // Inscriptions par mois, sur 12 derniers mois
      const { data } = await supabase.from('profiles').select('created_at');
      const months = {};
      const now = new Date();
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const k = d.toISOString().slice(0, 7);
        months[k] = 0;
      }
      (data || []).forEach(p => {
        const k = (p.created_at || '').slice(0, 7);
        if (k in months) months[k] += 1;
      });
      return Object.entries(months).map(([key, count]) => ({ key, count }));
    },

    async revenueByMonth() {
      const { data } = await supabase.from('sales').select('sell_price, buy_price, shipping, sold_at, status').eq('status', 'sold');
      const months = {};
      const now = new Date();
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const k = d.toISOString().slice(0, 7);
        months[k] = { revenue: 0, profit: 0 };
      }
      (data || []).forEach(s => {
        const k = (s.sold_at || '').slice(0, 7);
        if (k in months) {
          months[k].revenue += Number(s.sell_price);
          months[k].profit += Number(s.sell_price) - Number(s.buy_price) - Number(s.shipping);
        }
      });
      return Object.entries(months).map(([key, v]) => ({ key, ...v }));
    },

    async topSellers(limit = 5) {
      const { data: allSales } = await supabase
        .from('sales')
        .select('user_id, sell_price, buy_price, shipping, status, profiles(name, email)')
        .eq('status', 'sold');
      const by = {};
      (allSales || []).forEach(s => {
        const k = s.user_id;
        if (!by[k]) by[k] = {
          userId: k,
          name: s.profiles?.name || '—',
          email: s.profiles?.email || '',
          count: 0, revenue: 0, profit: 0,
        };
        by[k].count += 1;
        by[k].revenue += Number(s.sell_price);
        by[k].profit += Number(s.sell_price) - Number(s.buy_price) - Number(s.shipping);
      });
      return Object.values(by).sort((a, b) => b.profit - a.profit).slice(0, limit);
    },

    async topBrands(limit = 10) {
      const { data } = await supabase.from('sales').select('brand, sell_price, buy_price, shipping, status').eq('status', 'sold');
      const by = {};
      (data || []).forEach(s => {
        const k = s.brand || 'Sans marque';
        if (!by[k]) by[k] = { brand: k, count: 0, revenue: 0, profit: 0 };
        by[k].count += 1;
        by[k].revenue += Number(s.sell_price);
        by[k].profit += Number(s.sell_price) - Number(s.buy_price) - Number(s.shipping);
      });
      return Object.values(by).sort((a, b) => b.count - a.count).slice(0, limit);
    },

    async conditionBreakdown() {
      const { data } = await supabase.from('sales').select('condition, status').eq('status', 'sold');
      const by = {};
      (data || []).forEach(s => {
        const k = s.condition || 'Inconnu';
        by[k] = (by[k] || 0) + 1;
      });
      return Object.entries(by).map(([condition, count]) => ({ condition, count }))
        .sort((a, b) => b.count - a.count);
    },

    async recentActivity(limit = 10) {
      const [{ data: users }, { data: sales }] = await Promise.all([
        supabase.from('profiles').select('id, name, email, created_at').order('created_at', { ascending: false }).limit(limit),
        supabase.from('sales')
          .select('id, name, sell_price, sold_at, created_at, profiles(name)')
          .order('created_at', { ascending: false }).limit(limit),
      ]);
      const activities = [];
      (users || []).forEach(u => activities.push({
        type: 'signup', when: u.created_at, label: `${u.name} s'est inscrit`, meta: u.email,
      }));
      (sales || []).forEach(s => activities.push({
        type: 'sale', when: s.created_at,
        label: `${s.profiles?.name || '?'} a vendu ${s.name}`,
        meta: `${Number(s.sell_price).toFixed(2)} €`,
      }));
      return activities.sort((a, b) => (b.when || '').localeCompare(a.when || '')).slice(0, limit);
    },
  };

  window.SellTrackCloud = {
    enabled: true,
    client: supabase,
    auth,
    sales,
    storage,
    admin,
    stats,
  };
  console.log('[SellTrack] Mode cloud activé (Supabase).');
})();
