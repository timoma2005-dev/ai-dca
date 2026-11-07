"""Independent copy of the collector calendar. Unknown years fail closed."""
from datetime import date, timedelta
from .rules import DataUnavailable

HOLIDAYS = {
    2024: [("01-01", "01-01"), ("02-09", "02-17"), ("04-04", "04-06"), ("05-01", "05-05"),
           ("06-10", "06-10"), ("09-15", "09-17"), ("10-01", "10-07")],
    2025: [("01-01", "01-01"), ("01-28", "02-04"), ("04-04", "04-06"), ("05-01", "05-05"),
           ("05-31", "06-02"), ("10-01", "10-08")],
    2026: [("01-01", "01-03"), ("02-15", "02-23"), ("04-04", "04-06"), ("05-01", "05-05"),
           ("06-19", "06-21"), ("09-25", "09-27"), ("10-01", "10-07")],
}


def trading_day(day):
    if day.year not in HOLIDAYS:
        raise DataUnavailable("unconfigured_calendar_year")
    md = day.strftime("%m-%d")
    return day.weekday() < 5 and not any(start <= md <= end for start, end in HOLIDAYS[day.year])


def previous_day(day):
    for _ in range(40):
        day -= timedelta(days=1)
        if trading_day(day):
            return day
    raise DataUnavailable("previous_trading_day_unavailable")


def sessions(start, end):
    output = []
    while start <= end:
        if trading_day(start):
            output.append(start)
        start += timedelta(days=1)
    return output


def quarter_start(day):
    return date(day.year, 1 + 3 * ((day.month - 1) // 3), 1)


def next_quarter(day):
    q = quarter_start(day)
    return date(q.year + (q.month == 10), 1 if q.month == 10 else q.month + 3, 1)
