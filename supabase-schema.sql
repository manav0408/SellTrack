-- ============================================================
-- SellTrack — Schéma Supabase
-- ============================================================
-- À copier-coller dans Supabase > SQL Editor > New query
-- Puis cliquer sur "Run" en bas à droite.
--
-- Ce script crée :
--   - une table "profiles" liée à auth.users (nom, role, status)
--   - une table "sales" pour les ventes
--   - un bucket Storage "sale-images" pour les photos d'articles
--   - les politiques RLS (Row Level Security) :
--       * chaque user ne voit que ses propres ventes
--       * les admins voient tout
--       * personne ne peut s'auto-promouvoir admin
-- ============================================================

-- =============== TABLE : profiles ===============
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  email text unique not null,
  name text not null,
  role text not null default 'user' check (role in ('user', 'admin')),
  status text not null default 'active' check (status in ('active', 'banned')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists profiles_email_idx on public.profiles(email);

-- =============== TABLE : sales ===============
create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  brand text,
  condition text,
  buy_price numeric(10, 2) not null default 0,
  sell_price numeric(10, 2) not null default 0,
  shipping numeric(10, 2) not null default 0,
  sold_at date not null,
  image_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sales_user_sold_idx on public.sales(user_id, sold_at desc);

-- =============== Trigger : auto-create profile on signup ===============
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =============== Trigger : auto-update updated_at ===============
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

drop trigger if exists sales_touch on public.sales;
create trigger sales_touch before update on public.sales
  for each row execute function public.touch_updated_at();

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

alter table public.profiles enable row level security;
alter table public.sales enable row level security;

-- =============== Helper : is_admin() ===============
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(
    (select role = 'admin' from public.profiles where id = auth.uid()),
    false
  );
$$;

-- =============== Policies : profiles ===============
drop policy if exists "profiles_self_read" on public.profiles;
create policy "profiles_self_read" on public.profiles
  for select using (auth.uid() = id or public.is_admin());

drop policy if exists "profiles_self_update_safe" on public.profiles;
create policy "profiles_self_update_safe" on public.profiles
  for update using (auth.uid() = id)
  with check (
    auth.uid() = id
    -- empêche l'auto-promotion : on ne peut pas changer son propre role/status
    and role = (select role from public.profiles where id = auth.uid())
    and status = (select status from public.profiles where id = auth.uid())
  );

drop policy if exists "profiles_admin_all" on public.profiles;
create policy "profiles_admin_all" on public.profiles
  for all using (public.is_admin()) with check (public.is_admin());

-- =============== Policies : sales ===============
drop policy if exists "sales_self_select" on public.sales;
create policy "sales_self_select" on public.sales
  for select using (auth.uid() = user_id or public.is_admin());

drop policy if exists "sales_self_insert" on public.sales;
create policy "sales_self_insert" on public.sales
  for insert with check (auth.uid() = user_id);

drop policy if exists "sales_self_update" on public.sales;
create policy "sales_self_update" on public.sales
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "sales_self_delete" on public.sales;
create policy "sales_self_delete" on public.sales
  for delete using (auth.uid() = user_id or public.is_admin());

-- ============================================================
-- STORAGE : bucket pour les images d'articles
-- ============================================================

insert into storage.buckets (id, name, public)
values ('sale-images', 'sale-images', true)
on conflict (id) do nothing;

-- Chaque user a son dossier {user_id}/...
-- Lecture publique (les URLs sont longues et imprévisibles)
drop policy if exists "sale_images_public_read" on storage.objects;
create policy "sale_images_public_read" on storage.objects
  for select using (bucket_id = 'sale-images');

drop policy if exists "sale_images_self_write" on storage.objects;
create policy "sale_images_self_write" on storage.objects
  for insert with check (
    bucket_id = 'sale-images'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "sale_images_self_update" on storage.objects;
create policy "sale_images_self_update" on storage.objects
  for update using (
    bucket_id = 'sale-images'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "sale_images_self_delete" on storage.objects;
create policy "sale_images_self_delete" on storage.objects
  for delete using (
    bucket_id = 'sale-images'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- ============================================================
-- ADMIN INITIAL
-- ============================================================
-- Pour créer votre premier admin :
--   1. Inscrivez-vous normalement via l'écran de signup de SellTrack.
--   2. Allez dans Supabase > Table Editor > profiles
--   3. Modifiez votre ligne et passez "role" à "admin".
-- Alternative SQL (remplacez l'email) :
--   update public.profiles set role = 'admin' where email = 'vous@exemple.com';
-- ============================================================
