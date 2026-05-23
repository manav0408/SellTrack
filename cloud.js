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
      image: s.image_url,
      createdAt: s.created_at,
    };
  }

  function unmapSale(s) {
    return {
      name: s.name,
      brand: s.brand || null,
      condition: s.condition || null,
      buy_price: Number(s.buyPrice) || 0,
      sell_price: Number(s.sellPrice) || 0,
      shipping: Number(s.shipping) || 0,
      sold_at: s.soldAt,
      image_url: s.image || null,
    };
  }

  // =============== Sales ===============
  const sales = {
    async list() {
      const { data, error } = await supabase
        .from('sales').select('*').order('sold_at', { ascending: false });
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
      const { data: allSales, error: e2 } = await supabase.from('sales').select('user_id');
      if (e2) throw new Error(e2.message);
      const counts = {};
      allSales.forEach(s => { counts[s.user_id] = (counts[s.user_id] || 0) + 1; });
      return data.map(p => ({ ...mapProfile(p), salesCount: counts[p.id] || 0 }));
    },

    async updateUser(id, patch) {
      // patch = { role?, status? }
      const { error } = await supabase.from('profiles').update(patch).eq('id', id);
      if (error) throw new Error(error.message);
    },

    async deleteUser(id) {
      // Suppression cascade via FK (sales) + ON DELETE CASCADE depuis auth.users
      // Note : pour supprimer l'utilisateur auth lui-même il faut le service_role
      // (côté serveur). Côté client on supprime juste le profile + sales.
      await supabase.from('sales').delete().eq('user_id', id);
      const { error } = await supabase.from('profiles').delete().eq('id', id);
      if (error) throw new Error(error.message);
    },
  };

  // =============== Stats globales (admin) ===============
  const stats = {
    async global() {
      const [{ data: profiles }, { data: allSales }] = await Promise.all([
        supabase.from('profiles').select('id, status'),
        supabase.from('sales').select('sell_price, buy_price, shipping'),
      ]);
      const totalUsers = profiles?.length || 0;
      const banned = profiles?.filter(p => p.status === 'banned').length || 0;
      const totalSales = allSales?.length || 0;
      const totalRevenue = (allSales || []).reduce((s, x) => s + Number(x.sell_price), 0);
      const totalProfit = (allSales || []).reduce(
        (s, x) => s + Number(x.sell_price) - Number(x.buy_price) - Number(x.shipping), 0
      );
      return { totalUsers, banned, totalSales, totalRevenue, totalProfit };
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
