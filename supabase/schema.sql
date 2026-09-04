-- Project Operations System schema for Supabase PostgreSQL
-- Run this once in Supabase SQL Editor.

create table if not exists public.sectors (
  id text primary key,
  name varchar(100) not null,
  short_name varchar(50) not null,
  created_at timestamptz not null default now()
);

insert into public.sectors (id, name, short_name) values
  ('farming', 'Farming Activity', 'Farming'),
  ('mining', 'Mining Activity', 'Mining'),
  ('agriculture', 'Agriculture Activity', 'Agriculture'),
  ('movement', 'Movement & Facilitation', 'Movement')
on conflict (id) do update set name = excluded.name, short_name = excluded.short_name;

create table if not exists public.users (
  id serial primary key,
  username varchar(100) unique not null,
  password_hash text not null,
  name varchar(150) not null,
  role varchar(50) not null default 'manager' check (role in ('super-admin', 'manager')),
  sector varchar(50) references public.sectors(id),
  created_at timestamptz not null default now()
);

create or replace function public.enforce_manager_sector_limit()
returns trigger as $$
begin
  if new.role = 'manager' and new.sector is not null and
    (select count(*) from public.users where role = 'manager' and sector = new.sector and id <> coalesce(new.id, 0)) >= 3 then
    raise exception 'A sector cannot have more than three managers';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists manager_sector_limit on public.users;
create trigger manager_sector_limit
before insert or update on public.users
for each row execute function public.enforce_manager_sector_limit();

create table if not exists public.projects (
  id varchar(50) primary key,
  name varchar(200) not null,
  sector varchar(50) not null references public.sectors(id),
  manager_id integer references public.users(id) on delete set null,
  location varchar(200) not null,
  owner varchar(200) not null,
  status varchar(50) not null default 'On Track',
  progress integer not null default 0 check (progress between 0 and 100),
  budget numeric(18,2) not null default 0 check (budget >= 0),
  spent numeric(18,2) not null default 0 check (spent >= 0),
  category varchar(100) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.activities (
  id varchar(50) primary key,
  project_id varchar(50) not null references public.projects(id) on delete cascade,
  sector varchar(50) not null references public.sectors(id),
  category varchar(100) not null,
  activity varchar(200) not null,
  description text not null default '',
  quantity numeric(18,2) not null check (quantity > 0),
  cost_usd numeric(18,2) not null default 0 check (cost_usd >= 0),
  cost_rwf numeric(18,2) not null default 0 check (cost_rwf >= 0),
  cost_cdf numeric(18,2) not null default 0 check (cost_cdf >= 0),
  signed boolean not null default false,
  approved boolean not null default false,
  status varchar(50) not null default 'Pending' check (status in ('Pending', 'In Progress', 'Completed', 'Cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.approvals (
  id varchar(50) primary key,
  project_id varchar(50) references public.projects(id) on delete set null,
  title varchar(200) not null,
  sector varchar(50) not null references public.sectors(id),
  amount numeric(18,2) not null default 0 check (amount >= 0),
  owner varchar(150) not null,
  priority varchar(50) not null default 'Medium' check (priority in ('Low', 'Medium', 'High')),
  status varchar(50) not null default 'Pending' check (status in ('Pending', 'Approved', 'Rejected')),
  requested_by varchar(150) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.movements (
  id varchar(50) primary key,
  project_id varchar(50) references public.projects(id) on delete set null,
  ref varchar(100) unique not null,
  sector varchar(50) not null references public.sectors(id),
  purpose varchar(200) not null,
  destination varchar(200) not null,
  status varchar(50) not null default 'Pending' check (status in ('Pending', 'Approved', 'Ongoing', 'Completed', 'Cancelled')),
  cost numeric(18,2) not null default 0 check (cost >= 0),
  category varchar(100) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.projects add column if not exists manager_id integer references public.users(id) on delete set null;
alter table public.users add column if not exists sector varchar(50) references public.sectors(id);
alter table public.users add column if not exists created_at timestamptz not null default now();
alter table public.projects add column if not exists created_at timestamptz not null default now();
alter table public.projects add column if not exists updated_at timestamptz not null default now();
alter table public.activities add column if not exists cost_cdf numeric(18,2) not null default 0;
alter table public.activities add column if not exists created_at timestamptz not null default now();
alter table public.activities add column if not exists updated_at timestamptz not null default now();
alter table public.approvals add column if not exists project_id varchar(50) references public.projects(id) on delete set null;
alter table public.approvals add column if not exists created_at timestamptz not null default now();
alter table public.approvals add column if not exists updated_at timestamptz not null default now();
alter table public.movements add column if not exists project_id varchar(50) references public.projects(id) on delete set null;
alter table public.movements add column if not exists created_at timestamptz not null default now();
alter table public.movements add column if not exists updated_at timestamptz not null default now();

create index if not exists projects_sector_idx on public.projects(sector);
create index if not exists projects_manager_idx on public.projects(manager_id);
create index if not exists activities_project_created_idx on public.activities(project_id, created_at desc);
create index if not exists activities_sector_idx on public.activities(sector);
create index if not exists approvals_project_created_idx on public.approvals(project_id, created_at desc);
create index if not exists approvals_sector_idx on public.approvals(sector);
create index if not exists movements_project_created_idx on public.movements(project_id, created_at desc);
create index if not exists movements_sector_idx on public.movements(sector);

-- Supabase API safety: enable RLS, then use the Node server's database connection
-- for authenticated CRUD. Add your own policies if the browser accesses tables directly.
alter table public.sectors enable row level security;
alter table public.users enable row level security;
alter table public.projects enable row level security;
alter table public.activities enable row level security;
alter table public.approvals enable row level security;
alter table public.movements enable row level security;
