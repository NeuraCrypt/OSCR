"""``python -m oscr_cli``: how the tool runs inside this repository (D14-1), where ``oscr`` is the
harvester's command."""
from __future__ import annotations

from .main import main

raise SystemExit(main())
