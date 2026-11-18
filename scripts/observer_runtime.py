#!/usr/bin/env python3
"""Use the canonical runtime; no local role inference."""
import importlib.util
from pathlib import Path
import runpy
import sys
entry = Path(__file__).resolve().with_name('observer-bootstrap.py')
spec = importlib.util.spec_from_file_location('observer_bootstrap', entry)
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)
try:
    app = bootstrap.resolve_home()
except (ValueError, OSError) as exc:
    raise SystemExit(str(exc))
sys.path.insert(0, str(app / 'runtime'))
runpy.run_path(str(app / 'runtime/runtime.py'), run_name='__main__')
