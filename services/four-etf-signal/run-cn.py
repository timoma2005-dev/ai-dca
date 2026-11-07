"""Independent CN cron entry point. Secrets are inherited only for notify calls."""
import sys
sys.dont_write_bytecode = True
from four_etf_signal.runner import main

if __name__ == "__main__":
    raise SystemExit(main())
