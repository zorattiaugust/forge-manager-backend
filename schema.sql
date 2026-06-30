-- Run this in Supabase: Project > SQL Editor > New query > paste this > Run

-- Forge daily tracking data (mirrors what the Forge dashboard already tracks)
create table if not exists forge_logs (
  id bigint generated always as identity primary key,
  log_date date not null,
  category text not null,        -- 'workout' | 'exercise' | 'run' | 'meal' | 'supplement' | 'water' | 'reading' | 'budget'
  payload jsonb not null,        -- flexible field for whatever that category needs
  created_at timestamptz default now()
);

-- Coach chat history
create table if not exists coach_messages (
  id bigint generated always as identity primary key,
  role text not null,            -- 'user' | 'assistant'
  content text not null,
  created_at timestamptz default now()
);

-- Manager chat history (business ideas), grouped by conversation/topic
create table if not exists manager_threads (
  id bigint generated always as identity primary key,
  title text not null,
  created_at timestamptz default now()
);

create table if not exists manager_messages (
  id bigint generated always as identity primary key,
  thread_id bigint references manager_threads(id) on delete cascade,
  role text not null,            -- 'user' | 'manager' | 'agent:<name>'
  content text not null,
  created_at timestamptz default now()
);

-- Pending confirmations the Coach is waiting on you to approve
create table if not exists pending_logs (
  id bigint generated always as identity primary key,
  log_date date not null,
  category text not null,
  payload jsonb not null,
  status text not null default 'pending', -- 'pending' | 'confirmed' | 'rejected'
  created_at timestamptz default now()
);
