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
  ('movement', 'Logistics & Facilitation', 'Logistics')
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
  requested_by_id integer references public.users(id) on delete set null,
  justification text not null default '',
  decision_note text not null default '',
  decided_by_id integer references public.users(id) on delete set null,
  decided_at timestamptz,
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
alter table public.approvals add column if not exists requested_by_id integer references public.users(id) on delete set null;
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

-- =====================================================================
-- Logistics & Facilitation module
-- Mockup: "Movement_and_Facilitation_Side_Mockup" sections 3-9.
-- Movement stays its own area of operation (movements.sector = 'movement');
-- related_area records which other operation the movement supported.
-- =====================================================================

alter table public.movements add column if not exists movement_type varchar(50) not null default 'Other';
alter table public.movements add column if not exists related_area varchar(50) references public.sectors(id) on delete set null;
alter table public.movements add column if not exists origin varchar(200) not null default '';
alter table public.movements add column if not exists departure_date date;
alter table public.movements add column if not exists return_date date;
alter table public.movements add column if not exists person_team varchar(200) not null default '';
alter table public.movements add column if not exists transport_type varchar(100) not null default '';
alter table public.movements add column if not exists vehicle_driver varchar(200) not null default '';
alter table public.movements add column if not exists currency varchar(3) not null default 'RWF';
alter table public.movements add column if not exists cost_transport numeric(18,2) not null default 0;
alter table public.movements add column if not exists cost_fuel numeric(18,2) not null default 0;
alter table public.movements add column if not exists cost_accommodation numeric(18,2) not null default 0;
alter table public.movements add column if not exists cost_meals numeric(18,2) not null default 0;
alter table public.movements add column if not exists cost_handling numeric(18,2) not null default 0;
alter table public.movements add column if not exists cost_other numeric(18,2) not null default 0;
alter table public.movements add column if not exists funds_released numeric(18,2) not null default 0;
alter table public.movements add column if not exists actual_expense numeric(18,2) not null default 0;
alter table public.movements add column if not exists evidence_status varchar(20) not null default 'Pending';
alter table public.movements add column if not exists notes text not null default '';
-- Rate snapshot frozen onto the record when it is saved (mockup section 4).
alter table public.movements add column if not exists fx_rwf_per_usd numeric(18,6);
alter table public.movements add column if not exists fx_cdf_per_usd numeric(18,6);
alter table public.movements add column if not exists fx_source varchar(20) not null default 'reference';
alter table public.movements add column if not exists fx_recorded_at timestamptz;
alter table public.movements add column if not exists created_by integer references public.users(id) on delete set null;
alter table public.movements add column if not exists approved_by integer references public.users(id) on delete set null;
alter table public.movements add column if not exists approved_at timestamptz;
alter table public.movements add column if not exists completed_at timestamptz;

-- movements.cost holds the estimated facilitation total (sum of the breakdown).
alter table public.movements drop constraint if exists movements_status_check;
alter table public.movements add constraint movements_status_check
  check (status in ('Draft', 'Pending', 'Approved', 'Funds Released', 'Ongoing', 'Completed', 'Rejected', 'Cancelled'));
alter table public.movements drop constraint if exists movements_currency_check;
alter table public.movements add constraint movements_currency_check
  check (currency in ('RWF', 'USD', 'CDF'));
alter table public.movements drop constraint if exists movements_type_check;
alter table public.movements add constraint movements_type_check
  check (movement_type in ('Staff', 'Equipment', 'Materials', 'Field Operation', 'Other'));
alter table public.movements drop constraint if exists movements_evidence_status_check;
alter table public.movements add constraint movements_evidence_status_check
  check (evidence_status in ('Pending', 'Partial', 'Complete'));
alter table public.movements drop constraint if exists movements_related_area_check;
alter table public.movements add constraint movements_related_area_check
  check (related_area is null or related_area <> 'movement');

create table if not exists public.movement_evidence (
  id serial primary key,
  movement_id varchar(50) not null references public.movements(id) on delete cascade,
  kind varchar(50) not null default 'Receipt',
  original_name varchar(255) not null,
  stored_name varchar(255) not null,
  mime_type varchar(120) not null,
  size_bytes integer not null default 0,
  amount numeric(18,2) not null default 0,
  note text not null default '',
  uploaded_by integer references public.users(id) on delete set null,
  uploaded_by_name varchar(150) not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.movement_history (
  id serial primary key,
  movement_id varchar(50) not null references public.movements(id) on delete cascade,
  action varchar(60) not null,
  field varchar(60),
  old_value text,
  new_value text,
  actor_id integer references public.users(id) on delete set null,
  actor_name varchar(150) not null default '',
  created_at timestamptz not null default now()
);

-- Administrator-maintained reference rates. One row per revision so the
-- rate history is preserved; the newest row is the current reference rate.
create table if not exists public.exchange_rates (
  id serial primary key,
  rwf_per_usd numeric(18,6) not null check (rwf_per_usd > 0),
  cdf_per_usd numeric(18,6) not null check (cdf_per_usd > 0),
  note text not null default '',
  updated_by integer references public.users(id) on delete set null,
  updated_by_name varchar(150) not null default '',
  created_at timestamptz not null default now()
);

insert into public.exchange_rates (rwf_per_usd, cdf_per_usd, note, updated_by_name)
select 1450, 2850, 'Initial reference rate', 'System'
where not exists (select 1 from public.exchange_rates);

-- Sequential reference numbers per year: MF-2026-0048 (mockup section 3).
create table if not exists public.movement_ref_counters (
  year integer primary key,
  last_number integer not null default 0
);

create index if not exists movements_related_area_idx on public.movements(related_area);
create index if not exists movements_status_idx on public.movements(status);
create index if not exists movements_departure_idx on public.movements(departure_date desc);
create index if not exists movement_evidence_movement_idx on public.movement_evidence(movement_id, created_at desc);
create index if not exists movement_history_movement_idx on public.movement_history(movement_id, created_at desc);

alter table public.movement_evidence enable row level security;
alter table public.movement_history enable row level security;
alter table public.exchange_rates enable row level security;
alter table public.movement_ref_counters enable row level security;
