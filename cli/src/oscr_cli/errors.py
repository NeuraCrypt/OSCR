"""The tool's exit codes and the errors that carry them (docs/CLI.md "Exit codes"; ``oscr help
exit-codes``).

    0    done
    1    an error (the network, the registry, GitHub, a file): said on standard error
    2    a usage error: a command, flag or argument the tool does not take, or a value missing in a
         non-interactive run
    3    a check found a failure (``oscr check``, ``oscr trace check``): the report says which
    4    sign-in needed: no credential for this host, or it was refused (expired, revoked)
    130  interrupted (Ctrl-C)
"""
from __future__ import annotations

OK = 0
ERROR = 1
USAGE = 2
FAILED = 3
AUTH = 4
INTERRUPTED = 130


class CliError(Exception):
    """An error said to the person in words, with its exit code."""

    code = ERROR

    def __init__(self, message: str, *, hint: str = "", code: int | None = None):
        super().__init__(message)
        self.message = message
        self.hint = hint
        if code is not None:
            self.code = code


class UsageError(CliError):
    code = USAGE


class AuthError(CliError):
    code = AUTH


class CheckFailed(CliError):
    code = FAILED
