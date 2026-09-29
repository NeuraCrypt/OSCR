"""The platform's name and address, in one place (CLAUDE.md: the platform's name lives in one
configuration value, ``SITE_NAME``).

Every sentence of the tool that names the platform takes it from here, and the default host too. The
person's own configuration may point the tool at another deployment (``oscr config set host …``) and
give it its name (``oscr config set site_name …``); ``OSCR_SITE_NAME`` and ``OSCR_HOST`` do the same for
one run. The command's own name, ``oscr``, is the plan's (PLATFORM_PLAN §15.6, phase 14).
"""
from __future__ import annotations

#: The short name, as the website's ``SITE_NAME`` (website/src/config.ts) defaults to it.
SITE_NAME = "OSCR"

#: The registry's address while it is built (CLAUDE.md: the free workers.dev address, a domain before
#: the public launch).
DEFAULT_HOST = "oscr.yannbellec-b.workers.dev"

#: GitHub's own addresses (the device flow, git, the REST API). Tests point them at the fake GitHub.
DEFAULT_GITHUB_WEB = "https://github.com"
DEFAULT_GITHUB_API = "https://api.github.com"
