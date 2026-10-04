"""Import a CLI script without executing its build entry point."""
import importlib.util
from pathlib import Path
def load_builder():
    spec = importlib.util.spec_from_file_location('release_candidate', Path(__file__).with_name('build-release-candidate.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
