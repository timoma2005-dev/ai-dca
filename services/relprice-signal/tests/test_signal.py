from __future__ import annotations

from datetime import datetime, timedelta
import json
import math
from pathlib import Path
import sqlite3
import tempfile
import unittest

from relprice_signal.data import TZ, exchange_code, history_from_db, prior_days, signal_prices, trading_day, validate_latest
from relprice_signal.rules import CODES, DataUnavailable, decide, first_common_bar, scores
from relprice_signal.runner import Store, run


class RuleTests(unittest.TestCase):
    def setUp(self):
        self.history = [{c: 1. for c in CODES} for _ in range(30)]
        self.valid = dict.fromkeys(CODES, True)

    def test_log_relative_formula_and_prior_only_window(self):
        prices = dict.fromkeys(CODES, 1.)
        prices[CODES[0]] = math.exp(.012)
        values = scores(self.history, prices)
        self.assertAlmostEqual(values[CODES[0]], .011)
        self.assertAlmostEqual(values[CODES[1]], -.001)
        self.assertAlmostEqual(sum(values.values()), 0)
        # Per-fund fixed denomination scaling must not change any signal.
        scaled = [{c: row[c] * (i + 1) for i, c in enumerate(CODES)} for row in self.history]
        actual = scores(scaled, {c: prices[c] * (i + 1) for i, c in enumerate(CODES)})
        for code in CODES:
            self.assertAlmostEqual(actual[code], values[code], places=14)

    def test_threshold_equal_above_below_and_backtest_epsilon(self):
        for gap, expected in [(.006, 'rotate'), (.00600001, 'rotate'), (.00599999, 'hold'), (.006 - 5e-15, 'rotate')]:
            with self.subTest(gap=gap):
                prices = dict.fromkeys(CODES, 1.)
                prices['513110'] = math.exp(gap)
                result = decide(self.history, prices, self.valid, '513110')
                self.assertEqual(result['decision'], expected)
                self.assertEqual(result['target'], '513100')
                self.assertAlmostEqual(result['gap_bp'], gap * 10000)

    def test_alternative_target_can_be_worse_than_held(self):
        prices = dict.fromkeys(CODES, 1.)
        prices['513110'] = math.exp(-.02)
        result = decide(self.history, prices, self.valid, '513110')
        self.assertEqual(result['decision'], 'hold')
        self.assertLess(result['gap_bp'], 0)

    def test_held_suspended_and_no_alternative(self):
        self.valid['513110'] = False
        with self.assertRaisesRegex(DataUnavailable, 'holding_no_positive'):
            decide(self.history, self.history[0], self.valid, '513110')
        with self.assertRaisesRegex(DataUnavailable, 'no_eligible'):
            decide(self.history, self.history[0], {'513110': True}, '513110')

    def test_missing_and_nonfinite_cross_section_never_shrinks_pool(self):
        for value in [None, 0, -1, math.nan, math.inf]:
            prices = dict(self.history[0], **{'159501': value})
            with self.assertRaises(DataUnavailable):
                scores(self.history, prices)
        with self.assertRaises(DataUnavailable):
            scores(self.history[:-1], self.history[0])

    def test_common_bar_requires_both_positive_and_at_least_one_minute(self):
        def row(t, volume): return ['20261109' + t, 1., 1., 1., 1., volume]
        bars = {'513110': [row('1440', 1), row('1441', 0), row('1442', 5), row('1443', 5)],
                '513100': [row('1440', 1), row('1441', 4), row('1442', 0), row('1443', 4)]}
        self.assertEqual(first_common_bar(bars, '513110', '513100')['time'], '1443')
        bars['513100'] = [row('1441', 2)]
        self.assertIsNone(first_common_bar(bars, '513110', '513100'))

    def test_frozen_backtest_last_30_sessions(self):
        reference = json.loads((Path(__file__).parent / 'fixtures/backtest-reference.json').read_text())
        days = reference['days']
        held = reference['cases'][0]['holding']
        for expected in reference['cases']:
            index = days.index(expected['date'])
            result = decide([reference['prices'][d] for d in days[index - 30:index]],
                            reference['prices'][expected['date']], reference['valid'][expected['date']], held)
            for field in ('holding', 'target', 'next_holding', 'decision'):
                self.assertEqual(result[field], expected[field], (expected['date'], field))
            self.assertAlmostEqual(result['gap_bp'], expected['gap_bp'], places=8)
            held = result['next_holding']


class LiveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.now = datetime(2026, 11, 9, 14, 40, 0, tzinfo=TZ)
        self.config = {'history_db': self.tmp.name + '/m1.db', 'latest_url': 'http://127.0.0.1:18080/latest',
                       'data_dir': self.tmp.name + '/state', 'initial_holding': '513110', 'initial_as_of': '2026-11-06',
                       'max_snapshot_age_sec': 45, 'notification_mode': 'enabled', 'owner_user_id': 'owner'}
        db = sqlite3.connect(self.config['history_db'])
        db.execute('CREATE TABLE k1(code TEXT,ts TEXT,open REAL,close REAL,vol REAL,PRIMARY KEY(code,ts))')
        db.executemany('INSERT INTO k1 VALUES (?,?,?,?,?)', [(exchange_code(c), d + '1440', 1., 1., 1.) for c in CODES for d in prior_days(self.now.date())])
        db.commit()
        db.close()
        outer = self
        class Market:
            rotate = True
            def latest(self):
                return {'generated_at': outer.now.isoformat(), 'symbols': [{'symbol': c, 'price': 1., 'volume': 1., 'price_timestamp': outer.now.isoformat(), 'suspended': False, 'quality': {'status': 'ok'}} for c in CODES]}
            def bars(self, codes, day, now):
                return {c: [[day + t, 1., math.exp(.006) if self.rotate and c == '513110' else 1., 1., 1., 1.] for t in ['1440', '1441'] if t <= now.strftime('%H%M')] for c in codes}
        self.market = Market()
        self.sent = []

    def sleep(self, seconds):
        self.now += timedelta(seconds=seconds)

    def sender(self, config, payload):
        self.sent.append(payload)
        return {'ok': True, 'status': 'delivered'}

    def execute(self, **kwargs):
        return run(self.config, market=self.market, clock=lambda: self.now, sleeper=self.sleep, sender=self.sender, **kwargs)

    def test_dry_run_calculates_logs_and_never_sends_or_advances(self):
        result = self.execute(dry_run=True)
        self.assertEqual(result['decision'], 'rotate')
        self.assertEqual(result['execution_reference']['time'], '1441')
        self.assertEqual(self.sent, [])
        self.assertFalse(Path(self.config['data_dir'], 'state.json').exists())
        self.assertTrue(Path(self.config['data_dir'], 'signals.jsonl').exists())

    def test_live_rotation_dry_run_first_and_once_per_day(self):
        result = self.execute(dry_run=False)
        self.assertEqual(result['push'], 'delivered')
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(Store(self.config).state()['held_code'], '513100')
        records = [json.loads(line) for line in Path(self.config['data_dir'], 'signals.jsonl').read_text().splitlines()]
        self.assertEqual(records[0]['mode'], 'dry-run')
        self.now = self.now.replace(hour=14, minute=40)
        self.assertEqual(self.execute(dry_run=False)['decision'], 'skip')
        self.assertEqual(len(self.sent), 1)

    def test_hold_logs_without_notify(self):
        self.market.rotate = False
        result = self.execute(dry_run=False)
        self.assertEqual(result['decision'], 'hold')
        self.assertEqual(self.sent, [])
        self.assertEqual(Store(self.config).state()['held_code'], '513110')

    def test_weekend_holiday_unknown_year_and_late_run_fail_closed(self):
        for when, reason in [(datetime(2026, 11, 7, 14, 40, tzinfo=TZ), 'non_trading_day'),
                             (datetime(2026, 10, 1, 14, 40, tzinfo=TZ), 'non_trading_day'),
                             (datetime(2027, 1, 4, 14, 40, tzinfo=TZ), 'unconfigured_calendar_year'),
                             (datetime(2026, 11, 9, 14, 41, tzinfo=TZ), 'outside_signal_start_window')]:
            self.now = when
            self.assertEqual(self.execute(dry_run=False)['reason'], reason)
        self.assertFalse(self.sent)

    def test_stale_symbol_snapshot_future_and_suspension(self):
        for field, bad in [('generated_at', (self.now - timedelta(seconds=46)).isoformat()),
                           ('generated_at', (self.now + timedelta(seconds=3)).isoformat())]:
            payload = self.market.latest()
            payload[field] = bad
            with self.assertRaises(DataUnavailable): validate_latest(payload, self.now)
        for field, bad in [('price_timestamp', (self.now - timedelta(seconds=46)).isoformat()), ('suspended', True), ('volume', 0)]:
            payload = self.market.latest()
            payload['symbols'][0][field] = bad
            with self.assertRaises(DataUnavailable): validate_latest(payload, self.now)

    def test_missing_history_day_cannot_extend_lookback(self):
        days = prior_days(self.now.date())
        with sqlite3.connect(self.config['history_db']) as db:
            db.execute('DELETE FROM k1 WHERE ts=?', (days[-2] + '1440',))
        result = self.execute(dry_run=False)
        self.assertEqual(result['decision'], 'skip')
        self.assertIn('missing_history_session', result['reason'])
        self.assertFalse(self.sent)

    def test_history_mark_ffill_does_not_grant_signal_eligibility(self):
        days = prior_days(self.now.date())
        with sqlite3.connect(self.config['history_db']) as db:
            db.execute('UPDATE k1 SET vol=0,close=999 WHERE code=? AND ts=?', (exchange_code('513110'), days[-1] + '1440'))
        prices, valid = history_from_db(self.config['history_db'], days)
        self.assertEqual(prices[days[-1]]['513110'], 1.)
        self.assertFalse(valid[days[-1]]['513110'])

    def test_intraday_daily_volume_cannot_replace_minute_volume(self):
        bars = self.market.bars(CODES, '20261109', self.now)
        bars['513110'][0][5] = 0
        bars['513110'].insert(0, ['202611091439', 1., 1., 1., 1., 1.])
        prices, valid = signal_prices(bars, '20261109')
        self.assertEqual(prices['513110'], 1.)
        self.assertFalse(valid['513110'])

    def test_delivery_failure_keeps_reference_state_and_is_not_resent(self):
        def fail(*args): raise TimeoutError()
        result = run(self.config, dry_run=False, market=self.market, clock=lambda: self.now, sleeper=self.sleep, sender=fail)
        self.assertEqual(result['push'], 'failed_or_unknown')
        self.assertEqual(result['decision'], 'rotate')
        self.assertEqual(Store(self.config).state()['held_code'], '513100')

    def test_no_common_execution_bar_cancels_without_state_change_or_push(self):
        previous = self.market.bars
        def without_volume(*args):
            bars = previous(*args)
            for rows in bars.values():
                for row in rows:
                    if row[0].endswith('1441'):
                        row[5] = 0
            return bars
        self.market.bars = without_volume
        result = self.execute(dry_run=False)
        self.assertEqual(result['decision'], 'cancel')
        self.assertEqual(self.sent, [])
        self.assertEqual(Store(self.config).state()['held_code'], '513110')

    def test_manual_override_is_audited(self):
        store = Store(self.config)
        state = store.set_holding('159501', '2026-11-06', '用户纠正实际持仓')
        self.assertEqual(state['held_code'], '159501')
        self.assertTrue(state['actual_holding_confirmed'])
        self.assertIn('manual_override', (store.directory / 'signals.jsonl').read_text())

    def test_bootstrap_arms_only_after_valid_trading_dry_run(self):
        path = Path(self.tmp.name, 'config.json')
        self.config.update(notification_mode='after_dry_run', _config_path=str(path))
        path.write_text(json.dumps(self.config))
        self.execute(dry_run=True)
        self.assertEqual(json.loads(path.read_text())['notification_mode'], 'after_dry_run')
        self.assertFalse(Path(self.config['data_dir'], 'live-dry-run-passed.json').exists())
        self.now = self.now.replace(hour=14, minute=40, second=8)
        self.execute(dry_run=False)
        self.assertEqual(json.loads(path.read_text())['notification_mode'], 'enabled')
        self.assertTrue(Path(self.config['data_dir'], 'live-dry-run-passed.json').exists())
        self.assertEqual(len(self.sent), 1)

    def test_closed_day_cannot_arm_bootstrap_delivery(self):
        self.config['notification_mode'] = 'after_dry_run'
        self.now = datetime(2026, 11, 7, 14, 40, tzinfo=TZ)
        self.execute(dry_run=False)
        self.assertEqual(self.config['notification_mode'], 'after_dry_run')
        self.assertFalse(self.sent)


if __name__ == '__main__':
    unittest.main()
