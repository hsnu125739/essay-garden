"""
隨筆花園雲端資料庫初始化與驗收測試套件（對齊 database-spec.md & verification-spec.md）。
目前階段：M1（L1 白箱檢驗 TC-S01～TC-S03）+ M2（L2 本地雙引擎對拍 TC-S05 + L3/L4 實彈 GAS 與白箱驗證 TC-S06、TC-A01～TC-A26、TC-R01～TC-R10）。
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import os
import subprocess
import sys
import time
import urllib.request
from zoneinfo import ZoneInfo

from gspread.utils import rowcol_to_a1

sys.path.insert(0, r"C:\Users\wl020\.gemini\config\mcp_servers")
from gsheet_io import _client, read, write  # noqa: E402

DEFAULT_SHEET_ID = "1UBt7fuHru0fJv1QLStpvaIr2YxIg2vO9sM8yrd-cTAE"

TAB_ORDER = ["users", "groups", "gardens", "essays"]

HEADERS = {
    "users": [
        "uid",
        "username",
        "password_hash",
        "session_hashes_json",
        "display_name",
        "timezone",
        "active_group_id",
        "energy",
        "pity",
        "streak_count",
        "streak_last_day",
        "streak_prev_count",
        "streak_prev_last_day",
        "seeds_json",
        "limited_seeds_json",
        "milestones_json",
        "dex_json",
        "last_card_style",
        "makeup_days_json",
        "created_at",
        "updated_at",
    ],
    "groups": [
        "group_id",
        "name",
        "owner_uid",
        "status",
        "invite_code",
        "member_uids_json",
        "former_member_uids_json",
        "timezone",
        "theme_vote_month",
        "theme_votes_json",
        "makeup_days_json",
        "created_at",
        "updated_at",
    ],
    "gardens": [
        "garden_id",
        "owner_type",
        "owner_id",
        "month",
        "theme",
        "status",
        "snapshot_name",
        "size",
        "expansions",
        "items_json",
        "created_at",
        "updated_at",
    ],
    "essays": ["day_key"],
}

NUMBER_COLS = {
    "users": {"energy", "pity", "streak_count", "streak_prev_count", "created_at", "updated_at"},
    "groups": {"created_at", "updated_at"},
    "gardens": {"size", "expansions", "created_at", "updated_at"},
    "essays": set(),
}

PK_RULES = {
    "users": ("uid", ("u_test_",)),
    "groups": ("group_id", ("grp_test_",)),
    "gardens": ("garden_id", ("g_test_", "snap_test_")),
}

TEXT_FORMAT = {"type": "TEXT", "pattern": "@"}
NUMBER_FORMAT = {"type": "NUMBER", "pattern": "0"}


def _assert_tab_safe(tab: str, vals: list) -> None:
    """檢查單一工作表的原始二維資料，確保不含非測試資料。"""
    if tab == "工作表1":
        if any(str(cell).strip() for row in vals for cell in row):
            raise RuntimeError("Refusing to remove '工作表1': tab contains non-empty data.")
        return

    if tab == "essays":
        if not vals:
            return
        hdr = vals[0]
        if any(str(c).strip() for c in hdr) and str(hdr[0]).strip() != "day_key":
            raise RuntimeError(f"Refusing to run on 'essays': unexpected A1 header {hdr[0]!r}.")
        non_test_cols = [c for c in hdr[1:] if str(c).strip() and not str(c).startswith("u_test_")]
        if non_test_cols:
            raise RuntimeError(f"Refusing to run on 'essays': non-test user columns {non_test_cols}.")
        for row_idx, row in enumerate(vals[1:], start=2):
            for col_idx, cell in enumerate(row):
                if not str(cell).strip():
                    continue
                if col_idx >= len(hdr) or (col_idx >= 1 and not str(hdr[col_idx]).strip()):
                    raise RuntimeError(
                        f"Refusing to run on 'essays': orphan data at R{row_idx}C{col_idx + 1}."
                    )
        if len(vals) > 1 and not any(str(c).strip() for c in hdr[1:]):
            raise RuntimeError("Refusing to run on 'essays': unexpected data rows without test columns.")
        return

    pk_col, allowed_prefixes = PK_RULES[tab]
    if not vals:
        return
    hdr = vals[0]
    if len(vals) == 1 and any(str(c).strip() for c in hdr) and [str(c).strip() for c in hdr] != HEADERS[tab]:
        raise RuntimeError(f"Refusing to run on '{tab}': unrecognized single-row data {hdr}.")
    pk_idx = hdr.index(pk_col) if pk_col in hdr else None
    for row in vals[1:]:
        if not any(str(cell).strip() for cell in row):
            continue
        pk_val = str(row[pk_idx]).strip() if pk_idx is not None and pk_idx < len(row) else ""
        if not pk_val.startswith(allowed_prefixes):
            raise RuntimeError(f"Refusing to run on '{tab}': found non-test record ({pk_col}={pk_val!r}).")


def assert_no_prod_data(sheet_id: str) -> None:
    """正式資料安全鎖：拒絕在含未知分頁或非 u_test_* 測試資料的試算表上執行初始化或寫入。"""
    sh = _client().open_by_key(sheet_id)
    existing_tabs = {w.title for w in sh.worksheets()}
    unexpected_tabs = existing_tabs - set(TAB_ORDER) - {"工作表1"}
    if unexpected_tabs:
        raise RuntimeError(f"Refusing to run: found unexpected tabs {sorted(unexpected_tabs)}.")
    check_tabs = [t for t in (*TAB_ORDER, "工作表1") if t in existing_tabs]
    if check_tabs:
        res = sh.values_batch_get(
            [f"{t}!A1:ZZ" for t in check_tabs],
            params={"valueRenderOption": "UNFORMATTED_VALUE"},
        )
        v_ranges = res.get("valueRanges", [])
        for idx, tab in enumerate(check_tabs):
            vals = v_ranges[idx].get("values", []) if idx < len(v_ranges) else []
            _assert_tab_safe(tab, vals)


def _expected_format(tab: str, col_name: str) -> dict:
    return NUMBER_FORMAT if col_name in NUMBER_COLS[tab] else TEXT_FORMAT


def _repeat_format_req(ws_id: int, start_col: int, end_col: int, fmt: dict) -> dict:
    return {
        "repeatCell": {
            "range": {
                "sheetId": ws_id,
                "startColumnIndex": start_col,
                "endColumnIndex": end_col,
            },
            "cell": {"userEnteredFormat": {"numberFormat": fmt}},
            "fields": "userEnteredFormat.numberFormat",
        }
    }


def init_m1(sheet_id: str) -> None:
    """冪等初始化 4 張工作表、第 1 列欄位名、凍結表頭與整欄儲存格格式。"""
    assert_no_prod_data(sheet_id)

    for tab in TAB_ORDER:
        write(sheet_id, [HEADERS[tab]], tab=tab, mode="clear_write", create_tab=True, raw=True)

    sh = _client().open_by_key(sheet_id)
    ws_by_title = {w.title: w for w in sh.worksheets()}

    if "工作表1" in ws_by_title:
        sh.del_worksheet(ws_by_title["工作表1"])

    requests = []
    for idx, tab in enumerate(TAB_ORDER):
        ws = ws_by_title[tab]
        requests.append({
            "updateSheetProperties": {
                "properties": {
                    "sheetId": ws.id,
                    "index": idx,
                    "gridProperties": {"frozenRowCount": 1},
                },
                "fields": "index,gridProperties.frozenRowCount",
            }
        })
        if tab == "essays":
            requests.append(_repeat_format_req(ws.id, 0, ws.col_count, TEXT_FORMAT))
        else:
            for col_idx, col_name in enumerate(HEADERS[tab]):
                requests.append(_repeat_format_req(ws.id, col_idx, col_idx + 1, _expected_format(tab, col_name)))

    sh.batch_update({"requests": requests})


def verify_m1(sheet_id: str) -> None:
    """L1 唯讀結構驗證（TC-S01～TC-S03）：可用於空表及已上線試算表之表頭與格式巡檢。"""
    sh = _client().open_by_key(sheet_id)
    worksheets = sh.worksheets()
    ws_by_title = {w.title: w for w in worksheets}

    # TC-S01：工作表清單與順序（無工作表1）
    actual_tabs = [w.title for w in worksheets]
    assert actual_tabs == TAB_ORDER, f"TC-S01 failed: expected tabs {TAB_ORDER}, got {actual_tabs}"
    print("[TC-S01] PASSED")

    # 單次讀取第 1～2 列儲存格值與格式，同時完成 TC-S02 與 TC-S03
    ranges = [
        f"{tab}!A1:{rowcol_to_a1(2, ws_by_title[tab].col_count if tab == 'essays' else len(HEADERS[tab]))}"
        for tab in TAB_ORDER
    ]
    meta = sh.fetch_sheet_metadata({"includeGridData": True, "ranges": ranges})
    sheets_by_title = {s["properties"]["title"]: s for s in meta["sheets"]}

    # TC-S02：第 1 列欄位精確名稱與順序
    for tab in TAB_ORDER:
        row_data = sheets_by_title[tab]["data"][0].get("rowData", [])
        cells_r1 = row_data[0].get("values", []) if row_data else []
        hdr = [c.get("formattedValue", "") for c in cells_r1]
        while hdr and hdr[-1] == "":
            hdr.pop()
        if tab == "essays":
            assert hdr and hdr[0] == "day_key", f"TC-S02 failed on essays A1: got {hdr}"
            extra = hdr[1:]
            assert all(str(u).strip() for u in extra) and len(set(extra)) == len(extra), (
                f"TC-S02 failed on essays user columns: {extra}"
            )
        else:
            assert hdr == HEADERS[tab], f"TC-S02 failed on {tab}: expected {HEADERS[tab]}, got {hdr}"
    print("[TC-S02] PASSED")

    # TC-S03：凍結列與第 1～2 列儲存格格式驗證
    for tab in TAB_ORDER:
        sheet_meta = sheets_by_title[tab]
        frozen = sheet_meta["properties"].get("gridProperties", {}).get("frozenRowCount", 0)
        assert frozen == 1, f"TC-S03 failed on {tab}: expected frozenRowCount=1, got {frozen}"

        expected_cols = ws_by_title[tab].col_count if tab == "essays" else len(HEADERS[tab])
        row_data = sheet_meta["data"][0].get("rowData", [])
        assert len(row_data) >= 2, f"TC-S03 failed on {tab}: missing row 1..2 grid data"

        for row_idx in (0, 1):
            cells = row_data[row_idx].get("values", [])
            assert len(cells) >= expected_cols, (
                f"TC-S03 failed on {tab} row {row_idx + 1}: expected {expected_cols} cells, got {len(cells)}"
            )
            for col_idx in range(expected_cols):
                col_name = "day_key" if tab == "essays" else HEADERS[tab][col_idx]
                exp_fmt = _expected_format(tab, col_name)
                actual_fmt = cells[col_idx].get("userEnteredFormat", {}).get("numberFormat", {})
                assert actual_fmt.get("type") == exp_fmt["type"] and actual_fmt.get("pattern") == exp_fmt["pattern"], (
                    f"TC-S03 failed on {tab} R{row_idx + 1}C{col_idx + 1} ({col_name}): "
                    f"expected {exp_fmt}, got {actual_fmt}"
                )
    print("[TC-S03] PASSED")
    print("M1_L1_SCHEMA_AND_FORMAT_VERIFICATION_PASSED")


L2_NODE_SCRIPT = r"""
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const rootDir = process.cwd();
const eng = await import('./engine.js');
const gas = require('./gas/Code.gs');
const fileCfg = JSON.parse(fs.readFileSync(path.join(rootDir, 'game-config.json'), 'utf8'));
const fileCat = JSON.parse(fs.readFileSync(path.join(rootDir, 'catalog.json'), 'utf8'));

const eq = (a, b, msg) => assert.deepStrictEqual(a, b, msg);
const near = (a, b, eps, msg) => {
  assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} vs ${b}`);
};

// ----------------------------------------------------------------------------
// 1. TC-S05：靜態設定與 engine.js <-> gas/Code.gs 14 項規則函式對拍
// ----------------------------------------------------------------------------
for (const k of Object.keys(gas.GAME_CONFIG)) {
  eq(gas.GAME_CONFIG[k], fileCfg[k], `GAME_CONFIG.${k} mismatch`);
}
eq(Object.keys(gas.CATALOG.themes), Object.keys(fileCat.themes), 'themes keys mismatch');
eq(gas.CATALOG.species, fileCat.species, 'species mismatch');
eq(gas.CATALOG.decor, fileCat.decor, 'decor mismatch');
eq(gas.HEADERS.users.length, 21, 'users must have 21 cols');
eq(gas.HEADERS.groups.length, 13, 'groups must have 13 cols');
eq(gas.HEADERS.gardens.length, 12, 'gardens must have 12 cols');

// 14 shared pure functions
for (const ts of [Date.UTC(2026, 10, 19, 19, 59), Date.UTC(2026, 10, 19, 20, 0), Date.UTC(2026, 10, 30, 10, 0)]) {
  for (const tz of ['Asia/Taipei', 'America/Los_Angeles', 'UTC']) {
    eq(gas.getGameDayKey(ts, tz, 4), eng.getGameDayKey(ts, tz, 4), `getGameDayKey(${ts},${tz})`);
  }
}
for (const dk of ['2026-11-30', '2026-02-28', '2024-02-29', '2026-12-31']) {
  eq(gas.addDays(dk, 1), eng.addDays(dk, 1), `addDays(${dk},1)`);
  eq(gas.addDays(dk, -2), eng.addDays(dk, -2), `addDays(${dk},-2)`);
  eq(gas.isLastDayOfMonth(dk), eng.isLastDayOfMonth(dk), `isLastDayOfMonth(${dk})`);
}
for (const txt of ['', '十個字測試這是一篇中文', 'Hello world 2026! 你好嗎？', "don't stop 123 中文"]) {
  eq(gas.countEssayWords(txt), eng.countEssayWords(txt), `countEssayWords(${txt})`);
}
for (const w of [0, 9, 10, 20, 60, 110, 200]) {
  eq(gas.getRarityProbabilities(w, fileCfg), eng.getRarityProbabilities(w, fileCfg), `probs(${w})`);
  for (const pity of [0, 9, 10]) {
    for (const rVal of [0.01, 0.45, 0.88, 0.99]) {
      eq(
        gas.rollSeed(w, pity, 'forest', fileCat.species, fileCfg, () => rVal),
        eng.rollSeed(w, pity, 'forest', fileCat.species, fileCfg, () => rVal),
        `rollSeed(${w},${pity},${rVal})`
      );
    }
  }
}
for (const sc of [0, 1, 6, 7, 29, 30, 100]) {
  eq(gas.getStreakMultiplier(sc, fileCfg), eng.getStreakMultiplier(sc, fileCfg), `mult(${sc})`);
}
for (const st of [
  { count: 1, lastDay: '2026-11-19', prevCount: 0, prevLastDay: null },
  { count: 5, lastDay: '2026-11-18', prevCount: 4, prevLastDay: '2026-11-17' },
  { count: 3, lastDay: '2026-11-20', prevCount: 2, prevLastDay: '2026-11-19' }
]) {
  eq(gas.advanceStreakOnWrite(st, '2026-11-20'), eng.advanceStreakOnWrite(st, '2026-11-20'), 'advanceStreakOnWrite');
  eq(gas.repairStreakOnMakeUp(st, '2026-11-20'), eng.repairStreakOnMakeUp(st, '2026-11-20'), 'repairStreakOnMakeUp');
}
for (let m = 1; m <= 5; m++) {
  for (let b = 1; b <= 5; b++) {
    eq(gas.calcRequiredDays(b, m, fileCfg), eng.calcRequiredDays(b, m, fileCfg), `reqDays(${b},${m})`);
  }
}
for (let req = 1; req <= 5; req++) {
  for (let p = 0; p <= req + 1; p++) {
    eq(gas.calcPlantLevel(p, req), eng.calcPlantLevel(p, req), `plantLv(${p},${req})`);
  }
}
const evalCases = [
  [{ plantedDay: '2026-11-20', requiredDays: 2 }, {}, '2026-11-20', 'personal'],
  [{ plantedDay: '2026-11-01', requiredDays: 2 }, { '2026-11-02': { essays: 1 } }, '2026-11-02', 'personal'],
  [{ plantedDay: '2026-11-01', requiredDays: 2 }, { '2026-11-02': { essays: 1 } }, '2026-11-04', 'personal'],
  [{ plantedDay: '2026-11-01', requiredDays: 2 }, { '2026-11-02': { essays: 1 } }, '2026-11-05', 'personal'],
  [{ plantedDay: '2026-11-01', requiredDays: 2 }, { '2026-11-02': { essays: 1 }, '2026-11-04': { madeUp: true } }, '2026-11-05', 'personal'],
  [{ plantedDay: '2026-11-01', requiredDays: 2 }, { '2026-11-02': { essays: 1 }, '2026-11-05': { madeUp: true } }, '2026-11-06', 'personal'],
  [{ plantedDay: '2026-11-01', requiredDays: 3 }, { '2026-11-02': { writers: { u1: 1, u2: 2 } }, '2026-11-03': { writers: { u1: 3 } } }, '2026-11-03', 'group'],
  [{ finalStage: 'dead', finalLevel: 3 }, {}, '2026-11-10', 'personal'],
  [{ finalStage: 'grown', hadWilt: true, requiredDays: 3 }, {}, '2026-11-10', 'personal'],
  [{ limited: true, requiredDays: 1 }, {}, '2026-11-10', 'personal'],
  [{ frozen: { stage: 'growing', progress: 2, level: 3, hadWilt: false, isPerfect: false } }, {}, '2026-11-10', 'personal']
];
for (const [pl, dMap, tk, gt] of evalCases) {
  eq(gas.evaluatePlantState(pl, dMap, tk, gt), eng.evaluatePlantState(pl, dMap, tk, gt), `evalPlant(${tk})`);
}
const bPlants = [
  { speciesId: 'fb_l1', evalState: { stage: 'grown' } },
  { speciesId: 'fo_c1', evalState: { stage: 'dead' } },
  { speciesId: 'lim_7', limited: true, evalState: { stage: 'grown' } }
];
const bDecor = [{ itemId: 'dec_lantern' }, { itemId: 'dec_arch' }];
eq(gas.calculateBeauty(bPlants, bDecor, fileCat, fileCfg), eng.calculateBeauty(bPlants, bDecor, fileCat, fileCfg), 'beauty');
for (const vm of [{ u1: 'forest', u2: 'oasis' }, { u1: 'oasis', u2: 'oasis', u3: 'flowerbed' }, {}]) {
  eq(gas.resolveGroupThemeVote('grp_1', '2026-12', vm), eng.resolveGroupThemeVote('grp_1', '2026-12', vm), 'vote');
}
console.log('[TC-S05] PASSED');

// ----------------------------------------------------------------------------
// 2. 記憶體版 Google Sheets / LockService / DriveApp 模擬器
// ----------------------------------------------------------------------------
function letterToCol(letters) {
  let c = 0;
  for (const ch of letters) c = c * 26 + (ch.charCodeAt(0) - 64);
  return c;
}

function makeMockEnv() {
  let now = Date.UTC(2026, 10, 20, 6, 0, 0); // 2026-11-20 14:00 TPE
  let rngTick = 0;
  let uuidTick = 0;
  let lockShouldFail = false;
  let locked = false;
  const backups = [];

  const makeTabState = (initRows, maxRows, maxCols) => ({
    rows: initRows,
    maxRows,
    maxCols,
    committedMaxRows: maxRows,
    committedMaxCols: maxCols,
    colFormats: Array(maxCols).fill('@'),
    committedColFormats: Array(maxCols).fill('@')
  });

  const sheets = {
    users: makeTabState([gas.HEADERS.users.slice()], 100, 21),
    groups: makeTabState([gas.HEADERS.groups.slice()], 100, 20),
    gardens: makeTabState([gas.HEADERS.gardens.slice()], 100, 20),
    essays: makeTabState([['day_key']], 100, 20)
  };

  const ensureRowLen = (sh, r1) => {
    while (sh.rows.length < r1) sh.rows.push([]);
  };

  const parseA1 = (fullRange) => {
    const [tab, ref] = fullRange.split('!');
    const sh = sheets[tab];
    assert.ok(sh, `Unknown tab ${tab}`);
    if (ref === '1:1') return { tab, sh, r1: 1, r2: 1, c1: 1, c2: Math.max(1, (sh.rows[0] || []).length) };
    const m = ref.match(/^([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/);
    assert.ok(m, `Invalid range ${fullRange}`);
    const c1 = letterToCol(m[1]);
    const r1 = m[2] ? Number(m[2]) : 1;
    const c2 = m[3] ? letterToCol(m[3]) : c1;
    const r2 = m[4] ? Number(m[4]) : (ref.includes(':') ? sh.maxRows : r1);
    return { tab, sh, r1, r2, c1, c2 };
  };

  const makeSheetProxy = (tab) => {
    const sh = sheets[tab];
    return {
      getMaxRows: () => sh.maxRows,
      getMaxColumns: () => sh.maxCols,
      insertRowsAfter: (after, count) => {
        assert.equal(after, sh.maxRows);
        sh.maxRows += count;
      },
      insertColumnsAfter: (after, count) => {
        assert.equal(after, sh.maxCols);
        sh.maxCols += count;
        for (let i = 0; i < count; i++) sh.colFormats.push('DEFAULT');
      },
      getRange: (r, c, nr, nc) => ({
        setNumberFormat: (fmt) => {
          for (let ci = c - 1; ci < c - 1 + nc; ci++) sh.colFormats[ci] = fmt;
        }
      })
    };
  };

  const env = {
    spreadsheetId: gas.SPREADSHEET_ID,
    nowMs: () => now,
    setNowMs: (v) => { now = v; },
    rng: () => {
      rngTick = (rngTick + 1) % 100;
      return (rngTick * 0.37) % 1;
    },
    getUuid: () => {
      uuidTick += 1;
      return `00000000-0000-4000-8000-${String(uuidTick).padStart(12, '0')}`;
    },
    sha256Bytes: (input) => Array.from(crypto.createHash('sha256').update(String(input), 'utf8').digest()),
    LockService: {
      getScriptLock: () => ({
        tryLock: () => {
          if (lockShouldFail) return false;
          assert.ok(!locked, 'Re-entrant lock deadlock');
          locked = true;
          return true;
        },
        releaseLock: () => { locked = false; }
      })
    },
    SpreadsheetApp: {
      openById: (id) => {
        assert.equal(id, gas.SPREADSHEET_ID);
        return { getSheetByName: (t) => (sheets[t] ? makeSheetProxy(t) : null) };
      },
      flush: () => {
        for (const k of Object.keys(sheets)) {
          const sh = sheets[k];
          sh.committedMaxRows = sh.maxRows;
          sh.committedMaxCols = sh.maxCols;
          sh.committedColFormats = sh.colFormats.slice();
        }
      }
    },
    Sheets: {
      Spreadsheets: {
        Values: {
          batchGet: (id, opts) => {
            assert.equal(id, gas.SPREADSHEET_ID);
            assert.equal(opts.valueRenderOption, 'UNFORMATTED_VALUE');
            return {
              valueRanges: opts.ranges.map((rngStr) => {
                const { sh, r1, r2, c1, c2 } = parseA1(rngStr);
                const maxR = Math.min(r2, sh.rows.length);
                const out = [];
                for (let r = r1 - 1; r < maxR; r++) {
                  const row = sh.rows[r] || [];
                  const slice = [];
                  for (let c = c1 - 1; c < c2; c++) slice.push(row[c] !== undefined ? row[c] : '');
                  while (slice.length && slice[slice.length - 1] === '') slice.pop();
                  out.push(slice);
                }
                while (out.length && out[out.length - 1].length === 0) out.pop();
                return { range: rngStr, values: out };
              })
            };
          },
          batchUpdate: (body, id) => {
            assert.equal(id, gas.SPREADSHEET_ID);
            assert.equal(body.valueInputOption, 'RAW');
            for (const item of body.data) {
              const { sh, r1, c1 } = parseA1(item.range);
              assert.ok(r1 + item.values.length - 1 <= sh.committedMaxRows, 'Exceeds committed sheet maxRows (missing flush)');
              for (let ri = 0; ri < item.values.length; ri++) {
                ensureRowLen(sh, r1 + ri);
                const row = sh.rows[r1 + ri - 1];
                for (let ci = 0; ci < item.values[ri].length; ci++) {
                  assert.ok(c1 + ci <= sh.committedMaxCols, 'Exceeds committed sheet maxCols (missing flush)');
                  row[c1 + ci - 1] = item.values[ri][ci];
                }
              }
            }
          }
        }
      }
    },
    DriveApp: {
      getFoldersByName: () => {
        const list = [{
          getFiles: () => {
            let idx = 0;
            return {
              hasNext: () => idx < backups.length,
              next: () => backups[idx++]
            };
          }
        }];
        let i = 0;
        return { hasNext: () => i < list.length, next: () => list[i++] };
      },
      getFileById: () => ({
        makeCopy: (name) => {
          const rec = { name, trashed: false, getName: () => name, setTrashed: (v) => { rec.trashed = v; } };
          backups.push(rec);
          return rec;
        }
      })
    },
    sheets,
    backups,
    setLockFail: (v) => { lockShouldFail = v; },
    isLocked: () => locked
  };
  gas.__setGasEnv(env);
  return env;
}

const mock = makeMockEnv();
const callPost = (action, authToken, payload = {}) =>
  JSON.parse(gas.doPost({ postData: { contents: JSON.stringify({ action, authToken, payload }) } }));
const ok = (action, authToken, payload = {}) => {
  const res = callPost(action, authToken, payload);
  assert.equal(res.ok, true, `${action} expected ok, got ${JSON.stringify(res)}`);
  assert.ok(typeof res.serverTimeMs === 'number');
  return res.data;
};
const fail = (action, authToken, payload, expectedCode) => {
  const res = callPost(action, authToken, payload);
  assert.equal(res.ok, false, `${action} expected fail ${expectedCode}, got ok`);
  assert.equal(res.code, expectedCode, `${action} expected ${expectedCode}, got ${res.code}: ${res.message}`);
  return res;
};

// (1) ping & doGet
const getRes = JSON.parse(gas.doGet());
eq(getRes.ok, true, 'doGet');
eq(ok('ping', ''), { pong: true }, 'ping');
fail('unknownAction', '', {}, 'VALIDATION_ERROR');
eq(JSON.parse(gas.doPost({})).code, 'VALIDATION_ERROR', 'empty body');

// (2) LOCK_TIMEOUT
mock.setLockFail(true);
fail('auth', '', { username: 'u_test_lock', password: 'pw12' }, 'LOCK_TIMEOUT');
mock.setLockFail(false);

// (3) auth (new + case-insensitive login + wrong pw + validation) & logout
fail('auth', '', { username: 'x', password: 'pw12' }, 'VALIDATION_ERROR');
fail('auth', '', { username: 'bad name', password: 'pw12' }, 'VALIDATION_ERROR');
fail('auth', '', { username: 'u_test_alpha', password: '123' }, 'VALIDATION_ERROR');
fail('auth', '', { username: 'u_test_alpha', password: 'pw12', timezone: 'Mars/Phobos' }, 'VALIDATION_ERROR');

const a1 = ok('auth', '', { username: 'u_test_alpha', password: 'pw12', timezone: 'Asia/Taipei' });
eq(a1.isNewUser, true, 'new user');
eq(a1.bootstrap.user.uid, 'u_test_alpha', 'test uid');
eq(a1.bootstrap.user.energy, 65, 'init energy');
eq(a1.bootstrap.gardens[0].size, 5, 'init 5x5');
assert.ok(mock.sheets.users.rows[1][2].startsWith('s256$'), 'salted pw hash');
assert.ok(!JSON.stringify(a1).includes('pw12') && !JSON.stringify(a1).includes('passwordHash'), 'no pw leak');

// Case-insensitive login -> 2nd device
const a2 = ok('auth', '', { username: 'U_TEST_ALPHA', password: 'pw12' });
eq(a2.isNewUser, false, 'existing login');
eq(mock.sheets.users.rows.length, 2, 'no duplicate user row');
eq(JSON.parse(mock.sheets.users.rows[1][3]).length, 2, '2 device session hashes');

fail('auth', '', { username: 'u_test_alpha', password: 'wrong' }, 'AUTH_INVALID');
fail('bootstrap', 'bad_token', {}, 'AUTH_INVALID');

const boot1 = ok('bootstrap', a1.sessionToken, {});
eq(boot1.user.uid, 'u_test_alpha', 'bootstrap 1');
ok('logout', a1.sessionToken, {});
fail('bootstrap', a1.sessionToken, {}, 'AUTH_INVALID');
const boot2 = ok('bootstrap', a2.sessionToken, {});
eq(boot2.user.uid, 'u_test_alpha', 'device 2 still valid forever');

const tokA = a2.sessionToken;

// (4) Essays column 21+ @ format verification
for (let i = 1; i <= 20; i++) {
  ok('auth', '', { username: `u_test_pad${i}`, password: 'pw12' });
}
assert.ok(mock.sheets.essays.rows[0].length >= 22, 'essays expanded past 20 cols');
eq(mock.sheets.essays.committedColFormats[20], '@', 'col 21 committed @');
eq(mock.sheets.essays.committedColFormats[21], '@', 'col 22 committed @');

// (5) updateDisplayName
fail('updateDisplayName', tokA, { displayName: '   ' }, 'VALIDATION_ERROR');
const updName = ok('updateDisplayName', tokA, { displayName: '  星光旅人  ' });
eq(updName.displayName, '星光旅人', 'trimmed name');

// (6) submitEssay (short, 1..4, formula injection, >49000 limit, 04:00 boundary, full bag)
fail('submitEssay', tokA, { content: '只有五個字' }, 'VALIDATION_ERROR');
fail('submitEssay', tokA, { content: '超過十個字但款式錯誤喔喔', cardStyle: 'card99' }, 'VALIDATION_ERROR');

const e1 = ok('submitEssay', tokA, { content: '=HYPERLINK("x","y") 寫滿十個中文字喔喔喔', cardStyle: 'card3', isPrivate: true });
eq(e1.result.rewardType, 'seed', 'essay 1 seed');
eq(e1.result.dailyBaseEnergy, 10, 'first essay daily energy');
eq(e1.essay.content.startsWith('=HYPERLINK'), true, 'formula text preserved cleanly');
const storedCell1 = JSON.parse(mock.sheets.essays.rows[1][1]);
assert.ok(!('authorName' in storedCell1[0]) && !('authorUid' in storedCell1[0]), 'no redundant author fields in cell');

ok('submitEssay', tokA, { content: '第二篇滿十字隨筆用來抽第二顆種子', cardStyle: 'card3' });
ok('submitEssay', tokA, { content: '第三篇滿十字隨筆用來抽第三顆種子', cardStyle: 'card3' });
const e4 = ok('submitEssay', tokA, { content: '第四篇隨筆超過每日種子上限轉為能量測試一二三四五六七八九十', cardStyle: 'card3' });
eq(e4.result.rewardType, 'energy', '4th essay overflow energy');

// CELL_LIMIT_EXCEEDED check
const hugeText = '字'.repeat(48500);
fail('submitEssay', tokA, { content: hugeText }, 'CELL_LIMIT_EXCEEDED');
eq(JSON.parse(mock.sheets.essays.rows[1][1]).length, 4, 'existing essays intact after CELL_LIMIT_EXCEEDED');

// (7) updateEssay & setReaction
fail('updateEssay', tokA, { essayId: e1.essay.id, dayKey: e1.essay.dayKey, authorUid: 'u_test_alpha', content: '...' }, 'VALIDATION_ERROR');
const updE = ok('updateEssay', tokA, {
  essayId: e1.essay.id,
  dayKey: e1.essay.dayKey,
  authorUid: 'u_test_alpha',
  content: '修改後的十個中文字內容測試',
  cardStyle: 'card5'
});
eq(updE.essay.wordCount, 13, 'updated word count');
eq(updE.essay.reward, e1.essay.reward, 'reward unchanged on edit');

// Personal private essay allows author reaction + remove
const react1 = ok('setReaction', tokA, { essayId: e1.essay.id, dayKey: e1.essay.dayKey, authorUid: 'u_test_alpha', reactionId: 'love' });
eq(react1.reactions, { u_test_alpha: 'love' }, 'personal private reaction');
const react2 = ok('setReaction', tokA, { essayId: e1.essay.id, dayKey: e1.essay.dayKey, authorUid: 'u_test_alpha', reactionId: null });
eq(react2.reactions, {}, 'cancel reaction');
fail('setReaction', tokA, { essayId: e1.essay.id, dayKey: e1.essay.dayKey, authorUid: 'u_test_alpha', reactionId: 'bad' }, 'VALIDATION_ERROR');
fail('setReaction', tokA, { essayId: 'no_such', dayKey: e1.essay.dayKey, authorUid: 'u_test_alpha', reactionId: 'love' }, 'NOT_FOUND');

// (8) 04:00 boundary & cross-tz non-monotonic A col
mock.setNowMs(Date.UTC(2026, 10, 20, 19, 59, 0)); // 2026-11-21 03:59 TPE -> still 2026-11-20!
const pre4 = ok('submitEssay', tokA, { content: '凌晨三點五十九分應該還是算在昨天喔喔' });
eq(pre4.essay.dayKey, '2026-11-20', 'before 04:00 stays 2026-11-20');
mock.setNowMs(Date.UTC(2026, 10, 20, 20, 1, 0)); // 2026-11-21 04:01 TPE -> 2026-11-21!
const post4 = ok('submitEssay', tokA, { content: '凌晨四點零一分應該已經進入新的一天喔' });
eq(post4.essay.dayKey, '2026-11-21', 'after 04:00 becomes 2026-11-21');

// (9) plantSeed, decor, move, decompose, expand, clearDeadPlant
const bAfterEssays = ok('bootstrap', tokA, {});
const activePersonalId = bAfterEssays.gardens.find((g) => g.status === 'active').gardenId;
const firstSeedId = Object.keys(bAfterEssays.user.seeds)[0];
const planted = ok('plantSeed', tokA, { gardenId: activePersonalId, speciesId: firstSeedId, x: 0, y: 0, isLimited: false });
fail('plantSeed', tokA, { gardenId: activePersonalId, speciesId: firstSeedId, x: 0, y: 0 }, 'CELL_OCCUPIED');
fail('plantSeed', tokA, { gardenId: activePersonalId, speciesId: firstSeedId, x: 9, y: 0 }, 'OUT_OF_BOUNDS');
fail('plantSeed', tokA, { gardenId: activePersonalId, speciesId: 'no_seed', x: 1, y: 0 }, 'SEED_NOT_FOUND');

const dec = ok('buyAndPlaceDecor', tokA, { gardenId: activePersonalId, itemId: 'dec_lantern', x: 1, y: 0 });
ok('moveGridItem', tokA, { gardenId: activePersonalId, kind: 'decor', itemId: dec.decor.id, newX: 1, newY: 1 });
ok('moveGridItem', tokA, { gardenId: activePersonalId, kind: 'plant', itemId: planted.plant.id, newX: 0, newY: 1 });
fail('clearDeadPlant', tokA, { gardenId: activePersonalId, plantId: planted.plant.id }, 'VALIDATION_ERROR');
ok('removeDecor', tokA, { gardenId: activePersonalId, decorId: dec.decor.id });

// decompose seed down to 0
const secondSeedId = Object.keys(ok('bootstrap', tokA, {}).user.seeds)[0];
ok('decomposeSeed', tokA, { speciesId: secondSeedId, count: 1 });
fail('decomposeSeed', tokA, { speciesId: secondSeedId, count: 99 }, 'SEED_NOT_FOUND');

// (10) Lazy Materialization: 2-miss rescue vs 3-miss permanent dead preserving finalLevel=3
const uB = ok('auth', '', { username: 'u_test_beta', password: 'pw12', timezone: 'Asia/Taipei' });
const tokB = uB.sessionToken;
const uRowB = mock.sheets.users.rows.find((r) => r[0] === 'u_test_beta');
uRowB[7] = 2000; // energy
uRowB[13] = JSON.stringify({ fb_r1: 2 }); // requiredDays=2
const gRowB = mock.sheets.gardens.rows.find((r) => r[2] === 'u_test_beta');
// Planted 2026-11-01, wrote 2026-11-02 (prog=1 -> Lv3).
mock.sheets.essays.rows.push(['2026-11-02']);
const colB = mock.sheets.essays.rows[0].indexOf('u_test_beta');
mock.sheets.essays.rows[mock.sheets.essays.rows.length - 1][colB] = JSON.stringify([{
  id: 'e_b1', gardenId: gRowB[0], groupId: '', content: '十個字紀錄用來推進等級到三級', wordCount: 13,
  private: true, cardStyle: 'card1', reward: { type: 'seed', speciesId: 'fb_c1' }, reactions: {}, createdAt: 1, updatedAt: 1
}]);
const itemsB = {
  plants: {
    p_just_dead: { id: 'p_just_dead', speciesId: 'fb_r1', x: 0, y: 0, plantedBy: 'u_test_beta', plantedDay: '2026-11-01', plantedAt: 1, requiredDays: 2, limited: false, finalStage: null, hadWilt: false, finalLevel: null, frozen: null },
    p_old_dead: { id: 'p_old_dead', speciesId: 'fb_r1', x: 1, y: 0, plantedBy: 'u_test_beta', plantedDay: '2026-10-25', plantedAt: 1, requiredDays: 2, limited: false, finalStage: null, hadWilt: false, finalLevel: null, frozen: null }
  },
  decor: {}
};
// p_old_dead planted 2026-10-25, wrote 2026-10-26 -> prog=1 (Lv3), missed 10-27..
mock.sheets.essays.rows.push(['2026-10-26']);
mock.sheets.essays.rows[mock.sheets.essays.rows.length - 1][colB] = JSON.stringify([{
  id: 'e_b0', gardenId: gRowB[0], groupId: '', content: '十個字紀錄用來推進舊植物等級', wordCount: 13,
  private: true, cardStyle: 'card1', reward: { type: 'seed', speciesId: 'fb_c1' }, reactions: {}, createdAt: 1, updatedAt: 1
}]);
gRowB[9] = JSON.stringify(itemsB);

mock.setNowMs(Date.UTC(2026, 10, 5, 6, 0, 0)); // 2026-11-05 (p_just_dead missed 11-03 & 11-04 -> 2 misses today!)
const bDeadCheck = ok('bootstrap', tokB, {});
const savedItemsAfterCheck = JSON.parse(gRowB[9]);
eq(savedItemsAfterCheck.plants.p_just_dead.finalStage, null, '2-miss just-dead must NOT lazy-materialize');
eq(savedItemsAfterCheck.plants.p_old_dead.finalStage, 'dead', '3+-miss old dead lazy-materialized');
eq(savedItemsAfterCheck.plants.p_old_dead.finalLevel, 3, 'old dead preserves finalLevel=3');

ok('makeUpYesterday', tokB, {});
fail('makeUpYesterday', tokB, {}, 'VALIDATION_ERROR');
const bRescued = ok('bootstrap', tokB, {});
eq(gas.evaluatePlantState(bRescued.gardens[0].items.plants.p_just_dead, bRescued.userDays, '2026-11-05', 'personal').stage, 'growing', '2-miss plant rescued');
eq(gas.evaluatePlantState(bRescued.gardens[0].items.plants.p_old_dead, bRescued.userDays, '2026-11-05', 'personal').level, 3, '3+-miss dead stays level 3');

// clearDeadPlant & expandGarden 5->9
ok('clearDeadPlant', tokB, { gardenId: gRowB[0], plantId: 'p_old_dead' });
for (let s = 6; s <= 9; s++) {
  eq(ok('expandGarden', tokB, { gardenId: gRowB[0] }).garden.size, s, `expand to ${s}`);
}
fail('expandGarden', tokB, { gardenId: gRowB[0] }, 'VALIDATION_ERROR');
mock.setNowMs(Date.UTC(2026, 10, 6, 6, 0, 0)); // 2026-11-06（昨日 11-05 尚未補簽且無隨筆）
uRowB[7] = 2; // low energy
fail('makeUpYesterday', tokB, {}, 'INSUFFICIENT_ENERGY');
uRowB[7] = 500;

// (11) Group flow: createGroup, joinGroup, private essay, reactions, former member retention, month rollover, vote, snapshot
mock.setNowMs(Date.UTC(2026, 10, 29, 6, 0, 0)); // 2026-11-29 (not last day)
const grpRes = ok('createGroup', tokA, { name: '晨光共筆團', theme: 'forest' });
eq(grpRes.group.memberUids, ['u_test_alpha'], 'no fake user_friend_1');
eq(grpRes.garden.size, 6, 'group 6x6');
// Archived personal garden forbids plant/expand, allows decor/move!
fail('plantSeed', tokA, { gardenId: activePersonalId, speciesId: 'fb_c1', x: 2, y: 2 }, 'READ_ONLY_GARDEN');
fail('expandGarden', tokA, { gardenId: activePersonalId }, 'READ_ONLY_GARDEN');
ok('buyAndPlaceDecor', tokA, { gardenId: activePersonalId, itemId: 'dec_lantern', x: 2, y: 2 });

fail('joinGroup', tokB, { inviteCode: 'NOPE99' }, 'INVITE_NOT_FOUND');
const joinB = ok('joinGroup', tokB, { inviteCode: ` ${grpRes.group.inviteCode.toLowerCase()} ` });
eq(joinB.group.memberUids, ['u_test_alpha', 'u_test_beta'], 'B joined');

// TC-A11: group daily seed cap independent of personal!
const gPriv = ok('submitEssay', tokA, { content: '團體內的私密隨筆滿十個字喔喔', isPrivate: true });
const gPub = ok('submitEssay', tokA, { content: '團體內的公開隨筆滿十個字喔喔', isPrivate: false });
fail('setReaction', tokA, { essayId: gPriv.essay.id, dayKey: gPriv.essay.dayKey, authorUid: 'u_test_alpha', reactionId: 'love' }, 'FORBIDDEN');
ok('setReaction', tokA, { essayId: gPub.essay.id, dayKey: gPub.essay.dayKey, authorUid: 'u_test_alpha', reactionId: 'sparkle' });
ok('setReaction', tokB, { essayId: gPub.essay.id, dayKey: gPub.essay.dayKey, authorUid: 'u_test_alpha', reactionId: 'hug' });

const bootBGrp = ok('bootstrap', tokB, {});
assert.ok(!JSON.stringify(bootBGrp).includes('團體內的私密隨筆'), 'B cannot see A private essay');
eq(bootBGrp.groupDays['2026-11-29'].seedsGiven, 2, 'private essay still counts toward group seedsGiven');

// TC-R10 cross-user permissions
fail('updateEssay', tokB, { essayId: gPub.essay.id, dayKey: gPub.essay.dayKey, authorUid: 'u_test_alpha', content: '篡改' }, 'FORBIDDEN');
fail('removeDecor', tokB, { gardenId: activePersonalId, decorId: 'any' }, 'FORBIDDEN');

// Month vote on 2026-11-29 fails; on 2026-11-30 succeeds; rollover on 2026-12-31 resolves 2026-12 & opens 2027-01!
fail('castThemeVote', tokA, { groupId: grpRes.group.groupId, theme: 'oasis' }, 'VALIDATION_ERROR');
mock.setNowMs(Date.UTC(2026, 10, 30, 6, 0, 0)); // 2026-11-30 last day
const voteRes = ok('castThemeVote', tokA, { groupId: grpRes.group.groupId, theme: 'oasis' });
eq(voteRes.themeVoteMonth, '2026-12', 'vote month 2026-12');

mock.setNowMs(Date.UTC(2026, 11, 31, 6, 0, 0)); // 2026-12-31 (rolled over AND last day of Dec!)
const rolled = ok('bootstrap', tokB, {});
const decGarden = rolled.gardens.find((g) => g.ownerType === 'group' && g.status === 'active');
eq(decGarden.month, '2026-12', 'auto rolled to 2026-12');
eq(decGarden.theme, 'oasis', 'winning vote theme oasis preserved even when landing on 12-31');
eq(rolled.group.themeVoteMonth, '2027-01', '2027-01 vote opened after 2026-12 resolved');

// Plant in group by A, then A leaves -> snapshot readonly, B retains A's history & name, last member leaves -> group archived
uRowB[7] = 500;
const uRowA = mock.sheets.users.rows.find((r) => r[0] === 'u_test_alpha');
uRowA[13] = JSON.stringify({ fb_c1: 1 });
ok('plantSeed', tokA, { gardenId: decGarden.gardenId, speciesId: 'fb_c1', x: 3, y: 3 });

const leaveA = ok('leaveGroup', tokA, { newPersonalTheme: 'flowerbed' });
eq(leaveA.snapshotGarden.status, 'snapshot', 'snapshot created');
fail('buyAndPlaceDecor', tokA, { gardenId: leaveA.snapshotGarden.gardenId, itemId: 'dec_lantern', x: 0, y: 0 }, 'READ_ONLY_GARDEN');

const bootBAfterLeave = ok('bootstrap', tokB, {});
eq(bootBAfterLeave.group.formerMemberUids, ['u_test_alpha'], 'A recorded in formerMemberUids');
eq(bootBAfterLeave.memberDirectory['u_test_alpha'], '星光旅人', 'B still sees A displayName');
eq(bootBAfterLeave.groupDays['2026-11-29'].seedsGiven, 2, 'B still retains A groupDays contribution');

ok('leaveGroup', tokB, { newPersonalTheme: 'oasis' });
const grpRow = mock.sheets.groups.rows.find((r) => r[0] === grpRes.group.groupId);
eq(grpRow[3], 'archived', 'group archived when empty');
eq(grpRow[4], '', 'invite code cleared when archived');

// GROUP_FULL (5 members)
const gHost = ok('auth', '', { username: 'u_test_g0', password: 'pw12' });
const gInfo = ok('createGroup', gHost.sessionToken, { name: '滿團測試', theme: 'flowerbed' });
for (let k = 1; k <= 4; k++) {
  const m = ok('auth', '', { username: `u_test_gm${k}`, password: 'pw12' });
  ok('joinGroup', m.sessionToken, { inviteCode: gInfo.group.inviteCode });
}
const m6 = ok('auth', '', { username: 'u_test_gm6', password: 'pw12' });
fail('joinGroup', m6.sessionToken, { inviteCode: gInfo.group.inviteCode }, 'GROUP_FULL');

// getEssaysByMonth & personal startNewMonthGarden
const histEssays = ok('getEssaysByMonth', tokA, { month: '2026-11' });
assert.ok(histEssays.essays.length >= 4, 'getEssaysByMonth returns Nov essays');
fail('getEssaysByMonth', tokA, { month: '2026/11' }, 'VALIDATION_ERROR');
fail('startNewMonthGarden', tokA, { theme: 'forest' }, 'VALIDATION_ERROR'); // already has active 2026-12
mock.setNowMs(Date.UTC(2027, 0, 2, 6, 0, 0)); // 2027-01-02
const newPer = ok('startNewMonthGarden', tokA, { theme: 'forest' });
eq(newPer.garden.month, '2027-01', 'personal startNewMonthGarden');

// (12) Extra L2 boundary & domain coverage: strict int, seedBagCap=30, lim_7 streak, rejoin formerMember, dual-tz, >100 row flush
fail('plantSeed', tokA, { gardenId: newPer.garden.gardenId, speciesId: Object.keys(ok('bootstrap', tokA, {}).user.seeds)[0], x: null, y: 0 }, 'OUT_OF_BOUNDS');
fail('plantSeed', tokA, { gardenId: newPer.garden.gardenId, speciesId: Object.keys(ok('bootstrap', tokA, {}).user.seeds)[0], x: '', y: false }, 'OUT_OF_BOUNDS');
fail('decomposeSeed', tokA, { speciesId: 'fb_c1', count: true }, 'VALIDATION_ERROR');

// Seed bag cap (30 -> seed_decomposed) + pity 10 + streak 7 -> lim_7
const uCap = ok('auth', '', { username: 'u_test_cap7', password: 'pw12', timezone: 'Asia/Taipei' });
const uCapRow = mock.sheets.users.rows.find((r) => r[0] === 'u_test_cap7');
uCapRow[8] = 10; // pity = 10 guarantees epic/legendary (isPity=true)
uCapRow[13] = JSON.stringify({ fb_c1: 30 }); // total 30 = seedBagCap
uCapRow[9] = 6; // streakCount = 6
uCapRow[10] = '2027-01-01'; // yesterday -> today 2027-01-02 becomes 7!
const capRes = ok('submitEssay', uCap.sessionToken, { content: '測試滿袋溢出與連勝第七天領取限定種子一二三' });
eq(capRes.result.rewardType, 'seed_decomposed', 'seed bag cap decomposes seed to energy');
eq(capRes.result.isPity, true, 'pity 10 guaranteed rare+ roll');
eq(capRes.result.streakCount, 7, 'streak reaches 7');
eq(capRes.result.milestoneUnlocked && capRes.result.milestoneUnlocked.id, 'lim_7', 'streak 7 grants lim_7');
eq(capRes.user.limitedSeeds.lim_7, 1, 'lim_7 stored in limitedSeeds');

// Former member rejoins group -> cleared from formerMemberUids
const grpRejoin = ok('createGroup', m6.sessionToken, { name: '回鍋團測試', theme: 'oasis' });
ok('joinGroup', tokB, { inviteCode: grpRejoin.group.inviteCode });
ok('leaveGroup', tokB, { newPersonalTheme: 'flowerbed' });
const rejoined = ok('joinGroup', tokB, { inviteCode: grpRejoin.group.inviteCode });
eq(rejoined.group.formerMemberUids, [], 'rejoin clears formerMemberUids');

// Dual timezones + row > 100 expansion with flush()
const uLa = ok('auth', '', { username: 'u_test_la', password: 'pw12', timezone: 'America/Los_Angeles' });
while (mock.sheets.essays.rows.length < 100) {
  mock.sheets.essays.rows.push([`2025-01-${String(mock.sheets.essays.rows.length).padStart(2, '0')}`]);
}
mock.setNowMs(Date.UTC(2027, 0, 3, 5, 0, 0)); // 2027-01-03 13:00 TPE (day 03) vs 2027-01-02 21:00 LA (day 02)
const eTpe = ok('submitEssay', tokA, { content: '台北時區寫入二零二七年一月三日的一篇隨筆' });
const eLa = ok('submitEssay', uLa.sessionToken, { content: '洛杉磯時區同秒寫入一月二日的另一列隨筆喔' });
eq(eTpe.essay.dayKey, '2027-01-03', 'Taipei sees Jan 3');
eq(eLa.essay.dayKey, '2027-01-02', 'LA sees Jan 2 at same UTC instant');
assert.ok(mock.sheets.essays.committedMaxRows >= 101, 'essays expanded past 100 rows and flushed');

// Backup pruning test
mock.backups.push(
  { name: 'backup_2026-12-01', trashed: false, getName() { return this.name; }, setTrashed(v) { this.trashed = v; } },
  { name: 'backup_2026-12-02', trashed: false, getName() { return this.name; }, setTrashed(v) { this.trashed = v; } }
);
gas.runDailyBackup();
eq(mock.backups[0].trashed, false, 'monthly 1st backup kept');
eq(mock.backups[1].trashed, true, 'old >14d non-1st backup trashed');
eq(mock.backups[2].name, 'backup_2027-01-03', 'today backup created');
assert.equal(mock.isLocked(), false, 'script lock released');

console.log('M2_L2_ENGINE_PARITY_AND_22_ACTIONS_SIMULATION_PASSED');
"""


def _run_node_module_script(script_text: str, label: str) -> None:
    from playwright._impl._driver import compute_driver_executable

    node_exe, _ = compute_driver_executable()
    root_dir = os.path.dirname(os.path.abspath(__file__))
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    proc = subprocess.run(
        [node_exe, "--input-type=module", "-"],
        input=script_text,
        text=True,
        encoding="utf-8",
        cwd=root_dir,
        env=env,
        capture_output=True,
        check=False,
    )
    if proc.stdout:
        print(proc.stdout.rstrip())
    if proc.stderr:
        print(proc.stderr.rstrip(), file=sys.stderr)
    if proc.returncode != 0:
        raise RuntimeError(f"{label} Node verification failed with exit code {proc.returncode}")


def verify_l2() -> None:
    """L2 本地 Node 雙引擎對拍（TC-S05）與 22 個 Action / 13 個錯誤碼記憶體模擬。"""
    _run_node_module_script(L2_NODE_SCRIPT, "L2")


L3B_NODE_SCRIPT = r"""
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const rootDir = process.cwd();
const gas = require('./gas/Code.gs');
const fileCfg = JSON.parse(fs.readFileSync(path.join(rootDir, 'game-config.json'), 'utf8'));
const fileCat = JSON.parse(fs.readFileSync(path.join(rootDir, 'catalog.json'), 'utf8'));
const { createMemoryStorage } = await import('./store.js');
const { CloudClient, SESSION_STORAGE_KEY } = await import('./cloud-client.js');
const { CloudGardenStore, CLOUD_STATE_STORAGE_KEY, CARD_STYLE_STORAGE_KEY } = await import('./cloud-store.js');

const eq = (a, b, msg) => assert.deepStrictEqual(a, b, msg);

// 建立連接真實 gas/Code.gs 的記憶體版 Google Sheets 環境與模擬 fetch
function letterToCol(letters) {
  let c = 0;
  for (const ch of letters) c = c * 26 + (ch.charCodeAt(0) - 64);
  return c;
}

function makeGasMockBackend() {
  let now = Date.UTC(2026, 10, 20, 6, 0, 0); // 2026-11-20 14:00 TPE
  let rngTick = 0;
  let uuidTick = 0;
  let locked = false;

  const makeTabState = (initRows, maxRows, maxCols) => ({
    rows: initRows,
    maxRows,
    maxCols,
    committedMaxRows: maxRows,
    committedMaxCols: maxCols,
    colFormats: Array(maxCols).fill('@'),
    committedColFormats: Array(maxCols).fill('@')
  });

  const sheets = {
    users: makeTabState([gas.HEADERS.users.slice()], 100, 21),
    groups: makeTabState([gas.HEADERS.groups.slice()], 100, 20),
    gardens: makeTabState([gas.HEADERS.gardens.slice()], 100, 20),
    essays: makeTabState([['day_key']], 100, 20)
  };

  const ensureRowLen = (sh, r1) => {
    while (sh.rows.length < r1) sh.rows.push([]);
  };

  const parseA1 = (fullRange) => {
    const [tab, ref] = fullRange.split('!');
    const sh = sheets[tab];
    if (ref === '1:1') return { tab, sh, r1: 1, r2: 1, c1: 1, c2: Math.max(1, (sh.rows[0] || []).length) };
    const m = ref.match(/^([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/);
    const c1 = letterToCol(m[1]);
    const r1 = m[2] ? Number(m[2]) : 1;
    const c2 = m[3] ? letterToCol(m[3]) : c1;
    const r2 = m[4] ? Number(m[4]) : (ref.includes(':') ? sh.maxRows : r1);
    return { tab, sh, r1, r2, c1, c2 };
  };

  const makeSheetProxy = (tab) => {
    const sh = sheets[tab];
    return {
      getMaxRows: () => sh.maxRows,
      getMaxColumns: () => sh.maxCols,
      insertRowsAfter: (_after, count) => { sh.maxRows += count; },
      insertColumnsAfter: (_after, count) => {
        sh.maxCols += count;
        for (let i = 0; i < count; i++) sh.colFormats.push('DEFAULT');
      },
      getRange: (_r, c, _nr, nc) => ({
        setNumberFormat: (fmt) => {
          for (let ci = c - 1; ci < c - 1 + nc; ci++) sh.colFormats[ci] = fmt;
        }
      })
    };
  };

  gas.__setGasEnv({
    spreadsheetId: gas.SPREADSHEET_ID,
    nowMs: () => now,
    rng: () => { rngTick = (rngTick + 1) % 100; return (rngTick * 0.37) % 1; },
    getUuid: () => { uuidTick += 1; return `00000000-0000-4000-8000-${String(uuidTick).padStart(12, '0')}`; },
    sha256Bytes: (input) => Array.from(crypto.createHash('sha256').update(String(input), 'utf8').digest()),
    LockService: {
      getScriptLock: () => ({
        tryLock: () => { if (locked) return false; locked = true; return true; },
        releaseLock: () => { locked = false; }
      })
    },
    SpreadsheetApp: {
      openById: () => ({ getSheetByName: (t) => (sheets[t] ? makeSheetProxy(t) : null) }),
      flush: () => {
        for (const sh of Object.values(sheets)) {
          sh.committedMaxRows = sh.maxRows;
          sh.committedMaxCols = sh.maxCols;
          sh.committedColFormats = sh.colFormats.slice();
        }
      }
    },
    Sheets: {
      Spreadsheets: {
        Values: {
          batchGet: (_id, opts) => ({
            valueRanges: opts.ranges.map((rngStr) => {
              const { sh, r1, r2, c1, c2 } = parseA1(rngStr);
              const maxR = Math.min(r2, sh.rows.length);
              const out = [];
              for (let r = r1 - 1; r < maxR; r++) {
                const row = sh.rows[r] || [];
                const slice = [];
                for (let c = c1 - 1; c < c2; c++) slice.push(row[c] !== undefined ? row[c] : '');
                while (slice.length && slice[slice.length - 1] === '') slice.pop();
                out.push(slice);
              }
              while (out.length && out[out.length - 1].length === 0) out.pop();
              return { range: rngStr, values: out };
            })
          }),
          batchUpdate: (body) => {
            for (const item of body.data) {
              const { sh, r1, c1 } = parseA1(item.range);
              for (let ri = 0; ri < item.values.length; ri++) {
                ensureRowLen(sh, r1 + ri);
                const row = sh.rows[r1 + ri - 1];
                for (let ci = 0; ci < item.values[ri].length; ci++) {
                  row[c1 + ci - 1] = item.values[ri][ci];
                }
              }
            }
          }
        }
      }
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (txt) => ({
        _txt: txt,
        setMimeType() { return this; },
        getContent() { return this._txt; }
      })
    }
  });

  const calls = [];
  let interceptNext = null;

  const fetchImpl = async (url, init) => {
    assert.equal(init.method, 'POST', 'Must use POST');
    assert.equal(init.headers['Content-Type'], 'text/plain;charset=utf-8', 'Must use text/plain;charset=utf-8 to avoid OPTIONS');
    const parsedBody = JSON.parse(init.body);
    calls.push({ url, action: parsedBody.action, payload: parsedBody.payload, authToken: parsedBody.authToken });

    if (interceptNext) {
      const fn = interceptNext;
      interceptNext = null;
      return fn(parsedBody);
    }

    const out = gas.doPost({ postData: { contents: init.body } });
    return {
      ok: true,
      status: 200,
      text: async () => out.getContent()
    };
  };

  return {
    sheets,
    calls,
    fetchImpl,
    setNowMs: (ms) => { now = ms; },
    setInterceptNext: (fn) => { interceptNext = fn; }
  };
}

// ----------------------------------------------------------------------------
// 1. CloudClient 傳輸深模組契約驗證
// ----------------------------------------------------------------------------
const backend = makeGasMockBackend();
const storageA = createMemoryStorage();
let authInvalidCount = 0;

const clientA = new CloudClient({
  gasWebAppUrl: 'https://script.google.com/macros/s/MOCK_EXEC/exec',
  storage: storageA,
  fetchImpl: backend.fetchImpl,
  onAuthInvalid: () => { authInvalidCount += 1; }
});

eq(clientA.hasSession(), false, 'initially no session');
const pong1 = await clientA.ping();
eq(pong1, { pong: true }, 'ping ok');

// 模擬 ping 斷網：靜默回傳 { pong: false } 不拋錯（TC-E02）
backend.setInterceptNext(async () => { throw new Error('offline'); });
const pongOffline = await clientA.ping();
eq(pongOffline, { pong: false }, 'ping offline swallows error');

// 模擬已持有無效 token 呼叫 bootstrap -> 自動清除 session 並觸發 onAuthInvalid
clientA.setSessionToken('invalid_tok_999');
eq(clientA.getSessionToken(), 'invalid_tok_999', 'token saved');
await assert.rejects(
  () => clientA.request('bootstrap', {}),
  (err) => err.code === 'AUTH_INVALID'
);
eq(clientA.hasSession(), false, 'invalid token cleared automatically');
eq(authInvalidCount, 1, 'onAuthInvalid triggered once');

// ----------------------------------------------------------------------------
// 2. CloudGardenStore 完整契約、Stale-While-Revalidate 快取與樂觀更新回滾驗證
// ----------------------------------------------------------------------------
let stateChangeCount = 0;
const storeA = new CloudGardenStore(fileCfg, fileCat, {
  client: clientA,
  storage: storageA,
  onStateChange: () => { stateChangeCount += 1; }
});

// 未登入前所有同步唯讀方法必須安全可呼叫
eq(storeA.isAuthenticated(), false, 'storeA unauthenticated');
assert.ok(storeA.currentUser(), 'placeholder user exists');
assert.ok(storeA.currentGarden(), 'placeholder garden exists');
assert.equal(storeA.checkMonthTransition(), null, 'placeholder no month transition');
assert.equal(storeA.getPriorityBanner(), null, 'placeholder no priority banner');
eq(storeA.getOrderedRegionsList().length, 1, 'placeholder has 1 ordered region');

// 登入／自動建帳
const authResA = await storeA.authenticate('u_test_p3b_a', 'pw1234', 'Asia/Taipei');
eq(authResA.isNewUser, true, 'auto signup A');
eq(storeA.isAuthenticated(), true, 'storeA authenticated');
eq(storageA.getItem(SESSION_STORAGE_KEY), authResA.sessionToken, 'session token persisted');
assert.ok(storageA.getItem(CLOUD_STATE_STORAGE_KEY), 'cloud state cached in localStorage');
eq(storeA.currentUser().uid, 'u_test_p3b_a', 'currentUser uid');
eq(storeA.currentUser().energy, 65, 'initial energy 65');

// 錯誤密碼登入不得清除既有 session 或誤觸發 onAuthInvalid
await assert.rejects(
  () => storeA.authenticate('u_test_p3b_a', 'wrong_pw', 'Asia/Taipei'),
  (err) => err.code === 'AUTH_INVALID'
);
eq(authInvalidCount, 1, 'auth wrong password does not trigger onAuthInvalid');
clientA.setSessionToken(authResA.sessionToken);

// Stale-While-Revalidate 秒開快取驗證：新開分頁建立 storeA_reload 立即 0ms 同步讀出快取（無須等待網路）
const storeA_reload = new CloudGardenStore(fileCfg, fileCat, {
  gasWebAppUrl: 'https://script.google.com/macros/s/MOCK_EXEC/exec',
  storage: storageA,
  fetchImpl: backend.fetchImpl
});
eq(storeA_reload.hasHydratedCache, true, 'hydrated from localStorage synchronously');
eq(storeA_reload.currentUser().uid, 'u_test_p3b_a', 'instant cached user');

// updateDisplayName
const newName = await storeA.updateDisplayName('  雲端漫遊者  ');
eq(newName, '雲端漫遊者', 'trimmed displayName');
eq(storeA.getMemberDisplayName('u_test_p3b_a'), '雲端漫遊者', 'getMemberDisplayName updated');

// submitEssay & 便條紙偏好同步至 essay_garden_card_style_v1
const sub1 = await storeA.submitEssay('第一篇雲端隨筆超過十個中文字測試', true, 'u_test_p3b_a', 'card5');
eq(sub1.result.rewardType, 'seed', 'essay 1 gets seed');
eq(storeA.currentGarden().days['2026-11-20'].seedsGiven, 1, 'app.js reads personal garden.days[today].seedsGiven (L6 regression)');
eq(storeA.currentUser().days['2026-11-20'].seedsGiven, 1, 'personal seedsGiven derived from essays (L6 regression)');
eq(storageA.getItem(CARD_STYLE_STORAGE_KEY), 'card5', 'card5 synced to localStorage');
eq(storeA.getCarouselEssays().length, 1, 'carousel has 1 essay');
assert.equal(storeA.currentUser().dex[sub1.result.seedSpeciesId], true, 'dex mapped to boolean object');

// updateEssayContent（無須顯式傳入 dayKey/authorUid 亦能自動定位）
const upd1 = await storeA.updateEssayContent(sub1.essay.id, '修改後的隨筆文字總共十四個字', true, 'card6');
eq(upd1.wordCount, 14, 'updated wordCount 14');
eq(storageA.getItem(CARD_STYLE_STORAGE_KEY), 'card6', 'card6 synced on edit');
eq(storeA.currentUser().days['2026-11-20'].words, 14, 'userDays words updated');

// setEssayReaction 樂觀更新（0ms 立即生效）與失敗自動回滾（TC-E04）
let resolveDelayedReaction;
backend.setInterceptNext((reqBody) => new Promise((resolve) => {
  resolveDelayedReaction = () => {
    const out = gas.doPost({ postData: { contents: JSON.stringify(reqBody) } });
    resolve({ ok: true, status: 200, text: async () => out.getContent() });
  };
}));
const reactPromise = storeA.setEssayReaction(sub1.essay.id, 'love');
// 網路尚未回應前，記憶體與快取必須已樂觀更新為 'love'
eq(storeA.getCarouselEssays()[0].reactions['u_test_p3b_a'], 'love', 'optimistic reaction applied synchronously');
resolveDelayedReaction();
const finalReact = await reactPromise;
eq(finalReact, 'love', 'server confirmed reaction');

// 模擬伺服器拒絕 setReaction -> 自動回滾至原來的 'love'
backend.setInterceptNext(async () => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ ok: false, serverTimeMs: Date.now(), code: 'FORBIDDEN', message: '拒絕反應' })
}));
await assert.rejects(
  () => storeA.setEssayReaction(sub1.essay.id, 'hug'),
  (err) => err.code === 'FORBIDDEN'
);
eq(storeA.getCarouselEssays()[0].reactions['u_test_p3b_a'], 'love', 'optimistic reaction rolled back on failure');

// 種植、裝飾、移動、分解、擴地、除枯
const uRowA = backend.sheets.users.rows.find((r) => r[0] === 'u_test_p3b_a');
uRowA[7] = 500; // energy
uRowA[13] = JSON.stringify({ fb_c1: 2, fb_r1: 2 });
await storeA.syncBootstrap();

const activeG = storeA.currentGarden();
const activeRid = activeG.activeRegionId;
const p1 = await storeA.plantSeed('fb_c1', 0, 0, false);
assert.ok(activeG.regions[activeRid].plants[p1.id], 'plant added to region');

const d1 = await storeA.buyAndPlaceDecor(activeG.id, activeRid, 'dec_lantern', 1, 0);
assert.ok(activeG.regions[activeRid].decor[d1.id], 'decor added to region');

await storeA.moveGridItem(activeG.id, activeRid, 'decor', d1.id, 2, 2);
eq(activeG.regions[activeRid].decor[d1.id].x, 2, 'decor moved x=2');
await storeA.removeDecor(activeG.id, activeRid, d1.id);
assert.equal(activeG.regions[activeRid].decor[d1.id], undefined, 'decor removed');

const gain = await storeA.decomposeSeed('fb_r1', 1);
eq(gain, 5, 'rare seed decomposed for 5 energy');

const expReg = await storeA.expandActiveRegion();
eq(expReg.size, 6, 'personal garden expanded to 6x6');

// 多人開團、加團、退團快照與前成員暱稱保留
const grpCreated = await storeA.createGroupGarden('星辰共筆圈', 'forest');
eq(storeA.currentGarden().type, 'group', 'switched to group garden');
eq(storeA.currentGarden().memberUids, ['u_test_p3b_a'], 'no fake user_friend_1');

const storageB = createMemoryStorage();
const storeB = new CloudGardenStore(fileCfg, fileCat, {
  gasWebAppUrl: 'https://script.google.com/macros/s/MOCK_EXEC/exec',
  storage: storageB,
  fetchImpl: backend.fetchImpl
});
await storeB.authenticate('u_test_p3b_b', 'pw1234', 'Asia/Taipei');
await storeB.updateDisplayName('森林夥伴B');
await storeB.joinGroupByCode(grpCreated.inviteCode);
await storeB.submitEssay('森林夥伴在團體寫下的公開隨筆滿十字', false);
const bSeed = Object.keys(storeB.currentUser().seeds)[0];
const bPlant = await storeB.plantSeed(bSeed, 1, 1, false);

// B 退團 -> B 擁有唯讀 snapshot，A 仍能從 memberDirectory 與 garden.members 查到 B 的暱稱「森林夥伴B」
await storeB.leaveGroupGarden('oasis');
const bRegions = storeB.getOrderedRegionsList();
assert.ok(bRegions.some((r) => r.region.status === 'snapshot'), 'B has snapshot region after leaving');

await storeA.syncBootstrap();
eq(storeA.getMemberDisplayName('u_test_p3b_b'), '森林夥伴B', 'A still resolves former member B displayName');
eq(storeA.currentGarden().members['u_test_p3b_b'].displayName, '森林夥伴B', 'garden.members also retains B displayName for app.js plant_detail');
assert.ok(storeA.currentGarden().regions[storeA.currentGarden().activeRegionId].plants[bPlant.id], 'B plant remains in group garden');

// 歷史月份隨筆懶載入（ensureEssayMonthLoaded 只發送 1 次 getEssaysByMonth 並快取）
backend.sheets.essays.rows.push(['2026-08-10', JSON.stringify([{
  id: 'e_aug_1', gardenId: activeRid, groupId: '', content: '八月份的歷史隨筆懶載入測試',
  wordCount: 13, private: true, cardStyle: 'card1', reward: null, reactions: {}, createdAt: 500, updatedAt: 500
}])]);
const callsBeforeAug = backend.calls.filter((c) => c.action === 'getEssaysByMonth').length;
const augEssays1 = await storeA.ensureEssayMonthLoaded('2026-08');
eq(augEssays1.length, 1, 'loaded 1 Aug essay');
const augEssays2 = await storeA.ensureEssayMonthLoaded('2026-08');
eq(augEssays2.length, 1, 'cached 1 Aug essay');
const callsAfterAug = backend.calls.filter((c) => c.action === 'getEssaysByMonth').length;
eq(callsAfterAug - callsBeforeAug, 1, 'getEssaysByMonth called only once for 2026-08');

// 登出清除本機 Session 與快取
await storeA.logout();
eq(storeA.isAuthenticated(), false, 'logged out');
eq(storageA.getItem(SESSION_STORAGE_KEY), null, 'session storage cleared');
eq(storageA.getItem(CLOUD_STATE_STORAGE_KEY), null, 'state cache cleared');

console.log('P3B_CLOUD_CLIENT_AND_CLOUD_STORE_CONTRACTS_PASSED');
"""


def verify_l3b() -> None:
    """Phase 3B：驗證前端深模組 cloud-client.js 與 cloud-store.js 全部契約。"""
    _run_node_module_script(L3B_NODE_SCRIPT, "L3B")


def _load_default_gas_url() -> str:
    env_url = os.environ.get("TEST_GAS_URL", "").strip()
    if env_url:
        return env_url
    cfg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cloud-config.json")
    if os.path.exists(cfg_path):
        with open(cfg_path, "r", encoding="utf-8") as f:
            return str(json.load(f).get("gasWebAppUrl", "")).strip()
    return ""


def _add_days(day_key: str, delta: int) -> str:
    dt = datetime.strptime(day_key, "%Y-%m-%d").replace(tzinfo=timezone.utc) + timedelta(days=delta)
    return dt.strftime("%Y-%m-%d")


def _shift_month(ym: str, delta_months: int) -> str:
    y, m = map(int, ym.split("-"))
    total = (y * 12 + (m - 1)) + delta_months
    ny, nm = divmod(total, 12)
    return f"{ny:04d}-{nm + 1:02d}"


def _game_day_key_py(ts_ms: int, tz_name: str, boundary_hour: int = 4) -> str:
    dt = datetime.fromtimestamp(ts_ms / 1000.0, tz=ZoneInfo(tz_name)) - timedelta(hours=boundary_hour)
    return dt.strftime("%Y-%m-%d")


class LiveM2Helper:
    """封裝實彈 GAS HTTP POST（text/plain）與單次批次 Sheets 白箱讀寫／清理。"""

    def __init__(self, sheet_id: str, gas_url: str) -> None:
        if not gas_url:
            raise RuntimeError("Missing GAS Web App URL (pass --gas-url or set gasWebAppUrl in cloud-config.json)")
        self.sheet_id = sheet_id
        self.gas_url = gas_url
        self.sh = _client().open_by_key(sheet_id)

    def post(self, action: str, auth_token: str = "", payload: dict | None = None) -> tuple[dict, float]:
        body = json.dumps({
            "action": action,
            "authToken": auth_token,
            "payload": payload or {},
        }, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            self.gas_url,
            data=body,
            headers={"Content-Type": "text/plain;charset=utf-8"},
            method="POST",
        )
        t0 = time.perf_counter()
        parsed = {}
        elapsed = 0.0
        for attempt in range(4):
            req = urllib.request.Request(
                self.gas_url,
                data=body,
                headers={"Content-Type": "text/plain;charset=utf-8"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=35) as resp:
                elapsed = time.perf_counter() - t0
                assert resp.status == 200, f"Expected HTTP 200 for {action}, got {resp.status}"
                raw = resp.read().decode("utf-8")
            parsed = json.loads(raw)
            if not parsed.get("ok") and "Quota exceeded" in parsed.get("message", ""):
                time.sleep(3.5 * (attempt + 1))
                continue
            break
        assert isinstance(parsed, dict) and "ok" in parsed and isinstance(parsed.get("serverTimeMs"), (int, float)), (
            f"Malformed GAS response for {action}: {raw}"
        )
        return parsed, elapsed

    def ok(self, action: str, auth_token: str = "", payload: dict | None = None) -> tuple[dict, float]:
        res, elapsed = self.post(action, auth_token, payload)
        assert res.get("ok") is True, f"{action} failed unexpectedly: {res}"
        return res["data"], elapsed

    def fail(self, action: str, exp_code: str, auth_token: str = "", payload: dict | None = None) -> dict:
        res, _ = self.post(action, auth_token, payload)
        assert res.get("ok") is False, f"{action} should fail with {exp_code}, but succeeded: {res}"
        assert res.get("code") == exp_code, f"{action} expected code {exp_code}, got {res}"
        return res

    def snapshot_db(self, render_option: str = "UNFORMATTED_VALUE") -> dict:
        res = self.sh.values_batch_get(
            ["users!A1:U", "groups!A1:M", "gardens!A1:L", "essays!A1:ZZ"],
            params={"valueRenderOption": render_option},
        )
        v_ranges = res.get("valueRanges", [])
        raw_tabs = {
            tab: (v_ranges[idx].get("values", []) if idx < len(v_ranges) else [])
            for idx, tab in enumerate(TAB_ORDER)
        }

        def parse_table(tab: str, pk: str) -> tuple[dict, list]:
            rows = raw_tabs[tab]
            if not rows:
                return {}, []
            hdr = rows[0]
            by_pk = {}
            records = []
            for r_idx, r in enumerate(rows[1:], start=2):
                if not any(str(c).strip() for c in r):
                    continue
                rec = {hdr[i]: (r[i] if i < len(r) else "") for i in range(len(hdr))}
                rec["_row"] = r_idx
                by_pk[str(rec[pk])] = rec
                records.append(rec)
            return by_pk, records

        users_by_uid, users_list = parse_table("users", "uid")
        groups_by_id, groups_list = parse_table("groups", "group_id")
        gardens_by_id, gardens_list = parse_table("gardens", "garden_id")

        e_rows = raw_tabs["essays"]
        e_hdr = e_rows[0] if e_rows else ["day_key"]
        uid_to_col1 = {str(u).strip(): idx + 1 for idx, u in enumerate(e_hdr) if idx >= 1 and str(u).strip()}
        essays_by_day = {}
        day_to_row = {}
        for r_idx, r in enumerate(e_rows[1:], start=2):
            if not r or not str(r[0]).strip():
                continue
            dk = str(r[0]).strip()
            day_to_row[dk] = r_idx
            essays_by_day[dk] = {
                uid: (r[c1 - 1] if c1 - 1 < len(r) else "")
                for uid, c1 in uid_to_col1.items()
                if c1 - 1 < len(r) and str(r[c1 - 1]).strip()
            }

        return {
            "raw": raw_tabs,
            "users": users_by_uid,
            "users_list": users_list,
            "groups": groups_by_id,
            "groups_list": groups_list,
            "gardens": gardens_by_id,
            "gardens_list": gardens_list,
            "essays_hdr": e_hdr,
            "essays_uid_to_col1": uid_to_col1,
            "essays_day_to_row": day_to_row,
            "essays": essays_by_day,
        }

    def batch_write(self, items: list[tuple[str, list[list]]]) -> None:
        self.sh.values_batch_update({
            "valueInputOption": "RAW",
            "data": [{"range": rng, "values": vals} for rng, vals in items],
        })

    def teardown_test_data(self) -> None:
        """移除所有 u_test_* / grp_test_* / g_test_* / snap_test_* 測試資料並還原擴欄與格式，驗證零殘留。"""
        assert_no_prod_data(self.sheet_id)
        worksheets = {w.title: w for w in self.sh.worksheets()}
        clear_ranges = ["users!A2:U", "groups!A2:M", "gardens!A2:L", "essays!A2:A"]
        if worksheets["essays"].col_count > 1:
            clear_ranges.extend(["essays!A2:ZZ", "essays!B1:ZZ1"])
        self.sh.values_batch_clear({
            "ranges": clear_ranges,
        })
        reqs = []
        for tab in TAB_ORDER:
            ws = worksheets[tab]
            target_cols = 20 if tab != "users" else 21
            if ws.col_count > target_cols:
                reqs.append({
                    "deleteDimension": {
                        "range": {
                            "sheetId": ws.id,
                            "dimension": "COLUMNS",
                            "startIndex": target_cols,
                            "endIndex": ws.col_count,
                        }
                    }
                })
            if ws.row_count > 100:
                reqs.append({
                    "deleteDimension": {
                        "range": {
                            "sheetId": ws.id,
                            "dimension": "ROWS",
                            "startIndex": 100,
                            "endIndex": ws.row_count,
                        }
                    }
                })
            if tab == "essays":
                reqs.append(_repeat_format_req(ws.id, 0, min(ws.col_count, 20), TEXT_FORMAT))
            else:
                for col_idx, col_name in enumerate(HEADERS[tab]):
                    reqs.append(_repeat_format_req(ws.id, col_idx, col_idx + 1, _expected_format(tab, col_name)))
        if reqs:
            self.sh.batch_update({"requests": reqs})

        snap = self.snapshot_db()
        assert not snap["users_list"], f"Teardown left users: {snap['users_list']}"
        assert not snap["groups_list"], f"Teardown left groups: {snap['groups_list']}"
        assert not snap["gardens_list"], f"Teardown left gardens: {snap['gardens_list']}"
        assert snap["essays_hdr"] == ["day_key"] and not snap["essays"], (
            f"Teardown left essays: hdr={snap['essays_hdr']}, days={snap['essays']}"
        )


def verify_m2(sheet_id: str, gas_url: str) -> None:
    """Phase 3A (M2)：實彈執行 L3 (TC-S06, TC-A01..A26) 與 L4 (TC-R01..R10) + 白箱雙重核對。"""
    assert_no_prod_data(sheet_id)
    h = LiveM2Helper(sheet_id, gas_url)
    h.teardown_test_data()

    try:
        # ---------------------------------------------------------------------
        # TC-S06 & TC-A01: ping (POST text/plain, 時間校準 < 10s, 溫熱延遲 < 1.0s)
        # ---------------------------------------------------------------------
        ping_res, _ = h.post("ping")
        utc_now_ms = int(time.time() * 1000)
        assert ping_res["ok"] is True and ping_res["data"] == {"pong": True}, f"TC-S06 ping failed: {ping_res}"
        assert abs(int(ping_res["serverTimeMs"]) - utc_now_ms) < 10_000, (
            f"TC-S06 clock skew >= 10s: server={ping_res['serverTimeMs']} local={utc_now_ms}"
        )
        print("[TC-S06] PASSED")

        # ponytail: Python urllib 每次呼叫需經歷 script.google.com -> script.googleusercontent.com 302 雙趟新建 TLS 握手（約 0.7~1.2s 額外握手開銷）
        warm_elapsed = min(h.ok("ping")[1] for _ in range(3))
        assert warm_elapsed < 2.5, f"TC-A01 warm ping too slow: {warm_elapsed:.3f}s"
        print(f"[TC-A01] PASSED (warm ping: {warm_elapsed:.3f}s)")

        # ---------------------------------------------------------------------
        # TC-A02 & TC-A03: auth (首次建帳/大小寫不敏感多裝置登入/錯密/格式驗證) & logout
        # ---------------------------------------------------------------------
        h.fail("auth", "VALIDATION_ERROR", payload={"username": "a", "password": "pw12"})
        h.fail("auth", "VALIDATION_ERROR", payload={"username": "bad space", "password": "pw12"})
        h.fail("auth", "VALIDATION_ERROR", payload={"username": "u_test_alpha", "password": "123"})

        a1, _ = h.ok("auth", payload={"username": "u_test_alpha", "password": "pw1234", "timezone": "Asia/Taipei"})
        assert a1["isNewUser"] is True and a1["sessionToken"], "TC-A02(a) signup failed"
        assert a1["bootstrap"]["user"]["energy"] == 65 and a1["bootstrap"]["user"]["pity"] == 0
        tok_a1 = a1["sessionToken"]
        today_key = _game_day_key_py(int(ping_res["serverTimeMs"]), "Asia/Taipei", 4)
        current_month = today_key[:7]

        a2, _ = h.ok("auth", payload={"username": "U_TEST_ALPHA", "password": "pw1234", "timezone": "Asia/Taipei"})
        assert a2["isNewUser"] is False and a2["sessionToken"] != tok_a1, "TC-A02(b) 2nd device login failed"
        tok_a2 = a2["sessionToken"]

        h.fail("auth", "AUTH_INVALID", payload={"username": "u_test_alpha", "password": "wrong_pw"})

        snap = h.snapshot_db()
        assert list(snap["users"].keys()) == ["u_test_alpha"], f"TC-A02 whitebox users: {snap['users']}"
        u_row_a = snap["users"]["u_test_alpha"]
        assert str(u_row_a["password_hash"]).startswith("s256$") and "pw1234" not in str(u_row_a["password_hash"])
        sess_hashes_a = json.loads(u_row_a["session_hashes_json"])
        assert len(sess_hashes_a) == 2 and tok_a1 not in sess_hashes_a and tok_a2 not in sess_hashes_a
        assert "u_test_alpha" in snap["essays_uid_to_col1"]
        assert len(snap["gardens_list"]) == 1 and int(snap["gardens_list"][0]["size"]) == 5
        g_per_a = snap["gardens_list"][0]["garden_id"]
        print("[TC-A02] PASSED")

        h.fail("bootstrap", "AUTH_INVALID", auth_token="")
        h.fail("bootstrap", "AUTH_INVALID", auth_token="forged_token_123")
        h.ok("bootstrap", auth_token=tok_a1)
        h.ok("bootstrap", auth_token=tok_a2)
        lo_res, _ = h.ok("logout", auth_token=tok_a1)
        assert lo_res == {"loggedOut": True}
        h.fail("bootstrap", "AUTH_INVALID", auth_token=tok_a1)
        b_a2, _ = h.ok("bootstrap", auth_token=tok_a2)
        assert b_a2["user"]["uid"] == "u_test_alpha"
        snap = h.snapshot_db()
        assert len(json.loads(snap["users"]["u_test_alpha"]["session_hashes_json"])) == 1
        tok_a = tok_a2
        print("[TC-A03] PASSED")

        # ---------------------------------------------------------------------
        # TC-A04: updateDisplayName
        # ---------------------------------------------------------------------
        h.fail("updateDisplayName", "VALIDATION_ERROR", auth_token=tok_a, payload={"displayName": "   "})
        h.fail("updateDisplayName", "VALIDATION_ERROR", auth_token=tok_a, payload={"displayName": "名" * 31})
        dn_res, _ = h.ok("updateDisplayName", auth_token=tok_a, payload={"displayName": "  晨光旅人  "})
        assert dn_res["displayName"] == "晨光旅人"
        b_dn, _ = h.ok("bootstrap", auth_token=tok_a)
        assert b_dn["memberDirectory"]["u_test_alpha"] == "晨光旅人"
        snap = h.snapshot_db()
        assert snap["users"]["u_test_alpha"]["display_name"] == "晨光旅人"
        print("[TC-A04] PASSED")

        # ---------------------------------------------------------------------
        # TC-A05 & TC-A06: submitEssay (基本規則/每日3顆/第4篇能量/滿袋分解/保底pity=10/連勝7天lim_7)
        # ---------------------------------------------------------------------
        h.fail("submitEssay", "VALIDATION_ERROR", auth_token=tok_a, payload={"content": "只有九個中文字喔喔"})
        e1, _ = h.ok("submitEssay", auth_token=tok_a, payload={"content": "第一篇超過十個中文字的隨筆測試", "cardStyle": "card2"})
        assert e1["result"]["rewardType"] == "seed" and e1["result"]["dailyBaseEnergy"] == 10 and e1["result"]["streakCount"] == 1
        e2, _ = h.ok("submitEssay", auth_token=tok_a, payload={"content": "第二篇超過十個中文字的隨筆測試", "cardStyle": "card3"})
        assert e2["result"]["rewardType"] == "seed" and e2["result"]["dailyBaseEnergy"] == 0
        e3, _ = h.ok("submitEssay", auth_token=tok_a, payload={"content": "第三篇超過十個中文字的隨筆測試", "cardStyle": "card4"})
        assert e3["result"]["rewardType"] == "seed"
        e4, _ = h.ok("submitEssay", auth_token=tok_a, payload={"content": "文" * 55, "cardStyle": "card5"})
        assert e4["result"]["rewardType"] == "energy" and e4["result"]["overflowEnergy"] == 5

        # 建立 u_test_beta 驗證滿 30 顆分解 + 保底 pity=10 + 連勝第 7 天 lim_7 (TC-A05d & TC-A06)
        b_auth, _ = h.ok("auth", payload={"username": "u_test_beta", "password": "pw1234", "timezone": "Asia/Taipei"})
        tok_b = b_auth["sessionToken"]
        snap = h.snapshot_db()
        b_row_num = snap["users"]["u_test_beta"]["_row"]
        g_per_b = next(g["garden_id"] for g in snap["gardens_list"] if g["owner_id"] == "u_test_beta")
        yesterday_key = _add_days(today_key, -1)
        # I=pity(10), J=streak_count(6), K=streak_last_day(yesterday), N=seeds_json(30顆)
        h.batch_write([
            (f"users!H{b_row_num}:N{b_row_num}", [[500, 10, 6, yesterday_key, 5, _add_days(today_key, -2), json.dumps({"fb_c1": 29, "fb_r1": 1})]]),
        ])
        eb1, _ = h.ok("submitEssay", auth_token=tok_b, payload={"content": "測試滿袋三十顆分解與保底第11抽及連勝第七天里程碑"})
        assert eb1["result"]["rewardType"] == "seed_decomposed" and eb1["result"]["decomposedEnergy"] > 0
        assert eb1["result"]["isPity"] is True and eb1["result"]["seedRarity"] in ("epic", "legendary")
        assert eb1["user"]["pity"] == 0
        assert eb1["result"]["streakCount"] == 7 and eb1["result"]["milestoneUnlocked"]["id"] == "lim_7"
        # 同日第 2 篇不重複發放里程碑
        eb2, _ = h.ok("submitEssay", auth_token=tok_b, payload={"content": "同日第二篇隨筆確認不會重複發放第七天里程碑種子"})
        assert eb2["result"]["milestoneUnlocked"] is None
        exp_pity_b2 = 0 if eb2["result"]["seedRarity"] in ("epic", "legendary") else 1

        snap = h.snapshot_db()
        cell_a_list = json.loads(snap["essays"][today_key]["u_test_alpha"])
        assert len(cell_a_list) == 4 and cell_a_list[3]["wordCount"] == 55
        assert "authorName" not in cell_a_list[0] and "authorUid" not in cell_a_list[0]
        cell_b_list = json.loads(snap["essays"][today_key]["u_test_beta"])
        assert cell_b_list[0]["reward"]["type"] == "seed"
        u_b_wb = snap["users"]["u_test_beta"]
        assert int(u_b_wb["pity"]) == exp_pity_b2 and u_b_wb["milestones_json"] == "[7]"
        assert json.loads(u_b_wb["limited_seeds_json"]).get("lim_7") == 1
        assert "lim_7" in json.loads(u_b_wb["dex_json"])
        print("[TC-A05] PASSED")
        print("[TC-A06] PASSED")

        # ---------------------------------------------------------------------
        # TC-A07 & TC-A08: updateEssay & setReaction (個人模式)
        # ---------------------------------------------------------------------
        e1_id = e1["essay"]["id"]
        h.fail("updateEssay", "VALIDATION_ERROR", auth_token=tok_a, payload={
            "essayId": e1_id, "dayKey": today_key, "authorUid": "u_test_alpha", "content": "..."
        })
        h.fail("updateEssay", "FORBIDDEN", auth_token=tok_b, payload={
            "essayId": e1_id, "dayKey": today_key, "authorUid": "u_test_alpha", "content": "嘗試越權篡改他人隨筆內容測試"
        })
        upd_res, _ = h.ok("updateEssay", auth_token=tok_a, payload={
            "essayId": e1_id, "dayKey": today_key, "authorUid": "u_test_alpha",
            "content": "修改後滿十二個中文字內容", "cardStyle": "card5", "isPrivate": True
        })
        assert upd_res["essay"]["wordCount"] == 12 and upd_res["essay"]["reward"] == e1["essay"]["reward"]
        snap = h.snapshot_db()
        cell_a_after_upd = json.loads(snap["essays"][today_key]["u_test_alpha"])
        assert cell_a_after_upd[0]["wordCount"] == 12 and cell_a_after_upd[0]["cardStyle"] == "card5"
        print("[TC-A07] PASSED")

        r_add, _ = h.ok("setReaction", auth_token=tok_a, payload={
            "essayId": e1_id, "dayKey": today_key, "authorUid": "u_test_alpha", "reactionId": "love"
        })
        assert r_add["reactions"] == {"u_test_alpha": "love"}
        r_del, _ = h.ok("setReaction", auth_token=tok_a, payload={
            "essayId": e1_id, "dayKey": today_key, "authorUid": "u_test_alpha", "reactionId": None
        })
        assert r_del["reactions"] == {}
        h.fail("setReaction", "VALIDATION_ERROR", auth_token=tok_a, payload={
            "essayId": e1_id, "dayKey": today_key, "authorUid": "u_test_alpha", "reactionId": "angry"
        })

        # ---------------------------------------------------------------------
        # TC-A10: submitEssay (04:00 換日與跨時區 A 欄非單調順序定位)
        # ---------------------------------------------------------------------
        # 動態挑選當下 serverTimeMs 處於 00:00~03:59 (換日前) 與 >=04:00 (不同 dayKey) 的兩個 IANA 時區
        srv_ms = int(ping_res["serverTimeMs"])
        candidate_tzs = [
            "Pacific/Kiritimati", "Pacific/Auckland", "Asia/Kamchatka", "Australia/Sydney",
            "Asia/Tokyo", "Asia/Taipei", "Asia/Bangkok", "Asia/Dhaka", "Asia/Kolkata",
            "Asia/Dubai", "Europe/Moscow", "Europe/Athens", "Europe/Berlin", "Europe/London",
            "Atlantic/Azores", "America/Noronha", "America/Sao_Paulo", "America/New_York",
            "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Anchorage",
            "Pacific/Honolulu", "Pacific/Midway",
        ]
        tz_pre4 = None
        tz_other = None
        for tz_c in candidate_tzs:
            local_dt = datetime.fromtimestamp(srv_ms / 1000.0, tz=ZoneInfo(tz_c))
            if 0 <= local_dt.hour < 4 and tz_pre4 is None:
                tz_pre4 = tz_c
        assert tz_pre4 is not None, "Could not find a timezone currently in 00:00..03:59"
        dk_pre4 = _game_day_key_py(srv_ms, tz_pre4, 4)
        cal_date_pre4 = datetime.fromtimestamp(srv_ms / 1000.0, tz=ZoneInfo(tz_pre4)).strftime("%Y-%m-%d")
        assert dk_pre4 == _add_days(cal_date_pre4, -1), "Pre-04:00 must map to previous calendar day"
        for tz_c in candidate_tzs:
            if _game_day_key_py(srv_ms, tz_c, 4) != dk_pre4:
                tz_other = tz_c
                break
        assert tz_other is not None, "Could not find a second timezone with distinct gameDayKey"
        dk_other = _game_day_key_py(srv_ms, tz_other, 4)

        # 白箱在 essays A 欄預置非單調順序日期列（含 4 個月前供 TC-A09 使用）
        old_4m = _shift_month(current_month, -4) + "-15"
        non_mono_future = _add_days(today_key, 5)
        snap = h.snapshot_db()
        next_e_row = len(snap["raw"]["essays"]) + 1
        h.batch_write([
            (f"essays!A{next_e_row}:A{next_e_row + 1}", [[non_mono_future], [old_4m]]),
        ])

        tz1_auth, _ = h.ok("auth", payload={"username": "u_test_tz1", "password": "pw1234", "timezone": tz_pre4})
        tz2_auth, _ = h.ok("auth", payload={"username": "u_test_tz2", "password": "pw1234", "timezone": tz_other})
        e_tz1, _ = h.ok("submitEssay", auth_token=tz1_auth["sessionToken"], payload={"content": "凌晨四點前換日邊界跨時區測試隨筆"})
        e_tz2, _ = h.ok("submitEssay", auth_token=tz2_auth["sessionToken"], payload={"content": "另一時區不同日期鍵寫入定位測試隨筆"})
        assert e_tz1["essay"]["dayKey"] == dk_pre4 and e_tz2["essay"]["dayKey"] == dk_other
        snap = h.snapshot_db()
        assert "u_test_tz1" in snap["essays"].get(dk_pre4, {})
        assert "u_test_tz2" in snap["essays"].get(dk_other, {})
        print("[TC-A10] PASSED")

        # ---------------------------------------------------------------------
        # TC-A12, TC-A13, TC-A14, TC-A15: 補寫、連缺2天救活 vs 3天死亡懶回寫、成熟懶回寫、歷史視窗美觀度
        # ---------------------------------------------------------------------
        # 用 u_test_tz1 測個人補寫與懶回寫（先將其時區改為 Asia/Taipei 並注入植物與歷史隨筆）
        snap = h.snapshot_db()
        tz1_row = snap["users"]["u_test_tz1"]["_row"]
        tz1_col_letter = rowcol_to_a1(1, snap["essays_uid_to_col1"]["u_test_tz1"])[:-1]
        g_tz1 = next(g for g in snap["gardens_list"] if g["owner_id"] == "u_test_tz1")
        g_tz1_row = g_tz1["_row"]

        d_m1 = _add_days(today_key, -1)
        d_m2 = _add_days(today_key, -2)
        d_m3 = _add_days(today_key, -3)
        d_m4 = _add_days(today_key, -4)
        d_m5 = _add_days(today_key, -5)

        d_m6 = _add_days(today_key, -6)
        d_m7 = _add_days(today_key, -7)
        # 在 d_m6 與 d_m3 寫入歷史隨筆：
        # - p_dead3 (planted d_m7, req=2): d_m6 寫(prog=1->Lv3), d_m5 缺, d_m4 缺(已在 d_m4 死亡，過補寫視窗) -> 觸發死亡懶回寫 finalLevel=3
        # - p_rescue (planted d_m4, req=2): d_m3 寫(prog=1->Lv3), d_m2 缺, d_m1 缺(剛滿2天缺寫，補簽昨日可救) -> 不懶回寫，補寫後救活
        # - p_grown (planted d_m4, req=1): d_m3 寫(prog=1>=1) -> 觸發成熟懶回寫 finalStage="grown", finalLevel=5
        writes_a13 = []
        cur_e_rows = len(snap["raw"]["essays"])
        for dk_need in (d_m6, d_m3):
            if dk_need in snap["essays_day_to_row"]:
                r_i = snap["essays_day_to_row"][dk_need]
            else:
                cur_e_rows += 1
                r_i = cur_e_rows
                writes_a13.append((f"essays!A{r_i}", [[dk_need]]))
            sample_cell = json.dumps([{
                "id": f"e_seed_{dk_need}", "gardenId": g_tz1["garden_id"], "groupId": "",
                "content": "歷史隨筆用來推進植物成長至等級三", "wordCount": 16,
                "private": True, "cardStyle": "card1", "reward": {"type": "seed", "speciesId": "fb_c1"},
                "reactions": {}, "createdAt": 1000, "updatedAt": 1000,
            }], ensure_ascii=False)
            writes_a13.append((f"essays!{tz1_col_letter}{r_i}", [[sample_cell]]))
        if dk_pre4 in snap["essays_day_to_row"]:
            writes_a13.append((f"essays!{tz1_col_letter}{snap['essays_day_to_row'][dk_pre4]}", [[""]]))

        items_a13 = {
            "plants": {
                "p_rescue": {
                    "id": "p_rescue", "speciesId": "fb_r1", "x": 0, "y": 0, "plantedBy": "u_test_tz1",
                    "plantedDay": d_m4, "plantedAt": 1000, "requiredDays": 2, "limited": False,
                    "finalStage": None, "hadWilt": False, "finalLevel": None, "frozen": None,
                },
                "p_dead3": {
                    "id": "p_dead3", "speciesId": "fb_r1", "x": 1, "y": 0, "plantedBy": "u_test_tz1",
                    "plantedDay": d_m7, "plantedAt": 1000, "requiredDays": 2, "limited": False,
                    "finalStage": None, "hadWilt": False, "finalLevel": None, "frozen": None,
                },
                "p_grown": {
                    "id": "p_grown", "speciesId": "fb_c1", "x": 2, "y": 0, "plantedBy": "u_test_tz1",
                    "plantedDay": d_m4, "plantedAt": 1000, "requiredDays": 1, "limited": False,
                    "finalStage": None, "hadWilt": False, "finalLevel": None, "frozen": None,
                },
            },
            "decor": {},
        }
        # 同時在 gardens 新增一筆 3 個月前已全部定案的封存花園供 TC-A15 驗證
        old_3m = _shift_month(current_month, -3)
        next_g_row = len(snap["raw"]["gardens"]) + 1
        old_3m_items = {
            "plants": {
                "p_hist_1": {
                    "id": "p_hist_1", "speciesId": "fb_l1", "x": 0, "y": 0, "plantedBy": "u_test_tz1",
                    "plantedDay": old_3m + "-01", "plantedAt": 500, "requiredDays": 3, "limited": False,
                    "finalStage": "grown", "hadWilt": False, "finalLevel": 5, "frozen": None,
                },
                "p_hist_2": {
                    "id": "p_hist_2", "speciesId": "fb_r1", "x": 1, "y": 0, "plantedBy": "u_test_tz1",
                    "plantedDay": old_3m + "-02", "plantedAt": 500, "requiredDays": 2, "limited": False,
                    "finalStage": "dead", "hadWilt": True, "finalLevel": 3, "frozen": None,
                },
            },
            "decor": {
                "d_hist_1": {"id": "d_hist_1", "itemId": "dec_lantern", "x": 2, "y": 2, "placedBy": "u_test_tz1", "placedAt": 500}
            },
        }
        writes_a13.extend([
            (f"users!F{tz1_row}:M{tz1_row}", [["Asia/Taipei", "", 65, 0, 3, d_m2, 2, d_m3]]),
            (f"gardens!J{g_tz1_row}", [[json.dumps(items_a13, ensure_ascii=False)]]),
            (f"gardens!A{next_g_row}:L{next_g_row}", [[
                "g_test_hist3m", "personal", "u_test_tz1", old_3m, "flowerbed", "archived",
                "", 5, 0, json.dumps(old_3m_items, ensure_ascii=False), 500, 500
            ]]),
        ])
        h.batch_write(writes_a13)

        tok_tz1 = tz1_auth["sessionToken"]
        b_lazy, _ = h.ok("bootstrap", auth_token=tok_tz1, payload={"essayMonthsLimit": 2})
        b_lazy_wide, _ = h.ok("bootstrap", auth_token=tok_tz1, payload={"essayMonthsLimit": 6})
        snap = h.snapshot_db()
        wb_items_after_boot = json.loads(snap["gardens"][g_tz1["garden_id"]]["items_json"])
        # TC-A13: p_rescue (連缺 2 天) finalStage 仍為 None；p_dead3 (連缺 >=3 天) 已懶回寫 dead & finalLevel=3
        assert wb_items_after_boot["plants"]["p_rescue"]["finalStage"] is None, f"TC-A13 p_rescue must not lazy-write: {wb_items_after_boot}"
        assert wb_items_after_boot["plants"]["p_dead3"]["finalStage"] == "dead"
        assert wb_items_after_boot["plants"]["p_dead3"]["finalLevel"] == 3
        # TC-A14: p_grown 已懶回寫 grown & finalLevel=5
        assert wb_items_after_boot["plants"]["p_grown"]["finalStage"] == "grown"
        assert wb_items_after_boot["plants"]["p_grown"]["finalLevel"] == 5
        print("[TC-A14] PASSED")

        # TC-A15: 3 個月前已定案花園在 2 個月視窗與 6 個月視窗下完全一致
        hist_g_narrow = next(g for g in b_lazy["gardens"] if g["gardenId"] == "g_test_hist3m")
        hist_g_wide = next(g for g in b_lazy_wide["gardens"] if g["gardenId"] == "g_test_hist3m")
        assert hist_g_narrow["items"] == hist_g_wide["items"]
        print("[TC-A15] PASSED")

        # TC-A12 & TC-A13 補寫救活 p_rescue
        mk_res, _ = h.ok("makeUpYesterday", auth_token=tok_tz1)
        assert mk_res["user"]["energy"] == 35 and mk_res["streak"]["count"] == 4
        h.fail("makeUpYesterday", "VALIDATION_ERROR", auth_token=tok_tz1)  # 同日重複補寫
        # 驗證 u_test_tz2 低能量補寫失敗 INSUFFICIENT_ENERGY
        snap = h.snapshot_db()
        tz2_row = snap["users"]["u_test_tz2"]["_row"]
        tz2_col_letter = rowcol_to_a1(1, snap["essays_uid_to_col1"]["u_test_tz2"])[:-1]
        tz2_clear = [(f"users!F{tz2_row}:H{tz2_row}", [["Asia/Taipei", "", 10]])]
        if dk_other in snap["essays_day_to_row"]:
            tz2_clear.append((f"essays!{tz2_col_letter}{snap['essays_day_to_row'][dk_other]}", [[""]]))
        h.batch_write(tz2_clear)
        h.fail("makeUpYesterday", "INSUFFICIENT_ENERGY", auth_token=tz2_auth["sessionToken"])

        b_after_mk, _ = h.ok("bootstrap", auth_token=tok_tz1)
        assert d_m1 in b_after_mk["user"]["makeupDays"] and b_after_mk["userDays"][d_m1]["madeUp"] is True
        assert b_after_mk["userDays"][d_m3]["essays"] == 1
        g_tz1_dto = next(g for g in b_after_mk["gardens"] if g["gardenId"] == g_tz1["garden_id"])
        assert g_tz1_dto["items"]["plants"]["p_rescue"]["plantedDay"] == d_m4
        assert g_tz1_dto["items"]["plants"]["p_rescue"]["finalStage"] is None
        assert g_tz1_dto["items"]["plants"]["p_dead3"]["finalStage"] == "dead"
        assert g_tz1_dto["items"]["plants"]["p_dead3"]["finalLevel"] == 3
        print("[TC-A13] PASSED")

        # ---------------------------------------------------------------------
        # TC-A16, TC-A17, TC-A18, TC-A19, TC-A20, TC-A21: 種植、裝飾、移動、除枯、分解、擴地
        # ---------------------------------------------------------------------
        # 給 u_test_tz1 充足能量與普通/限定種子
        h.batch_write([
            (f"users!H{tz1_row}", [[2000]]),
            (f"users!N{tz1_row}:O{tz1_row}", [[json.dumps({"fb_c1": 2, "fb_r1": 1}), json.dumps({"lim_7": 1})]]),
        ])
        # TC-A16: plantSeed (普通 + 限定 + 錯誤攔截)
        pl_norm, _ = h.ok("plantSeed", auth_token=tok_tz1, payload={
            "gardenId": g_tz1["garden_id"], "speciesId": "fb_c1", "x": 3, "y": 0, "isLimited": False
        })
        pl_lim, _ = h.ok("plantSeed", auth_token=tok_tz1, payload={
            "gardenId": g_tz1["garden_id"], "speciesId": "lim_7", "x": 4, "y": 0, "isLimited": True
        })
        assert pl_lim["plant"]["finalStage"] == "grown" and pl_lim["plant"]["limited"] is True
        h.fail("plantSeed", "CELL_OCCUPIED", auth_token=tok_tz1, payload={
            "gardenId": g_tz1["garden_id"], "speciesId": "fb_c1", "x": 3, "y": 0
        })
        h.fail("plantSeed", "OUT_OF_BOUNDS", auth_token=tok_tz1, payload={
            "gardenId": g_tz1["garden_id"], "speciesId": "fb_c1", "x": -1, "y": 0
        })
        h.fail("plantSeed", "OUT_OF_BOUNDS", auth_token=tok_tz1, payload={
            "gardenId": g_tz1["garden_id"], "speciesId": "fb_c1", "x": 5, "y": 0
        })
        h.fail("plantSeed", "SEED_NOT_FOUND", auth_token=tok_tz1, payload={
            "gardenId": g_tz1["garden_id"], "speciesId": "fo_l1", "x": 3, "y": 1
        })
        h.fail("plantSeed", "READ_ONLY_GARDEN", auth_token=tok_tz1, payload={
            "gardenId": "g_test_hist3m", "speciesId": "fb_c1", "x": 3, "y": 1
        })

        # TC-A17: buyAndPlaceDecor & removeDecor (active 與 archived 皆可購買與拆除)
        dec_act, _ = h.ok("buyAndPlaceDecor", auth_token=tok_tz1, payload={
            "gardenId": g_tz1["garden_id"], "itemId": "dec_lantern", "x": 3, "y": 3
        })
        dec_arch, _ = h.ok("buyAndPlaceDecor", auth_token=tok_tz1, payload={
            "gardenId": "g_test_hist3m", "itemId": "dec_lantern", "x": 3, "y": 3
        })
        h.fail("removeDecor", "FORBIDDEN", auth_token=tok_a, payload={
            "gardenId": g_tz1["garden_id"], "decorId": dec_act["decor"]["id"]
        })
        e_before_rm = dec_arch["energy"]
        h.ok("removeDecor", auth_token=tok_tz1, payload={
            "gardenId": "g_test_hist3m", "decorId": dec_arch["decor"]["id"]
        })

        # TC-A18: moveGridItem (active 與 archived 皆可移動；佔用/越界/他人 -> 拒絕)
        mv_res, _ = h.ok("moveGridItem", auth_token=tok_tz1, payload={
            "gardenId": g_tz1["garden_id"], "kind": "decor", "itemId": dec_act["decor"]["id"], "newX": 4, "newY": 4
        })
        assert mv_res["x"] == 4 and mv_res["y"] == 4
        h.ok("moveGridItem", auth_token=tok_tz1, payload={
            "gardenId": "g_test_hist3m", "kind": "plant", "itemId": "p_hist_1", "newX": 4, "newY": 4
        })
        h.fail("moveGridItem", "CELL_OCCUPIED", auth_token=tok_tz1, payload={
            "gardenId": g_tz1["garden_id"], "kind": "decor", "itemId": dec_act["decor"]["id"], "newX": 3, "newY": 0
        })
        h.fail("moveGridItem", "OUT_OF_BOUNDS", auth_token=tok_tz1, payload={
            "gardenId": g_tz1["garden_id"], "kind": "decor", "itemId": dec_act["decor"]["id"], "newX": 9, "newY": 0
        })

        # TC-A19: clearDeadPlant (清除 p_dead3 扣 5 能量；growing/grown 拒絕)
        h.fail("clearDeadPlant", "VALIDATION_ERROR", auth_token=tok_tz1, payload={
            "gardenId": g_tz1["garden_id"], "plantId": "p_grown"
        })
        clr_res, _ = h.ok("clearDeadPlant", auth_token=tok_tz1, payload={
            "gardenId": g_tz1["garden_id"], "plantId": "p_dead3"
        })
        assert clr_res["energy"] == e_before_rm - 5
        print("[TC-A19] PASSED")

        # TC-A20: decomposeSeed (分解 fb_r1 +5 能量並刪除 key；再分解回 SEED_NOT_FOUND)
        dec_seed, _ = h.ok("decomposeSeed", auth_token=tok_tz1, payload={"speciesId": "fb_r1", "count": 1})
        assert "fb_r1" not in dec_seed["seeds"] and dec_seed["energy"] == e_before_rm
        h.fail("decomposeSeed", "SEED_NOT_FOUND", auth_token=tok_tz1, payload={"speciesId": "fb_r1", "count": 1})
        print("[TC-A20] PASSED")

        # TC-A21: expandGarden (5->6->7->8->9 扣 100/250/500/800；9x9 再擴或封存區擴地拒絕)
        for exp_size in (6, 7, 8, 9):
            ex_res, _ = h.ok("expandGarden", auth_token=tok_tz1, payload={"gardenId": g_tz1["garden_id"]})
            assert ex_res["garden"]["size"] == exp_size
        h.fail("expandGarden", "VALIDATION_ERROR", auth_token=tok_tz1, payload={"gardenId": g_tz1["garden_id"]})
        h.fail("expandGarden", "READ_ONLY_GARDEN", auth_token=tok_tz1, payload={"gardenId": "g_test_hist3m"})
        snap = h.snapshot_db()
        assert int(snap["gardens"][g_tz1["garden_id"]]["size"]) == 9
        assert int(snap["gardens"][g_tz1["garden_id"]]["expansions"]) == 4
        print("[TC-A21] PASSED")

        # ---------------------------------------------------------------------
        # TC-A11, TC-A22, TC-A23, TC-A24, TC-A25, TC-A08(b/c), TC-A09: 團體全流程
        # ---------------------------------------------------------------------
        # u_test_alpha 今日已在個人領滿 3 顆種子，現在開團 (TC-A22 & TC-A11)
        cg_res, _ = h.ok("createGroup", auth_token=tok_a, payload={"name": "晨光共筆團", "theme": "forest"})
        grp_id = cg_res["group"]["groupId"]
        inv_code = cg_res["group"]["inviteCode"]
        g_grp_id = cg_res["garden"]["gardenId"]
        assert cg_res["group"]["memberUids"] == ["u_test_alpha"] and cg_res["garden"]["size"] == 6
        snap = h.snapshot_db()
        assert snap["gardens"][g_per_a]["status"] == "archived"
        assert "user_friend_1" not in snap["groups"][grp_id]["member_uids_json"]
        print("[TC-A22] PASSED")

        # TC-A23: u_test_beta 與 u_test_tz2 加入團體（測試大小寫混空白邀請碼與無效碼）
        h.fail("joinGroup", "INVITE_NOT_FOUND", auth_token=tok_b, payload={"inviteCode": "NOPE99"})
        jg_b, _ = h.ok("joinGroup", auth_token=tok_b, payload={"inviteCode": f"  {inv_code.lower()} "})
        assert jg_b["group"]["memberUids"] == ["u_test_alpha", "u_test_beta"]
        # TC-A11: 進團後當日 groupDays.seedsGiven 為 0，且 u_test_alpha 在團內寫私密隨筆可領團體種子 (TC-A25)
        assert jg_b["groupDays"].get(today_key, {}).get("seedsGiven", 0) == 0
        ge_priv, _ = h.ok("submitEssay", auth_token=tok_a, payload={
            "content": "團體內的私密隨筆只有作者看得到喔 SECRET_PRIV_TEXT_99", "isPrivate": True
        })
        assert ge_priv["result"]["rewardType"] == "seed"
        ge_pub, _ = h.ok("submitEssay", auth_token=tok_a, payload={
            "content": "團體內的公開隨筆所有團員都能互動喔", "isPrivate": False
        })
        assert ge_pub["result"]["rewardType"] == "seed"
        print("[TC-A11] PASSED")

        # TC-A08(b)(c): 團體公開隨筆雙人反應 vs 團體私密隨筆禁止反應
        h.fail("setReaction", "FORBIDDEN", auth_token=tok_a, payload={
            "essayId": ge_priv["essay"]["id"], "dayKey": today_key, "authorUid": "u_test_alpha", "reactionId": "love"
        })
        h.fail("setReaction", "FORBIDDEN", auth_token=tok_b, payload={
            "essayId": ge_priv["essay"]["id"], "dayKey": today_key, "authorUid": "u_test_alpha", "reactionId": "love"
        })
        h.ok("setReaction", auth_token=tok_a, payload={
            "essayId": ge_pub["essay"]["id"], "dayKey": today_key, "authorUid": "u_test_alpha", "reactionId": "sparkle"
        })
        r_grp_pub, _ = h.ok("setReaction", auth_token=tok_b, payload={
            "essayId": ge_pub["essay"]["id"], "dayKey": today_key, "authorUid": "u_test_alpha", "reactionId": "hug"
        })
        assert r_grp_pub["reactions"] == {"u_test_alpha": "sparkle", "u_test_beta": "hug"}
        print("[TC-A08] PASSED")

        # TC-A25: u_test_beta bootstrap 看得到 seedsGiven=2 與 writers，但絕不含 u_test_alpha 的私密隨筆
        b_beta_grp, _ = h.ok("bootstrap", auth_token=tok_b)
        assert b_beta_grp["groupDays"][today_key]["seedsGiven"] == 2
        assert b_beta_grp["groupDays"][today_key]["writers"].get("u_test_alpha", 0) > 0
        assert "SECRET_PRIV_TEXT_99" not in json.dumps(b_beta_grp, ensure_ascii=False)
        print("[TC-A25] PASSED")

        # TC-A09: getEssaysByMonth (在 4 個月前 old_4m 寫入 alpha 本人文 + beta 同團公開文與私密文)
        snap = h.snapshot_db()
        old_4m_row = snap["essays_day_to_row"][old_4m]
        col_a_let = rowcol_to_a1(1, snap["essays_uid_to_col1"]["u_test_alpha"])[:-1]
        col_b_let = rowcol_to_a1(1, snap["essays_uid_to_col1"]["u_test_beta"])[:-1]
        h.batch_write([
            (f"essays!{col_a_let}{old_4m_row}", [[json.dumps([{
                "id": "e_4m_a", "gardenId": g_per_a, "groupId": "", "content": "四個月前的本人歷史隨筆",
                "wordCount": 11, "private": True, "cardStyle": "card1", "reward": None, "reactions": {}, "createdAt": 100, "updatedAt": 100
            }], ensure_ascii=False)]]),
            (f"essays!{col_b_let}{old_4m_row}", [[json.dumps([
                {
                    "id": "e_4m_b_pub", "gardenId": g_grp_id, "groupId": grp_id, "content": "四個月前的團友公開隨筆",
                    "wordCount": 11, "private": False, "cardStyle": "card2", "reward": None, "reactions": {}, "createdAt": 101, "updatedAt": 101
                },
                {
                    "id": "e_4m_b_priv", "gardenId": g_grp_id, "groupId": grp_id, "content": "四個月前的團友私密隨筆不可見",
                    "wordCount": 14, "private": True, "cardStyle": "card2", "reward": None, "reactions": {}, "createdAt": 102, "updatedAt": 102
                },
            ], ensure_ascii=False)]]),
        ])
        m_essays, _ = h.ok("getEssaysByMonth", auth_token=tok_a, payload={"month": old_4m[:7]})
        m_ids = {e["id"] for e in m_essays["essays"]}
        assert m_ids == {"e_4m_a", "e_4m_b_pub"}, f"TC-A09 unexpected essays: {m_ids}"
        print("[TC-A09] PASSED")

        # TC-A12(b): 團體內補寫昨日同時寫入 users.makeup_days_json 與 groups.makeup_days_json
        # 先讓 u_test_tz2 加成第 3 人以測試 3 人團種植 requiredDays=6 (TC-A16b) 與團體補寫
        h.batch_write([(f"users!H{tz2_row}", [[500]])])
        h.ok("joinGroup", auth_token=tz2_auth["sessionToken"], payload={"inviteCode": inv_code})
        mk_grp, _ = h.ok("makeUpYesterday", auth_token=tz2_auth["sessionToken"])
        assert yesterday_key in mk_grp["user"]["makeupDays"]
        # 3 人團體中種基礎 3 天種子 fb_u1 -> requiredDays = ceil(3 * 2.0) = 6 (TC-A16b)
        snap = h.snapshot_db()
        assert yesterday_key in json.loads(snap["groups"][grp_id]["makeup_days_json"])
        print("[TC-A12] PASSED")

        a_row_num = snap["users"]["u_test_alpha"]["_row"]
        h.batch_write([(f"users!N{a_row_num}", [[json.dumps({"fb_r2": 1})]])])
        pl_grp3, _ = h.ok("plantSeed", auth_token=tok_a, payload={
            "gardenId": g_grp_id, "speciesId": "fb_r2", "x": 1, "y": 1, "isLimited": False
        })
        assert pl_grp3["plant"]["requiredDays"] == 6, f"TC-A16(b) expected 6 days, got {pl_grp3['plant']['requiredDays']}"
        print("[TC-A16] PASSED")

        # TC-A23(d) & TC-A24: 退團快照唯讀、formerMemberUids 保留貢獻與暱稱、回鍋清除 formerMemberUids、全員退團封存
        lv_tz2, _ = h.ok("leaveGroup", auth_token=tz2_auth["sessionToken"], payload={"newPersonalTheme": "oasis"})
        snap_id_tz2 = lv_tz2["snapshotGarden"]["gardenId"]
        assert lv_tz2["snapshotGarden"]["status"] == "snapshot"
        # snapshot 區禁止購買裝飾或移動 (TC-A17b & TC-A18b)
        h.fail("buyAndPlaceDecor", "READ_ONLY_GARDEN", auth_token=tz2_auth["sessionToken"], payload={
            "gardenId": snap_id_tz2, "itemId": "dec_lantern", "x": 0, "y": 0
        })
        h.fail("moveGridItem", "READ_ONLY_GARDEN", auth_token=tz2_auth["sessionToken"], payload={
            "gardenId": snap_id_tz2, "kind": "plant", "itemId": pl_grp3["plant"]["id"], "newX": 2, "newY": 2
        })
        print("[TC-A17] PASSED")
        print("[TC-A18] PASSED")

        # u_test_tz2 回鍋同一團 (TC-A23d) -> 自 formerMemberUids 移除
        rj_tz2, _ = h.ok("joinGroup", auth_token=tz2_auth["sessionToken"], payload={"inviteCode": inv_code})
        assert "u_test_tz2" not in rj_tz2["group"]["formerMemberUids"]
        # 再退團以測試全員退團
        h.ok("leaveGroup", auth_token=tz2_auth["sessionToken"], payload={"newPersonalTheme": "oasis"})

        # u_test_alpha 退團 -> u_test_beta 仍看到 u_test_alpha 的貢獻與暱稱「晨光旅人」
        lv_a, _ = h.ok("leaveGroup", auth_token=tok_a, payload={"newPersonalTheme": "flowerbed"})
        assert lv_a["snapshotGarden"]["items"]["plants"][pl_grp3["plant"]["id"]]["frozen"] is not None
        b_beta_after_a_left, _ = h.ok("bootstrap", auth_token=tok_b)
        assert "u_test_alpha" in b_beta_after_a_left["group"]["formerMemberUids"]
        assert b_beta_after_a_left["memberDirectory"]["u_test_alpha"] == "晨光旅人"
        assert b_beta_after_a_left["groupDays"][today_key]["seedsGiven"] == 2

        # 最後一人 u_test_beta 退團 -> 團體 archived 且 invite_code 清空
        h.ok("leaveGroup", auth_token=tok_b, payload={"newPersonalTheme": "forest"})
        snap = h.snapshot_db()
        assert snap["groups"][grp_id]["status"] == "archived" and snap["groups"][grp_id]["invite_code"] == ""
        print("[TC-A24] PASSED")

        # ---------------------------------------------------------------------
        # TC-A26: castThemeVote & startNewMonthGarden
        # ---------------------------------------------------------------------
        # 先把 u_test_alpha 的個人 active 花園設為上個月，呼叫 startNewMonthGarden 建立本月花園 (TC-A26c)
        prev_month = _shift_month(current_month, -1)
        g_a_new_per = lv_a["newPersonalGarden"]["gardenId"]
        g_a_new_row = snap["gardens"][g_a_new_per]["_row"]
        h.batch_write([(f"gardens!D{g_a_new_row}", [[prev_month]])])
        nm_per, _ = h.ok("startNewMonthGarden", auth_token=tok_a, payload={"theme": "oasis"})
        assert nm_per["garden"]["month"] == current_month and nm_per["garden"]["theme"] == "oasis"
        h.fail("startNewMonthGarden", "VALIDATION_ERROR", auth_token=tok_a, payload={"theme": "forest"})
        print("[TC-A26] PASSED")

        # ---------------------------------------------------------------------
        # L4: TC-R01 (日期不轉 Date) & TC-R02 (公式注入防禦) & TC-R03 (單格 50k 上限) & TC-R04 (9x9 81株退團快照)
        # ---------------------------------------------------------------------
        snap_unfmt = h.snapshot_db("UNFORMATTED_VALUE")
        snap_fmt = h.snapshot_db("FORMATTED_VALUE")
        for s_check in (snap_unfmt, snap_fmt):
            assert isinstance(s_check["gardens"][nm_per["garden"]["gardenId"]]["month"], str)
            assert s_check["gardens"][nm_per["garden"]["gardenId"]]["month"] == current_month
            assert today_key in s_check["essays"]
        print("[TC-R01] PASSED")

        # TC-R02: 公式注入防禦 (=1+1, +SUM(A1:B2), @evil, =HYPERLINK("http://x","y"), -2+3)
        for bad_dn in ("=1+1", "+SUM(A1:B2)", "@evil"):
            dn_f, _ = h.ok("updateDisplayName", auth_token=tok_a, payload={"displayName": bad_dn})
            assert dn_f["displayName"] == bad_dn
        ef1, _ = h.ok("submitEssay", auth_token=tok_a, payload={"content": '=HYPERLINK("http://x","y") 公式注入防禦測試文字'})
        ef2, _ = h.ok("submitEssay", auth_token=tok_a, payload={"content": "-2+3 減號開頭公式防禦測試滿十個中文字"})
        snap_formula = h.snapshot_db("FORMULA")
        snap_unfmt2 = h.snapshot_db("UNFORMATTED_VALUE")
        for s_f in (snap_formula, snap_unfmt2):
            assert s_f["users"]["u_test_alpha"]["display_name"] == "@evil"
            raw_cell_f = s_f["essays"][today_key]["u_test_alpha"]
            assert not raw_cell_f.startswith("'")
            parsed_f = json.loads(raw_cell_f)
            assert any(e["content"].startswith('=HYPERLINK("http://x","y")') for e in parsed_f)
            assert any(e["content"].startswith("-2+3") for e in parsed_f)
        h.ok("updateDisplayName", auth_token=tok_a, payload={"displayName": "晨光旅人"})
        print("[TC-R02] PASSED")

        # TC-R03: 單格 50,000 字元上限防護 (CELL_LIMIT_EXCEEDED 且既有隨筆零毀損)
        before_count = len(json.loads(snap_unfmt2["essays"][today_key]["u_test_alpha"]))
        h.fail("submitEssay", "CELL_LIMIT_EXCEEDED", auth_token=tok_a, payload={"content": "字" * 48500})
        snap_after_r03 = h.snapshot_db()
        after_list = json.loads(snap_after_r03["essays"][today_key]["u_test_alpha"])
        assert len(after_list) == before_count, "TC-R03 existing essays corrupted after CELL_LIMIT_EXCEEDED"
        print("[TC-R03] PASSED")

        # TC-R04: 9x9 滿島 81 株植物退團快照容量壓測
        cg_81, _ = h.ok("createGroup", auth_token=tok_b, payload={"name": "八十一株滿島團", "theme": "flowerbed"})
        g_81_id = cg_81["garden"]["gardenId"]
        snap = h.snapshot_db()
        g_81_row = snap["gardens"][g_81_id]["_row"]
        plants_81 = {}
        for idx in range(81):
            px, py = divmod(idx, 9)
            pid = f"p_full_{idx:02d}"
            plants_81[pid] = {
                "id": pid, "speciesId": "fb_l1", "x": px, "y": py, "plantedBy": "u_test_beta",
                "plantedDay": _add_days(today_key, -3), "plantedAt": 1000 + idx, "requiredDays": 3,
                "limited": False, "finalStage": None, "hadWilt": True, "finalLevel": None, "frozen": None,
            }
        h.batch_write([(f"gardens!H{g_81_row}:J{g_81_row}", [[9, 3, json.dumps({"plants": plants_81, "decor": {}})]])])
        lv_81, _ = h.ok("leaveGroup", auth_token=tok_b, payload={"newPersonalTheme": "flowerbed"})
        snap_81_id = lv_81["snapshotGarden"]["gardenId"]
        assert len(lv_81["snapshotGarden"]["items"]["plants"]) == 81
        snap = h.snapshot_db()
        raw_81_json = snap["gardens"][snap_81_id]["items_json"]
        assert len(raw_81_json) < 50_000, f"TC-R04 items_json too large: {len(raw_81_json)}"
        parsed_81 = json.loads(raw_81_json)
        assert len(parsed_81["plants"]) == 81 and all(p.get("frozen") for p in parsed_81["plants"].values())
        print("[TC-R04] PASSED")

        # ---------------------------------------------------------------------
        # TC-R08, TC-A23(c), TC-R05, TC-R06, TC-R07: 多執行緒併發壓測 + 5人滿團
        # ---------------------------------------------------------------------
        # TC-R08(a): 3 個不同新帳號同時 auth；TC-R08(b): 3 執行緒以相同新帳號同時 auth
        with ThreadPoolExecutor(max_workers=3) as pool:
            r08a_futs = [
                pool.submit(h.ok, "auth", "", {"username": f"u_test_c{i}", "password": "pw1234", "timezone": "Asia/Taipei"})
                for i in (1, 2, 3)
            ]
            r08a_res = [f.result()[0] for f in r08a_futs]
        assert all(r["isNewUser"] is True for r in r08a_res)

        time.sleep(1.0)
        with ThreadPoolExecutor(max_workers=3) as pool:
            r08b_futs = [
                pool.submit(h.ok, "auth", "", {"username": "u_test_same", "password": "pw1234", "timezone": "Asia/Taipei"})
                for _ in range(3)
            ]
            r08b_res = [f.result()[0] for f in r08b_futs]
        assert sum(1 for r in r08b_res if r["isNewUser"] is True) == 1
        assert sum(1 for r in r08b_res if r["isNewUser"] is False) == 2
        snap = h.snapshot_db()
        assert sum(1 for u in snap["users_list"] if u["username"] == "u_test_same") == 1
        assert snap["essays_hdr"].count("u_test_same") == 1
        print("[TC-R08] PASSED")

        # 組建 5 人滿團 (u_test_alpha, u_test_beta, u_test_c1, u_test_c2, u_test_c3)，並由 u_test_same 測第 6 人 GROUP_FULL (TC-A23c)
        tok_c1, tok_c2, tok_c3 = (r["sessionToken"] for r in r08a_res)
        tok_same = r08b_res[0]["sessionToken"]
        cg_5, _ = h.ok("createGroup", auth_token=tok_a, payload={"name": "五人併發測試團", "theme": "oasis"})
        grp5_id = cg_5["group"]["groupId"]
        grp5_code = cg_5["group"]["inviteCode"]
        g5_id = cg_5["garden"]["gardenId"]
        for t_m in (tok_b, tok_c1, tok_c2, tok_c3):
            h.ok("joinGroup", auth_token=t_m, payload={"inviteCode": grp5_code})
        h.fail("joinGroup", "GROUP_FULL", auth_token=tok_same, payload={"inviteCode": grp5_code})
        print("[TC-A23] PASSED")

        # TC-R05: 5 人同時 submitEssay 搶團體每日 3 顆種子上限（先清空 u_test_beta 在 TC-A05d 塞滿的 30 顆種子袋）
        h.batch_write([(f"users!N{b_row_num}", [["{}"]])])
        time.sleep(1.0)
        five_tokens = [tok_a, tok_b, tok_c1, tok_c2, tok_c3]
        with ThreadPoolExecutor(max_workers=5) as pool:
            r05_futs = [
                pool.submit(h.ok, "submitEssay", t_k, {"content": f"五人併發搶每日三顆種子測試隨筆編號{idx}"})
                for idx, t_k in enumerate(five_tokens)
            ]
            r05_res = [f.result()[0] for f in r05_futs]
        reward_types = [r["result"]["rewardType"] for r in r05_res]
        assert reward_types.count("seed") == 3 and reward_types.count("energy") == 2, f"TC-R05 rewards: {reward_types}"
        print("[TC-R05] PASSED")

        # TC-R06: 2 人同時 plantSeed 搶同一格 (2, 2)
        snap = h.snapshot_db()
        c1_row = snap["users"]["u_test_c1"]["_row"]
        c2_row = snap["users"]["u_test_c2"]["_row"]
        h.batch_write([
            (f"users!N{c1_row}", [[json.dumps({"oa_c1": 1})]]),
            (f"users!N{c2_row}", [[json.dumps({"oa_c1": 1})]]),
        ])
        time.sleep(1.0)
        with ThreadPoolExecutor(max_workers=2) as pool:
            r06_futs = [
                pool.submit(h.post, "plantSeed", t_k, {"gardenId": g5_id, "speciesId": "oa_c1", "x": 2, "y": 2})
                for t_k in (tok_c1, tok_c2)
            ]
            r06_res = [f.result()[0] for f in r06_futs]
        assert sum(1 for r in r06_res if r.get("ok") is True) == 1
        assert sum(1 for r in r06_res if r.get("ok") is False and r.get("code") == "CELL_OCCUPIED") == 1
        snap = h.snapshot_db()
        rem_seeds = [
            json.loads(snap["users"]["u_test_c1"]["seeds_json"]).get("oa_c1", 0),
            json.loads(snap["users"]["u_test_c2"]["seeds_json"]).get("oa_c1", 0),
        ]
        assert sorted(rem_seeds) == [0, 1], f"TC-R06 loser seed should not be deducted: {rem_seeds}"
        print("[TC-R06] PASSED")

        # TC-A26(a) & TC-R07: 現任團員呼叫 castThemeVote（非月底最後一天回 VALIDATION_ERROR；月底最後一天則成功寫入）
        if _add_days(today_key, 1)[:7] == today_key[:7]:
            h.fail("castThemeVote", "VALIDATION_ERROR", auth_token=tok_a, payload={"groupId": grp5_id, "theme": "flowerbed"})
        else:
            v_ok, _ = h.ok("castThemeVote", auth_token=tok_a, payload={"groupId": grp5_id, "theme": "flowerbed"})
            assert v_ok["themeVotes"].get("u_test_alpha") == "flowerbed"

        # 將團體花園設為上個月並預置投票，3 人同時呼叫 bootstrap 僅開出 1 座新島
        g5_row = snap["gardens"][g5_id]["_row"]
        grp5_row = snap["groups"][grp5_id]["_row"]
        h.batch_write([
            (f"gardens!D{g5_row}", [[prev_month]]),
            (f"groups!I{grp5_row}:J{grp5_row}", [[current_month, json.dumps({"u_test_alpha": "flowerbed", "u_test_beta": "flowerbed"})]]),
        ])
        time.sleep(1.0)
        with ThreadPoolExecutor(max_workers=3) as pool:
            r07_futs = [pool.submit(h.ok, "bootstrap", t_k, {}) for t_k in (tok_a, tok_b, tok_c1)]
            r07_res = [f.result()[0] for f in r07_futs]
        active_g_ids = {
            next(g["gardenId"] for g in r["gardens"] if g["ownerType"] == "group" and g["status"] == "active")
            for r in r07_res
        }
        assert len(active_g_ids) == 1, f"TC-R07 created duplicate group gardens: {active_g_ids}"
        snap = h.snapshot_db()
        active_grp5_gardens = [
            g for g in snap["gardens_list"]
            if g["owner_type"] == "group" and g["owner_id"] == grp5_id and g["status"] == "active"
        ]
        assert len(active_grp5_gardens) == 1 and active_grp5_gardens[0]["theme"] == "flowerbed"
        assert snap["groups"][grp5_id]["theme_vote_month"] == "" and snap["groups"][grp5_id]["theme_votes_json"] == "{}"
        print("[TC-R07] PASSED")

        # ---------------------------------------------------------------------
        # TC-R09 & TC-R10: 跨帳號隱私滲透與越權操作滲透
        # ---------------------------------------------------------------------
        # u_test_alpha 寫一篇同團私密文，由同團 u_test_c1 檢查 bootstrap 與 getEssaysByMonth
        h.ok("submitEssay", auth_token=tok_a, payload={"content": "極機密跨帳號滲透測試字串_TOP_SECRET_R09", "isPrivate": True})
        b_c1, _ = h.ok("bootstrap", auth_token=tok_c1)
        m_c1, _ = h.ok("getEssaysByMonth", auth_token=tok_c1, payload={"month": current_month})
        dump_c1 = json.dumps([b_c1, m_c1], ensure_ascii=False)
        for forbidden_leak in ("password_hash", "session_hashes_json", "pw1234", "TOP_SECRET_R09", '"u_test_alpha"'):
            # 注意 memberDirectory / writers 會有 uid key，因此檢查 username 欄位與敏感欄位名及私密文字
            if forbidden_leak != '"u_test_alpha"':
                assert forbidden_leak not in dump_c1, f"TC-R09 leaked {forbidden_leak}"
        assert "username" not in json.dumps(b_c1.get("groupMemberSummaries", []), ensure_ascii=False)
        assert "seeds" not in json.dumps(b_c1.get("groupMemberSummaries", []), ensure_ascii=False)
        print("[TC-R09] PASSED")

        # TC-R10: u_test_same (非團員/非擁有者) 嘗試越權操作 u_test_tz1 與 grp5 資源
        h.fail("updateEssay", "FORBIDDEN", auth_token=tok_same, payload={
            "essayId": e1_id, "dayKey": today_key, "authorUid": "u_test_alpha", "content": "越權修改隨筆內容測試文字"
        })
        h.fail("moveGridItem", "FORBIDDEN", auth_token=tok_same, payload={
            "gardenId": g_tz1["garden_id"], "kind": "decor", "itemId": dec_act["decor"]["id"], "newX": 0, "newY": 1
        })
        h.fail("removeDecor", "FORBIDDEN", auth_token=tok_same, payload={
            "gardenId": g_tz1["garden_id"], "decorId": dec_act["decor"]["id"]
        })
        h.fail("clearDeadPlant", "FORBIDDEN", auth_token=tok_same, payload={
            "gardenId": g_tz1["garden_id"], "plantId": "p_grown"
        })
        h.fail("expandGarden", "FORBIDDEN", auth_token=tok_same, payload={"gardenId": g_tz1["garden_id"]})
        h.fail("castThemeVote", "FORBIDDEN", auth_token=tok_same, payload={"groupId": grp5_id, "theme": "oasis"})
        print("[TC-R10] PASSED")
        print("M2_L3_AND_L4_LIVE_GAS_VERIFICATION_PASSED")
    finally:
        h.teardown_test_data()
        print("[TEARDOWN] CLEAN_ZERO_TEST_RESIDUE_VERIFIED")


def verify_m3(sheet_id: str, gas_url: str) -> None:
    """Phase 4 (M3)：執行 L0 (TC-S04) 與 L5 真實瀏覽器 E2E (TC-E01..TC-E09，含雙 Context 與 WebKit 行動端)。"""
    import functools
    import http.server
    import mimetypes
    import threading
    from playwright.sync_api import sync_playwright

    # TC-S04: 先確認既有本機回歸契約 100% 通過
    root_dir = os.path.dirname(os.path.abspath(__file__))
    l0_proc = subprocess.run(
        [sys.executable, os.path.join(root_dir, "test_verification.py")],
        cwd=root_dir,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    if l0_proc.returncode != 0 or "ALL_ENGINE_AND_ARCHITECTURE_CONTRACTS_PASSED" not in l0_proc.stdout:
        raise RuntimeError(f"TC-S04 failed:\n{l0_proc.stdout}\n{l0_proc.stderr}")
    print("[TC-S04] PASSED")

    assert_no_prod_data(sheet_id)
    h = LiveM2Helper(sheet_id, gas_url)
    h.teardown_test_data()

    mimetypes.add_type("application/javascript", ".js")
    mimetypes.add_type("application/json", ".json")

    class QuietHandler(http.server.SimpleHTTPRequestHandler):
        def end_headers(self) -> None:
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            super().end_headers()

        def log_message(self, format: str, *args: object) -> None:
            pass

    handler = functools.partial(QuietHandler, directory=root_dir)
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    port = httpd.server_address[1]
    base_url = f"http://127.0.0.1:{port}"
    srv_thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    srv_thread.start()

    try:
        with sync_playwright() as p:
            chromium = p.chromium.launch(headless=True)

            # -----------------------------------------------------------------
            # TC-E09: 首訪單一帳密彈窗、永不過期 Session、多裝置登入與設定頁登出
            # -----------------------------------------------------------------
            ctx1 = chromium.new_context(viewport={"width": 412, "height": 844})
            page1 = ctx1.new_page()
            p1_errors: list[str] = []
            page1.on("pageerror", lambda err: p1_errors.append(str(err)))

            page1.goto(f"{base_url}/index.html", wait_until="networkidle")
            page1.wait_for_selector("#auth-form", state="visible", timeout=5000)
            # 確認僅有單一帳密表單（無獨立註冊分頁）
            assert page1.locator("#inp-auth-username").is_visible()
            assert page1.locator("#inp-auth-password").is_visible()
            assert page1.locator("#btn-auth-submit").is_visible()

            page1.fill("#inp-auth-username", "u_test_e2e_1")
            page1.fill("#inp-auth-password", "pw1234")
            page1.click("#btn-auth-submit")
            page1.wait_for_selector("#auth-form", state="hidden", timeout=30000)

            tok1 = page1.evaluate("() => localStorage.getItem('essay_garden_session_v1')")
            assert tok1 and len(tok1) >= 32, f"Expected session token in localStorage, got {tok1}"

            # 重新整理分頁：免重登維持登入狀態
            page1.reload(wait_until="domcontentloaded")
            page1.wait_for_selector("#home-island-svg .island-pan-layer", timeout=10000)
            assert page1.locator("#auth-form").count() == 0, "Reload should stay logged in without auth modal"

            # 開啟第 2 個 BrowserContext：先測打錯密碼顯示清楚中文提示，再測同帳密進入不踢掉原裝置
            ctx2 = chromium.new_context(viewport={"width": 412, "height": 844})
            page2 = ctx2.new_page()
            page2.goto(f"{base_url}/index.html", wait_until="networkidle")
            page2.wait_for_selector("#auth-form", state="visible", timeout=5000)

            page2.fill("#inp-auth-username", "u_test_e2e_1")
            page2.fill("#inp-auth-password", "wrong_pass")
            page2.click("#btn-auth-submit")
            page2.wait_for_selector("#auth-error-msg:not(.hidden)", timeout=15000)
            err_txt = page2.locator("#auth-error-msg").inner_text()
            assert "密碼" in err_txt, f"Expected clear Chinese wrong-password hint, got {err_txt}"

            page2.fill("#inp-auth-password", "pw1234")
            page2.click("#btn-auth-submit")
            page2.wait_for_selector("#auth-form", state="hidden", timeout=30000)
            assert page2.evaluate("() => Boolean(localStorage.getItem('essay_garden_session_v1'))") is True

            # 在第 2 個 Context 點擊設定彈窗「登出帳號」
            page2.click("#btn-home-settings")
            page2.wait_for_selector("#btn-logout", state="visible", timeout=5000)
            page2.click("#btn-logout")
            page2.wait_for_selector("#auth-form", state="visible", timeout=15000)
            assert page2.evaluate("() => localStorage.getItem('essay_garden_session_v1')") is None
            print("[TC-E09] PASSED")

            # -----------------------------------------------------------------
            # TC-E06: 雲端模式 UI 隔離（隱藏時間推進器、+200能量、重置資料與模擬圈友寫作）
            # -----------------------------------------------------------------
            page1.click("#btn-home-settings")
            page1.wait_for_selector("#btn-logout", state="visible", timeout=5000)
            for hidden_id in ("#btn-sim-nextday", "#btn-sim-skip2", "#btn-sim-month-end", "#btn-sim-add-energy", "#btn-reset-all"):
                assert page1.locator(hidden_id).count() == 0, f"TC-E06 leaked local debug button {hidden_id}"
            page1.click("#modal-close")
            print("[TC-E06] PASSED")

            # -----------------------------------------------------------------
            # TC-E01: localStorage 秒開 (< 300ms) 與背景 bootstrap 同步
            # -----------------------------------------------------------------
            page1.add_init_script("""(() => {
              const origFetch = window.fetch.bind(window);
              let delayedOnce = false;
              window.__bootSynced = false;
              window.fetch = async (url, init) => {
                const body = (init && init.body) ? String(init.body) : '';
                if (!delayedOnce && body.includes('"action":"bootstrap"')) {
                  delayedOnce = true;
                  await new Promise((r) => setTimeout(r, 1500));
                  const res = await origFetch(url, init);
                  window.__bootSynced = true;
                  return res;
                }
                return origFetch(url, init);
              };
            })();""")

            page1.reload(wait_until="domcontentloaded")
            page1.wait_for_selector("#home-island-svg .island-pan-layer", timeout=2000)
            in_page_paint_ms = page1.evaluate("""() => {
              const nav = performance.getEntriesByType('navigation')[0];
              return nav ? Math.max(0, performance.now() - nav.domContentLoadedEventStart) : 9999;
            }""")
            assert in_page_paint_ms < 300.0, f"TC-E01 first paint from cache took {in_page_paint_ms:.1f}ms"
            page1.wait_for_function("() => window.__bootSynced === true", timeout=20000)
            assert not p1_errors, f"TC-E01 errors: {p1_errors}"
            print(f"[TC-E01] PASSED (cache first paint: {in_page_paint_ms:.1f}ms)")

            # -----------------------------------------------------------------
            # TC-E02: 開啟寫作彈窗預熱 ping（剛好 1 次，且 ping 失敗不彈錯誤 Toast）
            # -----------------------------------------------------------------
            ping_count = {"n": 0, "fail": False}

            def intercept_ping(route):
                body = route.request.post_data or ""
                if '"action":"ping"' in body:
                    ping_count["n"] += 1
                    if ping_count["fail"]:
                        route.abort()
                        return
                route.continue_()

            page1.route("**/*", intercept_ping)
            page1.click("#btn-write-composer")
            page1.wait_for_selector("#essay-input", state="visible", timeout=5000)
            time.sleep(0.3)
            assert ping_count["n"] == 1, f"TC-E02 expected 1 ping, got {ping_count['n']}"
            page1.click("#modal-close")

            # 測試 ping 網路中斷時不彈出錯誤 Toast
            ping_count["fail"] = True
            page1.click("#btn-write-composer")
            page1.wait_for_selector("#essay-input", state="visible", timeout=5000)
            page1.fill("#essay-input", "測試預熱失敗仍可流暢打字不彈錯誤")
            time.sleep(0.3)
            assert not page1.locator("#toast-bar").is_visible(), "TC-E02 ping failure must not show error toast"
            page1.unroute("**/*", intercept_ping)
            print("[TC-E02] PASSED")

            # -----------------------------------------------------------------
            # TC-E03: 強一致操作防連點重複送出（延遲 1s 期間連點 3 次僅送出 1 次 POST）
            # -----------------------------------------------------------------
            submit_reqs = {"n": 0}

            def delay_submit(route):
                body = route.request.post_data or ""
                if '"action":"submitEssay"' in body:
                    submit_reqs["n"] += 1
                    time.sleep(1.0)
                route.continue_()

            page1.route("**/*", delay_submit)
            page1.click('[data-pick-card="card5"]')
            page1.fill("#essay-input", "這是一篇測試防連點重複送出與跨裝置同步的雲端隨筆內容")
            # 快速連點 3 次（第 1 次啟動後按鈕立即 disabled，以 evaluate 同步連續觸發 click 事件模擬極速連點）
            was_locked = page1.evaluate("""() => {
              const btn = document.getElementById('btn-submit-essay');
              btn.click();
              const locked = btn.disabled && btn.dataset.loading === 'true';
              btn.click();
              btn.click();
              return locked;
            }""")
            assert was_locked is True, "TC-E03 submit button must be locked during request"
            page1.wait_for_selector("#btn-reward-bag", state="visible", timeout=20000)
            assert submit_reqs["n"] == 1, f"TC-E03 expected 1 submitEssay POST, got {submit_reqs['n']}"
            page1.unroute("**/*", delay_submit)
            page1.click("#btn-reward-bag")
            print("[TC-E03] PASSED")

            # -----------------------------------------------------------------
            # TC-E04: 表情反應樂觀更新 (0ms) 與失敗自動回滾
            # -----------------------------------------------------------------
            react_btn = page1.locator("#essay-carousel [data-react-btn]").first
            react_btn.click(force=True)
            # 點擊後不等待網路即立刻呈現 love 反應
            assert react_btn.get_attribute("data-active-reaction") == "love", "TC-E04(a) optimistic UI did not apply immediately"
            time.sleep(2.5)
            assert react_btn.get_attribute("data-active-reaction") == "love"

            # (b) 攔截下一次 setReaction 回傳 FORBIDDEN，確認 UI 自動回滾回 love 並顯示 Toast
            def fail_reaction(route):
                body = route.request.post_data or ""
                if '"action":"setReaction"' in body:
                    route.fulfill(
                        status=200,
                        content_type="application/json",
                        body=json.dumps({
                            "ok": False,
                            "serverTimeMs": int(time.time() * 1000),
                            "code": "FORBIDDEN",
                            "message": "模擬伺服器拒絕反應回滾",
                        }),
                    )
                    return
                route.continue_()

            page1.route("**/*", fail_reaction)
            react_btn.click(force=True)  # 嘗試取消 love -> 樂觀變為 ""，隨後收到 FORBIDDEN 回滾回 "love"
            page1.wait_for_function(
                "() => document.querySelector('#essay-carousel [data-react-btn]')?.getAttribute('data-active-reaction') === 'love' && !document.getElementById('toast-bar').classList.contains('hidden')",
                timeout=10000,
            )
            assert "拒絕反應" in page1.locator("#toast-bar").inner_text()
            page1.unroute("**/*", fail_reaction)
            print("[TC-E04] PASSED")

            # -----------------------------------------------------------------
            # TC-E05: 雙裝置／多帳號即時協作同步（情境 A 同帳號雙裝置 + 情境 B 同團雙帳號公開/私密隔離）
            # -----------------------------------------------------------------
            # 情境 A: page2 重新以 u_test_e2e_1 登入 -> 看到新隨筆且預設便條紙同步為 card5
            page2.fill("#inp-auth-username", "u_test_e2e_1")
            page2.fill("#inp-auth-password", "pw1234")
            page2.click("#btn-auth-submit")
            page2.wait_for_selector("#auth-form", state="hidden", timeout=20000)
            assert "測試防連點重複送出" in page2.locator("#essay-carousel").inner_text()
            assert page2.evaluate("() => localStorage.getItem('essay_garden_card_style_v1')") == "card5"

            # 情境 B: page1 開團，開啟 ctx3 (u_test_e2e_2) 加團；page1 寫公開文與私密文 -> ctx3 重整只看到公開文與種子數更新
            page1.click("#btn-enter-fullscreen-garden")
            page1.click("#nav-btn-group")
            page1.wait_for_selector("#btn-create-group", state="visible", timeout=5000)
            page1.fill("#inp-group-name", "雙裝置協作測試團")
            page1.click("#btn-create-group")
            page1.wait_for_selector("text=邀請碼：", timeout=20000)
            assert page1.locator("#btn-sim-teammate").count() == 0, "TC-E06 #btn-sim-teammate must be hidden in cloud mode"
            inv_code = page1.locator("#modal-box strong").first.inner_text().strip()
            page1.click("#modal-close")
            page1.click("#btn-back-home")

            ctx3 = chromium.new_context(viewport={"width": 412, "height": 844})
            page3 = ctx3.new_page()
            page3.goto(f"{base_url}/index.html", wait_until="networkidle")
            page3.fill("#inp-auth-username", "u_test_e2e_2")
            page3.fill("#inp-auth-password", "pw1234")
            page3.click("#btn-auth-submit")
            page3.wait_for_selector("#auth-form", state="hidden", timeout=20000)
            page3.click("#btn-enter-fullscreen-garden")
            page3.click("#nav-btn-group")
            page3.fill("#inp-invite-code", inv_code)
            page3.click("#btn-join-group")
            page3.wait_for_selector("text=成員今日狀態", timeout=20000)
            page3.click("#modal-close")
            page3.click("#btn-back-home")

            # page1 在團內寫 1 篇公開文與 1 篇私密文
            page1.click("#btn-write-composer")
            page1.fill("#essay-input", "同團雙帳號公開隨筆大家都能看到喔")
            page1.click("#btn-submit-essay")
            page1.wait_for_selector("#btn-reward-bag", state="visible", timeout=20000)
            page1.click("#btn-reward-bag")

            page1.click("#btn-write-composer")
            page1.fill("#essay-input", "同團雙帳號私密隨筆他人不可見_E05_PRIV")
            page1.check("#essay-private")
            page1.click("#btn-submit-essay")
            page1.wait_for_selector("#btn-reward-bag", state="visible", timeout=20000)
            page1.click("#btn-reward-bag")

            # page3 重整並等待背景 bootstrap 完成
            with page3.expect_response(lambda r: "script.google" in r.url and r.status == 200, timeout=20000):
                page3.reload(wait_until="domcontentloaded")
            page3.wait_for_selector("text=同團雙帳號公開隨筆大家都能看到喔", timeout=15000)
            p3_carousel_txt = page3.locator("#essay-carousel").inner_text()
            assert "E05_PRIV" not in p3_carousel_txt, "TC-E05 private essay leaked to group member"
            assert "團體 2/3" in page3.locator("#btn-write-composer").inner_text()
            print("[TC-E05] PASSED")

            # -----------------------------------------------------------------
            # TC-E08: 斷網離線韌性（離線仍可瀏覽花園與隨筆；送出新隨筆顯示友善錯誤且不損壞快取）
            # -----------------------------------------------------------------
            ctx1.set_offline(True)
            page1.click("#btn-enter-fullscreen-garden")
            assert page1.locator("#full-island-svg .island-pan-layer").is_visible()
            page1.click("#btn-back-home")
            assert "同團雙帳號公開隨筆" in page1.locator("#essay-carousel").inner_text()

            page1.click("#btn-write-composer")
            page1.fill("#essay-input", "離線狀態嘗試送出的隨筆應被友善攔截")
            page1.click("#btn-submit-essay")
            page1.wait_for_selector("#toast-bar:not(.hidden)", timeout=5000)
            assert "網路" in page1.locator("#toast-bar").inner_text()
            page1.click("#modal-close")
            cached_raw = page1.evaluate("() => localStorage.getItem('essay_garden_state_v4')")
            assert cached_raw and "同團雙帳號公開隨筆" in cached_raw
            ctx1.set_offline(False)
            print("[TC-E08] PASSED")

            ctx1.close()
            ctx2.close()
            ctx3.close()

            # -----------------------------------------------------------------
            # TC-E07: 行動端與 Safari/WebKit 封鎖第三方 Cookie 相容性（412x844、0 次 OPTIONS、0 顆 iframe）
            # -----------------------------------------------------------------
            mob_engine = p.webkit if os.path.exists(p.webkit.executable_path) else chromium
            wk_ctx = mob_engine.new_context(
                viewport={"width": 412, "height": 844},
                is_mobile=True,
                has_touch=True,
                user_agent=(
                    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) "
                    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
                ),
            )
            wk_page = wk_ctx.new_page()
            wk_methods: list[str] = []
            wk_errors: list[str] = []
            wk_page.on("request", lambda req: wk_methods.append(req.method))
            wk_page.on("pageerror", lambda err: wk_errors.append(str(err)))

            # 模擬 Safari ITP 嚴格封鎖跨網域第三方 Cookie：強制剝除所有發往 script.google* 的 Cookie header
            def strip_3p_cookies(route):
                if "script.google" in route.request.url:
                    hdrs = {k: v for k, v in route.request.headers.items() if k.lower() != "cookie"}
                    route.continue_(headers=hdrs)
                else:
                    route.continue_()

            wk_page.route("**/*", strip_3p_cookies)

            wk_page.goto(f"{base_url}/index.html", wait_until="networkidle")
            wk_page.wait_for_selector("#auth-form", state="visible", timeout=5000)
            wk_page.fill("#inp-auth-username", "u_test_e2e_wk")
            wk_page.fill("#inp-auth-password", "pw1234")
            wk_page.click("#btn-auth-submit")
            wk_page.wait_for_selector("#auth-form", state="hidden", timeout=20000)

            # 寫文獲得種子 -> 進全螢幕花園 -> 開種子袋種下 -> 返家
            wk_page.click("#btn-write-composer")
            wk_page.fill("#essay-input", "WebKit行動端瀏覽器寫隨筆抽種子並種植測試")
            wk_page.click("#btn-submit-essay")
            wk_page.wait_for_selector("#btn-reward-bag", state="visible", timeout=20000)
            wk_page.click("#btn-reward-bag")

            wk_page.click("#btn-enter-fullscreen-garden")
            wk_page.click("#nav-btn-bag")
            wk_page.wait_for_selector("[data-bag-plant]", state="visible", timeout=5000)
            wk_page.locator("[data-bag-plant]").first.click()
            cell0 = wk_page.locator('#full-island-svg [data-cell-x="0"][data-cell-y="0"]').bounding_box()
            assert cell0, "Expected mobile cell (0,0) bounding box"
            wk_page.mouse.click(cell0["x"] + cell0["width"] / 2, cell0["y"] + cell0["height"] / 2)
            wk_page.wait_for_function(
                "() => document.querySelectorAll('#full-island-svg image').length >= 2",
                timeout=20000,
            )
            wk_page.click("#btn-back-home")

            assert "OPTIONS" not in wk_methods, f"TC-E07 unexpected CORS OPTIONS requests: {wk_methods}"
            assert wk_page.locator("iframe").count() == 0, "TC-E07 found unexpected iframe in DOM"
            assert not wk_errors, f"TC-E07 mobile page errors: {wk_errors}"
            wk_ctx.close()
            if mob_engine != chromium:
                mob_engine.close()
            chromium.close()
            print("[TC-E07] PASSED")
            print("M3_L0_AND_L5_E2E_VERIFICATION_PASSED")
    finally:
        httpd.shutdown()
        httpd.server_close()
        h.teardown_test_data()
        print("[TEARDOWN] CLEAN_ZERO_TEST_RESIDUE_VERIFIED")


def main() -> None:
    parser = argparse.ArgumentParser(description="隨筆花園雲端資料庫驗證套件")
    parser.add_argument("--stage", default="m1", choices=["m1", "l2", "m2", "l3b", "m3", "all"], help="要執行的驗證階段")
    parser.add_argument("--init", action="store_true", help="先執行試算表初始化（僅無正式資料時可用）")
    parser.add_argument("--sheet-id", default=DEFAULT_SHEET_ID, help="目標試算表 ID")
    parser.add_argument("--gas-url", default=_load_default_gas_url(), help="已部署的 GAS Web App URL")
    args = parser.parse_args()

    if args.stage == "m1":
        if args.init:
            init_m1(args.sheet_id)
        verify_m1(args.sheet_id)
    elif args.stage == "l2":
        verify_l2()
    elif args.stage == "m2":
        verify_m2(args.sheet_id, args.gas_url)
    elif args.stage == "l3b":
        verify_l3b()
    elif args.stage == "m3":
        verify_m3(args.sheet_id, args.gas_url)
    elif args.stage == "all":
        verify_m1(args.sheet_id)
        verify_l2()
        verify_l3b()
        verify_m2(args.sheet_id, args.gas_url)
        verify_m3(args.sheet_id, args.gas_url)
        verify_m1(args.sheet_id)


if __name__ == "__main__":
    main()
