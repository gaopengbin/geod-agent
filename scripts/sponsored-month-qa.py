"""Reuse the isolated real-provider controller under a distinct acceptance root."""
from pathlib import Path
import os
import runpy
root=Path(__file__).resolve().parents[1]/'artifacts/product-gaps-20261004/sponsored-months'
os.environ['GEOD_SPONSOR_QA_ROOT']=str(root)
os.environ['GEOD_SPONSOR_QA_BUDGET_PERIOD']='month'
runpy.run_path(str(Path(__file__).with_name('sponsored-qa-controller.py')),run_name='__main__')
