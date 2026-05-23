# SellTrack — Guide de mise en production

Trois choses à faire pour passer de l'app locale à une vraie SaaS installable :

1. Déployer en ligne (10 min)
2. Activer la sync cloud avec Supabase (15-30 min)
3. Générer un APK pour Android (10 min)

---

## 1. Déployer en ligne — Netlify Drop

C'est le pré-requis pour que la PWA soit installable (HTTPS obligatoire) et pour pouvoir générer un APK.

1. Ouvre https://app.netlify.com/drop
2. Glisse le dossier `SellTrack` entier dessus (avec tous les fichiers : `index.html`, `styles.css`, `app.js`, `manifest.webmanifest`, `sw.js`, `config.js`, `cloud.js`, le dossier `icons/`, etc.)
3. Tu reçois une URL type `https://nom-aleatoire.netlify.app`
4. Dans **Site settings > Change site name**, mets `selltrack-monnom` pour une URL propre

L'app est en ligne. Ouvre-la sur ton téléphone : Chrome (Android) ou Safari (iOS) te proposera "Installer l'application" / "Sur l'écran d'accueil". Elle se comportera comme une vraie app native.

Alternatives gratuites équivalentes : **Vercel** (`vercel deploy`), **GitHub Pages**, **Cloudflare Pages**.

---

## 2. Activer la sync cloud — Supabase

Sans cette étape, chaque appareil garde ses données séparément. Avec, tout est synchronisé via ton compte.

### Étape 2.1 — Créer le projet

1. Va sur https://supabase.com et crée un compte gratuit (Google ou email)
2. Clique **New project**. Choisis :
   - Un **nom** (ex : "selltrack-prod")
   - Un **mot de passe DB** (note-le quelque part, tu ne le reverras pas)
   - Une **région** proche (Frankfurt si tu es en Europe)
   - Plan : **Free** (suffisant pour démarrer)
3. Attends ~2 minutes que le projet soit provisionné

### Étape 2.2 — Créer les tables

1. Dans le menu de gauche : **SQL Editor** > **New query**
2. Ouvre le fichier `supabase-schema.sql` (livré dans le dossier SellTrack)
3. Copie tout son contenu, colle-le dans le SQL Editor
4. Clique **Run** (en bas à droite). Tu dois voir "Success. No rows returned"

Cela crée les tables `profiles` et `sales`, les politiques de sécurité (RLS), le bucket d'images, et tous les triggers nécessaires.

### Étape 2.3 — Récupérer les clés

1. Menu de gauche > **Settings** (icône engrenage) > **API**
2. Copie :
   - **Project URL** (ex : `https://abcdefghij.supabase.co`)
   - **anon public** key (longue chaîne commençant par `eyJ...`)

### Étape 2.4 — Configurer SellTrack

Ouvre `config.js` dans ton dossier SellTrack et remplace :

```js
window.SELLTRACK_CONFIG = {
  SUPABASE_URL: "https://abcdefghij.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOi...",
};
```

Re-déploie (re-glisse le dossier sur Netlify Drop, ou Netlify détectera automatiquement si tu as connecté un repo Git).

### Étape 2.5 — Créer ton compte admin

1. Ouvre ton app déployée
2. Crée un compte normal via l'écran de signup. Tu recevras un email de confirmation Supabase (cherche dans tes spams si besoin), clique sur le lien pour valider.
3. Reviens dans Supabase > **Table Editor** > `profiles`
4. Trouve ta ligne, double-clique sur la colonne `role`, change `user` → `admin`, sauvegarde

À ta prochaine connexion sur SellTrack tu auras l'onglet **Administration** dans la sidebar.

### Désactiver la vérification email (optionnel mais pratique en démo)

Dans Supabase > **Authentication** > **Providers** > **Email**, décoche "Confirm email". Les comptes seront actifs immédiatement.

### Limites du plan gratuit Supabase

500 Mo de DB, 1 Go de Storage, 50 000 connexions/mois. Largement suffisant pour démarrer. Tu peux upgrade plus tard si tu dépasses.

---

## 3. Générer un APK Android

Pré-requis : ton app est déployée à l'étape 1 (avec HTTPS) et a un manifest valide (déjà inclus).

### Méthode A — PWABuilder (recommandée, 10 min, sans rien installer)

1. Va sur https://www.pwabuilder.com
2. Colle l'URL de ton app Netlify
3. PWABuilder analyse ta PWA. Tu dois avoir un score élevé sur "Manifest" et "Service Worker" (SellTrack passe les deux).
4. Clique **Package For Stores**
5. Choisis **Android**. Options :
   - **Sign Web Manifest** : laisse les défauts
   - **Package ID** : ex `com.selltrack.app`
   - **App version** : `1.0.0`
   - **Signing key** : choisis **"Create new"** la première fois (PWABuilder génère un keystore). **TÉLÉCHARGE ET CONSERVE PRÉCIEUSEMENT** le fichier `signing.keystore` et le mot de passe : tu en auras besoin pour toutes les futures mises à jour. Sans lui, tu ne peux plus publier d'update.
6. Clique **Download Package**
7. Tu reçois un ZIP contenant :
   - `app-release-signed.apk` — c'est ton APK ! Tu peux l'installer directement sur un téléphone Android (activer "Sources inconnues" dans les paramètres) ou le distribuer.
   - `app-release-bundle.aab` — c'est le format à uploader sur le Play Store si tu veux publier officiellement.

### Méthode B — Capacitor (si tu veux accéder aux APIs natives)

Plus puissant : ça te donne accès à la caméra native, aux notifications push, au file system, etc. À utiliser si tu veux ajouter "scanner un code-barres" ou "notifications push de rappel".

```bash
npm init -y
npm install @capacitor/core @capacitor/cli @capacitor/android
npx cap init SellTrack com.selltrack.app --web-dir=.
npx cap add android
npx cap sync
npx cap open android   # ouvre Android Studio pour build
```

Tu auras besoin d'Android Studio installé localement.

### Publier sur le Play Store

1. Crée un compte développeur Google Play : 25 $ one-shot, https://play.google.com/console
2. Upload le `.aab` généré par PWABuilder
3. Remplis les méta (description, captures d'écran, politique de confidentialité)
4. Soumets pour review : 1-3 jours d'attente

### Pour iOS

iOS ne supporte pas directement les APK. Pour publier sur l'App Store il faut passer par Capacitor + Xcode (Mac obligatoire) + compte Apple Developer (99 $/an).

Mais **bonne nouvelle pour iOS** : grâce à la PWA, les utilisateurs iPhone peuvent quand même "installer" l'app via Safari (bouton Partager > Sur l'écran d'accueil). Elle se comporte alors comme une app native, sans passer par l'App Store et sans Apple Dev fee.

---

## Récap — Quel chemin choisir ?

| Objectif | Effort | Coût |
|---|---|---|
| Tester ton app | Double-clic sur `index.html` | 0 € |
| Donner accès à tes amis | Netlify Drop | 0 € |
| Multi-appareils (sync) | Supabase | 0 € |
| Installation rapide sur téléphone | Déjà fait via PWA (bouton "Installer") | 0 € |
| APK Android distribuable | PWABuilder | 0 € |
| Publier sur Play Store | PWABuilder + compte Google Play | 25 $ |
| Publier sur App Store | Capacitor + Xcode + Apple Dev | 99 $/an + Mac |

**Mon conseil pragmatique** : fais les étapes 1+2+3 méthode A en une après-midi. Tu auras une vraie app installable, synchronisée multi-appareils, distribuable en APK, sans avoir installé un seul outil de dev en local et sans dépenser un euro.
