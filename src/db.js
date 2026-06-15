'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const config = require('./config');
const { DEVICE_DIRECTORY } = require('./deviceDirectory');

function asInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getDatabaseConfig() {
  const databaseUrl = process.env.DATABASE_URL || '';
  const sslMode = process.env.PGSSLMODE || process.env.DB_SSLMODE || 'disable';

  if (databaseUrl) {
    return {
      connectionString: databaseUrl,
      ssl: sslMode === 'disable' ? false : { rejectUnauthorized: false },
    };
  }

  return {
    host: process.env.PGHOST || process.env.DB_HOST || '',
    port: asInt(process.env.PGPORT || process.env.DB_PORT, 5432),
    database: process.env.PGDATABASE || process.env.DB_NAME || 'postgres',
    user: process.env.PGUSER || process.env.DB_USER || '',
    password: process.env.PGPASSWORD || process.env.DB_PASSWORD || '',
    ssl: sslMode === 'disable' ? false : { rejectUnauthorized: false },
  };
}

const pool = new Pool({
  ...getDatabaseConfig(),
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (error) => {
  console.error('PC 사용 현황 DB pool error:', error);
});

async function query(sql, params = []) {
  await ready;
  return pool.query(sql, params);
}

async function rawQuery(sql, params = []) {
  return pool.query(sql, params);
}

async function withTransaction(task) {
  await ready;
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await task(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function migrate() {
  await rawQuery(`
    create table if not exists public.pmon_machines (
      id bigserial primary key,
      hostname text not null unique,
      username text,
      os text,
      ip text,
      local_ip text,
      vpn_connected boolean not null default false,
      vpn_ip text,
      mac text,
      boot_time bigint,
      work_start text not null default '09:00',
      work_end text not null default '18:00',
      security_tools jsonb,
      install_notified_at bigint,
      last_state text not null default 'unknown',
      current_status text not null default 'offline',
      status_updated_at bigint,
      source text not null default 'agent',
      monitoring_enabled boolean not null default true,
      archived boolean not null default false,
      first_seen bigint not null,
      last_seen bigint not null
    );

    create table if not exists public.pmon_ping_targets (
      id bigserial primary key,
      ip text not null unique,
      label text,
      enabled boolean not null default true,
      created_at bigint not null
    );

    create table if not exists public.pmon_events (
      id bigserial primary key,
      machine_id bigint not null references public.pmon_machines(id) on delete cascade,
      type text not null,
      ts bigint not null,
      received_at bigint not null,
      estimated boolean not null default false
    );

    create table if not exists public.pmon_ip_history (
      id bigserial primary key,
      machine_id bigint not null references public.pmon_machines(id) on delete cascade,
      remote_ip text,
      local_ip text,
      vpn_connected boolean not null default false,
      vpn_ip text,
      mac text,
      reason text,
      changed_at bigint not null
    );

    create table if not exists public.pmon_device_directory (
      id bigserial primary key,
      hostname text not null unique,
      username text,
      ip text,
      connected_ip text,
      mac text,
      system_type text,
      updated_at bigint not null
    );

    create index if not exists idx_pmon_events_machine_ts on public.pmon_events(machine_id, ts);
    create index if not exists idx_pmon_events_type on public.pmon_events(type);
    create index if not exists idx_pmon_ip_history_machine_changed on public.pmon_ip_history(machine_id, changed_at desc);
    create index if not exists idx_pmon_ping_targets_enabled on public.pmon_ping_targets(enabled, created_at);
    create index if not exists idx_pmon_machines_source_archived on public.pmon_machines(source, archived);

    alter table public.pmon_machines
      add column if not exists work_start text not null default '09:00';

    alter table public.pmon_machines
      add column if not exists work_end text not null default '18:00';

    alter table public.pmon_machines
      add column if not exists install_notified_at bigint;

    alter table public.pmon_machines
      add column if not exists security_tools jsonb;

    alter table public.pmon_machines
      add column if not exists vpn_connected boolean not null default false;

    alter table public.pmon_machines
      add column if not exists vpn_ip text;

    alter table public.pmon_machines
      add column if not exists current_status text not null default 'offline';

    alter table public.pmon_machines
      add column if not exists status_updated_at bigint;

    alter table public.pmon_machines
      add column if not exists monitoring_enabled boolean not null default true;

    alter table public.pmon_events
      add column if not exists estimated boolean not null default false;
  `);

  const directoryCount = one(await rawQuery('select count(*)::int as n from public.pmon_device_directory'));
  if (!directoryCount?.n) {
    await upsertDeviceDirectoryRows(DEVICE_DIRECTORY);
  }
  await applyDeviceDirectoryToMachines();
}

const ready = migrate();

function rows(result) {
  return result.rows || [];
}

function one(result) {
  return rows(result)[0] || null;
}

const stmts = {
  listMachines: {
    all: async () => rows(await query('select * from public.pmon_machines where archived = false and monitoring_enabled = true order by source, hostname')),
  },
  agentMachines: {
    all: async () => rows(await query("select * from public.pmon_machines where source = 'agent' and monitoring_enabled = true order by hostname")),
  },
  analysisMachines: {
    all: async () => rows(await query('select * from public.pmon_machines where archived = false and monitoring_enabled = true order by source, hostname')),
  },
  getMachine: {
    get: async (id) => one(await query('select * from public.pmon_machines where id = $1', [id])),
  },
  updateMachineProfile: {
    run: async (id, username, workStart, workEnd) => query(
      'update public.pmon_machines set username = $1, work_start = $2, work_end = $3 where id = $4',
      [username || null, workStart, workEnd, id]
    ),
  },
  updateMachineUsername: {
    run: async (id, username) => query(
      'update public.pmon_machines set username = $1 where id = $2',
      [username || null, id]
    ),
  },
  updateMachineCurrentStatus: {
    run: async (id, currentStatus, now) => query(
      'update public.pmon_machines set current_status = $1, status_updated_at = $2 where id = $3',
      [currentStatus, now, id]
    ),
  },
  disableMachineMonitoring: {
    run: async (id, now) => query(
      `update public.pmon_machines
          set monitoring_enabled = false,
              archived = true,
              last_state = 'offline',
              current_status = 'offline',
              status_updated_at = $2
        where id = $1`,
      [id, now]
    ),
  },
  ipHistoryForMachine: {
    all: async (machineId, start, end) =>
      rows(await query(
        `select *
           from public.pmon_ip_history
          where machine_id = $1 and changed_at >= $2 and changed_at < $3
          order by changed_at desc`,
        [machineId, start, end]
      )),
  },
  listDeviceDirectory: {
    all: async () => rows(await query('select * from public.pmon_device_directory order by username nulls last, hostname')),
  },
  updateDeviceDirectoryRow: {
    run: updateDeviceDirectoryRow,
  },
  upsertDeviceDirectoryRows: {
    run: upsertDeviceDirectoryRows,
  },
  replaceDeviceDirectoryRows: {
    run: replaceDeviceDirectoryRows,
  },
  applyDeviceDirectoryToMachines: {
    run: applyDeviceDirectoryToMachines,
  },
  markInstallNotified: {
    run: async (id, now) => query(
      'update public.pmon_machines set install_notified_at = $1 where id = $2 and install_notified_at is null',
      [now, id]
    ),
  },
  eventsForMachine: {
    all: async (machineId, start, end) =>
      rows(await query(
        'select * from public.pmon_events where machine_id = $1 and ts >= $2 and ts < $3 order by ts desc',
        [machineId, start, end]
      )),
  },
  lastSessionEvent: {
    get: async (machineId) =>
      one(await query(
        "select * from public.pmon_events where machine_id = $1 and type in ('lock','unlock') order by ts desc limit 1",
        [machineId]
      )),
  },
  latestEvent: {
    get: async (machineId) =>
      one(await query(
        "select * from public.pmon_events where machine_id = $1 and type not in ('heartbeat','power_on','shutdown') order by ts desc limit 1",
        [machineId]
      )),
  },
  eventsByDay: {
    all: async (start, end, username = '') => {
      const params = [start, end];
      let usernameWhere = '';
      if (username) {
        params.push(username);
        usernameWhere = ` and coalesce(m.username, '') = $${params.length}`;
      }
      return rows(await query(
        `select e.id, e.machine_id, e.type, e.ts, e.received_at, e.estimated,
                case
                  when e.type = 'lock' then 'locked'
                  when e.type in ('login', 'unlock', 'power_on') then 'online'
                  when e.type = 'shutdown' then 'offline'
                  else m.current_status
                end as event_status,
                m.hostname, m.username, m.ip, m.local_ip, m.vpn_connected, m.vpn_ip, m.mac, m.source,
                m.last_state, m.current_status
           from public.pmon_events e
           join public.pmon_machines m on m.id = e.machine_id
          where e.ts >= $1 and e.ts < $2
            ${usernameWhere}
          order by e.ts desc`,
        params
      ));
    },
  },
  eventDays: {
    get: async () => one(await query('select min(ts) as first_ts, max(ts) as last_ts, count(*)::int as n from public.pmon_events')),
  },
  listTargets: {
    all: async () => rows(await query('select * from public.pmon_ping_targets order by created_at')),
  },
  enabledTargets: {
    all: async () => rows(await query('select * from public.pmon_ping_targets where enabled = true order by created_at')),
  },
  insertTarget: {
    run: async ({ ip, label, now }) => {
      const result = await query(
        'insert into public.pmon_ping_targets (ip, label, enabled, created_at) values ($1, $2, true, $3) returning id',
        [ip, label, now]
      );
      return { lastInsertRowid: result.rows[0].id };
    },
  },
  deleteTarget: {
    run: async (id) => query('delete from public.pmon_ping_targets where id = $1', [id]),
  },
  getTarget: {
    get: async (id) => one(await query('select * from public.pmon_ping_targets where id = $1', [id])),
  },
};

function normalizeMac(mac) {
  return String(mac || '').trim().toLowerCase().replace(/-/g, ':');
}

function normalizeHost(hostname) {
  return String(hostname || '').trim().toLowerCase();
}

function pickValue(row, keys) {
  for (const key of keys) {
    if (row[key] != null && String(row[key]).trim()) return row[key];
  }
  const entries = Object.entries(row).map(([key, value]) => [String(key).trim().toLowerCase(), value]);
  for (const key of keys) {
    const wanted = String(key).trim().toLowerCase();
    const found = entries.find(([entryKey, value]) => entryKey === wanted && String(value ?? '').trim());
    if (found) return found[1];
  }
  return '';
}

function normalizeDirectoryRow(row) {
  const mac = normalizeMac(pickValue(row, ['mac', 'macAddress', 'Mac Address', 'MAC Address', 'MAC 주소']));
  const ips = [
    pickValue(row, ['ip', 'ipAddress', 'IP Address', 'IP 주소']),
    pickValue(row, ['ip1', 'ip 1', 'IP 1']),
    pickValue(row, ['ip2', 'ip 2', 'IP 2']),
    pickValue(row, ['ip3', 'ip 3', 'IP 3']),
    pickValue(row, ['ip4', 'ip 4', 'IP 4']),
    pickValue(row, ['connectedIp', 'connected_ip', '연결된 IP 주소']),
  ]
    .flatMap((value) => String(value || '').split(/[\s,]+/))
    .map((value) => value.trim())
    .filter(Boolean);
  const uniqueIps = [...new Set(ips)];
  const ip = uniqueIps.join(', ') || null;
  const connectedIp = uniqueIps[0] || null;
  const hostname = String(pickValue(row, ['hostname', 'Hostname', 'computerName', '컴퓨터 이름'])).trim() || mac || connectedIp;
  if (!hostname || !mac) return null;
  return {
    hostname,
    username: String(pickValue(row, ['username', 'userName', '사용자', '사용자 이름', '담당자', '관리자'])).trim() || null,
    ip,
    connectedIp,
    mac,
    systemType: String(pickValue(row, ['systemType', 'system_type', '시스템 종류', '용도'])).trim() || null,
  };
}

function dedupeDirectoryRows(rowsToDedupe = []) {
  const map = new Map();
  for (const row of rowsToDedupe) {
    const key = row.mac || row.hostname;
    if (!key) continue;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, row);
      continue;
    }
    const ips = [...new Set([
      ...String(prev.ip || '').split(/[\s,]+/).filter(Boolean),
      ...String(row.ip || '').split(/[\s,]+/).filter(Boolean),
    ])];
    map.set(key, {
      ...prev,
      ...row,
      username: row.username || prev.username,
      hostname: row.hostname || prev.hostname,
      ip: ips.join(', ') || row.ip || prev.ip,
      connectedIp: row.connectedIp || prev.connectedIp || ips[0] || null,
      systemType: row.systemType || prev.systemType,
    });
  }
  return [...map.values()];
}

async function upsertDeviceDirectoryRows(inputRows = []) {
  const normalized = dedupeDirectoryRows(inputRows.map(normalizeDirectoryRow).filter(Boolean));
  if (!normalized.length) return { count: 0 };
  const now = Date.now();
  await rawQuery('begin');
  try {
    for (const row of normalized) {
      await rawQuery(
        `insert into public.pmon_device_directory
           (hostname, username, ip, connected_ip, mac, system_type, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (hostname) do update set
           username = excluded.username,
           ip = excluded.ip,
           connected_ip = excluded.connected_ip,
           mac = excluded.mac,
           system_type = excluded.system_type,
           updated_at = excluded.updated_at`,
        [row.hostname, row.username, row.ip, row.connectedIp, row.mac || null, row.systemType, now]
      );
    }
    await rawQuery('commit');
  } catch (error) {
    await rawQuery('rollback');
    throw error;
  }
  return { count: normalized.length };
}

async function replaceDeviceDirectoryRows(inputRows = []) {
  const normalized = dedupeDirectoryRows(inputRows.map(normalizeDirectoryRow).filter(Boolean));
  const now = Date.now();
  await rawQuery('begin');
  try {
    await rawQuery('delete from public.pmon_device_directory');
    for (const row of normalized) {
      await rawQuery(
        `insert into public.pmon_device_directory
           (hostname, username, ip, connected_ip, mac, system_type, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [row.hostname, row.username, row.ip, row.connectedIp, row.mac || null, row.systemType, now]
      );
    }
    await rawQuery('commit');
  } catch (error) {
    await rawQuery('rollback');
    throw error;
  }
  return { count: normalized.length };
}

async function updateDeviceDirectoryRow(id, input) {
  const normalized = normalizeDirectoryRow({
    hostname: input.hostname || input.mac,
    username: input.username,
    사용자: input.username,
    mac: input.mac,
    ip: input.ip,
    connectedIp: input.connected_ip,
    systemType: input.system_type,
  });
  if (!normalized) return { count: 0 };
  const result = await query(
    `update public.pmon_device_directory
        set hostname = $1,
            username = $2,
            ip = $3,
            connected_ip = $4,
            mac = $5,
            system_type = $6,
            updated_at = $7
      where id = $8`,
    [
      normalized.hostname,
      normalized.username,
      normalized.ip,
      normalized.connectedIp,
      normalized.mac || null,
      normalized.systemType,
      Date.now(),
      id,
    ]
  );
  return { count: result.rowCount || 0 };
}

async function applyDeviceDirectoryToMachines() {
  const result = await rawQuery(`
    update public.pmon_machines m
       set username = d.username,
           mac = coalesce(nullif(m.mac, ''), d.mac),
           local_ip = coalesce(nullif(m.local_ip, ''), d.connected_ip, d.ip)
      from public.pmon_device_directory d
     where d.username is not null
       and nullif(d.mac, '') is not null
       and nullif(m.mac, '') is not null
       and replace(lower(m.mac), ':', '-') = replace(lower(d.mac), ':', '-')
  `);
  return { count: result.rowCount || 0 };
}

async function findDirectoryMatch(report, client) {
  const mac = normalizeMac(report.mac);
  if (!mac) return null;
  const result = await client.query(
    `select * from public.pmon_device_directory
      where nullif(mac, '') is not null
        and replace(lower(mac), ':', '-') = replace($1, ':', '-')
      limit 1`,
    [mac]
  );
  return one(result);
}

function deriveState(type, prevState) {
  if (type === 'lock') return 'locked';
  if (type === 'login') return 'unlocked';
  if (type === 'unlock') return 'unlocked';
  if (type === 'power_on') return 'unlocked';
  if (type === 'shutdown') return 'offline';
  return prevState && prevState !== 'offline' ? prevState : 'unlocked';
}

function statusFromState(state) {
  if (state === 'locked') return 'locked';
  if (state === 'offline') return 'offline';
  return 'online';
}

function normalizedIpSnapshot(source) {
  return {
    remoteIp: source.ip || null,
    localIp: source.local_ip || null,
    vpnConnected: source.vpn_connected === true,
    vpnIp: source.vpn_ip || null,
    mac: source.mac || null,
  };
}

function ipSnapshotChanged(prev, next) {
  if (!prev) return true;
  return (prev.ip || null) !== next.remoteIp
    || (prev.local_ip || null) !== next.localIp
    || (prev.vpn_connected === true) !== next.vpnConnected
    || (prev.vpn_ip || null) !== next.vpnIp
    || (prev.mac || null) !== next.mac;
}

async function recordIpHistory(client, machineId, snapshot, reason, now) {
  await client.query(
    `insert into public.pmon_ip_history
       (machine_id, remote_ip, local_ip, vpn_connected, vpn_ip, mac, reason, changed_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      machineId,
      snapshot.remoteIp,
      snapshot.localIp,
      snapshot.vpnConnected,
      snapshot.vpnIp,
      snapshot.mac,
      reason,
      now,
    ]
  );
}

async function ingest(report) {
  return withTransaction(async (client) => {
    const now = Date.now();
    const ts = report.ts && Number.isFinite(report.ts) ? report.ts : now;
    const existing = await client.query('select * from public.pmon_machines where hostname = $1 for update', [report.hostname]);
    let machine = one(existing);
    if (machine && machine.monitoring_enabled === false) {
      return { id: machine.id, disabled: true };
    }
    const directoryMatch = await findDirectoryMatch(report, client);
    const preferredUsername = directoryMatch?.username || report.username || null;
    const lastState = deriveState(report.type, machine ? machine.last_state : 'unknown');
    const ipSnapshot = normalizedIpSnapshot(report);
    const ipChanged = ipSnapshotChanged(machine, ipSnapshot);
    const isNewMachine = !machine;

    if (!machine) {
      const inserted = await client.query(
        `insert into public.pmon_machines
           (hostname, username, os, ip, local_ip, vpn_connected, vpn_ip, mac, boot_time, security_tools, last_state, current_status, status_updated_at, source, first_seen, last_seen)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, 'agent', $13, $13)
         returning id`,
        [
          report.hostname,
          preferredUsername,
          report.os || null,
          ipSnapshot.remoteIp,
          ipSnapshot.localIp,
          ipSnapshot.vpnConnected,
          ipSnapshot.vpnIp,
          ipSnapshot.mac,
          report.boot_time || null,
          report.security_tools ? JSON.stringify(report.security_tools) : null,
          lastState,
          statusFromState(lastState),
          now,
        ]
      );
      machine = { id: inserted.rows[0].id };
    } else {
      await client.query(
        `update public.pmon_machines
            set username = $1, os = $2, ip = $3, local_ip = $4,
                vpn_connected = $5, vpn_ip = $6, mac = $7,
                boot_time = $8, security_tools = coalesce($9::jsonb, security_tools),
                last_state = $10, current_status = $11, status_updated_at = $12,
                last_seen = $12, archived = false
          where id = $13`,
        [
          preferredUsername || machine.username,
          report.os || machine.os,
          ipSnapshot.remoteIp || machine.ip,
          ipSnapshot.localIp || machine.local_ip,
          ipSnapshot.vpnConnected,
          ipSnapshot.vpnIp,
          ipSnapshot.mac || machine.mac,
          report.boot_time || machine.boot_time,
          report.security_tools ? JSON.stringify(report.security_tools) : null,
          lastState,
          statusFromState(lastState),
          now,
          machine.id,
        ]
      );
    }

    if (ipChanged) {
      await recordIpHistory(client, machine.id, ipSnapshot, isNewMachine ? 'initial' : 'changed', now);
    }

    if (report.type !== 'heartbeat') {
      await client.query(
        'insert into public.pmon_events (machine_id, type, ts, received_at) values ($1, $2, $3, $4)',
        [machine.id, report.type, ts, now]
      );
    }

    return { id: machine.id, disabled: false };
  });
}

async function applyPing(target, reachable) {
  return withTransaction(async (client) => {
    const now = Date.now();
    const hostname = target.label && target.label.trim() ? target.label.trim() : target.ip;
    const existing = await client.query(
      "select * from public.pmon_machines where source = 'ping' and ip = $1 for update",
      [target.ip]
    );
    let machine = one(existing);
    if (machine && machine.monitoring_enabled === false) return null;
    const wasOnline = machine && machine.last_state === 'online';
    const newState = reachable ? 'online' : 'offline';
    let transition = null;

    if (!machine) {
      const inserted = await client.query(
        `insert into public.pmon_machines
           (hostname, ip, source, last_state, current_status, status_updated_at, boot_time, first_seen, last_seen)
         values ($1, $2, 'ping', $3, $3, $5, $4, $5, $5)
         returning id`,
        [hostname, target.ip, newState, reachable ? now : null, now]
      );
      machine = { id: inserted.rows[0].id };
      if (reachable) transition = 'power_on';
    } else {
      if (reachable && !wasOnline) transition = 'power_on';
      else if (!reachable && wasOnline) transition = 'shutdown';

      await client.query(
        `update public.pmon_machines
            set hostname = $1, last_state = $2, current_status = $2,
                status_updated_at = $4, boot_time = $3, last_seen = $4, archived = false
          where id = $5`,
        [hostname, newState, transition === 'power_on' ? now : machine.boot_time, now, machine.id]
      );
    }

    if (transition) {
      await client.query(
        'insert into public.pmon_events (machine_id, type, ts, received_at) values ($1, $2, $3, $3)',
        [machine.id, transition, now]
      );
    }

    return transition;
  });
}

async function archivePingMachine(ip) {
  const result = await query(
    "update public.pmon_machines set archived = true, last_state = 'offline', current_status = 'offline', status_updated_at = $2 where source = 'ping' and ip = $1",
    [ip, Date.now()]
  );
  return result.rowCount || 0;
}

async function archiveOrphanPingMachines() {
  const result = await query(`
    update public.pmon_machines
       set archived = true, last_state = 'offline', current_status = 'offline', status_updated_at = $1
     where source = 'ping'
       and archived = false
       and ip not in (select ip from public.pmon_ping_targets)
  `, [Date.now()]);
  return result.rowCount || 0;
}

// PC OFF 통계 대시보드용 집계. ts 는 epoch ms, 시각/요일은 한국시간(Asia/Seoul) 기준.
async function getStats(fromMs, toMs, blindHours = 24) {
  const KST = `at time zone 'Asia/Seoul'`;
  const tsExpr = `to_timestamp(ts / 1000.0) ${KST}`;
  const activeFilter = `archived = false`;
  const eventRange = `ts between $1 and $2 and type <> 'heartbeat'`;

  const [
    statusRes, osRes, vpnRes, kpiRes, secRes, weekdayRes, topUserRes,
  ] = await Promise.all([
    query(`select current_status as k, count(*)::int as n from public.pmon_machines where ${activeFilter} group by current_status`),
    query(`select case
              when os ilike 'mac%' then 'macOS'
              when os ilike 'windows%' then 'Windows'
              when os is null or os = '' then '미상'
              else os end as k,
            count(*)::int as n
            from public.pmon_machines where ${activeFilter} group by 1`),
    query(`select vpn_connected as k, count(*)::int as n from public.pmon_machines where ${activeFilter} group by vpn_connected`),
    query(`select
              count(*)::int as total,
              count(*) filter (where current_status = 'online')::int as online,
              count(*) filter (where current_status = 'locked')::int as locked,
              count(*) filter (where current_status = 'offline')::int as offline,
              count(*) filter (where vpn_connected)::int as vpn,
              count(*) filter (where monitoring_enabled)::int as monitoring,
              count(*) filter (where source = 'agent' and last_seen < $1)::int as blind
            from public.pmon_machines where ${activeFilter}`, [Date.now() - blindHours * 3600000]),
    query(`select
              count(*) filter (where (security_tools->'v3'->>'installed')::boolean)::int as v3_installed,
              count(*) filter (where (security_tools->'v3'->>'running')::boolean)::int as v3_running,
              count(*) filter (where (security_tools->'officekeeper'->>'installed')::boolean)::int as ok_installed,
              count(*) filter (where (security_tools->'officekeeper'->>'running')::boolean)::int as ok_running,
              count(*) filter (where security_tools is not null)::int as reported
            from public.pmon_machines where ${activeFilter}`),
    query(`select extract(dow from ${tsExpr})::int as w, count(*)::int as n
            from public.pmon_events where ${eventRange} group by 1`, [fromMs, toMs]),
    query(`select coalesce(m.username, m.hostname) as k, count(*)::int as n
            from public.pmon_events e join public.pmon_machines m on m.id = e.machine_id
            where e.ts between $1 and $2 and e.type <> 'heartbeat'
            group by 1 order by n desc limit 10`, [fromMs, toMs]),
  ]);

  const toMap = (res) => Object.fromEntries(rows(res).map((r) => [r.k, r.n]));
  const weekMap = toMap(weekdayRes);
  const weekday = Array.from({ length: 7 }, (_, w) => ({ dow: w, n: weekMap[w] || 0 }));

  const sec = one(secRes) || {};
  return {
    kpi: one(kpiRes) || {},
    status: toMap(statusRes),
    os: toMap(osRes),
    vpn: { connected: toMap(vpnRes).true || 0, disconnected: toMap(vpnRes).false || 0 },
    security: {
      reported: sec.reported || 0,
      v3Installed: sec.v3_installed || 0,
      v3Running: sec.v3_running || 0,
      okInstalled: sec.ok_installed || 0,
      okRunning: sec.ok_running || 0,
    },
    weekday,
    topUsers: rows(topUserRes),
  };
}

// 오프라인 확정(보고 끊긴 지 thresholdMs 이상) 에이전트에 대해, 아직 종료 이벤트가 없으면
// 마지막 보고시각(last_seen)에 '종료(추정)' 이벤트를 1건 자동 기록한다. 전원↔종료 짝을 맞춤.
async function closeStaleOfflineSessions(thresholdMs = 3 * 60 * 60 * 1000) {
  const now = Date.now();
  const cutoff = now - thresholdMs;
  const result = await query(
    `insert into public.pmon_events (machine_id, type, ts, received_at, estimated)
     select m.id, 'shutdown', m.last_seen, $1, true
       from public.pmon_machines m
      where m.source = 'agent'
        and m.archived = false
        and m.last_seen < $2
        and exists (select 1 from public.pmon_events e where e.machine_id = m.id and e.ts <= m.last_seen)
        and not exists (select 1 from public.pmon_events e where e.machine_id = m.id and e.type = 'shutdown' and e.ts >= m.last_seen)`,
    [now, cutoff]
  );
  return result.rowCount || 0;
}

module.exports = {
  pool,
  query,
  ready,
  stmts,
  ingest,
  applyPing,
  archivePingMachine,
  archiveOrphanPingMachines,
  getStats,
  closeStaleOfflineSessions,
  config,
};
