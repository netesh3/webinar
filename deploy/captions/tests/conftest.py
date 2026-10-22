import sys
from pathlib import Path

# The package lives beside tests/, not installed.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
