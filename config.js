/* ============================================================
   SellTrack — Configuration
   ============================================================
   
   POUR ACTIVER LA SYNCHRONISATION CLOUD (multi-appareils) :
   
   1. Créez un compte gratuit sur https://supabase.com
   2. Créez un nouveau projet (notez le mot de passe DB de côté)
   3. Allez dans Settings > API et copiez :
      - "Project URL" → SUPABASE_URL ci-dessous
      - "anon public" key → SUPABASE_ANON_KEY ci-dessous
   4. Allez dans SQL Editor, copiez/collez le contenu de "supabase-schema.sql"
      et exécutez-le pour créer les tables et les sécurités.
   5. Rafraîchissez SellTrack — un bandeau confirme que le mode cloud est actif.
   
   Tant que les deux constantes ci-dessous valent "", l'app fonctionne en
   mode LOCAL (localStorage). Vous pouvez utiliser SellTrack tel quel.
   ============================================================ */

window.SELLTRACK_CONFIG = {
  SUPABASE_URL: "",         // Ex : "https://abcdefg.supabase.co"
  SUPABASE_ANON_KEY: "",    // Ex : "eyJhbGciOi..." (clé publique anon)
};
