-- =====================================================================
--  選屋系統 · 資料庫結構（Supabase / PostgreSQL）
--  在 Supabase → SQL Editor 貼上整份檔案 → Run。可重複執行。
-- =====================================================================

-- ---------- 基本表格 ----------
create table if not exists public.settings (
  key        text primary key,
  value      jsonb not null,
  is_public  boolean not null default false
);

create table if not exists public.staff (
  email      text primary key,
  name       text not null default '',
  role       text not null default 'staff' check (role in ('admin','staff')),
  created_at timestamptz not null default now()
);

create table if not exists public.owners (
  no             int primary key,
  name           text not null,
  agent          text not null default '',
  before_value   bigint,
  ratio          numeric,
  value          bigint not null,
  id_no          text not null default '',
  phone          text not null default '',
  address        text not null default '',
  note           text not null default '',
  store_priority boolean not null default false,
  no_merge       boolean not null default false,
  participation  text not null default '未申請' check (participation in ('參與','不參與','未申請')),
  sel_formal     boolean not null default false,
  sel_date       date,
  over_approved  boolean not null default false,
  redo           boolean not null default false,
  updated_at     timestamptz not null default now(),
  updated_by     text not null default ''
);

create table if not exists public.units (
  code        text primary key,
  use         text not null default '住宅',
  floor       text not null,
  unit        text not null,
  main        numeric, aux numeric, common numeric, total numeric,
  price_per   bigint, terrace numeric, terrace_per bigint, terrace_val bigint,
  price       bigint not null,
  open        boolean not null default true,
  sort        int not null default 0
);

create table if not exists public.parking (
  code   text primary key,
  floor  text not null,
  type   text not null default '平面車位',
  size   text not null default '',
  price  bigint not null,
  open   boolean not null default true,
  sort   int not null default 0
);

create table if not exists public.merge_groups (
  id            serial primary key,
  note          text not null default '',
  over_approved boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.merge_members (
  group_id  int not null references public.merge_groups(id) on delete cascade,
  owner_no  int not null references public.owners(no) on delete cascade,
  amount    bigint not null default 0,
  primary key (group_id, owner_no)
);

-- 一筆 = 一位地主（或一個合併組）選了一個戶別或車位
create table if not exists public.picks (
  id         bigserial primary key,
  owner_no   int references public.owners(no) on delete cascade,
  group_id   int references public.merge_groups(id) on delete cascade,
  code       text not null,
  kind       text not null check (kind in ('unit','park')),
  created_at timestamptz not null default now(),
  created_by text not null default '',
  check ((owner_no is null) <> (group_id is null))
);
create unique index if not exists picks_owner_code on public.picks(owner_no, code) where owner_no is not null;
create unique index if not exists picks_group_code on public.picks(group_id, code) where group_id is not null;
create index if not exists picks_code on public.picks(code);

create table if not exists public.documents (
  owner_no   int not null references public.owners(no) on delete cascade,
  doc_idx    int not null,
  state      int not null default 0 check (state between 0 and 2),  -- 0 待收 1 收到紙本 2 已歸檔
  file_id    text not null default '',
  file_url   text not null default '',
  file_name  text not null default '',
  updated_at timestamptz not null default now(),
  updated_by text not null default '',
  primary key (owner_no, doc_idx)
);

create table if not exists public.calls (
  id       bigserial primary key,
  owner_no int not null references public.owners(no) on delete cascade,
  at       timestamptz not null default now(),
  by       text not null default '',
  phone    text not null default '',
  content  text not null
);

create table if not exists public.audit_log (
  id       bigserial primary key,
  at       timestamptz not null default now(),
  by       text not null default '',
  owner_no int,
  action   text not null,
  detail   text not null default ''
);
create index if not exists audit_owner on public.audit_log(owner_no);

create table if not exists public.announcements (
  id        bigserial primary key,
  date      date not null default current_date,
  title     text not null,
  content   text not null default '',
  published boolean not null default true
);

-- ---------- 身分與權限 ----------
create or replace function public.me() returns text
language sql stable as $$ select coalesce(auth.jwt()->>'email','system') $$;

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff where lower(email) = lower(coalesce(auth.jwt()->>'email','')))
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff where lower(email) = lower(coalesce(auth.jwt()->>'email','')) and role = 'admin')
$$;

-- 預設填入操作者
alter table public.calls     alter column by set default public.me();
alter table public.audit_log alter column by set default public.me();

do $$
declare t text;
begin
  foreach t in array array['settings','staff','owners','units','parking','merge_groups','merge_members','picks','documents','calls','audit_log','announcements'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists staff_read on public.%I', t);
    execute format('create policy staff_read on public.%I for select to authenticated using (public.is_staff())', t);
  end loop;
  -- 管理員才能直接改的表（設定、人員、匯入資料、公告）
  foreach t in array array['settings','staff','owners','units','parking','announcements'] loop
    execute format('drop policy if exists admin_write on public.%I', t);
    execute format('create policy admin_write on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
  -- 一般人員可以直接新增的（通話紀錄、操作紀錄）
  foreach t in array array['calls','audit_log'] loop
    execute format('drop policy if exists staff_insert on public.%I', t);
    execute format('create policy staff_insert on public.%I for insert to authenticated with check (public.is_staff())', t);
  end loop;
end $$;

-- 明確授權（專案建立時即使關閉「Automatically expose new tables」也能正常運作）
-- 未登入的訪客（anon）不能直接讀任何表，只能呼叫 public_board / verify_owner 兩個函式；
-- 登入後（authenticated）能做什麼，再由上面的 RLS 規則限制。
revoke all on all tables in schema public from anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- ---------- 共用計算 ----------
create or replace function public.setting(k text) returns jsonb
language sql stable security definer set search_path = public as $$ select value from settings where key = k $$;

create or replace function public.code_price(c text) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce((select price from units where code = c), (select price from parking where code = c))
$$;

create or replace function public.owner_cap(o_no int) returns bigint
language sql stable security definer set search_path = public as $$
  select round(value * coalesce((setting('cap_ratio'))::numeric, 1.10))::bigint from owners where no = o_no
$$;

create or replace function public.owner_own_total(o_no int) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(sum(code_price(code)),0)::bigint from picks where owner_no = o_no
$$;

-- 檢查一組戶別／車位，回傳錯誤、警告與總價
create or replace function public.check_codes(p_units text[], p_parks text[], p_self_owner int, p_self_group int)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  e text[] := '{}'; w text[] := '{}'; c text; total bigint := 0; ppu int; others text;
begin
  ppu := coalesce((setting('park_per_unit'))::int, 1);
  foreach c in array coalesce(p_units,'{}') loop
    if exists (select 1 from units where code = c) then
      if not (select open from units where code = c) then e := e || (c || ' 為保留戶，不開放選配'); end if;
      total := total + code_price(c);
    elsif exists (select 1 from parking where code = c) then e := e || (c || ' 是車位，請填在「車位」欄');
    else e := e || ('找不到戶別「' || c || '」'); end if;
  end loop;
  foreach c in array coalesce(p_parks,'{}') loop
    if exists (select 1 from parking where code = c) then
      if not (select open from parking where code = c) then e := e || (c || ' 不開放選配'); end if;
      total := total + code_price(c);
    elsif exists (select 1 from units where code = c) then e := e || (c || ' 是房屋，請填在「戶別」欄');
    else e := e || ('找不到車位「' || c || '」'); end if;
  end loop;
  if coalesce(array_length(p_parks,1),0) > coalesce(array_length(p_units,1),0) * ppu then
    e := e || format('一戶房屋最多搭配 %s 個車位', ppu);
  end if;
  foreach c in array coalesce(p_units,'{}') || coalesce(p_parks,'{}') loop
    select string_agg(coalesce(o.name, '合併組#' || p.group_id), '、') into others
      from picks p left join owners o on o.no = p.owner_no
     where p.code = c
       and not (p.owner_no is not distinct from p_self_owner and p_self_owner is not null)
       and not (p.group_id is not distinct from p_self_group and p_self_group is not null);
    if others is not null then
      if (setting('dup_mode')) #>> '{}' = 'block' then e := e || (c || ' 已被 ' || others || ' 選配');
      else w := w || (c || ' 已被 ' || others || ' 選配，將標為重複待抽籤'); end if;
    end if;
  end loop;
  return jsonb_build_object('errors', to_jsonb(e), 'warnings', to_jsonb(w), 'total', total);
end $$;

-- ---------- 選屋登錄（單一地主） ----------
create or replace function public.save_owner(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o owners%rowtype; v_units text[]; v_parks text[]; chk jsonb; e text[]; total bigint; capv bigint;
  mode text; formal boolean; approved boolean; part text; before text; after text;
begin
  if not is_staff() then raise exception '沒有權限'; end if;
  perform pg_advisory_xact_lock(4242);
  select * into o from owners where no = (p->>'no')::int for update;
  if not found then return jsonb_build_object('ok',false,'errors',jsonb_build_array('找不到這位地主')); end if;

  v_units := array(select jsonb_array_elements_text(coalesce(p->'units','[]')));
  v_parks := array(select jsonb_array_elements_text(coalesce(p->'parks','[]')));
  part    := coalesce(p->>'participation', o.participation);
  formal  := coalesce((p->>'formal')::boolean, true);
  approved:= coalesce((p->>'over_approved')::boolean, false);
  if part <> '參與' then v_units := '{}'; v_parks := '{}'; end if;

  chk := check_codes(v_units, v_parks, o.no, null);
  e := array(select jsonb_array_elements_text(chk->'errors'));
  total := (chk->>'total')::bigint;
  capv := owner_cap(o.no);
  mode := coalesce((setting('over_cap_mode')) #>> '{}', 'approve');

  if formal and part = '參與' then
    if total > capv then
      if mode = 'block' then e := e || format('超過選配上限 NT$%s', to_char(total-capv,'FM999,999,999,999'));
      elsif mode = 'approve' and not (approved and is_admin()) then
        if approved and o.over_approved then null;  -- 已核准過，沿用
        else e := e || format('超過選配上限 NT$%s，須由管理員註記已與實施者達成協議', to_char(total-capv,'FM999,999,999,999')); end if;
      end if;
    end if;
    if o.value < coalesce((setting('min_unit_value'))::bigint,0) and total > 0 then
      e := e || '應分配權利價值未達最小分配單元，不能單獨選配，請用合併選配'::text;
    end if;
  end if;
  if coalesce(array_length(e,1),0) > 0 then
    return jsonb_build_object('ok',false,'errors',to_jsonb(e),'warnings',chk->'warnings');
  end if;

  select coalesce(string_agg(code, '、' order by kind desc, code),'（無）') into before from picks where owner_no = o.no;
  delete from picks where owner_no = o.no;
  insert into picks(owner_no, code, kind, created_by)
    select o.no, x, 'unit', me() from unnest(v_units) x
    union all select o.no, x, 'park', me() from unnest(v_parks) x;
  after := coalesce(nullif(array_to_string(v_units || v_parks, '、'),''), case when part='不參與' then '不參與權變' else '（無）' end);

  update owners set
    participation = part,
    sel_formal    = formal,
    over_approved = case when total > capv then (approved and (is_admin() or o.over_approved)) else false end,
    redo          = case when total > 0 then false else redo end,
    phone   = coalesce(p->>'phone', phone),
    address = coalesce(p->>'address', address),
    id_no   = upper(coalesce(p->>'id_no', id_no)),
    note    = coalesce(p->>'note', note),
    sel_date= coalesce(nullif(p->>'sel_date','')::date, sel_date),
    updated_at = now(), updated_by = me()
  where no = o.no;

  insert into audit_log(owner_no, action, detail)
  values (o.no, case when formal then '正式登錄' else '存草稿' end, o.name || ' ' || before || ' → ' || after);
  return jsonb_build_object('ok',true,'warnings',chk->'warnings','total',total);
end $$;

-- 只更新聯絡資料／註記（不動選配）
create or replace function public.update_owner_info(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_staff() then raise exception '沒有權限'; end if;
  update owners set
    phone   = coalesce(p->>'phone', phone),
    address = coalesce(p->>'address', address),
    id_no   = upper(coalesce(p->>'id_no', id_no)),
    note    = coalesce(p->>'note', note),
    store_priority = case when is_admin() then coalesce((p->>'store_priority')::boolean, store_priority) else store_priority end,
    no_merge       = case when is_admin() then coalesce((p->>'no_merge')::boolean, no_merge) else no_merge end,
    updated_at = now(), updated_by = me()
  where no = (p->>'no')::int;
end $$;

-- ---------- 合併選配 ----------
create or replace function public.save_group(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  gid int := nullif(p->>'id','')::int; v_units text[]; v_parks text[]; chk jsonb; e text[]; total bigint;
  gcap bigint := 0; alloc bigint := 0; m jsonb; ow owners%rowtype; mode text; each_mode boolean; approved boolean;
  names text;
begin
  if not is_staff() then raise exception '沒有權限'; end if;
  perform pg_advisory_xact_lock(4242);
  v_units := array(select jsonb_array_elements_text(coalesce(p->'units','[]')));
  v_parks := array(select jsonb_array_elements_text(coalesce(p->'parks','[]')));
  approved := coalesce((p->>'over_approved')::boolean,false);
  chk := check_codes(v_units, v_parks, null, gid);
  e := array(select jsonb_array_elements_text(chk->'errors'));
  total := (chk->>'total')::bigint;
  mode := coalesce((setting('over_cap_mode')) #>> '{}', 'approve');
  each_mode := coalesce((setting('merge_cap_mode')) #>> '{}', 'group') = 'each';

  if jsonb_array_length(coalesce(p->'members','[]')) < 2 then e := e || '請至少選擇 2 位地主'::text; end if;
  for m in select * from jsonb_array_elements(coalesce(p->'members','[]')) loop
    select * into ow from owners where no = (m->>'no')::int;
    if not found then e := e || ('找不到地主編號 ' || (m->>'no')); continue; end if;
    if ow.no_merge then e := e || (ow.name || ' 已註記查封／假扣押，依法不得合併分配'); end if;
    if ow.participation = '不參與' then e := e || (ow.name || ' 目前為不參與權變'); end if;
    if (m->>'amount')::bigint < 0 then e := e || (ow.name || ' 出資不可為負數'); end if;
    gcap := gcap + owner_cap(ow.no) - owner_own_total(ow.no);
    alloc := alloc + (m->>'amount')::bigint;
    if each_mode and (m->>'amount')::bigint > owner_cap(ow.no) - owner_own_total(ow.no) then
      e := e || (ow.name || ' 的出資超過自己的剩餘額度'); end if;
  end loop;
  if alloc <> total then e := e || format('各人出資加總（%s）不等於選配總價（%s）', alloc, total); end if;
  if total > gcap then
    if mode = 'block' or (mode = 'approve' and not (approved and is_admin())) then
      e := e || format('超過合併可用上限 NT$%s，須由管理員註記已與實施者達成協議', to_char(total-gcap,'FM999,999,999,999'));
    end if;
  end if;
  if coalesce(array_length(e,1),0) > 0 then
    return jsonb_build_object('ok',false,'errors',to_jsonb(e),'warnings',chk->'warnings');
  end if;

  if gid is null then insert into merge_groups default values returning id into gid;
  else update merge_groups set updated_at = now(), over_approved = (total > gcap and approved) where id = gid; end if;
  delete from merge_members where group_id = gid;
  insert into merge_members(group_id, owner_no, amount)
    select gid, (x->>'no')::int, (x->>'amount')::bigint from jsonb_array_elements(p->'members') x;
  delete from picks where group_id = gid;
  insert into picks(group_id, code, kind, created_by)
    select gid, x, 'unit', me() from unnest(v_units) x union all select gid, x, 'park', me() from unnest(v_parks) x;
  update owners set participation = '參與', updated_at = now(), updated_by = me()
   where no in (select owner_no from merge_members where group_id = gid);
  select string_agg(o.name, '、') into names from merge_members mm join owners o on o.no = mm.owner_no where mm.group_id = gid;
  insert into audit_log(action, detail) values ('合併組', names || ' 選配 ' || array_to_string(v_units || v_parks, '、'));
  return jsonb_build_object('ok',true,'id',gid,'warnings',chk->'warnings');
end $$;

create or replace function public.delete_group(p_id int) returns void
language plpgsql security definer set search_path = public as $$
declare names text;
begin
  if not is_admin() then raise exception '只有管理員可以刪除合併組'; end if;
  select string_agg(o.name, '、') into names from merge_members mm join owners o on o.no = mm.owner_no where mm.group_id = p_id;
  delete from merge_groups where id = p_id;
  insert into audit_log(action, detail) values ('刪除合併組', coalesce(names,''));
end $$;

-- ---------- 抽籤結果 ----------
create or replace function public.lottery_win(p_code text, p_owner int, p_group int) returns void
language plpgsql security definer set search_path = public as $$
declare r record; winner text;
begin
  if not is_staff() then raise exception '沒有權限'; end if;
  perform pg_advisory_xact_lock(4242);
  select coalesce((select name from owners where no = p_owner), '合併組#' || p_group) into winner;
  for r in select * from picks where code = p_code
            and not (owner_no is not distinct from p_owner and p_owner is not null)
            and not (group_id is not distinct from p_group and p_group is not null) loop
    delete from picks where id = r.id;
    if r.owner_no is not null and r.kind = 'unit' then
      update owners set redo = true, updated_at = now(), updated_by = me() where no = r.owner_no;
      insert into audit_log(owner_no, action, detail) values (r.owner_no, '抽籤未中', (select name from owners where no=r.owner_no) || ' ' || p_code || ' 未中籤，需重選');
    end if;
  end loop;
  insert into audit_log(owner_no, action, detail) values (p_owner, '抽籤中籤', p_code || ' 中籤：' || winner);
end $$;

-- ---------- 文件狀態 ----------
create or replace function public.set_doc(p_owner int, p_idx int, p_state int, p_file_id text default null, p_file_url text default null, p_file_name text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_staff() then raise exception '沒有權限'; end if;
  insert into documents(owner_no, doc_idx, state, file_id, file_url, file_name, updated_at, updated_by)
  values (p_owner, p_idx, p_state, coalesce(p_file_id,''), coalesce(p_file_url,''), coalesce(p_file_name,''), now(), me())
  on conflict (owner_no, doc_idx) do update set
    state = excluded.state,
    file_id = coalesce(p_file_id, documents.file_id),
    file_url = coalesce(p_file_url, documents.file_url),
    file_name = coalesce(p_file_name, documents.file_name),
    updated_at = now(), updated_by = me();
  insert into audit_log(owner_no, action, detail)
  values (p_owner, '文件', (select name from owners where no = p_owner) || ' ' ||
          coalesce((setting('docs')->p_idx->>'name'), '文件'||p_idx) || ' → ' || (array['待收','收到紙本','已歸檔'])[p_state+1]);
end $$;

-- ---------- 前台（不需登入） ----------
-- 前台存取密碼：案件設定 public_passcode 有值時，要輸入正確密碼才看得到資料（測試期間用）
drop function if exists public.public_board();
drop function if exists public.verify_owner(text, text);

create or replace function public.passcode_ok(p_code text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(setting('public_passcode') #>> '{}', '') = '' or coalesce(setting('public_passcode') #>> '{}', '') = coalesce(p_code, '')
$$;

create or replace function public.board_data() returns jsonb
language sql stable security definer set search_path = public as $$
  with claims as (
    select p.code, count(*) n from picks p left join owners o on o.no = p.owner_no
     where p.group_id is not null or (o.participation = '參與' and o.sel_formal)
     group by p.code
  ), showp as (select coalesce((setting('show_prices'))::boolean,false) v)
  select jsonb_build_object(
    'settings', (select coalesce(jsonb_object_agg(key, value), '{}') from settings where is_public),
    'units', (select coalesce(jsonb_agg(jsonb_build_object('code',code,'use',use,'floor',floor,'unit',unit,'main',main,'aux',aux,'common',common,'total',total,'terrace',terrace,
                'price', case when (select v from showp) then price end) order by sort), '[]') from units),
    'parking', (select coalesce(jsonb_agg(jsonb_build_object('code',code,'floor',floor,'type',type,'size',size,
                'price', case when (select v from showp) then price end) order by sort), '[]') from parking),
    'status', (select coalesce(jsonb_object_agg(code, n), '{}') from (
                 select code, n from claims
                 union all select code, -1 from units where not open
                 union all select code, -1 from parking where not open) s),
    'names', case when coalesce((setting('show_names'))::boolean,false) then (
                 select coalesce(jsonb_object_agg(code, names), '{}') from (
                   select p.code, string_agg(coalesce(o.name, (select string_agg(o2.name,'、') from merge_members m2 join owners o2 on o2.no=m2.owner_no where m2.group_id=p.group_id)), '、') names
                     from picks p left join owners o on o.no = p.owner_no
                    where p.group_id is not null or (o.participation = '參與' and o.sel_formal)
                    group by p.code) n) else '{}'::jsonb end,
    'announcements', (select coalesce(jsonb_agg(jsonb_build_object('date',date,'title',title,'content',content) order by date desc, id desc), '[]') from announcements where published),
    'now', now()
  )
$$;

create or replace function public.public_board(p_code text default '') returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not passcode_ok(p_code) then
    perform pg_sleep(0.3);
    return jsonb_build_object('locked', true);
  end if;
  return board_data();
end $$;

create or replace function public.verify_owner(p_name text, p_id text, p_code text default '') returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare o owners%rowtype; res jsonb; docs jsonb; need int[]; in_group boolean;
begin
  perform pg_sleep(0.4);  -- 減緩連續猜測
  if not passcode_ok(p_code) then return null; end if;
  select * into o from owners where name = trim(p_name) and id_no <> '' and upper(id_no) = upper(trim(p_id)) limit 1;
  if not found then return null; end if;
  in_group := exists (select 1 from merge_members where owner_no = o.no);
  select coalesce(jsonb_agg(jsonb_build_object('name', d->>'name', 'state', coalesce(dd.state,0)) order by i), '[]') into docs
    from jsonb_array_elements(coalesce(setting('docs'),'[]')) with ordinality as t(d, i)
    left join documents dd on dd.owner_no = o.no and dd.doc_idx = (i-1)
   where (d->>'applies') = 'all'
      or ((d->>'applies') = 'participate' and o.participation <> '不參與')
      or ((d->>'applies') = 'merge' and in_group);
  res := jsonb_build_object(
    'no', o.no, 'name', o.name, 'value', o.value, 'participation', o.participation, 'formal', o.sel_formal, 'redo', o.redo,
    'below_min', o.value < coalesce((setting('min_unit_value'))::bigint,0),
    'units', (select coalesce(jsonb_agg(code order by code), '[]') from picks where owner_no = o.no and kind='unit'),
    'parks', (select coalesce(jsonb_agg(code order by code), '[]') from picks where owner_no = o.no and kind='park'),
    'dups',  (select coalesce(jsonb_agg(code), '[]') from (select p.code from picks p where p.code in (
                select code from picks where owner_no = o.no or group_id in (select group_id from merge_members where owner_no = o.no))
              group by p.code having count(*) > 1) s),
    'groups', (select coalesce(jsonb_agg(jsonb_build_object(
                 'with', (select string_agg(o2.name,'、') from merge_members m2 join owners o2 on o2.no=m2.owner_no where m2.group_id=mm.group_id and m2.owner_no<>o.no),
                 'amount', mm.amount,
                 'total', (select coalesce(sum(code_price(code)),0) from picks where group_id = mm.group_id),
                 'codes', (select coalesce(jsonb_agg(code order by kind desc, code),'[]') from picks where group_id = mm.group_id))), '[]')
               from merge_members mm where mm.owner_no = o.no),
    'docs', docs);
  return res;
end $$;

-- 函式權限
revoke all on function public.save_owner(jsonb), public.update_owner_info(jsonb), public.save_group(jsonb), public.delete_group(int),
  public.lottery_win(text,int,int), public.set_doc(int,int,int,text,text,text) from public, anon;
grant execute on function public.save_owner(jsonb), public.update_owner_info(jsonb), public.save_group(jsonb), public.delete_group(int),
  public.lottery_win(text,int,int), public.set_doc(int,int,int,text,text,text), public.is_staff(), public.is_admin() to authenticated;
revoke all on function public.board_data(), public.passcode_ok(text) from public, anon;
grant execute on function public.public_board(text), public.verify_owner(text,text,text) to anon, authenticated;

-- 即時同步（後台多人同時操作）
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['owners','picks','merge_groups','merge_members','documents','calls','audit_log','settings','units','parking'] loop
      begin execute format('alter publication supabase_realtime add table public.%I', t);
      exception when duplicate_object then null; end;
    end loop;
  end if;
end $$;

-- ---------- 預設案件設定（可在後台「案件設定」修改） ----------
insert into public.settings(key, value, is_public) values
  ('case_name',      '"（請在案件設定填寫個案名稱）"', true),
  ('short_name',     '"新個案"', true),
  ('location',       '""', true),
  ('developer',      '""', true),
  ('contact',        '""', true),
  ('test_mode',      'true', true),
  ('apply_start',    '""', true),
  ('apply_end',      '""', true),
  ('apply_end_time', '"17:00"', true),
  ('lottery_text',   '""', true),
  ('milestones',     '[]', true),
  ('cap_ratio',      '1.10', true),
  ('min_unit_value', '0', true),
  ('park_per_unit',  '1', true),
  ('over_cap_mode',  '"approve"', false),
  ('dup_mode',       '"allow"', false),
  ('merge_cap_mode', '"group"', false),
  ('docs', '[{"name":"附件二 意願調查表","applies":"all"},{"name":"附件三 申請書","applies":"participate"},{"name":"附件四 合併分配協議書","applies":"merge"},{"name":"附件五 委託書","applies":"optional"}]', true),
  ('drive_script_url', '""', false),
  ('drive_folder',   '""', false),
  ('show_names',     'false', true),
  ('show_prices',    'false', true),
  ('show_plans',     'true', true),
  ('refresh_sec',    '30', true),
  ('public_passcode', '""', false)
on conflict (key) do nothing;
