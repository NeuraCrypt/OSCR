"""The command tree: each module registers its commands (``register(sub)``) and says its group."""
from __future__ import annotations

from . import repo, settings

#: The groups, in the order the overview names them (the registry's own first: D14-10).
GROUPS = ("registry", "github", "account", "settings")

#: The modules, in the order `oscr --help` lists their commands.
MODULES = (repo, settings)
