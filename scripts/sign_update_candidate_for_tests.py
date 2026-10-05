"""Import a hyphenated script without executing its command-line entry point."""
import importlib.util
from pathlib import Path


def sign_module():
    path = Path(__file__).with_name("sign-update-candidate.py")
    spec = importlib.util.spec_from_file_location("sign_update_candidate", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
